/**
 * Presentation helpers for the /ui pages. Escaping is NOT done here — the
 * hono/jsx renderer escapes every interpolated string by construction — this
 * file only caps lengths (task item 4, mirroring the MCP renderer's cap
 * discipline) and words ages.
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** Human age, coarse on purpose — the feed is a timeline, not a stopwatch. */
export const formatUiAge = (ageMs: number): string => {
  if (ageMs < MS_PER_MINUTE) {
    return "just now";
  }
  if (ageMs < MS_PER_HOUR) {
    return `${String(Math.floor(ageMs / MS_PER_MINUTE))}m ago`;
  }
  if (ageMs < MS_PER_DAY) {
    return `${String(Math.floor(ageMs / MS_PER_HOUR))}h ago`;
  }
  return `${String(Math.floor(ageMs / MS_PER_DAY))}d ago`;
};

const ELLIPSIS = "…";

/**
 * Length cap for untrusted text. The JSX renderer escapes what remains; the
 * cap only stops one hostile record from swallowing the page. Slicing a
 * surrogate pair in half is harmless here — the escaper still escapes it.
 */
export const capped = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars)}${ELLIPSIS}`;

/**
 * Every character that acts instead of showing: bidi overrides, isolates and
 * marks, zero-width and other format characters, C0/C1 controls, and the
 * line and paragraph separators.
 */
const ACTING_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const HEX = 16;
const CODE_POINT_DIGITS = 4;

const codePointLabel = (character: string): string =>
  `⟨U+${(character.codePointAt(0) ?? 0).toString(HEX).toUpperCase().padStart(CODE_POINT_DIGITS, "0")}⟩`;

/**
 * Text on a page that says "exactly what your passkey signs" (round-1 review
 * L4): capped like any untrusted text, and every acting character shown as
 * its code point. Removing them would make the page differ from the signed
 * bytes; leaving them would let a right-to-left override reverse what the
 * person reads, or a separator forge a line beside the real word.
 */
export const shownAsSigned = (value: string, maxChars: number): string =>
  capped(value, maxChars).replace(ACTING_CHARACTER, codePointLabel);

/** href for a work-context page; the id is percent-encoded, never trusted. */
export const workContextHref = (workContextId: string): string =>
  `/ui/work-contexts/${encodeURIComponent(workContextId)}`;

/** href for a referee case-file page. */
export const contradictionHref = (contradictionId: string): string =>
  `/ui/contradictions/${encodeURIComponent(contradictionId)}`;

/** A work-context intent as the UI shows it: the sentence and its trust label. */
export interface UiIntent {
  readonly summary: string;
  /** "(derived)" for anything not declared — fail closed, like every renderer. */
  readonly label: string;
}

const DECLARED = "declared";

/**
 * The intent jsonb (services/diagnosis.ts, presence.ts) reduced to what a
 * page prints: null when there is no usable summary. Provenance is labelled
 * by positive equality on "declared"; an unknown or missing provenance reads
 * as derived, never as vouched.
 */
export const uiIntentOf = (
  intent: Record<string, unknown> | null | undefined,
): UiIntent | null => {
  const summary = intent?.["summary"];
  if (typeof summary !== "string" || summary.length === 0) {
    return null;
  }
  return {
    summary,
    label: intent?.["provenance"] === DECLARED ? "intent" : "intent (derived)",
  };
};
