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
 * The same maintenance region sweeps abandoned `writePrivateFile` temp
 * siblings (pilot finding, 2026-10-06: 40 in one machine's `state/`, aged up
 * to 925 h, and still being produced). The pure sweep is pinned in
 * connector-core/test/abandoned-temps.test.ts; this file pins that the hook
 * runs it.
 *
 * This runs the REAL `crosscheck hook session-start` against a throwaway hub,
 * because the interesting part is that the reap happens on the hook path at
 * all — not that the pure function works.
 */
import { serveLoopback } from "../../connector-core/test/fixtures/loopback-serve.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runHook } from "../src/index.ts";
import {
  ABANDONED_TEMP_MAX_AGE_MS,
  ABANDONED_TEMP_SWEEP_MAX_PER_RUN,
  MAX_SPOOL_AGE_DAYS,
  MS_PER_DAY,
} from "@crosscheck/connector-core/constants.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import { readCaptureLosses } from "@crosscheck/connector-core/state/loss-ledger.ts";
import {
  deriveSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import {
  makeHome,
  makeRepo,
  seedAbandonedTemps,
} from "../../connector-core/test/helpers.ts";
import { TEAMMATE_NAME, startSlowHub } from "./fixtures/slow-hub.ts";

const REPO_ID = "github.com/acme/api";
const LIVE_SESSION_ID = "state-reap-live";
/**
 * The review's backlog: the uncapped sweep took the real hook to 1006 ms
 * with it (default timeout, fast hub), past the 1000 ms budget.
 */
const LARGE_BACKLOG = 20_000;
/** Seeding twenty thousand files is most of this test's time, not the hook. */
const LARGE_BACKLOG_TEST_TIMEOUT_MS = 60_000;

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
  const server = serveLoopback({
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

/**
 * A session that has said nothing for `ageMs` — stamps AND file mtime, because
 * the reaper measures silence off the newest of the three
 * (`sessionSilentForMs`, state/session-scan.ts). That is what stops it
 * deleting a live session's state file: a session whose every edit lands in a
 * foreign checkout never heartbeats, so on the stamps alone it would look a
 * week dead while its hooks were still writing the file.
 */
const seedState = async (
  home: string,
  repo: string,
  hubUrl: string,
  hostSessionKey: string,
  ageMs: number,
): Promise<void> => {
  const when = new Date(Date.now() - ageMs);
  const stamp = when.toISOString();
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
  await utimes(join(home, "sessions", `${hostSessionKey}.json`), when, when);
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

/** A temp sibling in `<home>/state`, its mtime `ageMs` in the past. */
const seedStateTemp = async (
  home: string,
  name: string,
  ageMs: number,
): Promise<void> => {
  await mkdir(join(home, "state"), { recursive: true });
  const path = join(home, "state", name);
  await writeFile(path, "", "utf8");
  const when = new Date(Date.now() - ageMs);
  await utimes(path, when, when);
};

describe("SessionStart sweeps abandoned temp siblings", () => {
  test("a temp past ABANDONED_TEMP_MAX_AGE_MS goes; a fresh one stays", async () => {
    // Arrange: the two shapes the pilot machine had — an hour old and weeks old
    const repo = await makeRepo("temp-sweep", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("temp-sweep");
    paths.push(repo, home);
    const hubUrl = acceptingHub();
    const abandoned = "0123456789abcdef-hooks.json.tmp-4242-k3j9x0qa";
    const inFlight = "0123456789abcdef.json.tmp-4243-p0w8rt2z";
    await seedStateTemp(home, abandoned, ABANDONED_TEMP_MAX_AGE_MS + MS_PER_DAY);
    await seedStateTemp(home, inFlight, 60 * 60 * 1000);

    // Act: the real hook
    await runHook(
      "session-start",
      JSON.stringify({ session_id: LIVE_SESSION_ID, cwd: repo }),
      hookEnv(home, hubUrl),
    );

    // Assert
    const names = await readdir(join(home, "state"));
    expect(names).not.toContain(abandoned);
    expect(names).toContain(inFlight);
  });

  test(
    "a 20 000-orphan backlog never costs the briefing or books a hook timeout",
    async () => {
      // Arrange: the review's probe — a fast hub with a teammate to brief
      // about, the DEFAULT request timeout (so the real 1000 ms budget and
      // 400 ms reserve), and a backlog the uncapped sweep needed over a
      // second for
      const hub = startSlowHub({ ingest: 0, end: 0, other: 0 });
      const repo = await makeRepo("temp-sweep-backlog", {
        remote: "git@github.com:acme/api.git",
      });
      const home = await makeHome("temp-sweep-backlog");
      paths.push(repo, home);
      await seedAbandonedTemps(
        join(home, "state"),
        LARGE_BACKLOG,
        ABANDONED_TEMP_MAX_AGE_MS + MS_PER_DAY,
      );

      try {
        // Act: the real hook
        const out = await runHook(
          "session-start",
          JSON.stringify({ session_id: LIVE_SESSION_ID, cwd: repo }),
          {
            CROSSCHECK_HOME: home,
            HOME: home,
            CROSSCHECK_HUB_URL: hub.url,
            CROSSCHECK_API_KEY: "test-key",
          },
        );

        // Assert: the briefing arrived, nothing was booked as a timeout, and
        // this run took at most its cap — the rest is the next session's
        expect(out).toContain(TEAMMATE_NAME);
        const losses = await readCaptureLosses(home, repoKey(hub.url, REPO_ID));
        expect(losses.byDetail["hook_timed_out:session-start"]).toBeUndefined();
        const left = (await readdir(join(home, "state"))).filter((name) =>
          name.startsWith("seeded-"),
        );
        expect(left.length).toBeGreaterThanOrEqual(
          LARGE_BACKLOG - ABANDONED_TEMP_SWEEP_MAX_PER_RUN,
        );
      } finally {
        hub.stop();
      }
    },
    LARGE_BACKLOG_TEST_TIMEOUT_MS,
  );
});
