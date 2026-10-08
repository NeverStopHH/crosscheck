/**
 * A `crosscheck` ON PATH THAT DID NOT ANSWER IS NOT A FOREIGN TOOL.
 *
 * The defect (found by the load-only flake in cli/test/doctor.test.ts
 * "passes when the launcher resolves and identifies as crosscheck"): the
 * identity probe runs `<bin> --version` under a 3 s spawn timeout and
 * answered a plain boolean, so a probe the deadline KILLED read exactly like
 * a binary that printed somebody else's banner. Under CPU contention the
 * first exec of a freshly written launcher outlived the 3 s, and doctor told
 * the developer "a different tool owns the name on this PATH … remove it" —
 * about their own working install. The probe now answers own / foreign /
 * unanswered, and doctor says which.
 *
 * Deterministic: the hanging launcher never answers, so its deadline fires
 * at any load; the classification cases inject the probe outright.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkLauncherCommand } from "../src/config/launcher-check.ts";
import { probeCrosscheckBin } from "../src/config/launcher.ts";

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

  test("a launcher the deadline had to kill is unanswered, not foreign", async () => {
    const dir = await fakeBinDir(HANG);
    expect(await probeCrosscheckBin(join(dir, "crosscheck"), TIGHT_PROBE_MS)).toBe("unanswered");
  });
});

describe("doctor's launcher line says which answer it got", () => {
  const ENV_WITH = (dir: string) => ({ PATH: dir });
  const KEYWORDS = ["hook", "statusline"];

  test("an unanswered probe is a WARN that names the deadline, never the foreign-tool FAIL", async () => {
    // Arrange
    const dir = await fakeBinDir(HANG);

    // Act
    const health = await checkLauncherCommand("crosscheck hook session-start", ENV_WITH(dir), KEYWORDS, async () => "unanswered");

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
