/**
 * The deterministic gate in front of the Tier-1 summarizer (DESIGN.md §3
 * Tier 1). Everything here is decided BEFORE any LLM cost exists: cheap
 * regexes over the turn's transcript slice, a turn debounce, and the hard
 * per-session fire cap. The Stop hook runs these and either spawns the
 * detached worker or does nothing — it never waits on a model.
 *
 * THE FIRE CONDITION IS A CONJUNCTION, deliberately: an evidence signal (a
 * test command ran, or error output is present) AND hypothesis language.
 * Hypothesis language alone fires on planning chatter; an error alone fires
 * on every failing build with nothing diagnosed yet. Both misfires spend the
 * developer's own quota (§10 risk 7) and fill the hub with junk drafts
 * (§10 risk 4), so precision beats recall on every doubt.
 */
import {
  SUMMARIZER_DEBOUNCE_TURNS,
  SUMMARIZER_MAX_FIRES_PER_SESSION,
} from "../constants.ts";
import type { SessionState } from "../state/session-state.ts";

/**
 * A test runner invoked as a command. Anchored to a word boundary on both
 * sides so "we should test this later" and `ls contest/` do not count; the
 * runner name must be followed by a test-ish argument or subcommand.
 */
const TEST_COMMAND_PATTERN =
  /(?:^|[\s;&|(])(?:(?:bun|npm|pnpm|yarn|npx)\s+(?:run\s+)?test|(?:go|cargo)\s+test|pytest|vitest|jest|rspec|phpunit|tox)(?:$|[\s.:/])/m;

/**
 * Error markers the way tools actually print them. `\w*error` covers the
 * class-name form (TypeError, AssertionError) the plain word boundary missed.
 */
const ERROR_OUTPUT_PATTERN =
  /\b(?:\w*error|\w*exception|traceback|panic|segfault|stack trace)\b|\b(?:\d+\s+)?(?:tests?\s+)?fail(?:ed|ure|ures)?\b|\(fail\)/i;

/** Diagnosis prose: someone is asserting a cause, not narrating an edit. */
const HYPOTHESIS_PATTERN =
  /\b(?:root cause|hypothes[ie]s|likely (?:cause|culprit|because)|i suspect|suspect(?:s|ed)? (?:that|the)|caused by|because (?:the|it|of)|the (?:bug|problem|issue|culprit|defect) (?:is|was|seems|turns out)|turns out|traced (?:it|this|the|back) to|due to (?:a|the))\b/i;

export const hasTestCommand = (text: string): boolean =>
  TEST_COMMAND_PATTERN.test(text);

export const hasErrorOutput = (text: string): boolean =>
  ERROR_OUTPUT_PATTERN.test(text);

export const hasHypothesisLanguage = (text: string): boolean =>
  HYPOTHESIS_PATTERN.test(text);

/** The gate's content decision: evidence signal AND hypothesis language. */
export const isDiagnosisMoment = (sliceText: string): boolean =>
  (hasTestCommand(sliceText) || hasErrorOutput(sliceText)) &&
  hasHypothesisLanguage(sliceText);

/**
 * The gate's budget decision, on the state AFTER this turn was counted:
 * under the hard cap, and at least SUMMARIZER_DEBOUNCE_TURNS Stop turns
 * since the last fire. Pure arithmetic — scripts/mutation-check.ts re-breaks
 * the cap and test/stop-gate.test.ts must go red.
 */
export const summarizerFireAllowed = (state: SessionState): boolean => {
  if (state.summarizerFireCount >= SUMMARIZER_MAX_FIRES_PER_SESSION) {
    return false;
  }
  return (
    state.summarizerLastFireTurn === null ||
    state.stopTurnCount - state.summarizerLastFireTurn >=
      SUMMARIZER_DEBOUNCE_TURNS
  );
};

/** Every Stop invocation counts one turn — fires or not. */
export const withStopTurn = (state: SessionState): SessionState => ({
  ...state,
  stopTurnCount: state.stopTurnCount + 1,
});

/**
 * One fire, recorded against the CURRENT turn: count, debounce anchor, and
 * the token estimate the cost surfaces sum (§10 risk 7 — estimates, and
 * marked as such wherever they are printed).
 */
export const withSummarizerFire = (
  state: SessionState,
  estimatedTokens: number,
): SessionState => ({
  ...state,
  summarizerFireCount: state.summarizerFireCount + 1,
  summarizerLastFireTurn: state.stopTurnCount,
  summarizerEstimatedTokens:
    state.summarizerEstimatedTokens + Math.max(0, estimatedTokens),
});
