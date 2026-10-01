import { afterEach, describe, expect, test } from "bun:test";

import { runProcess } from "../bench/at7/exec.ts";

/**
 * runProcess is the one spawn path of the live driver (A1.5, A2.5). Two of
 * its claims decide whether a run is counted:
 *   - `timedOut` is true ONLY when the harness's own timer killed the child.
 *     A non-zero exit — an `is_error` claude run exits 1 — is not a timeout,
 *     and voiding it as `timed-out` would drop a hit already in that run.
 *   - the child gets the env allowlist plus the caller's pins, never the
 *     launcher's CROSSCHECK_* / CLAUDE_*.
 * Hermetic: `sh` and `sleep` only, no network.
 */
const LEAK = "CROSSCHECK_HUB_URL";

describe("runProcess — timedOut is the harness's own kill only (A2.5)", () => {
  test("a non-zero exit is not a timeout", async () => {
    // Act
    const result = await runProcess(["sh", "-c", "exit 3"], { timeoutMs: 5_000 });

    // Assert
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  test("a non-zero exit without any timeout is not a timeout", async () => {
    // Act
    const result = await runProcess(["sh", "-c", "exit 1"]);

    // Assert
    expect(result.timedOut).toBe(false);
  });

  test("a child the timer kills is timed out", async () => {
    // Act
    const result = await runProcess(["sleep", "5"], { timeoutMs: 150 });

    // Assert
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  test("a clean exit inside the timeout is not timed out", async () => {
    // Act
    const result = await runProcess(["sh", "-c", "printf ok"], { timeoutMs: 5_000 });

    // Assert
    expect(result.stdout).toBe("ok");
    expect(result.timedOut).toBe(false);
  });
});

describe("runProcess — the child env is the allowlist (A1.5)", () => {
  const saved = process.env[LEAK];

  afterEach(() => {
    if (saved === undefined) {
      delete process.env[LEAK];
    } else {
      process.env[LEAK] = saved;
    }
  });

  test("a launcher CROSSCHECK_HUB_URL never reaches the child", async () => {
    // Arrange
    process.env[LEAK] = "https://team-hub.example";

    // Act
    const result = await runProcess(["sh", "-c", `printf %s "\${${LEAK}-unset}"`]);

    // Assert
    expect(result.stdout).toBe("unset");
  });

  test("the caller's pinned variables do reach the child", async () => {
    // Act
    const result = await runProcess(["sh", "-c", 'printf %s "$CROSSCHECK_HOME"'], {
      env: { CROSSCHECK_HOME: "/tmp/run/home" },
    });

    // Assert
    expect(result.stdout).toBe("/tmp/run/home");
  });
});
