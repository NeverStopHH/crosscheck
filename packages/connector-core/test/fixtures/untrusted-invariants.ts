/**
 * The character-level rules that hold for ANY text crosscheck injects into a
 * reader's agent context — the SessionStart briefing and the MCP tools alike.
 *
 * WHY THESE LIVE IN ONE FILE. Both surfaces put other developers' text into the
 * same reader's context, so "the MCP tools assert the same invariants as the
 * briefing" has to be a fact rather than a claim. Two copies of these classes
 * would be two things to weaken, and the weaker copy would be the one nobody
 * re-reads. injection-corpus.test.ts and mcp-injection.test.ts both import from
 * here, so a class narrowed for one is narrowed for both and both go red.
 *
 * DERIVED FROM UNICODE, NOT FROM THE SANITIZER.
 *
 * HISTORICAL, and not re-derivable from this tree. An earlier version of the
 * briefing's constant claimed to be stated independently so that "a test that
 * borrowed the implementation's own pattern would agree with it however it was
 * weakened". It was a character-for-character copy of the sanitizer's own
 * pattern — the two literals diffed clean — so it could not disagree with the
 * implementation about anything, including the invisible characters both of them
 * let through. Neither that constant nor the pattern it copied survives here, so
 * no command re-measures the overlap and no figure for it is quoted.
 *
 * What replaces it asks Unicode instead: is this character's general category
 * one of the classes an injected line may never carry? The runtime's own
 * character database answers, and the sanitizer has no say in it. Weakening the
 * implementation's class — dropping \p{Cf} from it — therefore turns these files
 * red, which ci.yml's mutation job re-proves on every pull request.
 */
import { expect } from "bun:test";

export const INVISIBLE_BY_CATEGORY = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * Zero-width, and invisible to the categories above because they are Mn: the
 * combining grapheme joiner, the variation selectors in both planes, and the
 * Mongolian free variation selectors.
 */
export const ZERO_WIDTH_MARKS = /[͏᠋-᠍᠏︀-️\u{E0100}-\u{E01EF}]/u;

/**
 * Plane 14, the special-purpose plane: every code point in it is
 * Default_Ignorable and none is assigned outside Cf and Mn.
 *
 * VERIFY: bun -e 'let n=0,a=0; for(let c=0xE0000;c<=0xE0FFF;c++){const s=String.fromCodePoint(c); if(!/\p{Default_Ignorable_Code_Point}/u.test(s)) n++; if(!/\p{Cn}/u.test(s) && !/\p{Cf}/u.test(s) && !/\p{Mn}/u.test(s)) a++;} console.log(n,a)'
 * PRINTS: 0 0
 *
 * This used to cite `default-ignorable-sweep.ts --verbose`, which CANNOT show
 * it: that script lists only the code points which still ALTER the rendered
 * output, and plane 14 is stripped in full, so its verbose output contains zero
 * lines mentioning any U+E0xxx code point. That half is pinned in
 * briefing/sanitize.ts, beside the range table it belongs to.
 *
 * The tag block at its start is a MIX: U+E0001 and U+E0020-U+E007F are Cf and so
 * the `\p{Cf}` class above already sees them, but U+E0000 and U+E0002-U+E001F
 * are Cn and it does not. Those Cn members are the only reason the sanitizer
 * spells the range out, and `tag-characters-unassigned` in the corpus is built
 * from them.
 */
export const PLANE_14 = /[\u{E0000}-\u{E0FFF}]/u;

/** Backtick, angle brackets, backslash: no renderer here ever emits one. */
export const RENDERER_OWNED = /[`<>\\]/;

export const countOf = (line: string, needle: string): number =>
  line.split(needle).length - 1;

/**
 * Characters no injected line may carry, whichever surface produced it.
 *
 * The frame check is the half that catches a LOST frame rather than a smuggled
 * character: "no unbalanced « »" alone is satisfied by having no « » at all, so
 * the positive line-shape assertions in each caller are what make it bite.
 */
export const assertUntrustedCharacters = (line: string, where: string): void => {
  expect(INVISIBLE_BY_CATEGORY.test(line), where).toBe(false);
  expect(ZERO_WIDTH_MARKS.test(line), where).toBe(false);
  expect(PLANE_14.test(line), where).toBe(false);
  expect(RENDERER_OWNED.test(line), where).toBe(false);
  // The frame is the renderer's: opened and closed exactly by it, never opened,
  // closed or nested by whoever wrote the text inside.
  expect(countOf(line, "«"), where).toBe(countOf(line, "»"));
  expect(countOf(line, "«"), where).toBeLessThanOrEqual(1);
};
