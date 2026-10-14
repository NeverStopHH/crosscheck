/**
 * A `crosscheck` ON PATH THAT DID NOT ANSWER IS NOT A FOREIGN TOOL.
 *
 * The defect (found by the load-only flake in cli/test/doctor.test.ts
 * "passes when the launcher resolves and identifies as crosscheck"): the
 * identity probe runs `<bin> --version` under a 3 s deadline and answered a
 * plain boolean, so a probe the deadline KILLED read exactly like a binary
 * that printed somebody else's banner. Under CPU contention the first exec of
 * a freshly written launcher outlived the 3 s, and doctor told the developer
 * "a different tool owns the name on this PATH … remove it" — about their own
 * working install. The probe now answers own / foreign / silent, and doctor
 * says which.
 *
 * AND WITHIN A BUDGET (config/launcher.ts). `crosscheck --version` through
 * the node shim re-execs under bun, and under load (about 20) it ran past the
 * 3 s probe: init quietly wrote the absolute launcher (batch 2). A silent bin
 * is now asked again within the caller's budget, and a fallback names the bin
 * that stayed silent. A foreign answer is final.
 *
 * Deterministic: the hanging launcher never answers, so its deadline fires
 * at any load; the classification cases inject the probe outright; and the
 * retry cases drive the rule with a SCRIPTED probe that books its asks
 * (resolveLauncher's `probe` seam). They used to count a fake bin's runs
 * under a 400 ms deadline, and at load ~13 a shell could not start inside
 * it, so two asks booked one run (batch-2 integration review's load flake).
 * The 400 ms is nothing the product waits on — its budgets are 3 s and 10 s
 * (DEFAULT_IDENTITY_PROBE, INIT_IDENTITY_PROBE) — only the value the rule
 * must hand the probe, which is asserted.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkLauncherCommand } from "../src/config/launcher-check.ts";
import {
  DEFAULT_IDENTITY_PROBE,
  INIT_IDENTITY_PROBE,
  probeCrosscheckBin,
  resolveCommandPrefix,
  resolveLauncher,
  silentBareNote,
} from "../src/config/launcher.ts";
import type { BinIdentity, BinIdentityProbe } from "../src/config/launcher.ts";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

/** A dir holding an executable `crosscheck` with this shell body. */
const fakeBinDir = async (body: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-launcher-id-"));
  paths.push(dir);
  const bin = join(dir, "crosscheck");
  await writeFile(bin, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(bin, 0o755);
  return dir;
};

/** Far below the 3 s default: only a launcher that never answers can miss it… */
const TIGHT_PROBE_MS = 300;
/** …and this one never does: it outlives every probe here. */
const HANG = "exec /bin/sleep 30";

describe("the identity probe tells three answers apart", () => {
  test("our banner is own", async () => {
    const dir = await fakeBinDir('echo "crosscheck 9.9.9"');
    expect(await probeCrosscheckBin(join(dir, "crosscheck"))).toBe("own");
  });

  test("somebody else's banner is foreign", async () => {
    const dir = await fakeBinDir('echo "othertool 1.2.3"');
    expect(await probeCrosscheckBin(join(dir, "crosscheck"))).toBe("foreign");
  });

  test("a launcher the deadline had to kill is silent, not foreign", async () => {
    const dir = await fakeBinDir(HANG);
    expect(await probeCrosscheckBin(join(dir, "crosscheck"), TIGHT_PROBE_MS)).toBe("silent");
  });
});

describe("doctor's launcher line says which answer it got", () => {
  const ENV_WITH = (dir: string) => ({ PATH: dir });
  const KEYWORDS = ["hook", "statusline"];

  test("a silent probe is a WARN that names the deadline, never the foreign-tool FAIL", async () => {
    // Arrange
    const dir = await fakeBinDir(HANG);

    // Act
    const health = await checkLauncherCommand("crosscheck hook session-start", ENV_WITH(dir), KEYWORDS, async () => "silent");

    // Assert
    expect(health.level).toBe("WARN");
    expect(health.detail).toContain("did not answer");
    expect(health.detail).not.toContain("a different tool owns the name");
  });

  test("a foreign answer is still the FAIL that names the stranger", async () => {
    const dir = await fakeBinDir('echo "othertool 1.2.3"');
    const health = await checkLauncherCommand("crosscheck hook session-start", ENV_WITH(dir), KEYWORDS, async () => "foreign");
    expect(health.level).toBe("FAIL");
    expect(health.detail).toContain("a different tool owns the name");
  });

  test("the real probe, end to end, against a launcher that hangs", async () => {
    // The wiring: checkLauncherCommand hands the bin to the probe it is given.
    const dir = await fakeBinDir(HANG);
    const health = await checkLauncherCommand("crosscheck hook session-start", ENV_WITH(dir), KEYWORDS, (bin) =>
      probeCrosscheckBin(bin, TIGHT_PROBE_MS),
    );
    expect(health.level).toBe("WARN");
  });
});

const ENTRY = new URL("../../cli/src/bin/crosscheck.ts", import.meta.url).pathname;
/** What the rule must hand the probe on every ask — asserted, never waited on. */
const TEST_BUDGET = { timeoutMs: 400, attempts: 2 };

/**
 * A probe that answers from a script, one answer per ask, and books the
 * deadline each ask was given — no process, no clock, so the retry rule reads
 * the same at any load. The real probe's three answers are proven above.
 */
const scriptedProbe = (
  answers: readonly BinIdentity[],
): { readonly probe: BinIdentityProbe; readonly asks: readonly number[] } => {
  const asks: number[] = [];
  return {
    probe: (_binPath, timeoutMs) => {
      asks.push(timeoutMs);
      return Promise.resolve(answers[asks.length - 1] ?? "silent");
    },
    asks,
  };
};

const pathWith = (dir: string): Record<string, string> => ({ PATH: [dir, "/usr/bin", "/bin"].join(":") });

describe("the PATH bin's identity probe", () => {
  test("a bin that stays silent is asked once more, on the budget's deadline, then the absolute launcher is wired and says why", async () => {
    // Arrange — a bin on PATH, and a probe that never hears it answer
    const dir = await fakeBinDir('echo "crosscheck 9.9.9"');
    const { probe, asks } = scriptedProbe(["silent", "silent"]);

    // Act
    const launcher = await resolveLauncher(undefined, pathWith(dir), ENTRY, TEST_BUDGET, probe);

    // Assert: asked exactly twice, each ask on the budget's deadline
    expect(asks).toEqual([TEST_BUDGET.timeoutMs, TEST_BUDGET.timeoutMs]);
    expect(launcher).toMatchObject({ kind: "entry", silentBare: join(dir, "crosscheck") });
    if (launcher.kind !== "entry") {
      throw new Error("expected the absolute launcher");
    }
    expect(silentBareNote(launcher)).toBe(
      `crosscheck on PATH (${join(dir, "crosscheck")}) didn't answer in time; wired the absolute launcher ${resolveCommandPrefix(launcher)} instead; rerun init to switch`,
    );
  });

  test("a bin silent on the first ask and answering on the retry is wired by its bare name", async () => {
    // Arrange — the first ask hears nothing, the second hears our banner
    const dir = await fakeBinDir('echo "crosscheck 9.9.9"');
    const { probe, asks } = scriptedProbe(["silent", "own"]);

    // Act
    const launcher = await resolveLauncher(undefined, pathWith(dir), ENTRY, TEST_BUDGET, probe);

    // Assert
    expect(asks).toHaveLength(2);
    expect(launcher).toEqual({ kind: "bare", path: join(dir, "crosscheck") });
  });

  test("a foreign answer is final: not asked again, and no silence is reported", async () => {
    // Arrange
    const dir = await fakeBinDir('echo "othertool 1.2.3"');
    const { probe, asks } = scriptedProbe(["foreign", "own"]);

    // Act
    const launcher = await resolveLauncher(undefined, pathWith(dir), ENTRY, TEST_BUDGET, probe);

    // Assert
    expect(asks).toEqual([TEST_BUDGET.timeoutMs]);
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
