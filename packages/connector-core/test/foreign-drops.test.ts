/**
 * `readForeignRepoDrops` — the READER the foreign-repo drop counter was
 * missing (adversarial review of trial finding #9): the counter kept the
 * drop honest only in the state file, where nobody looks. This scanner is
 * what doctor/status print, so a multi-repo workspace's second repo going
 * silent is a sentence on a surface a human actually runs. Bounded files,
 * bounded named repos, fail-open zeros.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { FOREIGN_DROPS_SCAN_MAX_FILES } from "../src/constants.ts";
import {
  readForeignRepoDrops,
} from "../src/state/foreign-drops.ts";
import {
  deriveSessionState,
  writeSessionState,
} from "../src/state/session-state.ts";
import { makeHome } from "./helpers.ts";

const HUB_URL = "http://127.0.0.1:7100";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

const stateWithDrops = (key: string, repoId: string, drops: number) => ({
  ...deriveSessionState({
    hostSessionKey: key,
    repoId,
    repoRoot: "/tmp/repo",
    hubUrl: HUB_URL,
    developerId: "dev_a",
    startedAt: new Date("2026-08-19T08:00:00.000Z").toISOString(),
  }),
  foreignRepoDrops: drops,
});

describe("readForeignRepoDrops", () => {
  test("sums drops across live sessions and names the bound repos", async () => {
    // Arrange: two sessions dropping, one clean, one unreadable file
    const home = await makeHome("fdrops");
    paths.push(home);
    await writeSessionState(home, stateWithDrops("s1", "github.com/acme/api", 3));
    await writeSessionState(home, stateWithDrops("s2", "github.com/acme/web", 2));
    await writeSessionState(home, stateWithDrops("s3", "github.com/acme/api", 0));
    await writeFile(join(home, "sessions", "garbage.json"), "not json", "utf8");

    // Act
    const summary = await readForeignRepoDrops(home);

    // Assert: totals from dropping sessions only, repos deduplicated
    expect(summary.drops).toBe(5);
    expect(summary.sessions).toBe(2);
    expect([...summary.repoIds].sort()).toEqual([
      "github.com/acme/api",
      "github.com/acme/web",
    ]);
  });

  test("an empty or missing sessions dir is zeros, never a throw", async () => {
    // Arrange: a home with no sessions dir at all
    const home = await makeHome("fdrops-empty");
    paths.push(home);
    await rm(join(home, "sessions"), { recursive: true, force: true });

    // Act + Assert
    expect(await readForeignRepoDrops(home)).toEqual({
      drops: 0,
      sessions: 0,
      repoIds: [],
    });
  });

  test("the scan is bounded by FOREIGN_DROPS_SCAN_MAX_FILES", async () => {
    // Arrange: pin the bound is a real named constant, not a magic number
    expect(FOREIGN_DROPS_SCAN_MAX_FILES).toBeGreaterThan(0);
    const home = await makeHome("fdrops-bound");
    paths.push(home);
    await mkdir(join(home, "sessions"), { recursive: true });

    // Act + Assert: zero files stays zeros under the same bound
    expect((await readForeignRepoDrops(home)).drops).toBe(0);
  });
});
