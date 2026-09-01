/**
 * Summarizer cost, made visible (DESIGN.md §10 risk 7): the Stop hook books
 * every fire and its rough token estimate into the session state, and this
 * module sums what the LIVE sessions of one repo+hub have spent so
 * `crosscheck status` and `doctor` can print it. Session state is deleted at
 * SessionEnd, so this is per-LIVE-session visibility by design — the point
 * is that a running summarizer is never spending invisibly, not accounting.
 *
 * Every figure derived from CHARS_PER_TOKEN_ESTIMATE is an ESTIMATE, and
 * every surface printing one says so. WHAT IT COUNTS: the slice and the
 * prompt the Stop hook hands over, at ~4 chars/token — NOT the nested
 * claude's own system prompt, which is the larger share of a real call.
 * Measured 2026-08-21 on Claude Code 2.1.237 with the lean argv and the
 * doctor probe slice: the estimate says ~234 tokens; the CLI's usage
 * reports 6714 cached input + 187 output tokens (cost_usd 0.0028 on a
 * cache hit; the first, uncached call of the day creates that ~6.6k cache
 * at ~0.017). The line is a spend INDICATOR on the developer's quota —
 * "is this firing at all, and how often" — not a bill.
 */
import {
  DOCTOR_SUMMARIZER_MOSTLY_DEAD_MIN_FIRES,
  DOCTOR_SUMMARIZER_REJECTED_WARN,
  DOCTOR_SUMMARIZER_SILENT_FIRES_WARN,
  DOCTOR_SUMMARIZER_UNREADABLE_WARN,
} from "../../constants.ts";
import { readLiveSessionStates } from "../../state/session-state.ts";
import type {
  LiveSessionScan,
  SessionState,
} from "../../state/session-state.ts";

export interface SummarizerCost {
  /** Live sessions of this repo+hub that were counted. */
  readonly sessions: number;
  /** Session-state files that EXIST — the denominator of "N of M". */
  readonly filesSeen: number;
  /** Files this bounded scan actually opened. */
  readonly filesRead: number;
  /** Files skipped because their session stopped heartbeating. */
  readonly staleSkipped: number;
  /** Files that would not parse — counted, never silently dropped. */
  readonly parseFailures: number;
  readonly fires: number;
  /** Fires the model answered NONE — the gate's noise, counted honestly. */
  readonly nones: number;
  /** Fires that produced a spooled draft — the gate's signal. */
  readonly drafts: number;
  /**
   * Fires the RUNNER lost — binary missing, non-zero exit, deadline (trial
   * finding #14) — and one booked reason, already sanitized and bounded by
   * the writer (gate.ts withSummarizerFailure). Which live session's
   * failure is shown is scan order's choice; they all say the same thing
   * when the runner is broken, which is the case this exists for.
   */
  readonly fails: number;
  readonly lastFailure: string | null;
  /**
   * Answers the CONNECTOR refused (audit rows M16 / A3-4) — role-play, an
   * echo of the prompt or of a delivered hint, a credential-shaped body, a
   * claim the wire contract would not take — with one booked reason in
   * crosscheck's own words (core model/reject.ts never quotes the body). The
   * model SPOKE for each of these and the quota was spent, so they are not
   * runner failures; before they were booked they were invisible, and a
   * session whose every answer was refused read as a dead runner.
   */
  readonly rejects: number;
  readonly lastRejection: string | null;
  /**
   * Turns where the host had no slice to offer at all (gate.ts
   * withSummarizerNoSlice says why this is not a failure). Zero on Claude by
   * construction — its Stop hook has a transcript or it has no session — and
   * the number a Cursor build with transcripts disabled shows instead of a
   * runner WARN that would send the reader to a healthy binary.
   */
  readonly noSlice: number;
  readonly lastNoSlice: string | null;
  /**
   * Answers the MODEL gave that the contract could not read — stdout that is
   * neither claim JSON nor NONE, or nothing at all — with one booked reason
   * in crosscheck's own words (gate.ts UNREADABLE_EMPTY / UNREADABLE_SHAPE).
   * Zero on a working Claude by construction, and the first number to move
   * when CROSSCHECK_SUMMARIZER_CMD points at a model with output habits of
   * its own. Not a runner failure: the binary ran and exited 0.
   */
  readonly unreadable: number;
  readonly lastUnreadable: string | null;
  /** Rough figure at ~4 chars/token — an estimate, never a bill. */
  readonly estimatedTokens: number;
}

const NO_COST: SummarizerCost = {
  sessions: 0,
  filesSeen: 0,
  filesRead: 0,
  staleSkipped: 0,
  parseFailures: 0,
  fires: 0,
  nones: 0,
  drafts: 0,
  fails: 0,
  lastFailure: null,
  rejects: 0,
  lastRejection: null,
  noSlice: 0,
  lastNoSlice: null,
  unreadable: 0,
  lastUnreadable: null,
  estimatedTokens: 0,
};

/**
 * Sums a scan the CALLER has already taken. `crosscheck status` and `doctor`
 * print three model-cost lines and used to walk the session directory three
 * times over; the scan is `readLiveSessionStates` and lives in one place
 * (state/session-state.ts states why).
 *
 * THE BOUND IS VISIBLE IN THE OUTPUT, and that is the other half of the same
 * fix. The old scan was `readdir` → `.filter(.json)` → `.slice(0, 50)` in
 * bun's OS order, which is neither alphabetical nor chronological: on the
 * trial machine it read an arbitrary 50 of 100 files and printed
 * `13 runs (1 NONE, 2 drafts) … across 50 live sessions` while the full set
 * said 27 runs, 3 NONEs and 3 drafts — and nothing in the line suggested a
 * subset had been read. `isSummarizerSilentlyDead` then judged that same
 * arbitrary subset, which is how a WARN could fire or stay silent depending
 * on where the scan landed. The scan now sorts by mtime before the bound,
 * skips files whose session stopped heartbeating, and hands back
 * `filesSeen`/`filesRead`/`staleSkipped` so this line can say what it saw.
 */
export const summarizeSummarizerCost = (
  scan: LiveSessionScan,
): SummarizerCost => ({
  ...summarizeStateCosts(scan.states),
  filesSeen: scan.filesSeen,
  filesRead: scan.filesRead,
  staleSkipped: scan.staleSkipped,
  parseFailures: scan.parseFailures,
});

/**
 * The same sum over a SUBSET a caller already holds, without a scan's
 * file counters. The per-connector doctor sections need exactly this: they
 * are handed one machine's live states and must sum only the ones whose host
 * key is theirs, and `filesSeen`/`filesRead` describe the whole directory
 * scan rather than that filtered view — reporting them against a subset
 * would say "read 4 of 4 state files" about a machine that has twelve.
 * Those fields stay 0 here, and no connector line prints them.
 */
export const summarizeStateCosts = (
  states: readonly SessionState[],
): SummarizerCost =>
  states.reduce<SummarizerCost>(
    (total, state) => ({
      ...total,
      sessions: total.sessions + 1,
      fires: total.fires + state.summarizerFireCount,
      nones: total.nones + state.summarizerNoneCount,
      drafts: total.drafts + state.summarizerDraftCount,
      fails: total.fails + state.summarizerFailCount,
      lastFailure: state.summarizerLastFailure ?? total.lastFailure,
      rejects: total.rejects + state.summarizerRejectCount,
      lastRejection: state.summarizerLastRejection ?? total.lastRejection,
      noSlice: total.noSlice + state.summarizerNoSliceCount,
      lastNoSlice: state.summarizerLastNoSlice ?? total.lastNoSlice,
      unreadable: total.unreadable + state.summarizerUnreadableCount,
      lastUnreadable: state.summarizerLastUnreadable ?? total.lastUnreadable,
      estimatedTokens: total.estimatedTokens + state.summarizerEstimatedTokens,
    }),
    NO_COST,
  );

/** Scan-and-sum, for a caller that wants only this one figure. */
export const readSummarizerCost = async (
  home: string,
  hubUrl: string,
  repoId: string,
): Promise<SummarizerCost> =>
  summarizeSummarizerCost(await readLiveSessionStates(home, hubUrl, repoId));

/**
 * The one spelling of the cost fact both CLI surfaces print. The outcome
 * split (trial finding #12's measuring stick) rides in the middle: NONE is
 * the gate's noise, drafts its signal, failures the runner's own losses
 * with the last booked reason (trial finding #14), and any gap left to the
 * run count is a drop or unparseable output — figures the trial reads side
 * by side.
 */
const scanPart = (cost: SummarizerCost): string => {
  const stale =
    cost.staleSkipped === 0
      ? ""
      : ` (${String(cost.staleSkipped)} stale skipped)`;
  const unreadable =
    cost.parseFailures === 0
      ? ""
      : ` (${String(cost.parseFailures)} unreadable)`;
  return `${String(cost.filesRead)} of ${String(cost.filesSeen)} session state file${cost.filesSeen === 1 ? "" : "s"}${stale}${unreadable}`;
};

export const formatSummarizerCost = (cost: SummarizerCost): string => {
  if (cost.filesSeen === 0) {
    return "no live sessions";
  }
  if (cost.sessions === 0) {
    // Files exist but none of them belongs to a LIVE session of this repo —
    // which used to read "no live sessions" whether the directory was empty
    // or held a hundred corpses. The count is the difference.
    return `no live sessions — ${scanPart(cost)}`;
  }
  const draftsPart =
    cost.drafts === 1 ? "1 draft" : `${String(cost.drafts)} drafts`;
  const lastPart =
    cost.lastFailure === null ? "" : `: last "${cost.lastFailure}"`;
  const failsPart =
    cost.fails === 0 ? "" : `, ${String(cost.fails)} failed${lastPart}`;
  // Rejections read AFTER the failures and say why, because "2 refused" with
  // no reason is the number nobody can act on — and the reason is this
  // connector's own sentence, never the model's body.
  const rejectedReason =
    cost.lastRejection === null ? "" : `: last "${cost.lastRejection}"`;
  const rejectsPart =
    cost.rejects === 0
      ? ""
      : `, ${String(cost.rejects)} refused${rejectedReason}`;
  // Unreadable answers read INSIDE the run parentheses beside the refusals:
  // the model spoke and the quota was spent for both. What separates them is
  // that a refusal was well-formed and this was not, which is why the reason
  // is printed rather than left to the reader to guess.
  const unreadableReason =
    cost.lastUnreadable === null ? "" : `: last "${cost.lastUnreadable}"`;
  const unreadablePart =
    cost.unreadable === 0
      ? ""
      : `, ${String(cost.unreadable)} unreadable${unreadableReason}`;
  // The sliceless turns read LAST and outside the run parentheses, because
  // they are not runs: no model was spawned and no quota was spent.
  const noSliceReason =
    cost.lastNoSlice === null ? "" : `: ${cost.lastNoSlice}`;
  const noSlicePart =
    cost.noSlice === 0
      ? ""
      : `, ${String(cost.noSlice)} turn${cost.noSlice === 1 ? "" : "s"} with no slice${noSliceReason}`;
  return (
    `${String(cost.fires)} runs (${String(cost.nones)} NONE, ${draftsPart}${failsPart}${rejectsPart}${unreadablePart})${noSlicePart}, ` +
    `~${String(cost.estimatedTokens)} tokens (estimate) across ${scanPart(cost)}`
  );
};

/**
 * The finding-#14 signature: fires enough to mean it, and not ONE answered
 * — no NONE, no draft, and (since audit row A3-4) no refused answer either.
 * A refusal means the model SPOKE, so counting it as silence would send the
 * reader to the runner probe for a problem that is in the answers. Below
 * DOCTOR_SUMMARIZER_SILENT_FIRES_WARN a lost run is noise; from it on,
 * fail-open has become silently dead and doctor must say so (DESIGN.md §4:
 * "fail-open must never mean silently dead").
 */
export const isSummarizerSilentlyDead = (cost: SummarizerCost): boolean => {
  if (cost.fires < DOCTOR_SUMMARIZER_SILENT_FIRES_WARN) {
    return false;
  }
  // The FIRST signature keeps every way the model can have SPOKEN: a NONE, a
  // draft, a refused answer (audit A3-4) and — since the runner became
  // model-agnostic — an answer nobody could read. main's rewrite for the
  // second signature narrowed this to `nones + drafts`, which contradicts the
  // comment above it and would send a machine whose every answer was refused
  // to the runner probe, at a healthy binary.
  if (cost.nones + cost.drafts + cost.rejects + cost.unreadable === 0) {
    return true;
  }
  // The SECOND signature (trial finding M5). The original condition needs
  // every single answer to be missing, so a run where a handful answered and
  // the rest vanished read PASS — and "the rest" is the interesting half:
  // 21 of 27 fires on the trial machine were unexplained, booked as neither
  // NONE, draft, runner failure, refusal nor unreadable answer. When more
  // than half the fires end in that remainder, fail-open has become
  // mostly-dead, which is the state DESIGN.md §4 says must never be silent.
  //
  // Its own, higher floor (DOCTOR_SUMMARIZER_MOSTLY_DEAD_MIN_FIRES): a draft
  // dropped by the echo, secret or contract gates books nothing and is a
  // normal outcome, so at three fires two of them would be enough to fire
  // this on a healthy machine.
  if (cost.fires < DOCTOR_SUMMARIZER_MOSTLY_DEAD_MIN_FIRES) {
    return false;
  }
  // `rejects` and `unreadable` join the explained set for the same reason
  // they join the first signature: both are BOOKED outcomes of a fire, so a
  // machine full of them is not a machine whose fires vanished.
  const explained =
    cost.nones +
    cost.drafts +
    cost.fails +
    cost.rejects +
    cost.unreadable;
  return cost.fires - explained > cost.fires / 2;
};

/**
 * The other half of the same honesty rule (audit rows M16 / A3-4): the model
 * is answering, every answer is being refused, and nothing has landed. That
 * is a different remedy from a broken runner — a drifted prompt, a slice that
 * lost its ask, a model that role-plays — so it gets its own WARN with the
 * booked reason rather than being folded into "none answered".
 *
 * One refusal is ordinary: a session whose only draft echoed a teammate hint
 * is the echo guard working. From DOCTOR_SUMMARIZER_REJECTED_WARN on, with
 * nothing kept, the developer is paying for answers nobody uses.
 */
export const isSummarizerAlwaysRejected = (cost: SummarizerCost): boolean =>
  cost.rejects >= DOCTOR_SUMMARIZER_REJECTED_WARN && cost.drafts === 0;

/**
 * The third honesty rule on this line, and the one a foreign model reaches
 * first: the binary runs, exits 0 and SAYS something, and none of it fits the
 * output contract. That is neither a dead runner (the probe would PASS and
 * send the reader to a healthy binary) nor a refusal (those answers were
 * well-formed), so it gets its own WARN pointing at the model and at the
 * contract the model has to satisfy.
 *
 * `unreadable` is counted as SPEAKING by isSummarizerSilentlyDead above for
 * exactly that reason: once this is non-zero, "none answered" is the wrong
 * sentence and "the runner is broken" is the wrong remedy.
 *
 * One unreadable answer is ordinary — a model wanders off-format now and
 * then. From DOCTOR_SUMMARIZER_UNREADABLE_WARN on with nothing kept, the
 * developer is paying for answers nobody can use.
 */
export const isSummarizerUnreadable = (cost: SummarizerCost): boolean =>
  cost.unreadable >= DOCTOR_SUMMARIZER_UNREADABLE_WARN && cost.drafts === 0;
