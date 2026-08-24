import { z } from "zod";

import {
  classifyConnectionError,
  CONNECTION_FAILURE_CODES,
  shortConnectionMessage,
} from "./connection-error.ts";
import type { ConnectionCause } from "./connection-error.ts";
import { updateSyncState } from "../state/sync-state.ts";

const OkEnvelopeSchema = z.object({ ok: z.literal(true), data: z.unknown() });

const FailEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
});

export interface HubContext {
  readonly hubUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly home: string;
  readonly repoKey: string;
  readonly now: () => Date;
}

export type HubFailureKind = "network" | "http" | "malformed";

export type HubResult<T> =
  | { readonly ok: true; readonly data: T; readonly dateHeader: string | null }
  | {
      readonly ok: false;
      readonly kind: HubFailureKind;
      readonly status: number;
      readonly code: string;
      readonly message: string;
      /**
       * Set on "network" failures only: what the runtime error actually was
       * (http/connection-error.ts). CLI surfaces turn it into the sentence
       * with the matching remedy; hooks ignore it and stay fail-open.
       */
      readonly cause?: ConnectionCause;
    };

export interface HubRequest<T> {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly schema: z.ZodType<T>;
  readonly body?: unknown;
  /**
   * True on the four calls the CAPTURE path makes — register, heartbeat,
   * records, end (http/hub.ts marks them and nothing else). Only those stamp
   * `lastCaptureOkAt`, which is what stops "last capture sync" being a report
   * of the reader's own request: doctor's reachability probe and the
   * statusline's presence poll are reads, so they leave the capture stamp
   * exactly where the last hook left it.
   */
  readonly capture?: boolean;
}

const failure = <T>(
  kind: HubFailureKind,
  status: number,
  code: string,
  message: string,
  cause?: ConnectionCause,
): HubResult<T> => ({
  ok: false,
  kind,
  status,
  code,
  message,
  ...(cause === undefined ? {} : { cause }),
});

const parseEnvelope = <T>(
  raw: unknown,
  status: number,
  schema: z.ZodType<T>,
): { readonly ok: true; readonly data: T } | { readonly failure: HubResult<T> } => {
  const okEnvelope = OkEnvelopeSchema.safeParse(raw);
  if (okEnvelope.success) {
    // A hostile hub must not be able to inject arbitrary text into the
    // developer's context, so the payload is validated before any use.
    const payload = schema.safeParse(okEnvelope.data.data);
    if (!payload.success) {
      return {
        failure: failure("malformed", status, "malformed_payload", "unexpected response shape"),
      };
    }
    return { ok: true, data: payload.data };
  }
  const failEnvelope = FailEnvelopeSchema.safeParse(raw);
  if (failEnvelope.success) {
    return {
      failure: failure(
        "http",
        status,
        failEnvelope.data.error.code,
        failEnvelope.data.error.message,
      ),
    };
  }
  return {
    failure: failure("malformed", status, "malformed_envelope", "unrecognised response envelope"),
  };
};

const recordSync = async (
  ctx: HubContext,
  request: HubRequest<unknown>,
  result: HubResult<unknown>,
): Promise<void> => {
  if (ctx.repoKey.length === 0) {
    return;
  }
  const nowIso = ctx.now().toISOString();
  await updateSyncState(ctx.home, ctx.repoKey, {
    lastSyncAt: nowIso,
    ...(result.ok
      ? {
          lastOkAt: nowIso,
          lastError: null,
          lastErrorStatus: null,
          // ONLY the capture calls move this one (HubRequest.capture): a read
          // that re-stamped it would make every reader's own request the
          // freshest "capture", which is the tautology H5 names.
          ...(request.capture === true ? { lastCaptureOkAt: nowIso } : {}),
        }
      : {
          lastError: `${result.code}: ${result.message}`,
          lastErrorStatus: result.status,
        }),
  });
};

/**
 * Fail-open hub call: never throws, always writes the last-sync record, and
 * validates the response envelope plus payload before returning it.
 */
export const hubRequest = async <T>(
  ctx: HubContext,
  request: HubRequest<T>,
): Promise<HubResult<T>> => {
  const result = await performRequest(ctx, request);
  try {
    await recordSync(ctx, request, result);
  } catch {
    // A read-only home must not break the hook.
  }
  return result;
};

const performRequest = async <T>(
  ctx: HubContext,
  request: HubRequest<T>,
): Promise<HubResult<T>> => {
  let response: Response;
  try {
    response = await fetch(`${ctx.hubUrl}${request.path}`, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${ctx.apiKey}`,
        ...(request.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(request.body === undefined
        ? {}
        : { body: JSON.stringify(request.body) }),
      signal: AbortSignal.timeout(ctx.timeoutMs),
      // The api-key shield. A repo bunfig with logLevel="debug" makes bun
      // print every request VERBATIM to stderr, `Authorization: Bearer
      // <key>` included, for every process in that cwd — our hooks and MCP
      // server run there. Measured on Bun 1.3.13: NO env var overrides the
      // bunfig (BUN_CONFIG_VERBOSE_FETCH=0 in the spawn env and set at
      // runtime both still leak); this per-request option provably wins.
      // Pinned through the real hook binary by test/bunfig-leak.test.ts,
      // whose control arm fails first if a future bun changes the mechanism.
      verbose: false,
    });
  } catch (error) {
    // Classified rather than passed through: "hub unreachable" hiding a plain
    // timeout cost a real onboarding an hour (http/connection-error.ts).
    const cause = classifyConnectionError(error);
    return failure(
      "network",
      0,
      CONNECTION_FAILURE_CODES[cause],
      shortConnectionMessage(cause, error, ctx.timeoutMs),
      cause,
    );
  }

  const dateHeader = response.headers.get("date");
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return failure(
      "malformed",
      response.status,
      "malformed_body",
      "response body was not json",
    );
  }

  const parsed = parseEnvelope(raw, response.status, request.schema);
  if ("failure" in parsed) {
    return parsed.failure;
  }
  return { ok: true, data: parsed.data, dateHeader };
};
