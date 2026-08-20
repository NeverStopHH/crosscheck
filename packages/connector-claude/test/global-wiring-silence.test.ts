/**
 * The §2.1 invariant RE-PROVEN under a user-level ("global") install
 * (finding #11): with hooks wired once at the user scope, they fire in
 * EVERY directory on the machine — so the trust rule must hold at the
 * config gate, not at the wiring. A session in a git repo WITHOUT the
 * committed .crosscheck.json must stay silent forever even though the
 * developer is logged in (stored ~/.crosscheck/config.json carries a hub
 * URL and key): zero hub traffic, zero disk artifacts, zero visible
 * output. Pinned from BOTH directions — the same repo WITH the committed
 * config reports — so the gate is provably the config, not an accident.
 *
 * Stored login, not CROSSCHECK_HUB_URL, on purpose: the env override is an
 * operator's explicit instruction (and the test suite's harness) and keeps
 * standing in; the stored fallback is what a merely logged-in developer
 * carries everywhere, which is exactly what a global install must not turn
 * into machine-wide reporting.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { saveConfig } from "@crosscheck/connector-core/config/config.ts";
import { makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";

const TIMEOUT_MS = "4000";

const paths: string[] = [];
const stops: (() => void)[] = [];

afterEach(async () => {
  for (const stop of stops) {
    stop();
  }
  stops.length = 0;
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

/** A hub that counts every request it receives, whatever the path. */
const startCountingHub = (): { readonly url: string; requests: () => number } => {
  let count = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      count += 1;
      return Response.json({
        ok: true,
        data: { session: { id: "cc_x", developerId: "dev_x" } },
      });
    },
  });
  stops.push(() => {
    server.stop(true);
  });
  return { url: `http://127.0.0.1:${server.port}`, requests: () => count };
};

const sessionStartPayload = (cwd: string, sessionId: string): string =>
  JSON.stringify({
    session_id: sessionId,
    cwd,
    hook_event_name: "SessionStart",
    source: "startup",
  });

const postToolUsePayload = (repo: string, sessionId: string): string =>
  JSON.stringify({
    session_id: sessionId,
    cwd: repo,
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: `${repo}/src/app.ts` },
    tool_response: {},
  });

const entriesOrNone = async (dir: string): Promise<readonly string[]> => {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
};

/** A home whose stored config points at the hub — a logged-in developer. */
const loggedInHome = async (label: string, hubUrl: string): Promise<string> => {
  const home = await makeHome(label);
  paths.push(home);
  await saveConfig(home, { version: 1, hubUrl, apiKey: "stored-key" });
  return home;
};

describe("global wiring in an unconnected repo (DESIGN.md §2.1)", () => {
  test("stored login alone reports nothing: no hub call, no disk, no output", async () => {
    // Arrange: a git repo with NO committed .crosscheck.json, a developer
    // whose stored login knows the hub — the machine-wide wiring shape
    const repo = await makeRepo("global-silent", {
      remote: "git@github.com:acme/private.git",
    });
    paths.push(repo);
    await writeRepoFile(repo, "src/app.ts", "export const a = 1;\n");
    const hub = startCountingHub();
    const home = await loggedInHome("global-silent", hub.url);
    const env: Env = {
      CROSSCHECK_HOME: home,
      CROSSCHECK_TIMEOUT_MS: TIMEOUT_MS,
    };

    // Act: the three hooks a real session fires first
    const startOut = await runHook(
      "session-start",
      sessionStartPayload(repo, "silent-uuid"),
      env,
    );
    const postOut = await runHook(
      "post-tool-use",
      postToolUsePayload(repo, "silent-uuid"),
      env,
    );
    const endOut = await runHook(
      "session-end",
      JSON.stringify({
        session_id: "silent-uuid",
        cwd: repo,
        hook_event_name: "SessionEnd",
        reason: "other",
      }),
      env,
    );

    // Assert: zero visible output, zero hub traffic, zero disk artifacts
    expect(startOut).toBe("");
    expect(postOut).toBe("");
    expect(endOut).toBe("");
    expect(hub.requests()).toBe(0);
    expect(await entriesOrNone(join(home, "sessions"))).toEqual([]);
    expect(await entriesOrNone(join(home, "spool"))).toEqual([]);
  });

  test("the committed config is the gate: the same repo WITH it reports", async () => {
    // Arrange: identical shape plus the one difference — .crosscheck.json
    const repo = await makeRepo("global-connected", {
      remote: "git@github.com:acme/api.git",
    });
    paths.push(repo);
    await writeRepoFile(repo, "src/app.ts", "export const a = 1;\n");
    const hub = startCountingHub();
    const home = await loggedInHome("global-connected", hub.url);
    await writeFile(
      join(repo, ".crosscheck.json"),
      `${JSON.stringify({ hubUrl: hub.url }, null, 2)}\n`,
      "utf8",
    );
    const env: Env = {
      CROSSCHECK_HOME: home,
      CROSSCHECK_TIMEOUT_MS: TIMEOUT_MS,
    };

    // Act
    await runHook("session-start", sessionStartPayload(repo, "loud-uuid"), env);
    await runHook("post-tool-use", postToolUsePayload(repo, "loud-uuid"), env);

    // Assert: the session registered (hub traffic) and state exists on disk
    expect(hub.requests()).toBeGreaterThan(0);
    expect(await entriesOrNone(join(home, "sessions"))).not.toEqual([]);
  });
});
