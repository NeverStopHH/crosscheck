import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const BIN_PATH = resolve(import.meta.dir, "..", "src", "bin", "crosscheck.ts");

/** Comfortably above STDIN_TIMEOUT_MS, far below a developer's patience. */
const EXIT_WAIT_MS = 6000;

describe("crosscheck entry point", () => {
  test("exits on its own when stdin is never closed", async () => {
    // Arrange: a caller that opens stdin and then stalls forever
    const proc = Bun.spawn({
      cmd: [process.execPath, BIN_PATH, "hook", "session-start"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, CROSSCHECK_DISABLED: "1" },
    });

    // Act
    const outcome = await Promise.race([
      proc.exited,
      new Promise<"timed out">((resolveRace) => {
        setTimeout(() => resolveRace("timed out"), EXIT_WAIT_MS);
      }),
    ]);
    if (outcome === "timed out") {
      proc.kill();
    }

    // Assert
    expect(outcome).toBe(0);
  });
});