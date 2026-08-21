/**
 * The ONE spelling of a session intent on every surface (trial finding #16):
 * `intent (derived): «sentence»` — the word, the trust label, the sentence
 * inside the « » frame. The briefing's context and presence lines, the
 * pointer/claim hints, the tripwire reason, the MCP diagnosis and search
 * lines and `crosscheck status` all compose their line from THIS fragment,
 * so there is exactly one place the label can be weakened or the frame lost
 * (scripts/mutation-check.ts re-breaks both).
 *
 * PROSE class, like a title: the sentence is teammate-declared or
 * model-derived text, sanitized through `sanitizeUntrusted` at
 * INTENT_MAX_CHARS and framed. The label is a renderer literal decided by
 * POSITIVE equality on "declared" — anything else, including an unknown
 * provenance from a newer or hostile hub, reads as derived (fail closed: a
 * machine guess must never pass for a person's statement). Confidence is
 * never printed for an intent; provenance is the whole trust label here.
 *
 * A render-layer module: registered in RENDER_LAYER_MODULES beside
 * sanitize.ts and render.ts, covered by the §4.4 registry corpus through
 * every surface that embeds it.
 */
import { INTENT_MAX_CHARS } from "../constants.ts";
import type { IntentEntry } from "../http/hub.ts";
import { sanitizeUntrusted } from "./sanitize.ts";

const DECLARED_PROVENANCE = "declared";

/** The label a derived (or unknown-provenance) intent carries on every surface. */
export const INTENT_DERIVED_LABEL = "(derived)";

export interface IntentLabel {
  /** The sanitized, bounded sentence — never empty. */
  readonly text: string;
  readonly derived: boolean;
}

/**
 * Null when there is no intent, or nothing survives the sanitizer — callers
 * render no line at all rather than an empty frame.
 */
export const formatIntentLabel = (
  intent: IntentEntry | null | undefined,
): IntentLabel | null => {
  if (intent === null || intent === undefined) {
    return null;
  }
  const text = sanitizeUntrusted(intent.summary, INTENT_MAX_CHARS);
  if (text.length === 0) {
    return null;
  }
  return { text, derived: intent.provenance !== DECLARED_PROVENANCE };
};

/** `intent (derived): «…»` / `intent: «…»` — one « » pair, renderer-owned. */
export const intentFragment = (label: IntentLabel): string =>
  `intent${label.derived ? ` ${INTENT_DERIVED_LABEL}` : ""}: «${label.text}»`;

/**
 * The fragment for a raw wire intent, or null: the shape every surface wants
 * (`formatIntentLabel` then `intentFragment`), in one call.
 */
export const renderIntent = (
  intent: IntentEntry | null | undefined,
): string | null => {
  const label = formatIntentLabel(intent);
  return label === null ? null : intentFragment(label);
};
