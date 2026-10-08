/**
 * SET_INTENT'S WRITE, WITHOUT ITS WORDS (review-2 round 8, M5).
 *
 * The status goes into the state before the post, the post goes out, and each
 * answer decides what the state keeps, what is written down as refused, and
 * whether the work context a heal still owes is paid. The MCP tool
 * (mcp/tools/set-intent.ts) calls this once its arguments, the secret screen,
 * the echo check and the intent contract have passed, and turns the outcome
 * into sentences; the spool simulation calls the same function, so what it
 * exercises is this code and not a model of it.
 */
import type { SeqField, WorkContextTitleSource } from "@crosscheck/schema";

import { AMBIGUOUS_SESSION, seqAt } from "../../capture/seq.ts";
import type { HubContext } from "../../http/client.ts";
import { postRecords } from "../../http/hub.ts";
import type { RecordResult } from "../../http/hub.ts";
import { settleOwedOnIntent } from "../../spool/owed-work-context.ts";
import { recordRefusedLife } from "../../spool/refused-lives.ts";
import { rejectCauseOf } from "../../spool/reject-cause.ts";
import { allocateSeq, updateSessionState, withRecordedIntent } from "../../state/session-state.ts";
import type { SessionState } from "../../state/session-state.ts";
import type { OwnWorkContext } from "../session.ts";
import { issuesOf, resultAt } from "./shared.ts";
import type { HubFailure } from "./shared.ts";

export interface IntentWriteDeps {
  readonly home: string;
  readonly repoKey: string;
  readonly hub: HubContext;
  readonly now: () => Date;
  /** The work_context envelope the post carries: the tool's is mcp/tools/shared.ts envelopeFor. */
  readonly envelope: (
    producer: { readonly sessionId: string; readonly developerId: string | null },
    body: unknown,
    seq: SeqField,
  ) => Record<string, unknown>;
}

/** The work context set_intent writes to: one whose state holds a title and a status. */
export interface TitledWorkContext extends OwnWorkContext {
  readonly workContextTitle: string;
  readonly workContextStatus: string;
  /**
   * Set when the target is one of the life's TOPICS (flows/topic-contexts.ts
   * `intentTargetOf`): its status then lives in that topic's registry entry,
   * not in the session's, and the post carries the topic's branch and base
   * commit so a hub that has not seen the topic yet creates it whole.
   */
  readonly topicKey?: string;
  readonly branch?: string;
  readonly baseCommit?: string | null;
  /** The topic's own word about that base (flows/topic-base-word.ts), sent beside it. */
  readonly baseOnDefault?: boolean | null;
}

/** The status field this write moves: the session's own, or one topic's entry. */
const withStatus = (fresh: SessionState, own: TitledWorkContext, status: string): SessionState =>
  own.topicKey === undefined
    ? { ...fresh, workContextStatus: status }
    : {
        ...fresh,
        topicContexts: fresh.topicContexts.map((topic) =>
          topic.key === own.topicKey && topic.sessionId === own.crosscheckSessionId ? { ...topic, status } : topic,
        ),
      };

/** What the hub accepted, written where SessionEnd's last word reads it: the session's ack, or the topic's. */
const withAcked = (fresh: SessionState, own: TitledWorkContext, status: string): SessionState =>
  own.topicKey === undefined
    ? { ...fresh, workContextAcked: { id: own.workContextId, status } }
    : {
        ...fresh,
        topicContexts: fresh.topicContexts.map((topic) =>
          topic.key === own.topicKey && topic.sessionId === own.crosscheckSessionId
            ? { ...topic, ackedStatus: status, ackUncertain: false }
            : topic,
        ),
      };

/**
 * A post that may have landed went unanswered: the acknowledgement no longer
 * says what the hub holds, so SessionEnd — or session-reap, for a host that
 * died — sends the work context whatever the state's status is then
 * (spool/work-context-ack.ts; topics seed 416, sleep seed 10478). Only an
 * existing acknowledgement is marked — one never acknowledged at all is sent
 * by its own copies already.
 */
const withUncertainAck = (fresh: SessionState, own: TitledWorkContext): SessionState => {
  if (own.topicKey === undefined) {
    return fresh.workContextAcked?.id === own.workContextId
      ? { ...fresh, workContextAcked: { ...fresh.workContextAcked, uncertain: true } }
      : fresh;
  }
  return {
    ...fresh,
    topicContexts: fresh.topicContexts.map((topic) =>
      topic.key === own.topicKey && topic.sessionId === own.crosscheckSessionId && topic.ackedStatus !== null
        ? { ...topic, ackUncertain: true }
        : topic,
    ),
  };
};

export interface IntentWrite {
  readonly summary: string;
  /** The new status, when the call names one. */
  readonly status: string | undefined;
  /** The declared intent, as the wire schema takes it. */
  readonly intent: Record<string, unknown>;
}

export type IntentWriteOutcome =
  | { readonly outcome: "taken"; readonly result: RecordResult | undefined }
  | { readonly outcome: "ignored"; readonly result: RecordResult }
  | { readonly outcome: "rejected"; readonly result: RecordResult }
  | { readonly outcome: "failed"; readonly failure: HubFailure };

/** Connection failures that mean the request never reached the hub, so nothing it carried landed. */
const NEVER_SENT: ReadonlySet<string> = new Set(["dns", "refused", "tls"]);
const HTTP_SERVER_ERROR = 500;

/** Whether a failed post may still have landed: a timeout, a dropped connection, a gateway answering for the hub. */
const mayHaveLanded = (failure: HubFailure): boolean =>
  failure.kind === "network"
    ? !NEVER_SENT.has(failure.cause ?? "unknown")
    : failure.kind === "malformed" || failure.status >= HTTP_SERVER_ERROR;

/** The work context's status as the session's state records it — what every other sender reads. */
const writeStatus = (deps: IntentWriteDeps, own: TitledWorkContext, status: string): Promise<boolean> =>
  updateSessionState(deps.home, own.hostSessionKey, (fresh) => withStatus(fresh, own, status));

/** The title marker a set_intent post carries: a topic's is always `fallback`, the session's its own. */
const titleSourceOf = (own: TitledWorkContext): { readonly titleSource?: WorkContextTitleSource } => {
  if (own.topicKey !== undefined) {
    return { titleSource: "fallback" };
  }
  return own.workContextTitleSource === null ? {} : { titleSource: own.workContextTitleSource };
};

export const writeIntent = async (
  deps: IntentWriteDeps,
  own: TitledWorkContext,
  write: IntentWrite,
): Promise<IntentWriteOutcome> => {
  const status = write.status ?? own.workContextStatus;
  const body = {
    id: own.workContextId,
    sessionId: own.crosscheckSessionId,
    title: own.workContextTitle,
    // The marker the title registered with: an update without it would leave
    // the hub keeping a stored one only by luck (record-handlers.ts). A TOPIC's
    // title is always the connector's own `<branch> @ <label>`
    // (flows/topic-contexts.ts), so it is `fallback` — never the session's
    // marker, whose `host` would keep an opted-out developer's branch from
    // being withheld on the hub.
    ...titleSourceOf(own),
    status,
    intent: write.intent,
    ...(own.branch === undefined ? {} : { branch: own.branch }),
    ...(own.baseCommit === undefined || own.baseCommit === null ? {} : { baseCommit: own.baseCommit }),
    // ...with the topic's word about it, so a set_intent that reaches the hub
    // before the spool's copy creates the topic whole (topic review C1).
    ...(own.baseCommit === undefined || own.baseCommit === null || typeof own.baseOnDefault !== "boolean"
      ? {}
      : { baseOnDefault: own.baseOnDefault }),
    createdAt: own.startedAt,
  };
  const producer = { sessionId: own.crosscheckSessionId, developerId: own.developerId };
  // THE NEW STATUS GOES INTO THE STATE BEFORE THE POST (review-2 round 7,
  // found by the spool simulation): every other sender of this work context —
  // a SessionStart re-fire, a heal's debt — builds it from the state, so a
  // hook killed between a post the hub took and the state write below had
  // them put the old status back over the new one. A post that does not land
  // puts the old one back.
  const isNewStatus = write.status !== undefined && status !== own.workContextStatus;
  if (isNewStatus) {
    await writeStatus(deps, own, status);
  }
  const keepOldStatus = async (): Promise<void> => {
    if (isNewStatus) {
      await writeStatus(deps, own, own.workContextStatus);
    }
  };
  // BEFORE the envelope, never after the post: the state write at the end
  // would stamp a position on a record the hub has already stored (spec 01
  // §3.6). Under an ambiguous session no position is taken at all and the
  // record carries `ambiguous_session_assignment` — the intent lands, its
  // POSITION does not.
  const seq = own.sessionAmbiguous ? AMBIGUOUS_SESSION : await allocateSeq(deps.home, own.hostSessionKey, 1);
  const posted = await postRecords(deps.hub, [deps.envelope(producer, body, seqAt(seq, 0))]);
  if (!posted.ok) {
    // ...unless it may have landed after all — then the state keeps what the
    // hub may now hold, and the next sender of this work context makes the two
    // agree, rather than putting the old status back over it. SessionEnd is
    // that sender when nothing else comes, so the acknowledgement is marked as
    // no longer telling (topics seed 416, sleep seed 10478).
    if (mayHaveLanded(posted)) {
      await updateSessionState(deps.home, own.hostSessionKey, (fresh) => withUncertainAck(fresh, own));
    } else {
      await keepOldStatus();
    }
    return { outcome: "failed", failure: posted };
  }
  const result = resultAt(posted.data.results, 0);
  // The cap is an answer, not a success: the hub kept the record and not the
  // change inside it, so the state does not keep it either.
  if (result?.status === "ignored") {
    await keepOldStatus();
    return { outcome: "ignored", result };
  }
  if (result?.status === "rejected") {
    await keepOldStatus();
    if (rejectCauseOf(issuesOf(result)) === "session_ended") {
      // The hub says this life is over: its records still on disk are
      // withheld from every later flush (spool/refused-lives.ts, review-2
      // round 7, found by the spool simulation).
      await recordRefusedLife(deps.home, deps.repoKey, own.crosscheckSessionId, deps.now());
    }
    return { outcome: "rejected", result };
  }
  // The state write carries FOUR facts at once, and one lock round is the
  // reason they are together: the status the hub now holds, the sentence the
  // ghost worker will compare (`workContextIntent`), the debt that makes it
  // run (`ghostPending`), and the acknowledgement below. Best-effort like
  // every state update on this path.
  await updateSessionState(deps.home, own.hostSessionKey, (fresh) => {
    const recorded = withRecordedIntent(fresh, write.summary);
    const moved = write.status === undefined ? recorded : withStatus(recorded, own, status);
    // ...and the status the hub acknowledged, which SessionEnd compares the
    // state's with (spool/work-context-ack.ts, review-2 round 8, L7) — for a
    // topic, on that topic's own entry.
    return result?.status === "accepted" ? withAcked(moved, own, status) : moved;
  });
  // The hub holds this work context now, as set_intent just wrote it: a debt a
  // heal left for it is paid (spool/owed-work-context.ts), and no later flush
  // sends a copy over this status (review-2 round 7, M1).
  await settleOwedOnIntent(deps.home, deps.repoKey, own.hostSessionKey, own.workContextId);
  return { outcome: "taken", result };
};
