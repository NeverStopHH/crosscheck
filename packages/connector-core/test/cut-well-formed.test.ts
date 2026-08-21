/**
 * The bounded cut is a CODE-UNIT cut that never leaves half an astral
 * character behind (briefing/cut.ts). Before it existed, every bound in the
 * tree was a bare `slice(0, n)`: the sanitizer's ellipsis cut and the
 * summarizer's booked failure line could both end in a lone high surrogate —
 * the state file still parsed (JSON escapes it), the terminal printed U+FFFD,
 * and the comment on formatSummarizerFailure claimed a cut that "could not
 * split a character". Pinned here for the helper and for the sanitizer; the
 * summarizer side is pinned in connector-claude/test/summarizer-failure-telemetry.test.ts.
 */
import { describe, expect, test } from "bun:test";

import { MAX_TITLE_CHARS } from "../src/constants.ts";
import { cutWellFormed } from "../src/briefing/cut.ts";
import { bareUntrusted, sanitizeUntrusted } from "../src/briefing/sanitize.ts";

const EMOJI = "😀";

describe("cutWellFormed (code-unit bound, surrogate-safe edge)", () => {
  test("text within the bound is returned unchanged", () => {
    expect(cutWellFormed("abc", 10)).toBe("abc");
    expect(cutWellFormed(EMOJI + EMOJI, 4)).toBe(EMOJI + EMOJI);
    expect(cutWellFormed("", 0)).toBe("");
  });

  test("a cut that lands between the halves of a pair drops the lone high surrogate", () => {
    // Arrange: 119 BMP units, then a pair at units 119-120 — slice(0, 120) splits it.
    const text = "x".repeat(119) + EMOJI + EMOJI;

    // Act
    const cut = cutWellFormed(text, 120);

    // Assert: one unit under the bound, and well-formed
    expect(cut.length).toBe(119);
    expect(cut.isWellFormed()).toBe(true);
    expect(text.slice(0, 120).isWellFormed()).toBe(false);
  });

  test("a cut that lands on a pair boundary keeps the whole pair and the full bound", () => {
    const text = "x".repeat(118) + EMOJI + EMOJI;
    const cut = cutWellFormed(text, 120);
    expect(cut.length).toBe(120);
    expect(cut.endsWith(EMOJI)).toBe(true);
    expect(cut.isWellFormed()).toBe(true);
  });

  test("never exceeds the bound, for any bound", () => {
    const text = EMOJI.repeat(40);
    for (let bound = 0; bound <= text.length + 2; bound += 1) {
      const cut = cutWellFormed(text, bound);
      expect(cut.length).toBeLessThanOrEqual(bound);
      expect(cut.isWellFormed()).toBe(true);
    }
  });
});

describe("the sanitizer's ellipsis cut is the same cut", () => {
  test("a title whose cut would split a pair loses the half, keeps the ellipsis, stays within the bound", () => {
    // Arrange: the cut point is maxChars - 1 (room for the ellipsis); put a
    // pair exactly across it.
    const cutAt = MAX_TITLE_CHARS - 1;
    const title = "x".repeat(cutAt - 1) + EMOJI + EMOJI + EMOJI;

    // Act
    const shown = sanitizeUntrusted(title);
    const bare = bareUntrusted(title);

    // Assert
    expect(shown.isWellFormed()).toBe(true);
    expect(shown.endsWith("…")).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(shown).toBe("x".repeat(cutAt - 1) + "…");
    expect(bare.isWellFormed()).toBe(true);
  });

  test("a title that fits is untouched, astral characters included", () => {
    expect(sanitizeUntrusted("ship it " + EMOJI)).toBe("ship it " + EMOJI);
  });
});
