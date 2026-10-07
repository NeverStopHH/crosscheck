/**
 * A POSTTOOLUSE RECOVERY IS A STATE-LESS REGISTER LIKE ANY OTHER (review-2
 * round 9, M1 + M2). recoverState walked the life ladder itself under a fresh
 * epoch deriveSessionState minted: after a week asleep, or beside a resume
 * killed after its register, it put that mint onto a life the hub held under
 * another epoch, and left the state without the agent kind SessionEnd needs.
 * It runs registerSessionFlow in recovery mode now, as connector-cursor's
 * does: the epoch is decided the one way every register decides it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { sessionEpochPathForSlug, sessionSlug } from "@crosscheck/connector-core/config/paths.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";

const HOST_KEY = "recover-uuid";
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

/** A hub that takes every register and answers everything else with nothing. */
const startHub = (): string => {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/sessions" && request.method === "POST") {
        return Response.json({ ok: true, data: { session: { id: `cc_${HOST_KEY}`, developerId: "dev_recover" } } });
      }
      return Response.json({ ok: true, data: {} });
    },
  });
  stops.push(() => {
    server.stop(true);
  });
  return `http://127.0.0.1:${String(server.port)}`;
};

describe("a PostToolUse that finds no state", () => {
  test("recovers on the epoch a killed register reserved, and names its agent kind", async () => {
    // Arrange: a SessionStart killed after its register reserved an epoch, before its state
    const repo = await makeRepo("recover-epoch", { remote: "git@github.com:acme/api.git" });
    const home = await makeHome("recover-epoch");
    paths.push(repo, home);
    await writeRepoFile(repo, "src/limiter.ts", "export const a = 1;\n");
    const epoch = crypto.randomUUID();
    const reservation = sessionEpochPathForSlug(home, sessionSlug(HOST_KEY));
    await mkdir(dirname(reservation), { recursive: true });
    await writeFile(reservation, `${JSON.stringify({ epoch })}\n`);
    const hubUrl = startHub();
    const env: Env = {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_TIMEOUT_MS: TIMEOUT_MS,
    };

    // Act
    await runHook(
      "post-tool-use",
      JSON.stringify({
        session_id: HOST_KEY,
        cwd: repo,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: `${repo}/src/limiter.ts` },
        tool_response: {},
      }),
      env,
    );

    // Assert
    const state = await readSessionState(home, HOST_KEY);
    expect(state?.seqEpoch).toBe(epoch);
    expect(state?.agentKind).toBe("claude-code");
    expect(state?.briefingPending).toBe(true);
  });
});
