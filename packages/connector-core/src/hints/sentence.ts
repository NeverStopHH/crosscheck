/**
 * The first sentence of a teammate's claim body — the substance a prompt hint
 * carries (DESIGN.md §4, revised after the 2026-10 pilot). One sentence says
 * what the finding IS; the rest of the body, and the rest of the tree, stay
 * one get_diagnosis away.
 *
 * THE BOUNDARY IS UNICODE'S, NOT A LANGUAGE LIST: Intl.Segmenter applies
 * UAX #29 sentence rules, so "e.g." before a lowercase word, "v1.2.3" and
 * "src/auth/refresh.ts" do not end a sentence, a line break does, and a
 * German, Japanese or English body is cut the same way.
 *
 * A CUT, NEVER A CLEAN. This returns raw text; the caller frames it with the
 * BODY class (`quotedBody`), so the sanitizer runs AFTER the cut, on exactly
 * what is shown. Cutting first can only remove text — a suffix dropped
 * cannot open a frame or mint a field the sanitizer would have stopped.
 */
const SENTENCES = new Intl.Segmenter("und", { granularity: "sentence" });

/** The first non-blank sentence, trimmed; "" for a body with none. */
export const firstSentence = (body: string): string => {
  for (const { segment } of SENTENCES.segment(body)) {
    const sentence = segment.trim();
    if (sentence.length > 0) {
      return sentence;
    }
  }
  return "";
};
