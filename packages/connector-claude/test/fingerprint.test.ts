import { describe, expect, test } from "bun:test";

import {
  extractFailureText,
  fingerprint,
  isFailureResponse,
} from "../src/index.ts";

const ESCAPE = String.fromCharCode(27);

const failureAt = (cwd: string, timestamp: string, pid: number): string =>
  [
    `${timestamp} ERROR test run failed (pid ${pid})`,
    `  at Object.<anonymous> (${cwd}/src/auth/token.ts:42:17)`,
    "  TypeError: cannot read property 'sub' of undefined",
    `  at verifyToken (${cwd}/src/auth/verify.ts:88:3)`,
  ].join("\n");

describe("fingerprint", () => {
  test("hashes the same failure identically across cwd, timestamp and pid", () => {
    // Arrange
    const first = failureAt(
      "/Users/alice/work/api",
      "2026-07-24T09:00:00.000Z",
      4711,
    );
    const second = failureAt(
      "/home/bob/src/api",
      "2026-07-26T18:31:02.512Z",
      92183,
    );

    // Act
    const firstHash = fingerprint(first);
    const secondHash = fingerprint(second);

    // Assert
    expect(firstHash).not.toBeNull();
    expect(firstHash).toBe(secondHash as string);
  });

  test("gives different failures different hashes", () => {
    // Arrange
    const failing = failureAt("/tmp/a", "2026-07-24T09:00:00.000Z", 10);
    const other =
      "AssertionError: expected 3 received 4 in the active-seat aggregate rollup";

    // Act & Assert
    expect(fingerprint(failing)).not.toBe(fingerprint(other) as string);
  });

  test("returns null when the output carries no signal", () => {
    expect(fingerprint("exit 1")).toBeNull();
  });

  test("returns null when the output carries a secret", () => {
    // Arrange
    const withSecret = `${failureAt("/tmp/a", "2026-07-24T09:00:00.000Z", 10)}\nAKIAIOSFODNN7EXAMPLE`;

    // Act & Assert
    expect(fingerprint(withSecret)).toBeNull();
  });

  test("strips ansi escapes so coloured and plain output agree", () => {
    // Arrange
    const plain = failureAt("/tmp/a", "2026-07-24T09:00:00.000Z", 10);
    const coloured = plain.replace(
      "ERROR",
      `${ESCAPE}[31mERROR${ESCAPE}[0m`,
    );

    // Act & Assert
    expect(fingerprint(coloured)).toBe(fingerprint(plain) as string);
  });
});

describe("isFailureResponse", () => {
  test("detects is_error, isError, non-zero exit codes and success false", () => {
    expect(isFailureResponse({ is_error: true })).toBe(true);
    expect(isFailureResponse({ isError: true })).toBe(true);
    expect(isFailureResponse({ exit_code: 2 })).toBe(true);
    expect(isFailureResponse({ exitCode: 127 })).toBe(true);
    expect(isFailureResponse({ success: false })).toBe(true);
  });

  /**
   * The hooks reference, on `PostToolUseFailure.is_interrupt`: "Cancelling a
   * running tool does not fire this hook; the tool result carries the
   * interruption message instead" — so an ABORT reaches this connector HERE,
   * on the success event, and the failure hook's `is_interrupt` guard is on a
   * door aborts do not use. `interrupted` is a documented field of the Bash
   * tool's output shape (the `updatedToolOutput` example), which is why it is
   * the marker read.
   */
  test("an abort is not a failure, whatever else the result carries", () => {
    expect(isFailureResponse({ interrupted: true })).toBe(false);
    // The abort marker outranks every error marker in the same record: a
    // cancelled command can still report a non-zero exit, and "the developer
    // pressed escape" is text every session produces — the one input that
    // would fill the fingerprint index, which is the only signal collective
    // memory treats as content identity across repos.
    expect(isFailureResponse({ interrupted: true, is_error: true })).toBe(false);
    expect(isFailureResponse({ interrupted: true, exitCode: 130 })).toBe(false);
    // …and it is the marker that decides, not the field being present.
    expect(isFailureResponse({ interrupted: false, is_error: true })).toBe(true);
  });

  test("treats a missing failure marker as success", () => {
    expect(isFailureResponse({ stdout: "ok" })).toBe(false);
    expect(isFailureResponse({ exitCode: 0 })).toBe(false);
    expect(isFailureResponse("plain text response")).toBe(false);
    expect(isFailureResponse(undefined)).toBe(false);
  });
});

describe("extractFailureText", () => {
  test("concatenates the known text fields", () => {
    // Act
    const text = extractFailureText({
      stdout: "running",
      stderr: "boom",
      exitCode: 1,
    });

    // Assert
    expect(text).toBe("running\nboom");
  });

  test("uses a string response as-is", () => {
    expect(extractFailureText("raw output")).toBe("raw output");
  });
});
