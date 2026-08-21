/**
 * The one cut every bounded untrusted string takes — UTF-16 code units, as
 * `String.prototype.slice` counts them, minus a lone high surrogate at the
 * edge. Every bound in this codebase is a code-unit bound (a title's
 * MAX_TITLE_CHARS, the booked summarizer failure's
 * SUMMARIZER_FAILURE_MAX_CHARS): what it protects is the SIZE of a field in
 * a state file or a briefing line, so the cap has to hold in code units, not
 * code points. A plain slice keeps the cap and can still leave half an
 * astral character at the cut — `"x".repeat(119) + "😀"` sliced to 120 ends
 * in U+D83D alone, which JSON.stringify escapes (the file still parses) and
 * every terminal prints as U+FFFD. Dropping that one unit costs one
 * character of budget and keeps the string well-formed.
 *
 * VERIFY: bun -e 'const {cutWellFormed: c} = await import("./packages/connector-core/src/briefing/cut.ts"); const a = c("x".repeat(119) + "😀😀", 120); const b = ("x".repeat(119) + "😀😀").slice(0, 120); console.log(a.length, a.isWellFormed(), b.length, b.isWellFormed(), c("😀😀", 4) === "😀😀", c("abc", 10) === "abc")'
 * PRINTS: 119 true 120 false true true
 */

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;

const endsInLoneHighSurrogate = (text: string): boolean => {
  const last = text.charCodeAt(text.length - 1);
  return last >= HIGH_SURROGATE_MIN && last <= HIGH_SURROGATE_MAX;
};

/**
 * `text` cut to at most `maxUnits` UTF-16 code units, never ending in the
 * first half of a surrogate pair. Text already within the bound comes back
 * as it is, lone surrogates inside it included — this is a cut, not a
 * repair.
 */
export const cutWellFormed = (text: string, maxUnits: number): string => {
  if (text.length <= maxUnits) {
    return text;
  }
  const cut = text.slice(0, Math.max(0, maxUnits));
  return endsInLoneHighSurrogate(cut) ? cut.slice(0, -1) : cut;
};
