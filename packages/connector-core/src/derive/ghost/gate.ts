/**
 * The state transforms of the gated ghost check (VISION.md §3) — the
 * derived-intent gate's little sibling (intent/gate.ts), and deliberately its
 * exact shape: the debt is claimed under the state lock, the fire is booked
 * BEFORE the model is spawned, and the worker books exactly one of the four
 * outcomes afterwards.
 *
 * THE ONE THING THAT IS NOT THE INTENT GATE'S SHAPE is `withGhostNoOverlap`.
 * A fire that lands nothing is a problem worth a doctor WARN; a deterministic
 * core that found NOBODY is the feature working as designed and costing zero
 * tokens, which is the spec's own rule for it. Counting the two together would
 * make a quiet repo look like a broken runner, so the fire is only booked once
 * a candidate exists and this outcome is booked instead when none does.
 */
import {
  GHOST_MAX_FIRES_PER_SESSION,
  SUMMARIZER_FAILURE_MAX_CHARS,
} from "../../constants.ts";
import { cutWellFormed } from "../../briefing/cut.ts";
import type { SessionState } from "../../state/session-state.ts";

/** Has this session still got its one ghost check? */
export const hasGhostAllowance = (state: SessionState): boolean =>
  state.ghostFireCount < GHOST_MAX_FIRES_PER_SESSION;

/**
 * Claim the DEBT: the flag that says an intent is waiting to be compared.
 * Returns null — declining the write — when there is nothing owed, which is
 * what makes two racing hooks spawn one worker between them rather than two.
 */
export const withGhostClaimed = (state: SessionState): SessionState | null =>
  state.ghostPending ? { ...state, ghostPending: false } : null;

/** One fire, booked BEFORE the spawn (record-then-spawn, the Stop hook's rule). */
export const withGhostFire = (state: SessionState): SessionState => ({
  ...state,
  ghostFireCount: state.ghostFireCount + 1,
});

/** The deterministic core found nobody — an ANSWER, and a free one. */
export const withGhostNoOverlap = (state: SessionState): SessionState => ({
  ...state,
  ghostNoOverlapCount: state.ghostNoOverlapCount + 1,
});

/**
 * The HUB could not answer the overlap query — an older hub without the route,
 * or an unreachable one. Booked here rather than as a failure, and the
 * distinction is the same one `withGhostNoOverlap` makes: a failure means
 * something on THIS machine lost a model call, and the remedy doctor prints
 * for one is the summarizer runner probe. A deployment state has exactly one
 * honest voice on `doctor` and it is the `plan overlap` line.
 */
export const withGhostNoHubAnswer = (state: SessionState): SessionState => ({
  ...state,
  ghostNoHubAnswerCount: state.ghostNoHubAnswerCount + 1,
});

/** The model saw the two plans and said they do not collide. */
export const withGhostNone = (state: SessionState): SessionState => ({
  ...state,
  ghostNoneCount: state.ghostNoneCount + 1,
});

/** A ghost draft reached the spool — booked AFTER the append, never before. */
export const withGhostDraft = (state: SessionState): SessionState => ({
  ...state,
  ghostDraftCount: state.ghostDraftCount + 1,
});

/**
 * A fire that landed neither: a runner loss (missing binary, exit, deadline)
 * or a drop the worker decided (a secret, an echo of what it was shown, an
 * empty answer, a contract failure). Bounded by THIS writer to
 * SUMMARIZER_FAILURE_MAX_CHARS like both its siblings, so one chatty binary
 * can never grow the state file.
 */
export const withGhostFailure = (
  state: SessionState,
  detail: string,
): SessionState => ({
  ...state,
  ghostFailCount: state.ghostFailCount + 1,
  ghostLastFailure: cutWellFormed(detail, SUMMARIZER_FAILURE_MAX_CHARS),
});
