/**
 * THE STATUS THE HUB LAST ACKNOWLEDGED (review-2 round 8, L7).
 *
 * Every sender of a life's work context builds it from the state, so the next
 * one makes the hub agree with the state — except that at SessionEnd there is
 * no next one. A set_intent post that may have landed and did not left the hub
 * on the status before it for good, and one that surely did not, put back
 * after another sender carried it in the window, left the hub ahead of the
 * state. So the state remembers the last status the hub accepted for its work
 * context, from a flush or from set_intent's own post, and SessionEnd sends
 * the work context once more when the two differ (flows/end-session.ts).
 *
 * Only an `accepted` answer counts. A duplicate is an envelope the hub held
 * before, not the status it holds now. An acceptance this misses (a heal's
 * re-send) leaves the last one standing, or none: SessionEnd then compares
 * with an older status, or sends nothing for a work context the hub was
 * never seen to take.
 */
import type { RecordResult } from "../http/hub.ts";
import { updateSessionState } from "../state/session-state.ts";
import type { SessionState } from "../state/session-state.ts";
import { hostSessionKeyOf } from "./owed-work-context.ts";

/** A work context and the status the hub accepted for it. */
export interface AckedWorkContext {
  readonly id: string;
  readonly status: string;
}

const ackOf = (record: Record<string, unknown> | undefined): AckedWorkContext | null => {
  const body = record?.["body"] as { id?: unknown; status?: unknown } | undefined;
  return record?.["kind"] === "work_context" && typeof body?.id === "string" && typeof body.status === "string"
    ? { id: body.id, status: body.status }
    : null;
};

/** The work contexts a batch's answers say the hub accepted, in the order they were sent. */
export const ackedIn = (
  records: readonly Record<string, unknown>[],
  results: readonly RecordResult[] | undefined,
): readonly AckedWorkContext[] =>
  (results ?? [])
    .filter((result) => result.status === "accepted")
    .map((result) => ackOf(records[result.index]))
    .filter((ack): ack is AckedWorkContext => ack !== null);

/**
 * The last of them for the work context the spool's state names, written
 * down there — only in the flusher's OWN state, and only when it changes it.
 * Another conversation's state is never written: its file's write is that
 * conversation's liveness (state/session-scan.ts), and a write here revived
 * an abandoned host's state and held its spool from every successor.
 * Best-effort.
 */
export const noteWorkContextAcked = async (
  home: string,
  slug: string,
  flusherSessionId: string,
  acked: readonly AckedWorkContext[],
): Promise<void> => {
  const hostSessionKey = hostSessionKeyOf(slug);
  if (acked.length === 0 || hostSessionKey === null) {
    return;
  }
  await updateSessionState(home, hostSessionKey, (fresh) => {
    const last = acked.filter((ack) => ack.id === fresh.workContextId).at(-1);
    const isNew =
      last !== undefined &&
      (fresh.workContextAcked?.id !== last.id || fresh.workContextAcked.status !== last.status);
    return fresh.crosscheckSessionId === flusherSessionId && isNew ? { ...fresh, workContextAcked: last } : null;
  });
};

/**
 * Whether the hub last accepted ANOTHER status for the state's work context
 * than the state holds. One it never accepted any status for is not behind
 * but unknown to it: its own copies are on their way or counted, and one
 * more would only be refused with them.
 */
export const isHubBehindState = (state: SessionState): boolean =>
  state.workContextStatus !== null &&
  state.workContextAcked?.id === state.workContextId &&
  state.workContextAcked.status !== state.workContextStatus;
