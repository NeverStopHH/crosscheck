/**
 * WHAT A SWEEP SAYS IT ANSWERED (flows/git-lane.ts `sweepGitRoots`; review
 * mutation #4 of feat/topic-contexts). A root git did not answer for must
 * read as unanswered — the turn a skip, the loss booked, the root's bash mark
 * kept so the next Stop tries it first — never as swept. A root that answered
 * is swept, its mark spent.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { realpath, rm } from "node:fs/promises";

import { sweepGitRoots } from "../src/flows/git-lane.ts";
import type { SweepGitRootsInput } from "../src/flows/git-lane.ts";
import { deriveSessionState } from "../src/state/session-state.ts";
import { makeHome, makeRepo, writeRepoFile } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
/** A deadline no git process can meet: the spawn alone takes longer. */
const UNMEETABLE_GIT_TIMEOUT_MS = 1;
/** A deadline any git process meets on a loaded machine. */
const WIDE_GIT_TIMEOUT_MS = 30_000;

const cleanups: string[] = [];

afterAll(async () => {
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

const sweepOf = async (label: string, gitTimeoutMs: number): Promise<{ readonly root: string; readonly input: SweepGitRootsInput }> => {
  const root = await realpath(await makeRepo(label, { remote: "git@github.com:acme/api.git" }));
  const home = await makeHome(label);
  cleanups.push(root, home);
  await writeRepoFile(root, "src/dirty.ts", "export const d = 1;\n");
  const state = deriveSessionState({
    hostSessionKey: label,
    repoId: REPO_ID,
    repoRoot: root,
    hubUrl: "http://hub.invalid",
    developerId: "dev_1",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  return {
    root,
    input: {
      home,
      repoKey: "hub__github.com__acme__api",
      hostSessionKey: label,
      state,
      roots: [{ root, since: new Date(state.startedAt), firstHead: null, isSessionRoot: true }],
      producer: { developerId: "dev_1", agentKind: "claude-code", sessionId: state.crosscheckSessionId },
      denylist: null,
      now: new Date(),
      seq: null,
      gitTimeoutMs,
    },
  };
};

describe("a sweep answers only for the roots git answered for (review mutation #4)", () => {
  test("a root git did not answer in time is unavailable and not swept", async () => {
    // Arrange
    const { input } = await sweepOf("sweep-unanswered", UNMEETABLE_GIT_TIMEOUT_MS);

    // Act
    const sweep = await sweepGitRoots(input);

    // Assert: a skip the hook books, and the root keeps its turn
    expect(sweep.unavailable).toBe(true);
    expect(sweep.swept).toEqual([]);
  });

  test("a root git answered for is swept", async () => {
    // Arrange
    const { root, input } = await sweepOf("sweep-answered", WIDE_GIT_TIMEOUT_MS);

    // Act
    const sweep = await sweepGitRoots(input);

    // Assert
    expect(sweep.unavailable).toBe(false);
    expect(sweep.swept).toEqual([root]);
    expect(sweep.captured).toContain("src/dirty.ts");
  });
});
