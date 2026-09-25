/**
 * WHEN THE BACKGROUND FETCH STARTS, and when it must not
 * (docs/1.0/landed-changes.md, step 2).
 *
 * Three hooks ask for it — session start, every prompt, every edit — so the
 * question "is one due?" is asked constantly and answered "no" almost always.
 * What is pinned here:
 * - at most one fetch per clone per LANDING_FETCH_INTERVAL_MS, however many
 *   hooks race for it, and worktrees of one clone share that allowance
 *   because they share the refs;
 * - the attempt is BOOKED before the worker starts, so a worker that dies
 *   costs one interval, never a storm;
 * - either off switch, or an empty landing list, starts nothing and writes
 *   nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LANDING_FETCH_INTERVAL_MS } from "../src/constants.ts";
import { landingFetchRecordPath } from "../src/config/paths.ts";
import {
  claimLandingFetch,
  cloneKeyOf,
  readLandingFetchRecord,
  recordLandingFetch,
} from "../src/landed-changes/fetch-state.ts";
import { requestLandingFetch } from "../src/landed-changes/fetch-trigger.ts";
import { makeHome } from "./helpers.ts";
import { gitIn, isolatedGitEnv, makeLandingRepos } from "./fixtures/landing-repos.ts";
import type { LandingRepos } from "./fixtures/landing-repos.ts";

const HEAVY_SETUP_MS = 60_000;
const MINUTE_MS = 60_000;
const T0 = new Date("2026-09-25T09:00:00Z");
const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

/** The developer's own ssh, askpass and Crosscheck settings are shut out. */
const ENV = isolatedGitEnv();

interface Setup {
  readonly repos: LandingRepos;
  readonly home: string;
  /** Every root a worker was started for, in order. */
  readonly started: string[];
  readonly request: (options?: {
    readonly now?: Date;
    readonly root?: string;
    readonly env?: Record<string, string | undefined>;
  }) => ReturnType<typeof requestLandingFetch>;
}

const setup = async (label: string): Promise<Setup> => {
  const repos = await makeLandingRepos(label);
  const home = await makeHome(label);
  paths.push(repos.base, home);
  const started: string[] = [];
  return {
    repos,
    home,
    started,
    request: (options = {}) =>
      requestLandingFetch({
        home,
        root: options.root ?? repos.reader,
        env: options.env ?? ENV,
        now: options.now ?? T0,
        startWorker: (root) => {
          started.push(root);
        },
      }),
  };
};

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("how often", () => {
  test(
    "starts one worker, then none until the interval has passed",
    async () => {
      const s = await setup("lft-interval");

      expect(await s.request()).toBe("started");
      expect(await s.request({ now: at(MINUTE_MS) })).toBe("not-due");
      expect(await s.request({ now: at(LANDING_FETCH_INTERVAL_MS - 1) })).toBe("not-due");
      // No worker ever recorded a result here: the BOOKED attempt alone
      // holds the interval, and alone lets the next one through.
      expect(await s.request({ now: at(LANDING_FETCH_INTERVAL_MS) })).toBe("started");

      expect(s.started).toEqual([s.repos.reader, s.repos.reader]);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "racing hooks start exactly one worker",
    async () => {
      const s = await setup("lft-race");

      const answers = await Promise.all(Array.from({ length: 8 }, () => s.request()));

      expect(answers.filter((answer) => answer === "started")).toHaveLength(1);
      expect(s.started).toHaveLength(1);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "worktrees of one clone share the interval, because they share the refs",
    async () => {
      const s = await setup("lft-worktrees");
      const second = join(s.repos.base, "nick-second");
      await gitIn(s.repos.reader, ["worktree", "add", "-q", "-b", "nick/other", second, "origin/main"]);

      expect(await cloneKeyOf(second)).toBe(await cloneKeyOf(s.repos.reader));
      expect(await s.request()).toBe("started");
      expect(await s.request({ root: second, now: at(MINUTE_MS) })).toBe("not-due");
    },
    HEAVY_SETUP_MS,
  );

  test(
    "two separate clones of one origin each fetch for themselves",
    async () => {
      const s = await setup("lft-two-clones");
      const other = join(s.repos.base, "nick-other-clone");
      await gitIn(s.repos.base, ["clone", "-q", s.repos.origin, other]);

      expect(await cloneKeyOf(other)).not.toBe(await cloneKeyOf(s.repos.reader));
      expect(await s.request()).toBe("started");
      expect(await s.request({ root: other })).toBe("started");
    },
    HEAVY_SETUP_MS,
  );

  test(
    "a clock set back does not stop fetching until it catches up",
    async () => {
      const s = await setup("lft-clock-back");
      // Booked "an hour from now": the clock has since been set back.
      expect(await s.request({ now: at(60 * MINUTE_MS) })).toBe("started");

      expect(await s.request({ now: T0 })).toBe("started");
    },
    HEAVY_SETUP_MS,
  );

  test(
    "a booking seconds ahead is a racing hook that read the clock first, not a clock set back",
    async () => {
      const s = await setup("lft-racing-clock");
      // Two hooks: the one that read the clock LATER booked first.
      expect(await s.request({ now: at(2000) })).toBe("started");

      expect(await s.request({ now: T0 })).toBe("not-due");
      expect(s.started).toHaveLength(1);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "a clone that never fetched from origin is not fetched, and nothing is booked",
    async () => {
      const s = await setup("lft-not-tracking");
      await gitIn(s.repos.reader, ["remote", "remove", "origin"]);
      await gitIn(s.repos.reader, ["remote", "add", "origin", s.repos.origin]);

      expect(await s.request()).toBe("not-tracking");
      expect(s.started).toEqual([]);
      expect(
        await exists(landingFetchRecordPath(s.home, (await cloneKeyOf(s.repos.reader)) ?? "")),
      ).toBe(false);
    },
    HEAVY_SETUP_MS,
  );
});

describe("switched off", () => {
  test(
    "by one person, by the team, or by an empty landing list: nothing starts and nothing is written",
    async () => {
      const s = await setup("lft-off");
      const key = await cloneKeyOf(s.repos.reader);
      const record = landingFetchRecordPath(s.home, key ?? "");

      expect(await s.request({ env: { ...ENV, CROSSCHECK_LANDING_FETCH: "off" } })).toBe("off");
      await writeFile(join(s.repos.reader, ".crosscheck.json"), JSON.stringify({ landingFetch: false }));
      expect(await s.request()).toBe("off");
      await writeFile(join(s.repos.reader, ".crosscheck.json"), JSON.stringify({ landingBranches: [] }));
      expect(await s.request()).toBe("off");

      expect(s.started).toEqual([]);
      expect(await exists(record)).toBe(false);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "a landingFetch value that is not true or false leaves it on",
    async () => {
      const s = await setup("lft-invalid");
      await writeFile(join(s.repos.reader, ".crosscheck.json"), JSON.stringify({ landingFetch: "no" }));

      // doctor names the unusable value; the fetch keeps doing its job.
      expect(await s.request()).toBe("started");
    },
    HEAVY_SETUP_MS,
  );

  test("a directory that is not a git clone starts nothing", async () => {
    const home = await makeHome("lft-not-git");
    const plain = await mkdtemp(join(tmpdir(), "cx-lft-plain-"));
    paths.push(home, plain);
    const started: string[] = [];

    expect(
      await requestLandingFetch({
        home,
        root: plain,
        env: ENV,
        now: T0,
        startWorker: (root) => {
          started.push(root);
        },
      }),
    ).toBe("no-clone");
    expect(started).toEqual([]);
  });
});

describe("the record", () => {
  test(
    "counts failures in a row, and a success resets them",
    async () => {
      const s = await setup("lft-record");
      const key = (await cloneKeyOf(s.repos.reader)) ?? "";
      const failed = { kind: "failed", step: "fetch", timedOut: true } as const;

      await recordLandingFetch(s.home, key, failed, at(1));
      await recordLandingFetch(s.home, key, failed, at(2));
      expect((await readLandingFetchRecord(s.home, key)).failuresInARow).toBe(2);
      expect((await readLandingFetchRecord(s.home, key)).lastSuccessAt).toBeNull();

      await recordLandingFetch(s.home, key, { kind: "fetched", branches: ["main"] }, at(3));
      const afterSuccess = await readLandingFetchRecord(s.home, key);
      expect(afterSuccess.failuresInARow).toBe(0);
      expect(afterSuccess.lastSuccessAt).toBe(at(3).toISOString());
      expect(afterSuccess.last).toEqual({
        at: at(3).toISOString(),
        outcome: { kind: "fetched", branches: ["main"] },
      });

      // A skip is neither: nothing was tried against origin.
      await recordLandingFetch(s.home, key, { kind: "skipped", why: "shallow" }, at(4));
      expect((await readLandingFetchRecord(s.home, key)).failuresInARow).toBe(0);
      expect((await readLandingFetchRecord(s.home, key)).lastSuccessAt).toBe(at(3).toISOString());
    },
    HEAVY_SETUP_MS,
  );

  test(
    "a second booking inside the interval is refused, whoever asks",
    async () => {
      const s = await setup("lft-second-booking");
      const key = (await cloneKeyOf(s.repos.reader)) ?? "";

      expect(await claimLandingFetch(s.home, key, T0)).toBe(true);
      expect(await claimLandingFetch(s.home, key, at(MINUTE_MS))).toBe(false);
      expect(await claimLandingFetch(s.home, key, at(LANDING_FETCH_INTERVAL_MS))).toBe(true);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "a worker finishing late never moves the booked attempt",
    async () => {
      const s = await setup("lft-late-worker");
      const key = (await cloneKeyOf(s.repos.reader)) ?? "";
      expect(await claimLandingFetch(s.home, key, T0)).toBe(true);

      await recordLandingFetch(s.home, key, { kind: "fetched", branches: ["main"] }, at(2 * MINUTE_MS));

      expect((await readLandingFetchRecord(s.home, key)).lastAttemptAt).toBe(T0.toISOString());
    },
    HEAVY_SETUP_MS,
  );

  test("an unreadable record reads as never fetched, and is claimable", async () => {
    const home = await makeHome("lft-garbled");
    paths.push(home);
    const key = "0123456789abcdef";
    await Bun.write(landingFetchRecordPath(home, key), "{ not json");

    const record = await readLandingFetchRecord(home, key);
    expect(record.lastAttemptAt).toBeNull();
    expect(record.failuresInARow).toBe(0);
    expect(await claimLandingFetch(home, key, T0)).toBe(true);
  });
});
