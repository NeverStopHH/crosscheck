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
import type { SeqField } from "@crosscheck/schema";

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
}

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
const writeStatus = (deps: IntentWriteDeps, own: OwnWorkContext, status: string): Promise<boolean> =>
  updateSessionState(deps.home, own.hostSessionKey, (fresh) => ({ ...fresh, workContextStatus: status }));

/**
 * A post that may have landed went unanswered: the acknowledgement no longer
 * says what the hub holds, so SessionEnd sends the work context whatever the
 * state's status is then (spool/work-context-ack.ts). Only an existing
 * acknowledgement is marked — one never acknowledged at all is sent by its
 * own copies already.
 */
const withUncertainAck = (fresh: SessionState, own: OwnWorkContext): SessionState =>
  fresh.workContextAcked?.id === own.workContextId
    ? { ...fresh, workContextAcked: { ...fresh.workContextAcked, uncertain: true } }
    : fresh;

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
    status,
    intent: write.intent,
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
    // no longer telling.
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
  await updateSessionState(deps.home, own.hostSessionKey, (fresh) => ({
    ...withRecordedIntent(fresh, write.summary),
    workContextStatus: write.status === undefined ? fresh.workContextStatus : status,
    // ...and the status the hub acknowledged, which SessionEnd compares the
    // state's with (spool/work-context-ack.ts, review-2 round 8, L7).
    workContextAcked: result?.status === "accepted" ? { id: own.workContextId, status } : fresh.workContextAcked,
  }));
  // The hub holds this work context now, as set_intent just wrote it: a debt a
  // heal left for it is paid (spool/owed-work-context.ts), and no later flush
  // sends a copy over this status (review-2 round 7, M1).
  await settleOwedOnIntent(deps.home, deps.repoKey, own.hostSessionKey, own.workContextId);
  return { outcome: "taken", result };
};
