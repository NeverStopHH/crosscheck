/**
 * THE PATH BIN'S IDENTITY PROBE, WITHIN A BUDGET (config/launcher.ts).
 *
 * `crosscheck --version` through the node shim re-execs under bun, and under
 * load (about 20) it ran past the 3 s probe: init quietly wrote the absolute
 * launcher (batch 2). A silent bin is now asked again within the caller's
 * budget, and a fallback names the bin that stayed silent. A foreign answer
 * is final. Each fake bin books every run, so the retry count is measured.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_IDENTITY_PROBE,
  INIT_IDENTITY_PROBE,
  resolveCommandPrefix,
  resolveLauncher,
  silentBareNote,
} from "../src/config/launcher.ts";

const ENTRY = new URL("../../cli/src/bin/crosscheck.ts", import.meta.url).pathname;
/** Short enough to keep the suite fast, long past what a fake that answers at once needs. */
const TEST_BUDGET = { timeoutMs: 400, attempts: 2 };

let base = "";

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "cx-launcher-identity-"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** A `crosscheck` in its own bin dir that books each run, then runs `body`. */
const fakeBin = async (label: string, body: string): Promise<{ readonly dir: string; readonly runs: () => Promise<number> }> => {
  const dir = join(base, label);
  const count = join(base, `${label}.runs`);
  await Bun.write(join(dir, ".keep"), "");
  await writeFile(join(dir, "crosscheck"), `#!/bin/sh\necho run >> "${count}"\n${body}\n`, "utf8");
  await chmod(join(dir, "crosscheck"), 0o755);
  return {
    dir,
    runs: async () => (await readFile(count, "utf8").catch(() => "")).split("\n").filter((line) => line.length > 0).length,
  };
};

const pathWith = (dir: string): Record<string, string> => ({ PATH: [dir, "/usr/bin", "/bin"].join(":") });

describe("the PATH bin's identity probe", () => {
  test("a bin that stays silent is asked once more, then the absolute launcher is wired and says why", async () => {
    // Arrange — never answers before the deadline
    const bin = await fakeBin("silent", "exec sleep 5");

    // Act
    const launcher = await resolveLauncher(undefined, pathWith(bin.dir), ENTRY, TEST_BUDGET);

    // Assert
    expect(await bin.runs()).toBe(2);
    expect(launcher).toMatchObject({ kind: "entry", silentBare: join(bin.dir, "crosscheck") });
    if (launcher.kind !== "entry") {
      throw new Error("expected the absolute launcher");
    }
    expect(silentBareNote(launcher)).toBe(
      `crosscheck on PATH (${join(bin.dir, "crosscheck")}) didn't answer in time; wired the absolute launcher ${resolveCommandPrefix(launcher)} instead; rerun init to switch`,
    );
  });

  test("a bin silent on the first try and answering on the retry is wired by its bare name", async () => {
    // Arrange — the first run stalls, the second answers like ours
    const count = join(base, "late.runs");
    const bin = await fakeBin("late", `if [ "$(wc -l < "${count}")" -le 1 ]; then exec sleep 5; fi\necho 'crosscheck 0.11.0'`);

    // Act
    const launcher = await resolveLauncher(undefined, pathWith(bin.dir), ENTRY, TEST_BUDGET);

    // Assert
    expect(await bin.runs()).toBe(2);
    expect(launcher).toEqual({ kind: "bare", path: join(bin.dir, "crosscheck") });
  });

  test("a foreign answer is final: not asked again, and no silence is reported", async () => {
    // Arrange
    const bin = await fakeBin("foreign", "echo 'crosscheck-cli 9.9.9 by somebody else'");

    // Act
    const launcher = await resolveLauncher(undefined, pathWith(bin.dir), ENTRY, TEST_BUDGET);

    // Assert
    expect(await bin.runs()).toBe(1);
    expect(launcher.kind).toBe("entry");
    if (launcher.kind !== "entry") {
      throw new Error("expected the absolute launcher");
    }
    expect(launcher.silentBare).toBeUndefined();
    expect(silentBareNote(launcher)).toBeNull();
  });

  test("init waits 10 s and asks twice; everything else keeps 3 s and asks once", () => {
    // Act + Assert
    expect(INIT_IDENTITY_PROBE).toEqual({ timeoutMs: 10_000, attempts: 2 });
    expect(DEFAULT_IDENTITY_PROBE).toEqual({ timeoutMs: 3_000, attempts: 1 });
  });
});
