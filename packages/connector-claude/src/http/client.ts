import { z } from "zod";

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
    };

export interface HubRequest<T> {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly schema: z.ZodType<T>;
  readonly body?: unknown;
}

const failure = <T>(
  kind: HubFailureKind,
  status: number,
  code: string,
  message: string,
): HubResult<T> => ({ ok: false, kind, status, code, message });

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
  result: HubResult<unknown>,
): Promise<void> => {
  if (ctx.repoKey.length === 0) {
    return;
  }
  const nowIso = ctx.now().toISOString();
  await updateSyncState(ctx.home, ctx.repoKey, {
    lastSyncAt: nowIso,
    ...(result.ok
      ? { lastOkAt: nowIso, lastError: null }
      : { lastError: `${result.code}: ${result.message}` }),
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
    await recordSync(ctx, result);
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
    });
  } catch (error) {
    return failure(
      "network",
      0,
      "network_error",
      error instanceof Error ? error.message : "request failed",
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
