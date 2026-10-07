/**
 * Landed detection, connector side (DESIGN.md §5): which session base
 * commits are ancestors of the default branch — bounded, fail-open,
 * absence-collector style. Real git repos, not mocks: ancestry is exactly
 * the kind of fact a mock would get politely wrong.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

import { MAX_LANDED_ANCESTRY_CHECKS } from "../src/constants.ts";
import {
  baseReachableFromDefault,
  collectLandedCommits,
  collectLandedReading,
  landedEvidenceRecord,
  probeBaseOnDefault,
  readCommitDates,
} from "../src/capture/landed.ts";
import { resolveDefaultBranchRef } from "../src/git/default-branch.ts";
import { runGit } from "../src/git/git.ts";
import { git, makeRepo } from "./helpers.ts";

const revParse = async (root: string, ref: string): Promise<string> => {
  const sha = await runGit(["rev-parse", ref], root);
  if (sha === null) {
    throw new Error(`rev-parse ${ref} failed`);
  }
  return sha;
};

/** A repo whose origin/main is known and whose feature branch diverged. */
const makeRepoWithOrigin = async (): Promise<{
  root: string;
  mainSha: string;
  featureSha: string;
}> => {
  const root = await makeRepo("landed");
  const mainSha = await revParse(root, "HEAD");
  await git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await git(root, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);
  await git(root, ["checkout", "-q", "-b", "feat/divergent"]);
  await writeFile(join(root, "feature.ts"), "export const x = 1;\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "feature work"]);
  const featureSha = await revParse(root, "HEAD");
  return { root, mainSha, featureSha };
};

describe("resolveDefaultBranchRef", () => {
  test("follows the origin/HEAD symref", async () => {
    // Arrange
    const { root } = await makeRepoWithOrigin();

    // Act
    const ref = await resolveDefaultBranchRef(root);

    // Assert
    expect(ref).toBe("origin/main");
  });

  test("falls back to origin/master when origin/HEAD is unset", async () => {
    // Arrange: a clone that never had origin/HEAD written, master-named.
    const root = await makeRepo("landed-master");
    await git(root, ["update-ref", "refs/remotes/origin/master", "HEAD"]);

    // Act
    const ref = await resolveDefaultBranchRef(root);

    // Assert
    expect(ref).toBe("origin/master");
  });

  test("a repo with no origin refs resolves to nothing — fail open", async () => {
    // Arrange
    const root = await makeRepo("landed-local");

    // Act
    const ref = await resolveDefaultBranchRef(root);

    // Assert
    expect(ref).toBeNull();
  });
});

describe("collectLandedCommits", () => {
  test("keeps ancestors of the default ref and drops divergent commits", async () => {
    // Arrange
    const { root, mainSha, featureSha } = await makeRepoWithOrigin();

    // Act
    const landed = await collectLandedCommits(root, "origin/main", [
      mainSha,
      featureSha,
    ]);

    // Assert
    expect(landed).toEqual([mainSha]);
  });

  test("an unknown sha is dropped, never reported — a missed fact beats a false one", async () => {
    // Arrange
    const { root } = await makeRepoWithOrigin();

    // Act
    const landed = await collectLandedCommits(root, "origin/main", [
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    ]);

    // Assert
    expect(landed).toEqual([]);
  });

  test("flag-shaped and non-sha values never reach git", async () => {
    // Arrange
    const { root } = await makeRepoWithOrigin();

    // Act
    const landed = await collectLandedCommits(root, "origin/main", [
      "--all",
      "HEAD",
      "refs/heads/main",
    ]);

    // Assert
    expect(landed).toEqual([]);
  });

  test("the fan-out is capped and deduplicated", async () => {
    // Arrange: the same ancestor repeated far past the cap.
    const { root, mainSha } = await makeRepoWithOrigin();
    const commits = Array.from(
      { length: MAX_LANDED_ANCESTRY_CHECKS * 3 },
      () => mainSha,
    );

    // Act
    const landed = await collectLandedCommits(root, "origin/main", commits);

    // Assert: one distinct commit in, one out.
    expect(landed).toEqual([mainSha]);
  });

  test("the rotation walks the window so no candidate starves behind the cap", async () => {
    // Arrange: two more distinct candidates than one probe may check. A
    // fixed window would probe the same first ten on every SessionStart and
    // the overflow pair would present as open forever, however long ago it
    // merged. All twelve are real ancestors, so whichever the window covers
    // are provably landed — the RESULT reveals the window.
    const { root } = await makeRepoWithOrigin();
    const overflow = 2;
    const candidates: string[] = [];
    for (let i = 0; i < MAX_LANDED_ANCESTRY_CHECKS + overflow; i += 1) {
      await writeFile(join(root, "walk.ts"), `export const step = ${String(i)};\n`, "utf8");
      await git(root, ["add", "."]);
      await git(root, ["commit", "-q", "-m", `step ${String(i)}`]);
      candidates.push(await revParse(root, "HEAD"));
    }
    await git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    const overflowPair = candidates.slice(MAX_LANDED_ANCESTRY_CHECKS);

    // Act: day zero's window, then the day the rotation reaches the tail.
    const dayZero = await collectLandedCommits(
      root,
      "origin/main",
      candidates,
      0,
    );
    const laterDay = await collectLandedCommits(
      root,
      "origin/main",
      candidates,
      MAX_LANDED_ANCESTRY_CHECKS,
    );

    // Assert: the cap holds on both days, and the candidates day zero's
    // window missed are exactly what the rotated window reaches.
    expect(dayZero.length).toBe(MAX_LANDED_ANCESTRY_CHECKS);
    expect(laterDay.length).toBe(MAX_LANDED_ANCESTRY_CHECKS);
    for (const sha of overflowPair) {
      expect(dayZero).not.toContain(sha);
      expect(laterDay).toContain(sha);
    }
  });
});

/** A commit whose committer date is fixed — the one thing the shared helper cannot set. */
const commitDatedAt = async (root: string, message: string, committedAt: string): Promise<void> => {
  const proc = Bun.spawn({
    cmd: ["git", "commit", "-q", "-m", message],
    cwd: root,
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_COMMITTER_DATE: committedAt },
  });
  expect(await proc.exited).toBe(0);
};

describe("baseReachableFromDefault — what register says about its own base", () => {
  test("a detached checkout of a commit main already holds is on the default branch", async () => {
    // Arrange: the pilot owner's shape — a worktree detached at a main commit.
    const { root, mainSha } = await makeRepoWithOrigin();
    await git(root, ["checkout", "-q", "--detach", mainSha]);

    // Act
    const onDefault = await baseReachableFromDefault(root, mainSha, "origin/main");

    // Assert
    expect(onDefault).toBe(true);
  });

  test("a branch's own commit main does not hold yet is not", async () => {
    // Arrange
    const { root, featureSha } = await makeRepoWithOrigin();

    // Act + Assert
    expect(await baseReachableFromDefault(root, featureSha, "origin/main")).toBe(false);
  });

  test("git that cannot answer says nothing — never a guess either way", async () => {
    // Arrange
    const { root } = await makeRepoWithOrigin();

    // Act + Assert: unknown sha, flag-shaped value, no default ref.
    expect(await baseReachableFromDefault(root, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "origin/main")).toBeUndefined();
    expect(await baseReachableFromDefault(root, "--all", "origin/main")).toBeUndefined();
    expect(await baseReachableFromDefault(root, "a1b2c3d4", null)).toBeUndefined();
  });

  test("probeBaseOnDefault resolves the default ref itself on a named branch", async () => {
    // Arrange
    const { root, mainSha, featureSha } = await makeRepoWithOrigin();

    // Act + Assert
    expect(await probeBaseOnDefault({ root, baseCommit: mainSha, branch: "feat/cut" })).toBe(true);
    expect(await probeBaseOnDefault({ root, baseCommit: featureSha, branch: "feat/divergent" })).toBe(false);
  });

  test("a detached HEAD is never probed — the hub never lands it by its base anyway", async () => {
    // Arrange: count the default-ref resolutions the probe asks for.
    const { root, mainSha } = await makeRepoWithOrigin();
    let resolutions = 0;
    const resolveRef = (): Promise<string | null> => {
      resolutions += 1;
      return Promise.resolve("origin/main");
    };

    // Act
    const detached = await probeBaseOnDefault({ root, baseCommit: mainSha, branch: `detached@${mainSha.slice(0, 9)}` }, resolveRef);

    // Assert: no answer and no git — not even the default ref.
    expect(detached).toBeUndefined();
    expect(resolutions).toBe(0);
  });
});

describe("collectLandedReading — the ancestors, and when each was committed", () => {
  test("dates exactly the landed commits, by git's committer date", async () => {
    // Arrange: main's commit was committed at a known instant.
    const root = await makeRepo("landed-dated");
    await writeFile(join(root, "dated.ts"), "export const d = 1;\n", "utf8");
    await git(root, ["add", "."]);
    await commitDatedAt(root, "dated", "2026-08-21T10:00:00+02:00");
    const mainSha = await revParse(root, "HEAD");
    await git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await git(root, ["checkout", "-q", "-b", "feat/unmerged"]);
    await writeFile(join(root, "unmerged.ts"), "export const u = 1;\n", "utf8");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-q", "-m", "unmerged"]);
    const featureSha = await revParse(root, "HEAD");

    // Act
    const reading = await collectLandedReading(root, "origin/main", [mainSha, featureSha]);

    // Assert: in UTC, as the wire wants it; the unmerged commit is neither.
    expect(reading).toEqual({
      commits: [mainSha],
      commitDates: [{ sha: mainSha, committedAt: "2026-08-21T08:00:00.000Z" }],
    });
  });

  test("readCommitDates reads nothing for an unknown or flag-shaped value", async () => {
    // Arrange
    const { root, mainSha } = await makeRepoWithOrigin();

    // Act
    const dates = await readCommitDates(root, [mainSha, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "--all"]);

    // Assert
    expect(dates.map((entry) => entry.sha)).toEqual([mainSha]);
  });
});

describe("landedEvidenceRecord", () => {
  test("wraps the finding in a landed_evidence envelope", () => {
    // Arrange
    const now = new Date("2026-07-24T09:00:00.000Z");

    // Act
    const record = landedEvidenceRecord(
      "github.com/acme/api",
      "origin/main",
      { commits: ["a1b2c3d4"], commitDates: [] },
      {
        developerId: "dev_1",
        agentKind: "claude-code",
        sessionId: "cc_1",
      },
      now,
    );

    // Assert: no dates read, no field — never an empty list.
    expect(record.kind).toBe("landed_evidence");
    expect(record.body).toEqual({
      repo: "github.com/acme/api",
      defaultBranch: "origin/main",
      checkedAt: "2026-07-24T09:00:00.000Z",
      commits: ["a1b2c3d4"],
    });
  });

  test("carries the commits' dates when git gave them", () => {
    // Arrange
    const dates = [{ sha: "a1b2c3d4", committedAt: "2026-07-23T18:00:00.000Z" }];

    // Act
    const record = landedEvidenceRecord(
      "github.com/acme/api",
      "origin/main",
      { commits: ["a1b2c3d4"], commitDates: dates },
      { developerId: "dev_1", agentKind: "claude-code", sessionId: "cc_1" },
      new Date("2026-07-24T09:00:00.000Z"),
    );

    // Assert
    expect((record.body as { commitDates?: unknown }).commitDates).toEqual(dates);
  });
});
