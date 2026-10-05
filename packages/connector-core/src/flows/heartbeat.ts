/**
 * `heartbeatMaybe` (DESIGN-agent-agnostic.md §1.3) — the post-tool-use
 * heartbeat throttle as an extracted function: at most one `heartbeatSession`
 * per HEARTBEAT_MIN_INTERVAL_MS, measured off the caller's `lastHeartbeatAt`.
 *
 * EXTRACTED FROM `connector-claude/src/hooks/post-tool-use.ts`
 * (`shouldHeartbeat` + the send), not invented. WHICH events may heartbeat is
 * host policy and stays in the connector (Claude gates on edit/bash tools;
 * the ACP proxy fires on `session/prompt` and edit-kind tool calls); the
 * throttle arithmetic and the send have exactly one spelling here.
 *
 * Returns true when a heartbeat was ATTEMPTED — the caller then records
 * `now` as its new `lastHeartbeatAt`, whatever the hub answered (fail-open:
 * a dead hub must not turn the throttle into a hammer).
 */
import { HEARTBEAT_MIN_INTERVAL_MS, HTTP_CONFLICT, HTTP_NOT_FOUND } from "../constants.ts";
import { heartbeatSession } from "../http/hub.ts";
import type { HubContext } from "../http/client.ts";
import { readTelemetryLossReport } from "../spool/loss-report.ts";

export interface HeartbeatMaybeInput {
  readonly hub: HubContext;
  readonly crosscheckSessionId: string;
  readonly lastHeartbeatAt: string | null;
  readonly now: Date;
  readonly status?: string | undefined;
  /**
   * Called when the hub refuses the session itself — 409, already ended, or
   * 404, never registered (server routes/sessions.ts). The caller binds its
   * healer (flows/heal-session.ts), whose cooldown bounds how often this costs
   * a walk. Absent: the answer is discarded, as it always was.
   */
  readonly onRefused?: () => Promise<unknown>;
}

/** The two answers that mean the session is dead to the hub, not that the hub is down. */
const isRefusedSession = (status: number): boolean =>
  status === HTTP_CONFLICT || status === HTTP_NOT_FOUND;

export const heartbeatMaybe = async (
  input: HeartbeatMaybeInput,
): Promise<boolean> => {
  if (input.lastHeartbeatAt !== null) {
    const lastMs = Date.parse(input.lastHeartbeatAt);
    const isDue =
      Number.isNaN(lastMs) ||
      input.now.getTime() - lastMs >= HEARTBEAT_MIN_INTERVAL_MS;
    if (!isDue) {
      return false;
    }
  }
  // THE LOSS REPORT RIDES EVERY BEAT (docs/1.0/loss-accounting.md §4.2): the
  // most frequent of the three session carriers, so a loss mid-session
  // reaches the hub's coverage within HEARTBEAT_MIN_INTERVAL_MS rather than
  // at the end. Read AFTER the throttle decided a beat is due, so a hook that
  // beats nothing pays nothing; a local read of the ledgers, no round trip.
  const losses = await readTelemetryLossReport(input.hub.home, input.hub.repoKey);
  const result = await heartbeatSession(input.hub, input.crosscheckSessionId, input.status, losses);
  if (!result.ok && isRefusedSession(result.status)) {
    await input.onRefused?.();
  }
  return true;
};
