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
  collectLandedCommits,
  landedEvidenceRecord,
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
});

describe("landedEvidenceRecord", () => {
  test("wraps the finding in a landed_evidence envelope", () => {
    // Arrange
    const now = new Date("2026-07-24T09:00:00.000Z");

    // Act
    const record = landedEvidenceRecord(
      "github.com/acme/api",
      "origin/main",
      ["a1b2c3d4"],
      {
        developerId: "dev_1",
        agentKind: "claude-code",
        sessionId: "cc_1",
      },
      now,
    );

    // Assert
    expect(record.kind).toBe("landed_evidence");
    expect(record.body).toEqual({
      repo: "github.com/acme/api",
      defaultBranch: "origin/main",
      checkedAt: "2026-07-24T09:00:00.000Z",
      commits: ["a1b2c3d4"],
    });
  });
});
