/**
 * A BARE SHELL COMMAND IS NO TASK (hold-out review round 5, M3): "bun test"
 * reached the CI-cache tree on "bun" and "test", and "bun test
 * packages/api/src/auth" the auth trees on the path. A binary from the list,
 * then only flags, paths and operation words, is content-free; a command
 * followed by what broke is a task.
 */
import { describe, expect, test } from "bun:test";

import { isContentFreePrompt, promptTerms } from "../src/prompt-terms.ts";
import { isBareShellCommand } from "../src/shell-command.ts";

describe("a bare shell command is content-free", () => {
  test.each([
    ["bun test"],
    ["bun test packages/api/src/auth"],
    ["npm run build"],
    ["pnpm lint --fix"],
    ["yarn test e2e/checkout.spec.ts"],
    ["git log -5"],
    ["!git status"],
    ["$ make test"],
    ["docker build -f docker/postgres/Dockerfile ."],
    ["kubectl logs -f deploy/api"],
    ["cargo test -- --nocapture"],
    ["go test ./..."],
    ["pytest tests/test_refresh.py -x"],
    ["uv run --frozen ./scripts/check.py"],
    ["bun test."],
  ])("%p", (prompt) => {
    // Arrange, Act
    const terms = promptTerms(prompt);

    // Assert — the verdict the hub and the connector both read
    expect(isBareShellCommand(prompt)).toBe(true);
    expect(terms.isContentFree).toBe(true);
    expect(isContentFreePrompt(prompt)).toBe(true);
  });
});

describe("a command with a task beside it is a task", () => {
  test.each([
    ["npm run build fails with ENOENT on the icons dir", "it says what broke"],
    ["bun test hangs on the websocket suite", "a symptom after the command"],
    ["git rebase main broke the lockfile", "a consequence after the command"],
    ["docker build fails on arm64", "a platform and a failure"],
    ["why does bun test take 3 minutes", "a question about the command"],
    ["make the checkout button green", "make as the English verb"],
    ["go to the settings page and fix the dark theme", "go as the English verb"],
    ["terraform plan", "a binary off the list"],
    ["npx prettier --check .", "a tool's name is no operation word (accepted: it reaches the hub)"],
  ])("%p — %s", (prompt) => {
    // Arrange, Act
    const isBare = isBareShellCommand(prompt);

    // Assert
    expect(isBare).toBe(false);
  });

  test("the task after a command stays a task to the verdict", () => {
    // Arrange, Act
    const terms = promptTerms("npm run build fails with ENOENT on the icons dir");

    // Assert
    expect(terms.isContentFree).toBe(false);
    expect(isContentFreePrompt("npm run build fails with ENOENT on the icons dir")).toBe(false);
    expect(terms.topical).toContain("icons");
  });
});
