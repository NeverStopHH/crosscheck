/**
 * The sentence a substance hint shows (DESIGN.md §4): the FIRST sentence of a
 * claim body that CARRIES CONTENT, or "" when none does — and then the hint
 * is a pointer, never a frame around "1.", "Yes.", "Bestätigt.", "See PR
 * #412." or a full stop behind three zero-width spaces (review of batch 1006,
 * finding 7).
 *
 * HERE, IN THE SHARED SCHEMA, so there is exactly one answer to "which
 * sentence is this hint": the connector shows it, the hub scores the claim's
 * relevance on it (server services/hints.ts), and a body whose shown sentence
 * shares nothing with the prompt cannot be lifted by a keyword-stuffed tail.
 *
 * THE BOUNDARY IS UNICODE'S: Intl.Segmenter applies UAX #29 sentence rules,
 * so "v1.2.3" and "src/auth/refresh.ts" never end a sentence and a line break
 * does. Two corrections ride on top, both of which UAX #29 leaves to its
 * caller:
 *   - an ORDINAL list marker ("1.", "2)") is the start of the sentence after
 *     it, not a sentence of its own;
 *   - an ABBREVIATION does not end a sentence: any run of single letters
 *     with dots ("z.", "B.", "e.g.", "i.e.", "d.h.", "u.a.") and the common
 *     German/English ones in ABBREVIATIONS. That is a list of abbreviations a
 *     sentence boundary must know, not a list of words a prompt may contain.
 *
 * CONTENT is SUBSTANCE_MIN_WORDS words of at least two letters each: a
 * one-word acknowledgement, a bare reference and punctuation around invisible
 * characters all fall short, in any language.
 *
 * A CUT, NEVER A CLEAN. This returns raw text; the connector frames it with
 * the BODY class (`quotedBody`), so the sanitizer runs AFTER the cut, on
 * exactly what is shown. Cutting first can only remove text — a suffix
 * dropped cannot open a frame or mint a field the sanitizer would have
 * stopped.
 */
import { isGermanPrompt, promptTokens } from "./prompt-terms.ts";
import { ENGLISH_STOP_WORDS, GERMAN_FUNCTION_WORDS } from "./stop-words.ts";
import { spanRedacted } from "./untrusted-text.ts";

const SENTENCES = new Intl.Segmenter("und", { granularity: "sentence" });

/**
 * CONTENT words a shown sentence needs: at least two letters each, and not a
 * function word of PostgreSQL's stop lists — the English one always, the
 * German one in a German sentence (stop-words.ts; review 1006b, L2). "Use
 * Redis here, it is the one." carries two.
 */
export const SUBSTANCE_MIN_WORDS = 3;

/**
 * The most of that sentence a hint shows — the connector frames it at this
 * width (HINT_SUBSTANCE_MAX_CHARS is this number), and the hub scores
 * relevance on no more than it, so words a reader would never see past the
 * ellipsis never make a claim relevant.
 */
export const SUBSTANCE_MAX_CHARS = 200;

/** Common German and English abbreviations whose dot does not end a sentence. */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  "approx",
  "bspw",
  "bzw",
  "ca",
  "cf",
  "dr",
  "etc",
  "evtl",
  "ggf",
  "incl",
  "inkl",
  "nr",
  "resp",
  "usw",
  "vgl",
  "vs",
]);

const SINGLE_LETTER_ABBREVIATION = /^(?:\p{L}\.)+$/u;
const ORDINAL_MARKER = /^\(?\d{1,3}[.)]$/u;

const lastToken = (text: string): string => text.trim().split(/\s+/u).at(-1) ?? "";

const endsInAbbreviation = (text: string): boolean => {
  const token = lastToken(text);
  return (
    SINGLE_LETTER_ABBREVIATION.test(token) ||
    (token.endsWith(".") && ABBREVIATIONS.has(token.slice(0, -1).toLowerCase()))
  );
};

/** A segment the segmenter ended too early — it belongs to the next one. */
const runsOn = (text: string): boolean =>
  ORDINAL_MARKER.test(text.trim()) || endsInAbbreviation(text);

/** The body's sentences, with the segmenter's early stops glued back on. */
const sentencesOf = (body: string): readonly string[] => {
  const glued = [...SENTENCES.segment(body)].reduce<{
    readonly done: readonly string[];
    readonly open: string;
  }>(
    (state, { segment }) => {
      const joined = state.open + segment;
      return runsOn(joined)
        ? { done: state.done, open: joined }
        : { done: [...state.done, joined], open: "" };
    },
    { done: [], open: "" },
  );
  return [...glued.done, glued.open].map((sentence) => sentence.trim());
};

/** Content words: two letters or more, and no function word of either stop list in force. */
const contentWords = (sentence: string): number => {
  const isGerman = isGermanPrompt(promptTokens(sentence));
  return sentence
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => (token.match(/\p{L}/gu)?.length ?? 0) >= 2)
    .filter((token) => !ENGLISH_STOP_WORDS.has(token) && !(isGerman && GERMAN_FUNCTION_WORDS.has(token))).length;
};

const ORDINAL_START = /^\(?\d{1,3}[.)]\s/u;

/** A short sentence after the chosen one qualifies it ("U.S. traffic only.") — never the next list item. */
const isQualifier = (sentence: string): boolean =>
  sentence.length > 0 && contentWords(sentence) < SUBSTANCE_MIN_WORDS && !ORDINAL_START.test(sentence);

/** A sentence that introduces what follows ("… three causes:") never stands alone. */
const isLeadIn = (sentence: string): boolean => sentence.endsWith(":");

/**
 * The first sentence that carries content, with what it cannot be read
 * without (L2): a short qualifier after it stays attached, and a sentence
 * that introduces a list keeps the item after it — one sentence, never more.
 */
export const substanceSentence = (body: string): string => {
  const sentences = sentencesOf(body);
  const index = sentences.findIndex((sentence) => contentWords(sentence) >= SUBSTANCE_MIN_WORDS);
  const chosen = sentences[index];
  if (chosen === undefined) {
    return "";
  }
  const next = sentences[index + 1] ?? "";
  return next.length > 0 && (isLeadIn(chosen) || isQualifier(next)) ? `${chosen} ${next}` : chosen;
};

/**
 * EXACTLY WHAT A READER IS SHOWN of a claim (review 1006b, M4): the sentence
 * above, through the BODY class — NFKC, the invisibles and the renderer's
 * characters stripped, instruction-shaped spans redacted, cut at
 * SUBSTANCE_MAX_CHARS with the visible ellipsis. The connector frames this
 * text; the hub scores a claim's relevance on this text. A ligature counts as
 * the word it reads as, a redacted span counts for nothing, and a word past
 * the ellipsis is not there.
 */
export const shownSubstance = (body: string): string => {
  const sentence = substanceSentence(body);
  return sentence.length === 0 ? "" : spanRedacted(sentence, SUBSTANCE_MAX_CHARS);
};
