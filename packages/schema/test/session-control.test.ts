/**
 * A prompt made only of words that steer the SESSION — continue, resume,
 * limit, reset, please — carries no task (DESIGN.md §4), typos or not. Live
 * on 0.10.0: "mache weiter, limit zuruckgesetzt. bitte alles wiederuafnhemen"
 * pointed at an unrelated teammate tree. The words arrive here AFTER the
 * hub's two stop lists, so "weiter" and "alles" are already gone.
 */
import { describe, expect, test } from "bun:test";

import { isSessionControlOnly } from "../src/session-control.ts";

describe("a prompt of session-steering words only is content-free", () => {
  test.each([
    ["the live pilot prompt, typos included", ["mache", "limit", "zuruckgesetzt", "bitte", "wiederuafnhemen"]],
    ["the same with its umlaut", ["mache", "limit", "zurückgesetzt"]],
    ["an inserted letter in a longer word", ["macxhe", "limit", "zurukgsetz"]],
    ["English", ["please", "continue", "limit", "reset"]],
    ["an English transposition", ["contineu", "resume"]],
    ["a plural", ["limits", "resets"]],
    ["capitals", ["Weitermachen", "Bitte"]],
    ["a usage limit reset", ["usage", "limit", "reset", "continue"]],
  ])("%s", (_, words) => {
    expect(isSessionControlOnly(words)).toBe(true);
  });
});

describe("one task word makes it a prompt again", () => {
  test.each([
    ["a task word beside the control words", ["bitte", "limit", "upload", "robuster"]],
    ["rate limit headers", ["rate", "limit", "headers"]],
    ["a five-letter word one letter from a control word is not a typo of it", ["cache", "limit"]],
    ["process is not proceed", ["process"]],
    ["result is not resume", ["result"]],
    ["nothing at all is not a session command either", []],
  ])("%s", (_, words) => {
    expect(isSessionControlOnly(words)).toBe(false);
  });
});
