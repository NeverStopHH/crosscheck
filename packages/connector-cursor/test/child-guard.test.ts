/**
 * The Tier-1 summarizer's child marker on the Cursor runner (trial finding
 * #14). A nested `claude -p` does not run Cursor hooks today — but a marker
 * that only SOME entries honour is the marker the next entry forgets, so the
 * cursor dispatcher exits on it before the budget like the Claude one: the
 * no-op JSON Cursor requires, zero hub requests, nothing under the home.
 *
 * The marker's spelling is operator-visible, so it is spelled out rather
 * than imported: this file must run — and go red — on a tree without it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdir, rm } from "node:fs/promises";

import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import {
  readSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import { CURSOR_NO_OP_OUTPUT, runCursorHook } from "../src/index.ts";
import type { CursorHookEvent } from "../src/index.ts";
import {
  AFTER_FILE_EDIT_INPUT,
  SESSION_END_INPUT,
  SESSION_START_INPUT,
  STOP_INPUT,
} from "./fixtures/cursor-contract/payloads.ts";
import { makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";
import { startSlowHub } from "../../connector-claude/test/fixtures/slow-hub.ts";
import type { MockHub } from "../../connector-claude/test/fixtures/slow-hub.ts";

const CHILD_MARKER = "CROSSCHECK_SUMMARIZER_CHILD";
const CONVERSATION = "conv-child-guard";

const paths: string[] = [];
const hubs: MockHub[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
  for (const hub of hubs) {
    hub.stop();
  }
  hubs.length = 0;
});

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly hub: MockHub;
  readonly file: string;
  readonly env: Env;
}

const fixture = async (label: string): Promise<Fixture> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  const file = await writeRepoFile(repo, "src/limiter.ts", "export const a = 1;\n");
  const hub = startSlowHub({ ingest: 0, end: 0, other: 0 });
  hubs.push(hub);
  return {
    repo,
    home,
    hub,
    file,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_TIMEOUT_MS: "2000",
    },
  };
};

const totalCalls = (hub: MockHub): number =>
  Object.values(hub.calls).reduce((sum, count) => sum + count, 0);

/** A fixture payload rooted in the test's repo under one conversation. */
const inRepo = (payload: object, fix: Fixture): string =>
  JSON.stringify({
    ...payload,
    conversation_id: CONVERSATION,
    ...("session_id" in payload ? { session_id: CONVERSATION } : {}),
    workspace_roots: [fix.repo],
    ...("file_path" in payload ? { file_path: fix.file } : {}),
  });

/**
 * The events that DO work on a fresh session without the marker (register,
 * capture, end). `stop` is not here: the cursor stop handler is silent on a
 * session it does not know, so a fresh-session `stop` row would pass on a
 * tree without the guard — a test that never reaches the broken path. It
 * gets a registered session below instead.
 */
const FRESH_EVENTS: readonly (readonly [CursorHookEvent, object])[] = [
  ["sessionStart", SESSION_START_INPUT],
  ["afterFileEdit", AFTER_FILE_EDIT_INPUT],
  ["sessionEnd", SESSION_END_INPUT],
];

const HOST_SESSION_KEY = `cur-${CONVERSATION}`;

/** A registered cursor session, as sessionStart would have left it; returns the state as written. */
const seedState = async (fix: Fixture): Promise<string> => {
  await writeSessionState(fix.home, {
    hostSessionKey: HOST_SESSION_KEY,
    crosscheckSessionId: `cc_${HOST_SESSION_KEY}`,
    workContextId: `wc_cc_${HOST_SESSION_KEY}`,
    repoId: "github.com/acme/api",
    repoRoot: fix.repo,
    hubUrl: fix.hub.url,
    developerId: "dev_self",
    startedAt: new Date().toISOString(),
  });
  return JSON.stringify(await readSessionState(fix.home, HOST_SESSION_KEY));
};

describe("cursor hooks under the summarizer child marker", () => {
  test.each(FRESH_EVENTS)(
    "%s answers the no-op JSON, makes no hub request, writes nothing",
    async (event, payload) => {
      // Arrange
      const fix = await fixture(`cursor-child-${event}`);

      // Act
      const out = await runCursorHook(event, inRepo(payload, fix), {
        ...fix.env,
        [CHILD_MARKER]: "1",
      });

      // Assert
      expect(out).toBe(CURSOR_NO_OP_OUTPUT);
      expect(totalCalls(fix.hub)).toBe(0);
      expect(await readdir(fix.home)).toEqual([]);
    },
  );

  test("stop on a registered session: no-op JSON, zero hub requests, state byte-identical, no turn counted", async () => {
    // Arrange: a session the stop handler WOULD count a turn on
    const fix = await fixture("cursor-child-stop");
    const before = await seedState(fix);

    // Act
    const out = await runCursorHook("stop", inRepo(STOP_INPUT, fix), {
      ...fix.env,
      [CHILD_MARKER]: "1",
    });

    // Assert
    expect(out).toBe(CURSOR_NO_OP_OUTPUT);
    expect(totalCalls(fix.hub)).toBe(0);
    expect(JSON.stringify(await readSessionState(fix.home, HOST_SESSION_KEY))).toBe(before);
    expect((await readSessionState(fix.home, HOST_SESSION_KEY))?.stopTurnCount).toBe(0);
    expect(await readdir(fix.home)).toEqual(["sessions"]);
  });

  test("positive control: without the marker the same stop counts a turn on the seeded session", async () => {
    // The seeded path reaches the handler — so the silence above is the guard's.
    const fix = await fixture("cursor-stop-control");
    await seedState(fix);

    await runCursorHook("stop", inRepo(STOP_INPUT, fix), fix.env);

    expect((await readSessionState(fix.home, HOST_SESSION_KEY))?.stopTurnCount).toBe(1);
  });

  test("positive control: without the marker sessionStart registers and writes state", async () => {
    const fix = await fixture("cursor-control");

    await runCursorHook("sessionStart", inRepo(SESSION_START_INPUT, fix), fix.env);

    expect(fix.hub.calls.register).toBeGreaterThanOrEqual(1);
    expect(await readSessionState(fix.home, `cur-${CONVERSATION}`)).not.toBeNull();
  });
});
