/**
 * LOSS-11 (docs/1.0/loss-accounting.md §7): the three capture-side refusals
 * that used to be a `break` and two `continue`s — the per-call cap, the
 * secret scan, an edit outside every root of the repo — are counted in the
 * `.drops` ledger like every other record the connector did not write. A
 * READ outside every root is not a lost edit and books nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_GIT_TOUCH_CANDIDATES, MAX_TARGETS_PER_INVOCATION } from "../src/constants.ts";
import { captureGitTouches } from "../src/flows/capture-git-touches.ts";
import { repoKey } from "../src/config/paths.ts";
import type { Producer } from "../src/capture/records.ts";
import { captureFileTargets } from "../src/flows/capture-targets.ts";
import { captureTouchedFiles } from "../src/flows/capture-touched-files.ts";
import { readDropDetail, readDropSummary } from "../src/spool/drops.ts";
import { git, makeHome, makeRepo, writeRepoFile } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
const KEY = repoKey("http://127.0.0.1:9", REPO_ID);
const SESSION = "capture-losses";
const NOW = new Date("2026-09-20T10:00:00.000Z");
const PRODUCER: Producer = { developerId: "dev_1", agentKind: "test", sessionId: "cc_1" };
/** An AWS access key id shape: `AKIA` + 16 upper-case alphanumerics. */
const SECRET_PATH = "config/AKIAABCDEFGHIJKLMNOP.json";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
  cleanups.length = 0;
});

const fixture = async (label: string): Promise<{ home: string; repo: string }> => {
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  cleanups.push(home, repo);
  return { home, repo };
};

const targetsInput = (fx: { home: string; repo: string }, paths: readonly string[]) => ({
  home: fx.home,
  repoKey: KEY,
  hostSessionKey: SESSION,
  repoRoot: fx.repo,
  cwd: fx.repo,
  paths,
  denylist: null,
  seenTargets: [],
  workContextId: "wc_1",
  producer: PRODUCER,
  now: NOW,
});

describe("LOSS-11: capture-side refusals are counted drops", () => {
  test("paths past the per-call cap are counted as capture-capped, exactly as many as were cut", async () => {
    // Arrange
    const fx = await fixture("capped");
    const paths = Array.from({ length: MAX_TARGETS_PER_INVOCATION + 5 }, (_, index) => `src/file-${String(index)}.ts`);

    // Act
    const captured = await captureFileTargets(targetsInput(fx, paths));

    // Assert
    expect(captured).toHaveLength(MAX_TARGETS_PER_INVOCATION);
    expect((await readDropDetail(fx.home, KEY)).byReason["capture-capped"]).toBe(5);
  });

  test("a path the secret scan refuses is counted as a secret-path drop and never captured", async () => {
    // Arrange
    const fx = await fixture("secret");

    // Act
    const captured = await captureFileTargets(targetsInput(fx, ["src/ok.ts", SECRET_PATH]));

    // Assert
    expect(captured).toEqual(["src/ok.ts"]);
    expect((await readDropDetail(fx.home, KEY)).byReason["secret-path"]).toBe(1);
  });

  test("a call that lost nothing writes no ledger line", async () => {
    // Arrange
    const fx = await fixture("clean");

    // Act
    await captureFileTargets(targetsInput(fx, ["src/a.ts", "src/b.ts"]));

    // Assert
    expect(await readDropSummary(fx.home, KEY)).toEqual({ records: 0, entries: 0, malformed: 0 });
  });

  test("with editFired false nothing is ledgered — an ACP read is not a lost edit", async () => {
    // Arrange
    const fx = await fixture("read");
    const paths = Array.from({ length: MAX_TARGETS_PER_INVOCATION + 5 }, (_, index) => `src/file-${String(index)}.ts`);

    // Act
    await captureFileTargets({ ...targetsInput(fx, [...paths, SECRET_PATH]), editFired: false });

    // Assert
    expect(await readDropSummary(fx.home, KEY)).toEqual({ records: 0, entries: 0, malformed: 0 });
  });

  test("an edit outside every root of the repo is counted as an outside-root drop; a read is not", async () => {
    // Arrange: a loose directory that is inside no git repository at all
    const fx = await fixture("outside");
    const loose = await mkdtemp(join(tmpdir(), "cx-loose-"));
    cleanups.push(loose);
    const touched = (editFired: boolean) =>
      captureTouchedFiles({
        ...targetsInput(fx, [join(loose, "loose.ts")]),
        editFired,
        sessionRepoId: REPO_ID,
        identityRoot: fx.repo,
        identityRepoId: REPO_ID,
        knownWorktreeRoots: [],
      });

    // Act
    const read = await touched(false);
    const edit = await touched(true);

    // Assert
    expect(read.resolution?.outsideDrops).toBe(1);
    expect(edit.resolution?.outsideDrops).toBe(1);
    expect(edit.captured).toHaveLength(0);
    const detail = await readDropDetail(fx.home, KEY);
    expect(detail.byReason["outside-root"]).toBe(1);
    expect(detail.summary.records).toBe(1);
  });

  test("review M5: dirty paths past the git lane's candidate bound are counted, not skipped unseen", async () => {
    // Arrange: 65 tracked files, all modified since HEAD
    const fx = await fixture("git-lane-cut");
    const dirty = MAX_GIT_TOUCH_CANDIDATES + 5;
    for (let index = 0; index < dirty; index += 1) {
      await writeRepoFile(fx.repo, `src/f${String(index)}.ts`, "export const a = 1;\n");
    }
    await git(fx.repo, ["add", "-A"]);
    await git(fx.repo, ["commit", "-m", "files"]);
    for (let index = 0; index < dirty; index += 1) {
      await writeRepoFile(fx.repo, `src/f${String(index)}.ts`, "export const a = 2;\n");
    }

    // Act
    await captureGitTouches({
      home: fx.home,
      repoKey: KEY,
      hostSessionKey: SESSION,
      repoRoot: fx.repo,
      workContextId: "wc_1",
      producer: PRODUCER,
      seenTargets: [],
      denylist: null,
      since: new Date(0),
      now: NOW,
    });

    // Assert: the 5 cut before the freshness check, plus the 40 the per-call
    // cap (MAX_TARGETS_PER_INVOCATION) cut from the 60 it examined
    const detail = await readDropDetail(fx.home, KEY);
    expect(detail.byReason["capture-capped"]).toBe(
      dirty - MAX_GIT_TOUCH_CANDIDATES + (MAX_GIT_TOUCH_CANDIDATES - MAX_TARGETS_PER_INVOCATION),
    );
  });
});
