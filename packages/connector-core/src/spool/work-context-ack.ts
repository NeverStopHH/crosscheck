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
import type { Envelope } from "@crosscheck/schema";

import { UNKNOWN_DEVELOPER_ID, workContextRecord } from "../capture/records.ts";
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
    // An acceptance answers an uncertain post too: the hub holds THIS status now.
    const isNew =
      last !== undefined &&
      (fresh.workContextAcked?.id !== last.id ||
        fresh.workContextAcked.status !== last.status ||
        fresh.workContextAcked.uncertain === true);
    return fresh.crosscheckSessionId === flusherSessionId && isNew ? { ...fresh, workContextAcked: last } : null;
  });
};

/**
 * Whether the hub last accepted ANOTHER status for the state's work context
 * than the state holds — or may hold another since: a set_intent post after
 * that acceptance went unanswered (`uncertain`), and a later one that failed
 * may have put the state back on the acknowledged status while the hub took
 * the unanswered one. One it never accepted any status for is not behind but
 * unknown to it: its own copies are on their way or counted, and one more
 * would only be refused with them.
 */
export const isHubBehindState = (state: SessionState): boolean =>
  state.workContextStatus !== null &&
  state.workContextAcked?.id === state.workContextId &&
  (state.workContextAcked.uncertain === true || state.workContextAcked.status !== state.workContextStatus);

/**
 * THE LIFE'S LAST WORK CONTEXT, from its state, when the hub may be behind it:
 * what SessionEnd spools ahead of its drain (flows/end-session.ts), and what
 * session-reap spools for a host that died without a SessionEnd
 * (state/session-reap.ts) — no later sender would come for either. None for a
 * state from before `agentKind` was written down: it has no producer to send
 * it under.
 */
export const lastWorkContextRecords = (state: SessionState, now: Date): readonly Envelope[] =>
  state.agentKind === null || state.workContextTitle === null || state.workContextStatus === null || !isHubBehindState(state)
    ? []
    : [
        workContextRecord(
          {
            workContextId: state.workContextId,
            sessionId: state.crosscheckSessionId,
            title: state.workContextTitle,
            status: state.workContextStatus,
          },
          {
            developerId: state.developerId ?? UNKNOWN_DEVELOPER_ID,
            agentKind: state.agentKind,
            sessionId: state.crosscheckSessionId,
          },
          now,
        ),
      ];
