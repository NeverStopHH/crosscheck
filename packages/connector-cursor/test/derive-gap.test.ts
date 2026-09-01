/**
 * THE GAP, STATED AS THREE ASSERTIONS — and the only file here that could be
 * RUN before the gap was closed.
 *
 * Its siblings (derive.test.ts, derive-doctor.test.ts) import modules this
 * step created, so on the base commit they fail with "cannot find module".
 * That is an honest red for a new module and a weak one for a BEHAVIOUR: it
 * says the file is new, not that Cursor used to derive nothing. This file
 * imports only what existed before — the connector's own entry point and core
 * session state — so it runs on the base commit and fails there for the
 * reason the whole step exists:
 *
 *   1. `beforeSubmitPrompt` was not a registered event, so the only Cursor
 *      payload carrying a prompt never reached this connector at all.
 *   2. `set_intent` inside Cursor set `ghostPending` and NOTHING ever paid
 *      it — the debt sat in the state file for the session's whole life and
 *      no surface said so.
 *   3. `stop` counted the turn and stopped there: no gate, no fire, whatever
 *      the turn concluded.
 *
 * Deliberately NOT asserted here: what the workers then produce. That needs
 * the fake model and the spool, which is derive.test.ts's job — and mixing
 * the two would cost this file the property that makes it worth having.
 */
import { afterEach, afterAll, describe, expect, test } from "bun:test";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  readSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";

import type { Env } from "@crosscheck/connector-core/config/paths.ts";

import { isCursorHookEvent, runCursorHook } from "../src/index.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

/** A throwaway hub on this task's own port range, never 7100. */
const HUB_PORT = 7614;
const server = Bun.serve({
  port: HUB_PORT,
  fetch: () => new Response("not found", { status: 404 }),
});
const HUB_URL = `http://127.0.0.1:${String(server.port)}`;

const CONV = "conv-gap-1";
const HOST_KEY = `cur-${CONV}`;
const paths: string[] = [];

afterEach(async () => {
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

afterAll(() => {
  server.stop(true);
});

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly env: Env;
}

const fixture = async (
  label: string,
  overrides: Record<string, unknown> = {},
): Promise<Fixture> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  await writeSessionState(home, {
    hostSessionKey: HOST_KEY,
    crosscheckSessionId: `cc_${HOST_KEY}`,
    workContextId: `wc_cc_${HOST_KEY}`,
    repoId: "github.com/acme/api",
    repoRoot: repo,
    hubUrl: HUB_URL,
    developerId: "dev_self",
    startedAt: new Date().toISOString(),
    workContextTitle: "main @ api",
    workContextStatus: "analyzing",
    ...overrides,
  });
  return {
    repo,
    home,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: HUB_URL,
      CROSSCHECK_API_KEY: "test-key",
      CURSOR_PROJECT_DIR: repo,
      // No model may run in this file: a missing binary is the point at
      // which every assertion below has already been decided.
      CROSSCHECK_SUMMARIZER_CMD: "/nonexistent/crosscheck-no-model",
      PATH: process.env["PATH"],
    },
  };
};

const stopPayload = (fix: Fixture, extra: object = {}): string =>
  JSON.stringify({
    conversation_id: CONV,
    hook_event_name: "stop",
    workspace_roots: [fix.repo],
    status: "completed",
    ...extra,
  });

describe("what Cursor could not do before this step", () => {
  test("beforeSubmitPrompt is a registered event — the only payload carrying a prompt", async () => {
    // Arrange
    const fix = await fixture("gap-prompt-event");

    // Assert: the event exists at all…
    expect(isCursorHookEvent("beforeSubmitPrompt")).toBe(true);

    // …and running it books the derived-intent fire.
    await runCursorHook(
      "beforeSubmitPrompt",
      JSON.stringify({
        conversation_id: CONV,
        hook_event_name: "beforeSubmitPrompt",
        workspace_roots: [fix.repo],
        prompt: "why does the refresh call 500 after the key rotation",
      }),
      fix.env,
    );
    expect((await readSessionState(fix.home, HOST_KEY))?.intentFireCount).toBe(1);
  });

  test("a ghost debt is PAID, not left to rot in the state file", async () => {
    // Arrange: exactly what set_intent leaves behind inside Cursor.
    const fix = await fixture("gap-ghost-debt", {
      ghostPending: true,
      workContextIntent: "Fix the refresh 500s after the key rotation",
    });

    // Act
    await runCursorHook("stop", stopPayload(fix), fix.env);
    await Bun.sleep(2000);

    // Assert: the flag is claimed. What the worker then decides (the hub here
    // answers 404, so it books noHubAnswer) is another file's business — the
    // gap is that nothing used to claim it at all.
    expect((await readSessionState(fix.home, HOST_KEY))?.ghostPending).toBe(false);
  }, 20_000);

  test("stop runs the Tier-1 gate, not only the turn counter", async () => {
    // Arrange
    const fix = await fixture("gap-summarizer");
    const transcript = join(fix.home, "transcript.jsonl");
    await writeFile(
      transcript,
      `${[
        JSON.stringify({
          role: "user",
          text: "the refresh endpoint 500s after we rotate the key",
        }),
        JSON.stringify({
          role: "assistant",
          text: "ran bun test src/auth — 3 tests failed with TypeError: cannot read token",
        }),
        JSON.stringify({
          role: "assistant",
          text: "Root cause: the refresh path reads the retired key; all tests passing now.",
        }),
      ].join("\n")}\n`,
      "utf8",
    );

    // Act
    await runCursorHook("stop", stopPayload(fix, { transcript_path: transcript }), fix.env);

    // Assert: the turn is counted AND the gate fired on it.
    const state = await readSessionState(fix.home, HOST_KEY);
    expect(state?.stopTurnCount).toBe(1);
    expect(state?.summarizerFireCount).toBe(1);
  }, 20_000);
});
