/**
 * The deterministic gate and the state transforms of the derived-intent
 * capture (trial finding #16) — the summarizer gate's little sibling. Nothing
 * here costs a token: the UserPromptSubmit hook asks `isSubstantivePrompt`,
 * books the fire under the state lock, and spawns the detached worker; the
 * worker books what came of it.
 */
import {
  HINT_MIN_TOKEN_CHARS,
  INTENT_MIN_PROMPT_CHARS,
  SUMMARIZER_FAILURE_MAX_CHARS,
} from "@crosscheck/connector-core/constants.ts";
import { cutWellFormed } from "@crosscheck/connector-core/briefing/cut.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";

/**
 * A bare acknowledgement is not a task: "yes", "ok go ahead", "continue.",
 * "thanks" — case-insensitive, a trailing full stop or bang allowed.
 */
const ACKNOWLEDGEMENT_PATTERN =
  /^(?:y|yes|yep|yeah|n|no|nope|ok|okay|sure|go|go ahead|continue|proceed|thanks?|thank you|done|fine|lgtm)[.!]?$/i;

/**
 * "Substantive": long enough to state a task (INTENT_MIN_PROMPT_CHARS), not
 * a slash command (`/clear`, `/model haiku`), not a bare yes/no, and carrying
 * at least one word of HINT_MIN_TOKEN_CHARS — the same meaning floor the
 * hint path applies. The cheapest possible check, because it runs on EVERY
 * prompt: the fire itself is exactly-once (gate.ts withIntentFire under the
 * lock), this only decides whether a prompt is worth that fire.
 */
export const isSubstantivePrompt = (prompt: string): boolean => {
  const trimmed = prompt.trim();
  if (trimmed.length < INTENT_MIN_PROMPT_CHARS) {
    return false;
  }
  if (trimmed.startsWith("/")) {
    return false;
  }
  if (ACKNOWLEDGEMENT_PATTERN.test(trimmed)) {
    return false;
  }
  return trimmed
    .split(/[^\p{L}\p{N}]+/u)
    .some((token) => token.length >= HINT_MIN_TOKEN_CHARS);
};

/** One fire, booked BEFORE the spawn (the Stop hook's ordering contract). */
export const withIntentFire = (state: SessionState): SessionState => ({
  ...state,
  intentFireCount: state.intentFireCount + 1,
});

/** The model answered NONE — an answer, not a failure. */
export const withIntentNone = (state: SessionState): SessionState => ({
  ...state,
  intentNoneCount: state.intentNoneCount + 1,
});

/** An intent record reached the spool — booked AFTER the append, never before. */
export const withIntentSet = (state: SessionState): SessionState => ({
  ...state,
  intentSetCount: state.intentSetCount + 1,
});

/**
 * A fire that landed neither: a runner loss (binary missing, exit, deadline
 * — runner.ts formatSummarizerFailure's line) or a drop the worker decided
 * (secret-like sentence, a delivered hint echoed, an empty answer, a state
 * file predating intent support) — the reason named, bounded by THIS writer
 * to SUMMARIZER_FAILURE_MAX_CHARS like its summarizer twin, so one chatty
 * binary can never grow the state file.
 */
export const withIntentFailure = (
  state: SessionState,
  detail: string,
): SessionState => ({
  ...state,
  intentFailCount: state.intentFailCount + 1,
  intentLastFailure: cutWellFormed(detail, SUMMARIZER_FAILURE_MAX_CHARS),
});
