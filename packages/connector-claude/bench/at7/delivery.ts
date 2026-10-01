/**
 * Delivery as RENDERED (Amendment A1.2). §5 condition 2 and §7 are met only
 * when the SessionStart briefing contains `asks: «R»`, where R is dana's
 * question body after the connector's OWN question sanitizer — the exact call
 * briefing/questions.ts makes. A token match alone is not delivery; the same
 * check applies to the control note.
 *
 * Importing the real sanitizer (not a copy) is the point: a re-typed pipeline
 * would agree with itself however the connector changed.
 */
import { MAX_QUESTION_BODY_LENGTH } from "@crosscheck/schema";
import { spanRedactedUntrusted } from "@crosscheck/connector-core/briefing/sanitize.ts";

/** The question body exactly as the reader's briefing renders it. */
export const renderedQuestionBody = (body: string): string =>
  spanRedactedUntrusted(body, MAX_QUESTION_BODY_LENGTH);

/** The briefing line that proves delivery: `asks: «<rendered body>»`. */
export const renderedAsksLine = (body: string): string =>
  `asks: «${renderedQuestionBody(body)}»`;
