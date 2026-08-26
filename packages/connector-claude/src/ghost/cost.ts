/**
 * Ghost-check cost and outcome, made visible (VISION.md §3; the finding-#14
 * lesson that a fire which lands nothing must be a number somebody can
 * explain) — the derived-intent cost module's shape, with ONE counter the
 * others do not have and one they do not need.
 *
 * `noOverlap` IS THE POINT OF THE LINE. This feature's bargain is that the
 * free half runs always and the paid half only when the free half found
 * somebody, so the number a reader most wants is how often the model was NOT
 * called. Folding it into "fires" would hide exactly the thing that makes the
 * feature affordable, and folding it into "failures" would make a quiet team
 * look like a broken runner.
 *
 * `notices` is the OTHER half of the same question: how often the free half
 * had something to say at all. A repo where notices are zero has no overlap
 * to check, which is why the doctor rule below never treats an unspent
 * allowance as a fault.
 *
 * No token estimate here, like the intent module and for the same reason: at
 * most one call per session (GHOST_MAX_FIRES_PER_SESSION), so the count IS
 * the spend indicator.
 */
import { DOCTOR_GHOST_SILENT_FIRES_WARN } from "@crosscheck/connector-core/constants.ts";
import { readLiveSessionStates } from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";

export interface GhostCost {
  /** Live sessions of this repo+hub that were counted. */
  readonly sessions: number;
  /** Deterministic overlap notices actually SHOWN to this reader. */
  readonly notices: number;
  /** Checks that reached the model — one per session at most. */
  readonly fires: number;
  /** Checks the deterministic core answered with nobody: no model, no cost. */
  readonly noOverlap: number;
  /**
   * Checks that never got an answer OUT OF THE HUB — a hub too old for
   * /api/ghost-checks, or an unreachable one. Its own number for the reason
   * `noOverlap` has one: nothing local failed, so this must not read as a
   * local failure. `doctor`'s `plan overlap` line is what says which of the
   * two it is.
   */
  readonly noHubAnswer: number;
  /** Fires the model answered NONE — two plans that do not collide. */
  readonly nones: number;
  /** Fires that put a derived draft on the spool. */
  readonly drafts: number;
  /**
   * Fires that landed neither: a runner loss, a hub that could not answer,
   * or a worker-side drop (a secret, an echo of what it was shown, an empty
   * answer, a contract failure) — with one booked reason, already sanitized
   * and bounded by the writer (ghost/gate.ts withGhostFailure).
   */
  readonly fails: number;
  readonly lastFailure: string | null;
}

const NO_COST: GhostCost = {
  sessions: 0,
  notices: 0,
  fires: 0,
  noOverlap: 0,
  noHubAnswer: 0,
  nones: 0,
  drafts: 0,
  fails: 0,
  lastFailure: null,
};

/** Sums states the caller already read — one scan for all three counters. */
export const summarizeGhostCost = (
  states: readonly SessionState[],
): GhostCost =>
  states.reduce<GhostCost>(
    (total, state) => ({
      sessions: total.sessions + 1,
      notices: total.notices + state.ghostNoticeCount,
      fires: total.fires + state.ghostFireCount,
      noOverlap: total.noOverlap + state.ghostNoOverlapCount,
      noHubAnswer: total.noHubAnswer + state.ghostNoHubAnswerCount,
      nones: total.nones + state.ghostNoneCount,
      drafts: total.drafts + state.ghostDraftCount,
      fails: total.fails + state.ghostFailCount,
      lastFailure: state.ghostLastFailure ?? total.lastFailure,
    }),
    NO_COST,
  );

/** Scan-and-sum, for a caller that wants only this one figure. */
export const readGhostCost = async (
  home: string,
  hubUrl: string,
  repoId: string,
): Promise<GhostCost> =>
  summarizeGhostCost(await readLiveSessionStates(home, hubUrl, repoId));

/** The one spelling of the ghost fact both CLI surfaces print. */
export const formatGhostCost = (cost: GhostCost): string => {
  if (cost.sessions === 0) {
    return "no live sessions";
  }
  const sessionsPart =
    cost.sessions === 1
      ? "1 live session"
      : `${String(cost.sessions)} live sessions`;
  const noticesPart =
    cost.notices === 1 ? "1 overlap notice shown" : `${String(cost.notices)} overlap notices shown`;
  // The free half first, because it is what a reader sees; the paid half in
  // brackets after it, with the not-called count named rather than implied.
  const firesPart = cost.fires === 1 ? "1 check" : `${String(cost.fires)} checks`;
  const lastPart = cost.lastFailure === null ? "" : `: last "${cost.lastFailure}"`;
  const failsPart =
    cost.fails === 0 ? "" : `, ${String(cost.fails)} failed${lastPart}`;
  // Named, never folded into the failures beside it: the reader has to be
  // able to tell "my hub is older than my connector" from "my model call
  // died", because the two have different remedies and only one of them is
  // on this machine.
  const noHubPart =
    cost.noHubAnswer === 0
      ? ""
      : `, ${String(cost.noHubAnswer)} not measured (the hub could not answer)`;
  return (
    `${noticesPart} · ${firesPart} ` +
    `(${String(cost.noOverlap)} skipped, nobody to compare; ${String(cost.nones)} NONE, ` +
    `${String(cost.drafts)} drafted${failsPart}${noHubPart}) across ${sessionsPart}`
  );
};

/**
 * Doctor's WARN rule, the intent capture's verbatim: any booked failure at
 * all, or DOCTOR_GHOST_SILENT_FIRES_WARN fires that landed neither a NONE nor
 * a draft. Never PASS-only (the finding-#14 lesson).
 *
 * WHAT IS DELIBERATELY NOT A WARNING, second entry: a hub that could not
 * answer the overlap query. `noHubAnswer` is deployment state, not a fault on
 * this machine, and warning on it made this line contradict the `plan overlap`
 * line two rows below — same condition, one WARN and one PASS — while sending
 * the reader to the summarizer runner probe, which is not the cause.
 *
 * WHAT IS DELIBERATELY NOT A WARNING: an unspent allowance. A session that
 * showed notices and never fired is the common shape of a one-prompt session
 * — the debt is booked by `set_intent` or by the derived-intent worker and
 * paid by the NEXT prompt hook, so a session that ends first simply never
 * spends it. Warning on that would cry wolf on the most ordinary session
 * there is, and the failure it would be aiming at (a runner that cannot run)
 * is already caught by the summarizer runner probe one check away.
 */
export const isGhostSilentlyDead = (cost: GhostCost): boolean =>
  cost.fails > 0 ||
  (cost.fires >= DOCTOR_GHOST_SILENT_FIRES_WARN && cost.nones + cost.drafts === 0);
