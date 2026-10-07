/**
 * THE REGISTER SAYS WHETHER ITS BASE WAS ALREADY ON THE DEFAULT BRANCH
 * (pilot finding, 2026-10-05). A long-lived worktree detached at an old main
 * commit has a base that is an ancestor from its first second; the hub must
 * hear that from the session itself, or a teammate's landed report stamps
 * its context landed and takes its files out of every collision check
 * (server services/landed.ts). Real git, a fake hub on an ephemeral port.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { probeBaseOnDefault } from "../src/capture/landed.ts";
import { repoKey } from "../src/config/paths.ts";
import { registerSessionFlow } from "../src/flows/register-session.ts";
import type { RegisterSessionFlowInput } from "../src/flows/register-session.ts";
import { runGit } from "../src/git/git.ts";
import { guaranteeDeclarationFor } from "../src/guarantees/declarations.ts";
import { git, makeHome, makeRepo } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
const bodies: Record<string, unknown>[] = [];
const cleanups: string[] = [];

const server = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/sessions" && request.method === "POST") {
      bodies.push((await request.json()) as Record<string, unknown>);
      return Response.json({ session: { id: "cc_base", developerId: "dev_self" } });
    }
    return Response.json({ ok: true, data: { accepted: 0, duplicates: 0, ignored: 0, rejected: 0 } });
  },
});
const HUB_URL = `http://127.0.0.1:${String(server.port)}`;

afterAll(async () => {
  server.stop(true);
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

const headOf = async (root: string): Promise<string> => {
  const sha = await runGit(["rev-parse", "HEAD"], root);
  if (sha === null) {
    throw new Error("no HEAD");
  }
  return sha;
};

/** A clone whose origin/main holds `main`'s commit, with one unmerged commit on a branch. */
const cloneWithOrigin = async (label: string): Promise<{ root: string; mainSha: string; branchSha: string }> => {
  const root = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  cleanups.push(root);
  const mainSha = await headOf(root);
  await git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  await git(root, ["checkout", "-q", "-b", "feat/unmerged"]);
  await writeFile(join(root, "work.ts"), "export const work = 1;\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "own work"]);
  return { root, mainSha, branchSha: await headOf(root) };
};

const registerFrom = async (
  root: string,
  branch: string,
  baseCommit: string,
  baseOnDefault: boolean | undefined,
): Promise<Record<string, unknown> | undefined> => {
  const home = await makeHome("register-base");
  cleanups.push(home);
  const key = repoKey(HUB_URL, REPO_ID);
  const input: RegisterSessionFlowInput = {
    home,
    hub: { hubUrl: HUB_URL, apiKey: "test-key", timeoutMs: 2000, home, repoKey: key, now: () => new Date() },
    repoKey: key,
    hostSessionKey: `register-base-${crypto.randomUUID()}`,
    repoId: REPO_ID,
    repoRoot: root,
    hubUrl: HUB_URL,
    agentKind: "claude-code",
    branch,
    baseCommit,
    baseOnDefault,
    status: "analyzing",
    fallbackDeveloperId: "dev_self",
    title: "register base", titleSource: "host",
    now: new Date(),
    guarantees: guaranteeDeclarationFor("claude-code"),
  };
  const before = bodies.length;
  await registerSessionFlow(input);
  return bodies[before];
};

describe("the register carries baseOnDefault", () => {
  test("a detached checkout whose HEAD is an ancestor of origin/main says true", async () => {
    // Arrange: the pilot owner's worktree, detached at a commit main holds.
    const { root, mainSha } = await cloneWithOrigin("register-detached");
    await git(root, ["checkout", "-q", "--detach", mainSha]);

    // Act
    const body = await registerFrom(root, `detached@${mainSha.slice(0, 9)}`, mainSha, await probeBaseOnDefault(root, mainSha));

    // Assert
    expect(body?.["baseCommit"]).toBe(mainSha);
    expect(body?.["baseOnDefault"]).toBe(true);
  });

  test("a branch whose own commit main does not hold says false", async () => {
    // Arrange
    const { root, branchSha } = await cloneWithOrigin("register-branch");

    // Act
    const body = await registerFrom(root, "feat/unmerged", branchSha, await probeBaseOnDefault(root, branchSha));

    // Assert
    expect(body?.["baseOnDefault"]).toBe(false);
  });

  test("a probe git could not answer leaves the field off — never a guess", async () => {
    // Arrange: a clone with no origin refs at all.
    const root = await makeRepo("register-no-origin");
    cleanups.push(root);
    const head = await headOf(root);

    // Act
    const body = await registerFrom(root, "main", head, await probeBaseOnDefault(root, head));

    // Assert
    expect(body !== undefined && "baseOnDefault" in body).toBe(false);
  });
});
