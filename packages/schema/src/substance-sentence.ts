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
const SENTENCES = new Intl.Segmenter("und", { granularity: "sentence" });

/** Words a shown sentence needs, each of at least two letters. */
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

/** Words of at least two letters — what "carries content" is counted in. */
const contentWords = (sentence: string): number =>
  sentence
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => (token.match(/\p{L}/gu)?.length ?? 0) >= 2).length;

export const substanceSentence = (body: string): string =>
  sentencesOf(body).find((sentence) => contentWords(sentence) >= SUBSTANCE_MIN_WORDS) ?? "";
