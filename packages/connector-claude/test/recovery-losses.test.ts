/**
 * Review LOW (2026-10-01): "not every register carries the report". A
 * PostToolUse with no state file — a hook installed mid-session — recovers by
 * registering the session itself (hooks/post-tool-use.ts recoverState), and
 * that register sent no `losses`, so the recovered row read "never reported"
 * until its first heartbeat. LOSS-8's rule is every call, zeros included.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { EMPTY_LOSS_REPORT } from "@crosscheck/schema";

import { runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

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

/** A hub that answers every call and keeps the bodies of POST /api/sessions. */
const startRegisterCapture = (): { readonly url: string; readonly bodies: Record<string, unknown>[] } => {
  const bodies: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (request.method === "POST" && pathname === "/api/sessions") {
        bodies.push((await request.json()) as Record<string, unknown>);
      }
      return Response.json({ ok: true, data: { session: { id: "cc_x", developerId: "dev_self" } } });
    },
  });
  stops.push(() => {
    server.stop(true);
  });
  return { url: `http://127.0.0.1:${String(server.port)}`, bodies };
};

describe("a recovered session's register carries the loss report", () => {
  test("a PostToolUse with no state file registers with losses, zeros included", async () => {
    // Arrange: a connected repo, a clean home, no state file for the session
    const hub = startRegisterCapture();
    const repo = await makeRepo("recovery-losses", { remote: "git@github.com:acme/api.git" });
    const home = await makeHome("recovery-losses");
    paths.push(repo, home);
    const env: Env = {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_SSH_CANONICALIZE: "off",
    };

    // Act
    await runHook(
      "post-tool-use",
      JSON.stringify({
        session_id: "recovery-losses-uuid",
        cwd: repo,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: join(repo, "src/limiter.ts") },
        tool_response: {},
      }),
      env,
    );

    // Assert
    expect(hub.bodies.length).toBeGreaterThan(0);
    expect(hub.bodies[0]?.["losses"]).toEqual(EMPTY_LOSS_REPORT);
  });
});
