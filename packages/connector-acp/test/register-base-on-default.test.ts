/**
 * The ACP proxy's session/new says whether its base was already on the
 * default branch (pilot finding, 2026-10-05), and the hub STORES it — the
 * real in-process hub, read back from agent_sessions.base_on_default. Real
 * git decides the answer.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { bootCaptureHub, createHarness, handshake, REMOTE } from "./fixtures/capture-harness.ts";
import type { CaptureHub } from "./fixtures/capture-harness.ts";
import { git, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";

let hub: CaptureHub;
const cleanups: string[] = [];

beforeAll(async () => {
  hub = await bootCaptureHub("acp-base-on-default");
});

afterAll(async () => {
  hub.server.stop(true);
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

/** A clone whose origin/main holds the initial commit, checked out on `branch`. */
const cloneOn = async (label: string, branch: string, ownCommit: boolean): Promise<string> => {
  const repo = await makeRepo(label, { remote: REMOTE });
  cleanups.push(repo);
  await git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  await git(repo, ["checkout", "-q", "-b", branch]);
  if (ownCommit) {
    await writeRepoFile(repo, "src/own.ts", "export const own = 1;\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-q", "-m", "own work"]);
  }
  return repo;
};

const storedFlagOf = async (sessionId: string): Promise<unknown> => {
  const result = await hub.db.execute(`select base_on_default from agent_sessions where id = '${sessionId}'`);
  return (result.rows[0] as { base_on_default?: unknown } | undefined)?.base_on_default;
};

describe("ACP's register carries baseOnDefault", () => {
  test("a branch cut from main stores true; a branch with its own commit stores false", async () => {
    // Arrange
    const cut = await createHarness(hub, cleanups, "acp-base-cut", { repo: await cloneOn("acp-base-cut", "feat/cut", false) });
    const own = await createHarness(hub, cleanups, "acp-base-own", { repo: await cloneOn("acp-base-own", "feat/own", true) });

    // Act
    handshake(cut, "sess_base_cut", cut.repo);
    handshake(own, "sess_base_own", own.repo);
    await cut.capture.settle();
    await own.capture.settle();

    // Assert
    expect(await storedFlagOf("cc_acp-fake-agent--sess_base_cut")).toBe(true);
    expect(await storedFlagOf("cc_acp-fake-agent--sess_base_own")).toBe(false);
  });
});
