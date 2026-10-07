/**
 * The deterministic gate and the state transforms of the derived-intent
 * capture (trial finding #16) — the summarizer gate's little sibling. Nothing
 * here costs a token: the UserPromptSubmit hook asks `isSubstantivePrompt`,
 * books the fire under the state lock, and spawns the detached worker; the
 * worker books what came of it.
 */
import {
  HINT_MIN_TOKEN_CHARS,
  INTENT_MAX_NONE_REFUNDS,
  INTENT_MIN_PROMPT_CHARS,
  INTENT_MIN_TOPICAL_WORDS,
  SUMMARIZER_FAILURE_MAX_CHARS,
} from "../../constants.ts";
import { classifyPrompt, promptTerms } from "@crosscheck/schema";
import type { ClassifiedPrompt } from "@crosscheck/schema";

import { cutWellFormed } from "../../briefing/cut.ts";
import type { SessionState } from "../../state/session-state.ts";

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

/**
 * What the session's ONE intent fire is spent on, or null (review 1006b, H2):
 * never a turn the harness wrote, never a prompt that carries no task, and
 * only the HUMAN text of a turn — the wrapper neither parks its words nor
 * lends its length to the floor. A notification as the first long turn used
 * to spend the fire and park "Monitor event: CI checks pass" as the intent.
 * A turn that is all harness has no human text, so it fails the length
 * floor below — `isHarnessTurn` is exactly that, and needs no second call.
 *
 * AND ONLY A TURN WITH A TOPIC (hold-out review round 3, H2): at least
 * INTENT_MIN_TOPICAL_WORDS words of no closed class, so a task made of the
 * session's machinery never parks a sentence the model can only answer with
 * machinery. That floor is the content-free rule too: a content-free prompt
 * is one whose every word is of a closed class, so it has no topical word.
 */
export const intentPromptFrom = (classified: ClassifiedPrompt): string | null => {
  const human = classified.human;
  // A PROMPT THAT CARRIES THE SESSION ON names the session's own work, not a
  // new task (round 4, H2; continuation.ts): "the checkout tests pass now,
  // carry on" would park a status report as the intent.
  if (!isSubstantivePrompt(human) || classified.terms.hasContinuation) {
    return null;
  }
  // UNCLASSED, not topical (round 4, M1): in a task a meta word is a topic
  // for the hint floor, but a turn of nothing but machinery still parks none.
  return classified.terms.unclassed.length >= INTENT_MIN_TOPICAL_WORDS ? human : null;
};

/** The same, for a caller that has not classified the prompt yet (the worker's re-read). */
export const intentPromptOf = (prompt: string): string | null => intentPromptFrom(classifyPrompt(prompt));

/**
 * A derived intent with a topic (round 3, H2): at least one of its content
 * words of no closed class. "Continue the session after the usage limit
 * reset" is all machinery, and such an intent pulled limit chatter onto an
 * intent-only tree on every teammate's prompt.
 */
export const hasTopic = (sentence: string): boolean => promptTerms(sentence).unclassed.length > 0;

/** One fire, booked BEFORE the spawn (the Stop hook's ordering contract). */
export const withIntentFire = (state: SessionState): SessionState => ({
  ...state,
  intentFireCount: state.intentFireCount + 1,
});

/** The model answered NONE — an answer, not a failure, and a fire given back (H2, below). */
export const withIntentNone = (state: SessionState): SessionState => ({
  ...state,
  intentNoneCount: state.intentNoneCount + 1,
});

/**
 * THE SESSION'S INTENT FIRE IS SPENT while its fires outnumber the ones a
 * NONE gave back (hold-out review round 4, H2): a NONE says the prompt named
 * no task, and the session's next prompt that does may still find its
 * intent — at most INTENT_MAX_NONE_REFUNDS times, so a session of status
 * reports costs at most that many model calls more. Derived from the
 * counters the state already keeps: every NONE answered a fire.
 */
export const isIntentFireSpent = (state: SessionState): boolean =>
  state.intentFireCount > Math.min(state.intentNoneCount, INTENT_MAX_NONE_REFUNDS);

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
