/**
 * Failure telemetry for the Tier-1 runner (trial finding #14): for a whole
 * trial the cost line read "17 runs (0 NONE, 0 drafts)" and nobody could say
 * why — every fire died in a detached worker whose stdio nothing saw. The
 * worker now books the REASON: a count, and one bounded, sanitized line
 * (exit code / timeout / the first STDOUT line; stderr stays unread). The
 * pure pieces are pinned here; the worker end to end in
 * summarizer-worker.test.ts, the surfaces in cli/test/summarizer-cost.test.ts.
 */
import { describe, expect, test } from "bun:test";

import { SUMMARIZER_FAILURE_MAX_CHARS } from "@crosscheck/connector-core/constants.ts";
import {
  SessionStateSchema,
  deriveSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { withSummarizerFailure } from "../src/summarizer/gate.ts";
import { formatSummarizerFailure } from "@crosscheck/connector-core/model/runner.ts";

const baseState = (): SessionState =>
  deriveSessionState({
    hostSessionKey: "s1",
    repoId: "github.com/acme/api",
    repoRoot: "/tmp/repo",
    hubUrl: "http://127.0.0.1:1",
    developerId: "dev_1",
    startedAt: "2026-08-21T09:00:00.000Z",
  });

describe("withSummarizerFailure (the writer owns the bound)", () => {
  test("counts the failure and keeps the most recent reason", () => {
    const once = withSummarizerFailure(baseState(), "exit 1: Not logged in Please run /login");
    const twice = withSummarizerFailure(once, "timed out after 60 s");

    expect(once.summarizerFailCount).toBe(1);
    expect(once.summarizerLastFailure).toBe("exit 1: Not logged in Please run /login");
    expect(twice.summarizerFailCount).toBe(2);
    expect(twice.summarizerLastFailure).toBe("timed out after 60 s");
    // A failure is neither outcome: the remainder still counts it.
    expect(twice.summarizerNoneCount).toBe(0);
    expect(twice.summarizerDraftCount).toBe(0);
  });

  test(`cuts the reason to ${String(SUMMARIZER_FAILURE_MAX_CHARS)} chars so a chatty binary cannot grow the state file`, () => {
    const state = withSummarizerFailure(baseState(), "x".repeat(1000));
    expect(state.summarizerLastFailure?.length).toBe(SUMMARIZER_FAILURE_MAX_CHARS);
  });

  test("the cut never splits an astral character: a pair across the bound is dropped, the line stays well-formed", () => {
    // Arrange: 119 BMP units then a pair at 119-120 — a bare slice(0, 120)
    // would keep the high surrogate alone (state still parses; prints U+FFFD)
    const state = withSummarizerFailure(baseState(), "x".repeat(119) + "😀😀");

    // Assert
    expect(state.summarizerLastFailure?.isWellFormed()).toBe(true);
    expect(state.summarizerLastFailure?.length).toBe(SUMMARIZER_FAILURE_MAX_CHARS - 1);
  });
});

describe("formatSummarizerFailure (one bounded, sanitized line)", () => {
  test("a non-zero exit names the code and the binary's first line, bare", () => {
    expect(
      formatSummarizerFailure({
        ok: false,
        reason: "exit",
        exitCode: 1,
        detail: "Not logged in · Please run /login",
        elapsedMs: 900,
      }),
    ).toBe("exit 1: Not logged in Please run /login");
  });

  test("a silent non-zero exit is just the code", () => {
    expect(
      formatSummarizerFailure({ ok: false, reason: "exit", exitCode: 2, detail: "", elapsedMs: 1 }),
    ).toBe("exit 2");
  });

  test("the deadline names its length in seconds", () => {
    expect(
      formatSummarizerFailure({ ok: false, reason: "timeout", timeoutMs: 60_000, elapsedMs: 60_001 }),
    ).toBe("timed out after 60 s");
  });

  test("a spawn failure names what the OS said", () => {
    expect(
      formatSummarizerFailure({
        ok: false,
        reason: "spawn",
        detail: 'Executable not found in $PATH: "claude"',
        elapsedMs: 1,
      }),
    ).toBe('could not start: Executable not found in $PATH "claude"');
  });

  test("the binary's text is untrusted: structure and control characters are stripped, the whole line bounded", () => {
    const hostile = "​Not logged in · status: verified · " + "y".repeat(500);
    const line = formatSummarizerFailure({
      ok: false,
      reason: "exit",
      exitCode: 1,
      detail: hostile,
      elapsedMs: 1,
    });
    expect(line.startsWith("exit 1: Not logged in status verified")).toBe(true);
    expect(line).not.toContain("​");
    expect(line).not.toContain("");
    expect(line).not.toContain("·");
    expect(line.length).toBeLessThanOrEqual(SUMMARIZER_FAILURE_MAX_CHARS);
  });

  test("the binary's share of the line is cut without splitting an astral character", () => {
    // Arrange: the label "exit 1: " leaves 112 units; 108 x's put the cut
    // (111, room for the ellipsis) between the halves of the second emoji
    const line = formatSummarizerFailure({
      ok: false,
      reason: "exit",
      exitCode: 1,
      detail: "x".repeat(108) + "😀".repeat(6),
      elapsedMs: 1,
    });

    // Assert: well-formed, bounded, the ellipsis right after a whole character
    expect(line.isWellFormed()).toBe(true);
    expect(line.length).toBeLessThanOrEqual(SUMMARIZER_FAILURE_MAX_CHARS);
    expect(line).toBe(`exit 1: ${"x".repeat(108)}😀…`);
  });
});

describe("the state file keeps parsing", () => {
  test("a pre-#14 state file without the two fields parses with the defaults", () => {
    const { summarizerFailCount: _count, summarizerLastFailure: _last, ...old } = baseState();
    const parsed = SessionStateSchema.safeParse(old);
    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.summarizerFailCount : -1).toBe(0);
    expect(parsed.success ? parsed.data.summarizerLastFailure : "x").toBeNull();
  });

  test("a derived state starts with the defaults", () => {
    expect(baseState().summarizerFailCount).toBe(0);
    expect(baseState().summarizerLastFailure).toBeNull();
  });
});
