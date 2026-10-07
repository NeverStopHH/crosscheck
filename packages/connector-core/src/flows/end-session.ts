/**
 * `endSessionFlow` (DESIGN-agent-agnostic.md §1.3) — the session-end recipe
 * as an extracted function:
 *
 *   flush (budgeted) → pending-end marker → ended-life lineage → delete
 *   state (compared: a life a heal moved it to is ended too) → count
 *   undelivered → `end` only when nothing is left on disk (else the marker
 *   defers it to `reap`'s DeferredEnder).
 *
 * EXTRACTED FROM `connector-claude/src/hooks/session-end.ts`, not invented —
 * the hook calls this now. The ordering arguments travel with the code:
 *
 *   - flush BEFORE ending: ingest rejects records whose producer session has
 *     ended, and this flush sends them under THIS session's id;
 *   - the marker is written BEFORE the `end` call, not instead of it: a
 *     marker left by a call that DID land costs one idempotent retry; a lost
 *     call costs a session that stays open with nobody left to close it;
 *   - state is deleted BEFORE the hub call, whatever life it names: a state
 *     file that outlives its session makes a spool permanently unreapable,
 *     and reap reads the marker only once the state is gone.
 */
import {
  intentPromptPathForSlug,
  removeFile,
  sessionHealPathForSlug,
  sessionSlug,
  spoolPendingEndPath,
  writePrivateFile,
} from "../config/paths.ts";
import { endSession } from "../http/hub.ts";
import type { HubContext } from "../http/client.ts";
import { readSessionSpool } from "../spool/files.ts";
import { readOwedWorkContext } from "../spool/owed-work-context.ts";
import { flushSpool } from "../spool/flush.ts";
import { readTelemetryLossReport } from "../spool/loss-report.ts";
import { recordRefusedLife } from "../spool/refused-lives.ts";
import { seqAt } from "../capture/seq.ts";
import { lifeRungOf, recordEndedLife } from "../state/session-lineage.ts";
import { allocateSeq, closeSessionState, crosscheckSessionIdFor, readSessionState } from "../state/session-state.ts";
import type { SeqField } from "@crosscheck/schema";

export interface EndSessionFlowInput {
  readonly home: string;
  readonly repoKey: string;
  readonly hub: HubContext;
  readonly hostSessionKey: string;
  readonly crosscheckSessionId: string;
  readonly developerId: string | null;
  /** Wall-clock room the caller can spare for the drain; ≤0 skips it. */
  readonly flushBudgetMs: number;
  readonly now: () => Date;
}

export interface EndSessionFlowResult {
  /** Own records still on disk after the drain — >0 defers the `end`. */
  readonly undelivered: number;
  /** True when the hub acknowledged the `end` (marker removed again). */
  readonly ended: boolean;
  /** The position this end took, or the refusal that travels instead. */
  readonly seq: SeqField;
}

/**
 * The marker of ONE life's deferred end (config/paths.ts spoolPendingEndPath):
 * a conversation resumed after a deferred end ends again under the same slug,
 * and one marker per host session was overwritten by the next life's
 * (review-2 finding 3).
 */
const pendingEndPathOf = (input: EndSessionFlowInput, lifeId: string): string =>
  spoolPendingEndPath(
    input.home,
    input.repoKey,
    sessionSlug(input.hostSessionKey),
    lifeRungOf(crosscheckSessionIdFor(input.hostSessionKey), lifeId) ?? 0,
  );

/** One life's end as SessionEnd writes it down: the life, its position, its marker. */
interface LifeEnd {
  readonly sessionId: string;
  readonly seq: SeqField;
  readonly markerPath: string;
}

const lifeEnd = (input: EndSessionFlowInput, sessionId: string, seq: SeqField): LifeEnd => ({
  sessionId,
  seq,
  markerPath: pendingEndPathOf(input, sessionId),
});

/** What the state says the life's work context is, kept on its marker once the state is gone. */
interface WorkContextStanding {
  readonly workContextTitle: string | null;
  readonly workContextStatus: string | null;
}

/** The marker, then the lineage — both before the state goes. */
const writeDownEnd = async (input: EndSessionFlowInput, end: LifeEnd, standing: WorkContextStanding): Promise<void> => {
  await writePrivateFile(
    end.markerPath,
    `${JSON.stringify({
      crosscheckSessionId: end.sessionId,
      at: input.now().toISOString(),
      // THE MARKER IS THE ONLY CARRIER LEFT. reap's DeferredEnder runs in a
      // later process with no state file to consult — so a deferred end
      // without this is permanently unsequenced, and nothing would say why.
      seq: end.seq,
      // ...and the last title and status the life's state held: a work
      // context still on disk for it goes with these, not the ones it was
      // spooled with (spool/owed-work-context.ts readLifeState, review-2 round
      // 7, found by the spool simulation).
      ...(standing.workContextTitle === null ? {} : { workContextTitle: standing.workContextTitle }),
      ...(standing.workContextStatus === null ? {} : { workContextStatus: standing.workContextStatus }),
    })}\n`,
  );
  // The life this end closes, written down BEFORE its state goes: the state
  // file is what named it, and a host that resumes this conversation under
  // the same id must start its next life one rung up, not on this one — an
  // end reported here is final on the hub (state/session-lineage.ts).
  await recordEndedLife(input.home, input.hostSessionKey, end.sessionId, input.now());
};

/**
 * Tells the hub one life is over; its marker goes once the hub took it — and
 * the life is written down as refused (review-2 round 8, M1): a record of it a
 * parallel process appends after this end, a reload's SessionStart re-fire
 * beside it, is withheld from every later flush rather than filed into the
 * ended session (spool/refused-lives.ts).
 */
const endOnHub = async (
  input: EndSessionFlowInput,
  end: LifeEnd,
  losses: Awaited<ReturnType<typeof readTelemetryLossReport>>,
): Promise<boolean> => {
  const result = await endSession(input.hub, end.sessionId, end.seq, losses);
  if (result.ok) {
    await removeFile(end.markerPath);
    await recordRefusedLife(input.home, input.repoKey, end.sessionId, input.now());
  }
  return result.ok;
};

export const endSessionFlow = async (
  input: EndSessionFlowInput,
): Promise<EndSessionFlowResult> => {
  const slug = sessionSlug(input.hostSessionKey);

  await flushSpool(
    input.hub,
    {
      sessionId: input.crosscheckSessionId,
      developerId: input.developerId,
    },
    input.flushBudgetMs,
  );

  // ALLOCATED, NEVER READ, and taken BEFORE the state file is deleted. The
  // counter this session has been handing out lives only in that file, and a
  // Stop-time git lane or a detached worker can allocate inside this very
  // window — so a read yields a position that is not last, and `session.ended`
  // then sorts before events that preceded it. Allocating puts the end
  // strictly past everything the session has issued, which is the one thing
  // its position has to mean. A null block (no state file, or a state file
  // from before this field) becomes `allocation_failed`: no position, and a
  // reason rather than a silence.
  const own = lifeEnd(
    input,
    input.crosscheckSessionId,
    seqAt(await allocateSeq(input.home, input.hostSessionKey, 1), 0),
  );
  const state = await readSessionState(input.home, input.hostSessionKey);
  const standing: WorkContextStanding = {
    workContextTitle: state?.workContextTitle ?? null,
    workContextStatus: state?.workContextStatus ?? null,
  };
  await writeDownEnd(input, own, standing);
  // COMPARED, NOT BLIND (review-2 finding 2): a heal that moved the state
  // after this SessionEnd read it registered a life that ends with this host
  // session too. Left open with no state naming it, the next resume would
  // land on it under a fresh epoch and split its order.
  const moved = await closeSessionState(input.home, input.hostSessionKey, input.crosscheckSessionId);
  const healed = moved === null ? null : lifeEnd(input, moved.crosscheckSessionId, seqAt(moved.seq, 0));
  if (healed !== null) {
    await writeDownEnd(input, healed, standing);
  }
  // A first prompt parked for the derived-intent worker that never ran (a
  // spawn that failed, a session ending inside the worker's deadline) must
  // not outlive the session: best-effort, like the state delete above.
  await removeFile(intentPromptPathForSlug(input.home, slug));
  // ...and so must the mid-life heal's cooldown stamp: a resumed life heals
  // on its own clock, not on the one this life left running.
  await removeFile(sessionHealPathForSlug(input.home, slug));

  // Per SESSION, not per repo: another session's backlog says nothing about
  // whether this one's work has arrived. Counted once the state is gone, so
  // a record a sibling spooled in between holds the end back too — and so
  // does a work context still OWED for the life this end closes or the one a
  // heal moved it to (spool/owed-work-context.ts): ended now, the heal's
  // re-send under that life would be refused as a late write.
  const owed = await readOwedWorkContext(input.home, input.repoKey, slug);
  const owesEnding =
    owed !== null && (owed.sessionId === input.crosscheckSessionId || owed.sessionId === healed?.sessionId);
  const undelivered =
    (await readSessionSpool(input.home, input.repoKey, slug)).lines.length + (owesEnding ? 1 : 0);
  if (undelivered > 0) {
    // Telling the hub "done" now would publish a finished session while
    // records it produced are still on disk. The marker hands the end to
    // reap's DeferredEnder; the records stay deliverable either way.
    return { undelivered, ended: false, seq: own.seq };
  }
  // The session's last word about its own ledgers (docs/1.0/loss-accounting.md
  // §4.2), read AFTER the drain above so a batch that drain had refused or
  // the hub had ignored is already in it. The deferred path returns before
  // this line and carries no report: the SessionStart that spends its marker
  // registered with the same snapshot a moment earlier.
  const losses = await readTelemetryLossReport(input.home, input.repoKey);
  const ownEnded = await endOnHub(input, own, losses);
  const healedEnded = healed === null || (await endOnHub(input, healed, losses));
  return { undelivered, ended: ownEnded && healedEnded, seq: own.seq };
};
