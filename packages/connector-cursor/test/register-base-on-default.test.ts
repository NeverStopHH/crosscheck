/**
 * Cursor's sessionStart says whether its base was already on the default
 * branch (pilot finding, 2026-10-05) — the hub never lands such a context by
 * base ancestry (server services/landed.ts). A capturing hub on an ephemeral
 * port reads the register body; real git decides the answer.
 */
import { serveLoopback } from "../../connector-core/test/fixtures/loopback-serve.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import type { Env } from "@crosscheck/connector-core/config/paths.ts";

import { runCursorHook } from "../src/index.ts";
import { SESSION_START_INPUT } from "./fixtures/cursor-contract/payloads.ts";
import { git, makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";

const REMOTE = "git@github.com:acme/api.git";
const registers: Record<string, unknown>[] = [];
const cleanups: string[] = [];

const server = serveLoopback({
  port: 0,
  fetch: async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/sessions" && request.method === "POST") {
      const body = (await request.json()) as Record<string, unknown>;
      registers.push(body);
      return Response.json({ ok: true, data: { session: { id: body["id"], developerId: "dev_cursor" } } });
    }
    return Response.json({ ok: true, data: {} });
  },
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

/** A clone whose origin/main holds the initial commit, checked out on `branch`. */
const cloneOn = async (label: string, branch: string, ownCommit: boolean): Promise<{ repo: string; env: Env }> => {
  const repo = await makeRepo(label, { remote: REMOTE });
  const home = await makeHome(label);
  cleanups.push(repo, home);
  await git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  await git(repo, ["checkout", "-q", "-b", branch]);
  if (ownCommit) {
    await writeRepoFile(repo, "src/own.ts", "export const own = 1;\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-q", "-m", "own work"]);
  }
  return {
    repo,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: `http://127.0.0.1:${String(server.port)}`,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_TIMEOUT_MS: "4000",
    },
  };
};

const startIn = async (repo: string, env: Env, conversationId: string): Promise<Record<string, unknown> | undefined> => {
  const before = registers.length;
  await runCursorHook(
    "sessionStart",
    JSON.stringify({ ...SESSION_START_INPUT, conversation_id: conversationId, session_id: conversationId, workspace_roots: [repo] }),
    env,
  );
  return registers[before];
};

describe("Cursor's register carries baseOnDefault", () => {
  test("a branch cut from main with nothing of its own says its base is already on it", async () => {
    // Arrange
    const { repo, env } = await cloneOn("cursor-base-cut", "feat/cut", false);

    // Act
    const body = await startIn(repo, env, "conv-base-cut");

    // Assert
    expect(body?.["baseOnDefault"]).toBe(true);
  });

  test("a branch with its own commit says its base is not", async () => {
    // Arrange
    const { repo, env } = await cloneOn("cursor-base-own", "feat/own", true);

    // Act
    const body = await startIn(repo, env, "conv-base-own");

    // Assert
    expect(body?.["baseOnDefault"]).toBe(false);
  });
});
