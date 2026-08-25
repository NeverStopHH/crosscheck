/**
 * How long a hub refusal may be — the WHOLE sentence, not the list inside it.
 *
 * Every connector quotes a hub message at `MAX_HUB_MESSAGE_CHARS` and drops
 * the rest (connector-core mcp/tools/shared.ts, mcp/render.ts), so a refusal
 * past that bound arrives with its tail missing. For most endpoints that costs
 * a rationale; for the search filters it costs the ADDRESSES and the CLOSEST
 * SPELLINGS — the half that makes the sentence a next step instead of a
 * complaint, and the entire reason those two refusals exist.
 *
 * The budget belongs here, above both filter modules, because both of them
 * echo the caller's own term back and neither can see the other's length: a
 * list budgeted on its own still overflows once a long term is echoed beside
 * it, which is exactly how the developer refusals came to be 267 characters.
 */

/**
 * Mirrors connector-core's `MAX_HUB_MESSAGE_CHARS`. Two constants rather than
 * an import: the hub does not depend on any connector package, and one hub
 * serves connectors of several versions at once — so this is the hub's own
 * promise about the sentences it sends, checked against the connector's bound
 * by the directive below rather than by a type.
 *
 * VERIFY: grep -c "MAX_HUB_MESSAGE_CHARS = 200" packages/connector-core/src/constants.ts
 * PRINTS: 1
 */
export const MAX_REFUSAL_CHARS = 200;

/**
 * The sentence AS THE READER WILL COUNT IT.
 *
 * The bound above is only kept if it is measured in the same unit the cut uses,
 * and it is not this side that cuts: a connector runs the message through
 * `sanitizeUntrusted`, whose first step is `.normalize("NFKC")`, and compares
 * the result against its own 200 (connector-core briefing/sanitize.ts). NFKC
 * NEVER SHRINKS and often grows — U+2026 becomes three dots, ﬁ becomes two
 * letters, U+FDFA becomes eighteen — so a sentence counted raw is counted in a
 * unit nobody downstream uses.
 *
 * Plain ASCII is enough to break it: the ellipsis this module inserts when it
 * cuts an echo costs one character here and three there, which turns a sentence
 * built to exactly 200 into 202 as read, and the reader loses the tail of the
 * only next step the refusal offers.
 *
 * NFKC alone rather than the connector's whole `cleanUntrusted`: the hub does
 * not depend on any connector package (see the note above), and the rest of that
 * pipeline only ever REMOVES characters — separators collapse, invisibles and
 * renderer-owned characters go — so normalizing is the upper bound on what the
 * reader counts, which is the safe side to be wrong on.
 *
 * That the reader's pipeline really starts with that fold is pinned the same
 * way the 200 above is — by grep across the package boundary, not by an import
 * this package is not allowed to have:
 *
 * VERIFY: grep -c 'normalize("NFKC")' packages/connector-core/src/briefing/sanitize.ts
 * PRINTS: 1
 *
 * and that the fold GROWS the one character this module inserts itself:
 *
 * VERIFY: bun -e 'const s="a…b";console.log(s.length, s.normalize("NFKC").length)'
 * PRINTS: 3 5
 */
export const asRendered = (sentence: string): string =>
  sentence.normalize("NFKC");

/**
 * Widest echo of the caller's own term, when the sentence has room for it —
 * counted, like everything else here, on the normalized form.
 */
export const MAX_ECHOED_TERM_CHARS = 80;

/**
 * Narrowest echo the shrinking below will go to. Not zero: a refusal that
 * never repeats the term cannot tell a caller which of several filters it is
 * about, and a term cut this short is still enough to recognise.
 */
export const MIN_ECHOED_TERM_CHARS = 24;

/**
 * The caller's own term, quoted, and marked when it was cut — the ellipsis is
 * load-bearing: without it a truncated echo reads as the whole term, and the
 * caller looks for a bug in a value they never sent.
 */
export const echoedTerm = (term: string, maxChars: number): string => {
  // Normalized BEFORE it is measured or cut, so `maxChars` characters of term
  // are `maxChars` characters to the reader too. Cutting first and normalizing
  // later is how one code point of a caller's term became eighteen on screen.
  const trimmed = asRendered(term).trim();
  return trimmed.length <= maxChars
    ? `"${trimmed}"`
    : `"${trimmed.slice(0, maxChars)}…"`;
};

/** Widest the LIST inside a refusal may be, when the sentence has room. */
export const MAX_LISTED_CHARS = 60;

/**
 * Builds a refusal that FITS, by giving back the caller's own term first.
 *
 * WHICH HALF LOSES CHARACTERS IS THE WHOLE DESIGN, and it is an order, not a
 * budget: the caller already knows what they typed, so the ECHO yields first,
 * all the way down to MIN_ECHOED_TERM_CHARS. Only if the sentence still does
 * not fit does the LIST give up room — because what the caller does not know
 * is how this hub spells the name or which addresses sit behind it, and that
 * is the half that turns the sentence into a next step.
 *
 * `build` takes both slots and is called until the sentence fits; each round
 * subtracts the exact overflow, so one is normally enough, and every round
 * strictly shrinks one knob, so it terminates whatever `build` does. Reaching
 * the end with both knobs spent means the FIXED text alone is too long — a
 * sentence this cannot rescue, which test/search-filters.test.ts fails on
 * rather than letting a connector quote half of it.
 */
export const fitRefusal = (
  build: (echo: string, listChars: number) => string,
  term: string,
): string => {
  let echoChars = MAX_ECHOED_TERM_CHARS;
  let listChars = MAX_LISTED_CHARS;
  let sentence = build(echoedTerm(term, echoChars), listChars);
  while (asRendered(sentence).length > MAX_REFUSAL_CHARS) {
    const over = asRendered(sentence).length - MAX_REFUSAL_CHARS;
    if (echoChars > MIN_ECHOED_TERM_CHARS) {
      echoChars = Math.max(MIN_ECHOED_TERM_CHARS, echoChars - over);
    } else if (listChars > 0) {
      listChars = Math.max(0, listChars - over);
    } else {
      return sentence;
    }
    sentence = build(echoedTerm(term, echoChars), listChars);
  }
  return sentence;
};
