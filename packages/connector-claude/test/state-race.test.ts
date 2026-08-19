/**
 * Sibling hooks racing over the session-state file. Claude Code can run tools
 * in parallel, so a PostToolUse still in flight (spool flush against the hub)
 * overlaps a PreToolUse for the next tool — and a whole-file read-modify-write
 * would let the slower hook write back a stale snapshot, erasing the faster
 * one's markers ("one ask per file per session", §10 risk 1).
 *
 * The interleavings here are DETERMINISTIC, not sleep-and-hope: the hub
 * fixture's latency dial holds the slow hook open while the fast one runs to
 * completion inside its window.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import {
  readSessionState,
  updateSessionState,
  withTripwireAsked,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";
import { activeTeammateSession, startHintHub } from "../../connector-core/test/fixtures/hint-hub.ts";
import type { HintHub, HintHubLatency } from "../../connector-core/test/fixtures/hint-hub.ts";

const REPO_ID = "github.com/acme/api";
const SESSION_ID = "state-race-uuid";
const EDITED_FILE = "src/auth/refresh.ts";
const OTHER_FILE = "src/auth/token.ts";

/**
 * Holds the slow hook's hub leg open long enough for the fast hook to finish
 * (~50 ms wait + ~50 ms hook), with margin, while staying under the 400 ms
 * per-request abort that would end the flush early.
 */
const SLOW_LEG_MS = 350;
const OVERLAP_WAIT_MS = 50;

const paths: string[] = [];
const hubs: HintHub[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
  for (const hub of hubs) {
    hub.stop();
  }
  hubs.length = 0;
});

const sessionState = (repo: string, hubUrl: string): SessionState => ({
  hostSessionKey: SESSION_ID,
  crosscheckSessionId: `cc_${SESSION_ID}`,
  workContextId: `wc_cc_${SESSION_ID}`,
  repoId: REPO_ID,
  repoRoot: repo,
  hubUrl,
  developerId: "dev_self",
  startedAt: new Date().toISOString(),
  lastHeartbeatAt: null,
  seenTargets: [],
  deliveredHintRefs: [],
  deliveredHintHashes: [],
  tripwireAskedFiles: [],
  briefingSolvedRefs: [],
  foreignRepoDrops: 0,
  stopTurnCount: 0,
  summarizerFireCount: 0,
  summarizerLastFireTurn: null,
  summarizerEstimatedTokens: 0,
});

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly hub: HintHub;
  readonly env: Env;
}

const fixture = async (
  label: string,
  latency: HintHubLatency,
): Promise<Fixture> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  await writeRepoFile(repo, EDITED_FILE, "export const a = 1;\n");
  await writeRepoFile(repo, OTHER_FILE, "export const b = 2;\n");
  const hub = startHintHub(latency);
  hub.setTripwireSessions([activeTeammateSession()]);
  hubs.push(hub);
  await writeSessionState(home, sessionState(repo, hub.url));
  return {
    repo,
    home,
    hub,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: "test-key",
    },
  };
};

const toolPayload = (
  repo: string,
  hookEventName: string,
  filePath: string,
): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd: repo,
    hook_event_name: hookEventName,
    tool_name: "Edit",
    tool_input: { file_path: `${repo}/${filePath}` },
    tool_response: {},
  });

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

describe("session-state writes survive sibling hooks", () => {
  test("a PostToolUse in flight cannot erase a tripwire marker", async () => {
    // Arrange — the flush leg of PostToolUse is held open by the hub
    const { repo, home, env } = await fixture("erase", {
      candidates: 0,
      tripwire: 0,
      records: SLOW_LEG_MS,
    });

    // Act — PostToolUse(a) starts first and finishes LAST; PreToolUse(b)
    // asks and records its marker inside a's window
    const post = runHook("post-tool-use", toolPayload(repo, "PostToolUse", OTHER_FILE), env);
    await sleep(OVERLAP_WAIT_MS);
    const ask = await runHook("pre-tool-use", toolPayload(repo, "PreToolUse", EDITED_FILE), env);
    await post;

    // Assert — the ask happened, and BOTH hooks' markers survive
    expect(ask).toContain('"ask"');
    const state = await readSessionState(home, SESSION_ID);
    expect(state?.tripwireAskedFiles).toContain(EDITED_FILE);
    expect(state?.seenTargets).toContain(OTHER_FILE);
  });

  test("two simultaneous PreToolUse on one file ask exactly once", async () => {
    // Arrange — the tripwire leg is slow enough that both hooks pass the
    // already-asked check before either records the ask
    const { repo, env } = await fixture("doubleask", {
      candidates: 0,
      tripwire: 150,
    });
    const payload = toolPayload(repo, "PreToolUse", EDITED_FILE);

    // Act
    const [first, second] = await Promise.all([
      runHook("pre-tool-use", payload, env),
      runHook("pre-tool-use", payload, env),
    ]);

    // Assert — one ask, one silence; the CLAIM of the marker is atomic even
    // though both raced past the pre-check and both paid the hub call
    const asks = [first, second].filter((stdout) => stdout.length > 0);
    expect(asks.length).toBe(1);
  });

  test("concurrent updateSessionState calls both land", async () => {
    // Arrange
    const repo = await makeRepo("merge", { remote: "git@github.com:acme/api.git" });
    const home = await makeHome("merge");
    paths.push(repo, home);
    await writeSessionState(home, sessionState(repo, "http://127.0.0.1:1"));

    // Act — two writers, each transforming the FRESHEST state under the lock
    await Promise.all([
      updateSessionState(home, SESSION_ID, (fresh) =>
        withTripwireAsked(fresh, "a.ts"),
      ),
      updateSessionState(home, SESSION_ID, (fresh) =>
        withTripwireAsked(fresh, "b.ts"),
      ),
    ]);

    // Assert — neither write clobbered the other
    const state = await readSessionState(home, SESSION_ID);
    expect(state?.tripwireAskedFiles).toContain("a.ts");
    expect(state?.tripwireAskedFiles).toContain("b.ts");
  });

  test("a declined transform writes nothing and reports false", async () => {
    // Arrange
    const repo = await makeRepo("decline", { remote: "git@github.com:acme/api.git" });
    const home = await makeHome("decline");
    paths.push(repo, home);
    const base = sessionState(repo, "http://127.0.0.1:1");
    await writeSessionState(home, withTripwireAsked(base, "a.ts"));

    // Act — the transform sees the marker already present and declines
    const claimed = await updateSessionState(home, SESSION_ID, (fresh) =>
      fresh.tripwireAskedFiles.includes("a.ts")
        ? null
        : withTripwireAsked(fresh, "a.ts"),
    );

    // Assert
    expect(claimed).toBe(false);
    const state = await readSessionState(home, SESSION_ID);
    expect(state?.tripwireAskedFiles).toEqual(["a.ts"]);
  });
});
