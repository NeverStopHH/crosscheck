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
import { HEARTBEAT_MIN_INTERVAL_MS } from "../constants.ts";
import { heartbeatSession } from "../http/hub.ts";
import type { HubContext } from "../http/client.ts";

export interface HeartbeatMaybeInput {
  readonly hub: HubContext;
  readonly crosscheckSessionId: string;
  readonly lastHeartbeatAt: string | null;
  readonly now: Date;
  readonly status?: string | undefined;
}

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
  await heartbeatSession(input.hub, input.crosscheckSessionId, input.status);
  return true;
};
