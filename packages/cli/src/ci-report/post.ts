/**
 * ONE POST TO `/api/ci-runs` (spec 05 §3.7), and the four things it can mean.
 *
 * NOT THROUGH `hubRequest`. The developer client (connector-core/src/http)
 * carries a HubContext — an api key, a home directory for the spool, a repo
 * key — and every one of those is a DEVELOPER's. The reporter is not a
 * producer: it has a CI token from a repository secret and nothing else, it
 * never spools (a run that could not be sent is said and dropped), and it
 * must never read `~/.crosscheck`, because the machine it runs on belongs to
 * nobody on the team. So this is a plain fetch with a bearer token.
 *
 * FOUR OUTCOMES, NEVER TWO. `stored` is the only one the caller may hang a
 * re-run on; `refused`, `network` and `malformed` each print their own
 * sentence, because they send an operator to different remedies — a wrong
 * secret, a firewall, a hub too old for the route. A `malformed` answer is
 * an answer this client would otherwise have TRUSTED: the id it hands back
 * becomes the next row's `rerunOf`, so it is checked against the shape the
 * hub mints (`cir_` + 32 hex, services/ci-runs.ts) before it is used or
 * printed.
 */
import type { CiRunReport } from "@crosscheck/schema";

/**
 * A CI runner talking to a hub across the public internet, on nobody's
 * session-latency budget: this is NOT the 400 ms hook timeout, because
 * nothing here runs in a hook (spec 05 §6 — hook-path cost is zero). Ten
 * seconds is a choice, not a measurement: long enough for a cold hub behind
 * a tunnel, short enough that an unreachable hub costs the job seconds, not
 * the runner's own timeout.
 */
export const CI_REPORT_HTTP_TIMEOUT_MS = 10_000;

export const CI_RUNS_ROUTE = "/api/ci-runs";

/** The id shape the hub mints: `cir_` + the first 32 hex of a sha256. */
const CI_RUN_ID_PATTERN = /^cir_[0-9a-f]{32}$/;

const STORED_STATUSES = new Set(["accepted", "duplicate"]);

export type CiReportFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export type CiRunPostOutcome =
  | {
      readonly kind: "stored";
      readonly status: "accepted" | "duplicate";
      readonly id: string;
    }
  | {
      readonly kind: "refused";
      readonly httpStatus: number;
      readonly message: string;
    }
  | { readonly kind: "network"; readonly message: string }
  | { readonly kind: "malformed"; readonly message: string };

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface HubEnvelope {
  readonly ok?: unknown;
  readonly data?: { readonly id?: unknown; readonly status?: unknown };
  readonly error?: { readonly message?: unknown };
}

const readEnvelope = async (
  response: Response,
): Promise<HubEnvelope | string> => {
  try {
    const parsed: unknown = await response.json();
    return typeof parsed === "object" && parsed !== null
      ? (parsed as HubEnvelope)
      : "body is not a JSON object";
  } catch (error) {
    return `body is not JSON (${errorMessage(error)})`;
  }
};

const storedOutcome = (envelope: HubEnvelope): CiRunPostOutcome => {
  const id = envelope.data?.id;
  const status = envelope.data?.status;
  if (
    envelope.ok !== true ||
    typeof id !== "string" ||
    !CI_RUN_ID_PATTERN.test(id) ||
    typeof status !== "string" ||
    !STORED_STATUSES.has(status)
  ) {
    return {
      kind: "malformed",
      message: "a 2xx answer without a run id and status of the expected shape",
    };
  }
  return { kind: "stored", status: status as "accepted" | "duplicate", id };
};

export const postCiRun = async (
  fetchImpl: CiReportFetch,
  hubUrl: string,
  token: string,
  body: CiRunReport,
): Promise<CiRunPostOutcome> => {
  let response: Response;
  try {
    response = await fetchImpl(`${hubUrl}${CI_RUNS_ROUTE}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CI_REPORT_HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: "network", message: errorMessage(error) };
  }
  const envelope = await readEnvelope(response);
  if (typeof envelope === "string") {
    return {
      kind: "malformed",
      message: `${envelope} (HTTP ${String(response.status)})`,
    };
  }
  if (!response.ok) {
    const message = envelope.error?.message;
    return {
      kind: "refused",
      httpStatus: response.status,
      message: typeof message === "string" ? message : "no reason given",
    };
  }
  return storedOutcome(envelope);
};
