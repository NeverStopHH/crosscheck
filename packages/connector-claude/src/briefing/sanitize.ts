import { MAX_TITLE_CHARS } from "../constants.ts";

export const REDACTED_TITLE = "[redacted: title looked like an instruction]";

/** C0/C1 controls plus bidi and zero-width chars: invisible to a human reviewer. */
const INVISIBLE_PATTERN = new RegExp(
  "[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]",
  "g",
);

/** Quote-frame and markup characters the renderer owns, never the author. */
const STRUCTURAL_PATTERN = /[`<>«»\\]/g;

/**
 * Opportunistic defence-in-depth, not a guarantee. The primary defence is
 * structural and sits above and around this list: NFKC normalization, control /
 * bidi / zero-width stripping, removal of the characters the renderer owns, the
 * length cap, the « » quote frame, and the briefing header that states the
 * quoted text is data rather than instruction. This literal-phrase list only
 * catches the blunt attempts — "forget everything above" walks straight past
 * it, and trying to complete the list is not a winnable game.
 */
const INJECTION_PATTERN =
  /(ignore (all |the )?(previous|above)|disregard|system prompt|system-reminder|new instructions?|you (must|should|are required)|act as|override|do not tell)/i;

const ELLIPSIS = "…";

/**
 * Renders untrusted, teammate- or LLM-authored text safe for injection into the
 * reader's context. Returns "" when nothing survives — callers skip the item.
 */
export const sanitizeUntrusted = (
  raw: string,
  maxChars: number = MAX_TITLE_CHARS,
): string => {
  const cleaned = raw
    .normalize("NFKC")
    .replace(INVISIBLE_PATTERN, " ")
    .replace(STRUCTURAL_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) {
    return "";
  }
  if (INJECTION_PATTERN.test(cleaned)) {
    return REDACTED_TITLE;
  }
  if (cleaned.length <= maxChars) {
    return cleaned;
  }
  return `${cleaned.slice(0, maxChars - ELLIPSIS.length)}${ELLIPSIS}`;
};
