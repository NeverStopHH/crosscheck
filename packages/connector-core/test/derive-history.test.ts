/**
 * THE DERIVE COUNTERS OUTLIVE THEIR SESSION (state/derive-history.ts): the
 * session-state file is deleted at SessionEnd, and with it every number that
 * could say why nothing was drafted — so a doctor run after the session
 * closed read "no live sessions" and said nothing. The end flow now folds the
 * session's derive digest into a bounded per-repo history first.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { DERIVE_HISTORY_MAX_SESSIONS } from "../src/constants.ts";
import { deriveHistoryPath, repoKey } from "../src/config/paths.ts";
import { endSessionFlow } from "../src/flows/end-session.ts";
import { foldDeriveHistory, readDeriveHistory } from "../src/state/derive-history.ts";
import { readSessionState, writeSessionState } from "../src/state/session-state.ts";
import type { SessionStateInput } from "../src/state/session-state.ts";
import { makeHome } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
const DEAD_HUB_URL = "http://127.0.0.1:1";
const KEY = repoKey(DEAD_HUB_URL, REPO_ID);

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.map((path) => rm(path, { recursive: true, force: true })));
  homes.length = 0;
});

const home = async (label: string): Promise<string> => {
  const path = await makeHome(label);
  homes.push(path);
  return path;
};

const seed = (at: string, hostSessionKey: string, overrides: Partial<SessionStateInput> = {}): Promise<void> =>
  writeSessionState(at, {
    hostSessionKey,
    crosscheckSessionId: `cc_${hostSessionKey}`,
    workContextId: `wc_cc_${hostSessionKey}`,
    repoId: REPO_ID,
    repoRoot: "/tmp/repo",
    hubUrl: DEAD_HUB_URL,
    developerId: "dev_self",
    startedAt: new Date().toISOString(),
    ...overrides,
  });

describe("foldDeriveHistory", () => {
  test("keeps each ended session's counters, newest first", async () => {
    // Arrange
    const at = await home("history-two");
    await seed(at, "first-uuid", {
      stopTurnCount: 3,
      intentFireCount: 3,
      intentFailCount: 1,
      intentRefusedCount: 1,
      intentSkippedCount: 1,
    });
    await seed(at, "second-uuid", {
      summarizerFireCount: 1,
      summarizerFailCount: 1,
      summarizerLastFailure: "could not start: Executable not found",
    });

    // Act
    await foldDeriveHistory(at, "first-uuid", new Date());
    await foldDeriveHistory(at, "second-uuid", new Date());
    const history = await readDeriveHistory(at, KEY);

    // Assert
    expect(history.folded).toBe(2);
    expect(history.sessions).toHaveLength(2);
    expect(history.sessions[0]?.summarizerLastFailure).toBe("could not start: Executable not found");
    expect(history.sessions[1]?.stopTurnCount).toBe(3);
    expect(history.sessions[1]?.intentFailCount).toBe(1);
    // A refusal and a skip outlive the session too: without them the ended
    // session's answers would read as runs that never reported back.
    expect(history.sessions[1]?.intentRefusedCount).toBe(1);
    expect(history.sessions[1]?.intentSkippedCount).toBe(1);
  });

  test("is bounded to the newest DERIVE_HISTORY_MAX_SESSIONS and counts every fold", async () => {
    const at = await home("history-ring");
    const total = DERIVE_HISTORY_MAX_SESSIONS + 3;
    for (let i = 0; i < total; i += 1) {
      await seed(at, `ring-${String(i)}-uuid`, { stopTurnCount: i });
      await foldDeriveHistory(at, `ring-${String(i)}-uuid`, new Date());
    }

    const history = await readDeriveHistory(at, KEY);

    expect(history.folded).toBe(total);
    expect(history.sessions).toHaveLength(DERIVE_HISTORY_MAX_SESSIONS);
    expect(history.sessions[0]?.stopTurnCount).toBe(total - 1);
  });

  test("a session with no state file folds nothing", async () => {
    const at = await home("history-none");

    await foldDeriveHistory(at, "ghost-uuid", new Date());

    expect((await readDeriveHistory(at, KEY)).folded).toBe(0);
  });

  test("a corrupt history reads as empty and is replaced, never thrown", async () => {
    const at = await home("history-corrupt");
    await mkdir(dirname(deriveHistoryPath(at, KEY)), { recursive: true });
    await writeFile(deriveHistoryPath(at, KEY), "{not json", "utf8");
    await seed(at, "after-uuid", { stopTurnCount: 2 });

    expect((await readDeriveHistory(at, KEY)).sessions).toEqual([]);
    await foldDeriveHistory(at, "after-uuid", new Date());
    expect((await readDeriveHistory(at, KEY)).sessions).toHaveLength(1);
  });
});

describe("the history belongs to the session's own repo", () => {
  test("a SessionEnd fired from another repo's cwd still files the digest under the session's repo", async () => {
    // Arrange: the session worked on acme/api; its SessionEnd hook resolved
    // the cwd of a sibling checkout (acme/web) as the hook's repo
    const at = await home("history-own-repo");
    await seed(at, "own-repo-uuid", { stopTurnCount: 4 });
    const otherKey = repoKey(DEAD_HUB_URL, "github.com/acme/web");

    // Act
    await endSessionFlow({
      home: at,
      repoKey: otherKey,
      hub: { hubUrl: DEAD_HUB_URL, apiKey: "k", timeoutMs: 400, home: at, repoKey: otherKey, now: () => new Date() },
      hostSessionKey: "own-repo-uuid",
      crosscheckSessionId: "cc_own-repo-uuid",
      developerId: "dev_self",
      flushBudgetMs: 200,
      now: () => new Date(),
    });

    // Assert
    expect((await readDeriveHistory(at, KEY)).sessions[0]?.stopTurnCount).toBe(4);
    expect((await readDeriveHistory(at, otherKey)).folded).toBe(0);
  });
});

describe("the end flow folds before it deletes", () => {
  test("SessionEnd leaves the digest behind and the state file gone", async () => {
    // Arrange
    const at = await home("history-end");
    await seed(at, "ended-uuid", { stopTurnCount: 7, summarizerFireCount: 2, summarizerNoneCount: 2 });

    // Act
    await endSessionFlow({
      home: at,
      repoKey: KEY,
      hub: { hubUrl: DEAD_HUB_URL, apiKey: "k", timeoutMs: 400, home: at, repoKey: KEY, now: () => new Date() },
      hostSessionKey: "ended-uuid",
      crosscheckSessionId: "cc_ended-uuid",
      developerId: "dev_self",
      flushBudgetMs: 200,
      now: () => new Date(),
    });

    // Assert
    expect(await readSessionState(at, "ended-uuid")).toBeNull();
    const history = await readDeriveHistory(at, KEY);
    expect(history.sessions[0]?.stopTurnCount).toBe(7);
    expect(history.sessions[0]?.summarizerNoneCount).toBe(2);
    // ...with WHEN it ended, which is what tells a run that finished after
    // SessionEnd from a worker that never reported back.
    expect(typeof history.sessions[0]?.endedAt).toBe("string");
  });
});
