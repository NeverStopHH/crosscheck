/**
 * SessionStart reaps its own home's session-state corpses (trial finding M6).
 *
 * A state file is deleted at SessionEnd and nowhere else, so every killed
 * agent, closed terminal and budget-starved SessionEnd leaves one forever —
 * 100 of them on the trial machine. They are not inert: `spool/reap.ts
 * isSessionLive` refuses to remove a spool data file while its session's state
 * file exists, so each corpse pinned a delivered `.jsonl` that could never be
 * reaped.
 *
 * This runs the REAL `crosscheck hook session-start` against a throwaway hub,
 * because the interesting part is that the reap happens on the hook path at
 * all — not that the pure function works.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { runHook } from "../src/index.ts";
import {
  MAX_SPOOL_AGE_DAYS,
  MS_PER_DAY,
} from "@crosscheck/connector-core/constants.ts";
import {
  deriveSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const LIVE_SESSION_ID = "state-reap-live";

const paths: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const server of servers) {
    server.stop(true);
  }
  servers.length = 0;
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

const acceptingHub = (): string => {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        ok: true,
        data: {
          session: { id: `cc_${LIVE_SESSION_ID}`, developerId: "dev_1" },
          sessions: [],
          workContexts: [],
          absences: [],
          drafts: [],
          matches: [],
          candidates: [],
          accepted: 0,
          duplicates: 0,
          ignored: 0,
          rejected: 0,
        },
      }),
  });
  servers.push(server);
  return `http://127.0.0.1:${String(server.port)}`;
};

const seedState = async (
  home: string,
  repo: string,
  hubUrl: string,
  hostSessionKey: string,
  ageMs: number,
): Promise<void> => {
  const stamp = new Date(Date.now() - ageMs).toISOString();
  await writeSessionState(home, {
    ...deriveSessionState({
      hostSessionKey,
      repoId: REPO_ID,
      repoRoot: repo,
      hubUrl,
      developerId: "dev_1",
      startedAt: stamp,
    }),
    lastHeartbeatAt: stamp,
  });
};

const stateNames = async (home: string): Promise<readonly string[]> =>
  (await readdir(join(home, "sessions"))).sort();

const hookEnv = (home: string, hubUrl: string) => ({
  CROSSCHECK_HOME: home,
  HOME: home,
  CROSSCHECK_HUB_URL: hubUrl,
  CROSSCHECK_API_KEY: "test-key",
  CROSSCHECK_TIMEOUT_MS: "4000",
});

describe("SessionStart reaps zombie state files", () => {
  test("eight-day-old states go; a fresh one and the running session stay", async () => {
    // Arrange
    const repo = await makeRepo("state-reap", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("state-reap");
    paths.push(repo, home);
    const hubUrl = acceptingHub();
    const eightDaysMs = (MAX_SPOOL_AGE_DAYS + 1) * MS_PER_DAY;
    for (const id of ["zombie-1", "zombie-2", "zombie-3"]) {
      await seedState(home, repo, hubUrl, id, eightDaysMs);
    }
    await seedState(home, repo, hubUrl, "recent", 60_000);

    // Act: the real hook
    await runHook(
      "session-start",
      JSON.stringify({ session_id: LIVE_SESSION_ID, cwd: repo }),
      hookEnv(home, hubUrl),
    );

    // Assert: three corpses gone, the recent one and this session's own left
    const names = await stateNames(home);
    expect(names).not.toContain("zombie-1.json");
    expect(names).not.toContain("zombie-2.json");
    expect(names).not.toContain("zombie-3.json");
    expect(names).toContain("recent.json");
    expect(names).toContain(`${LIVE_SESSION_ID}.json`);
  });

  test("a home with nothing week-old loses nothing", async () => {
    // Arrange
    const repo = await makeRepo("state-reap-clean", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("state-reap-clean");
    paths.push(repo, home);
    const hubUrl = acceptingHub();
    await seedState(home, repo, hubUrl, "recent-a", 60_000);
    await seedState(home, repo, hubUrl, "recent-b", 2 * 60 * 60 * 1000);

    // Act
    await runHook(
      "session-start",
      JSON.stringify({ session_id: LIVE_SESSION_ID, cwd: repo }),
      hookEnv(home, hubUrl),
    );

    // Assert: a two-hour-old session is stale for DOCTOR's report and far too
    // young for a DELETION — the two thresholds are deliberately different
    const names = await stateNames(home);
    expect(names).toContain("recent-a.json");
    expect(names).toContain("recent-b.json");
  });
});
