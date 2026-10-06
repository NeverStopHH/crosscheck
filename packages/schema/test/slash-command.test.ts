/**
 * A slash command is the developer typing to the harness (hold-out review,
 * H1 d): its name is never a task word, only its arguments are scored, an
 * argument that is itself a command is a command too, and a bare command is
 * content-free. Every registered shape carries a sample this test runs.
 */
import { describe, expect, test } from "bun:test";

import { SLASH_COMMAND_SHAPES, commandArguments } from "../src/slash-command.ts";
import { isContentFreePrompt, promptTerms } from "../src/prompt-terms.ts";

describe("the registered shapes", () => {
  test.each(SLASH_COMMAND_SHAPES.map((shape) => [shape.name, shape.sample, shape.arguments] as const))(
    "%p: %p scores only %p",
    (_, sample, expected) => {
      expect(commandArguments(sample)).toBe(expected);
    },
  );
});

describe("only a leading command is one", () => {
  test.each([
    ["/review the checkout flow", "the checkout flow"],
    ["  /compact", ""],
    ["/loop 5m /babysit-prs", ""],
    ["/loop 10m /babysit-prs", ""],
    ["/loop 90s check the deploy", "check the deploy"],
    ["/model haiku", "haiku"],
  ])("%p scores %p — a unit-number argument is the command's own (round 3, H1)", (prompt, expected) => {
    expect(commandArguments(prompt)).toBe(expected);
  });

  test.each([
    ["/repo/src/limiter.ts rejects the upload"],
    ["why does /health return 503"],
    ["the endpoint /api/users is slow"],
  ])("%p is a prompt, not a command", (prompt) => {
    expect(commandArguments(prompt)).toBe(prompt);
  });
});

describe("the classifier scores the arguments", () => {
  test.each([["/code-review"], ["/compact"], ["/walkthrough"], ["/loop 5m /babysit-prs"], ["/loop 10m /babysit-prs"]])(
    "a bare command %p is content-free",
    (prompt) => {
      expect(isContentFreePrompt(prompt)).toBe(true);
    },
  );

  test("a command's name is never a term; its arguments are", () => {
    expect(promptTerms("/code-review the checkout flow").content).toEqual(["checkout", "flow"]);
  });
});
