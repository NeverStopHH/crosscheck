/**
 * Argument parsing for `crosscheck acp`. Refusal happens BEFORE any spawn —
 * nothing is running yet, so failing loud here can kill no session, and a
 * silently-ignored typo'd flag would be swallowed forever. Everything after
 * `--` belongs to the agent and is never interpreted.
 */
import { describe, expect, test } from "bun:test";

import { ACP_USAGE, isUsageError, parseAcpArgs } from "../src/cli.ts";

describe("parseAcpArgs", () => {
  test("parses the bare wrap: everything after -- is the agent command", () => {
    // Act
    const parsed = parseAcpArgs(["--", "gemini", "--experimental-acp"]);

    // Assert
    if (isUsageError(parsed)) throw new Error(parsed.error);
    expect(parsed.command).toEqual(["gemini", "--experimental-acp"]);
    expect(parsed.recordPath).toBeUndefined();
  });

  test("parses --record with its file path", () => {
    const parsed = parseAcpArgs(["--record", "/tmp/wire.ndjson", "--", "agent"]);

    if (isUsageError(parsed)) throw new Error(parsed.error);
    expect(parsed.recordPath).toBe("/tmp/wire.ndjson");
    expect(parsed.command).toEqual(["agent"]);
  });

  test("refuses a missing -- separator", () => {
    const parsed = parseAcpArgs(["gemini"]);

    expect(isUsageError(parsed)).toBe(true);
  });

  test("refuses an empty agent command after --", () => {
    const parsed = parseAcpArgs(["--"]);

    expect(isUsageError(parsed)).toBe(true);
  });

  test("refuses an unknown flag, naming it", () => {
    const parsed = parseAcpArgs(["--bogus", "--", "agent"]);

    if (!isUsageError(parsed)) throw new Error("expected a usage error");
    expect(parsed.error).toContain("--bogus");
  });

  test("refuses --record without a value", () => {
    const parsed = parseAcpArgs(["--record", "--", "agent"]);

    expect(isUsageError(parsed)).toBe(true);
  });

  test("flags after -- reach the agent verbatim, never the proxy", () => {
    const parsed = parseAcpArgs(["--", "agent", "--record", "x", "--bogus"]);

    if (isUsageError(parsed)) throw new Error(parsed.error);
    expect(parsed.command).toEqual(["agent", "--record", "x", "--bogus"]);
    expect(parsed.recordPath).toBeUndefined();
  });
});

describe("usage text", () => {
  test("names the command and the one flag it takes", () => {
    expect(ACP_USAGE).toContain("crosscheck acp");
    expect(ACP_USAGE).toContain("--record");
    expect(ACP_USAGE).toContain("--");
  });
});
