/**
 * `doctor`'s landing-fetch line: whether the background fetch of the landing
 * branches is doing its job in THIS clone (docs/1.0/landed-changes.md, step 2).
 *
 * The fetch fails silently by design — it starts from a hook, and nobody
 * waits for it. A fetch that has failed for a day reads exactly like "nothing
 * landed" at the pre-edit stop, so this line is where that silence gets a
 * name: how old the last fetch is, and a WARN once it has failed several
 * times in a row, with what to do about it. Transient failures (a laptop
 * offline for a train ride) stay a PASS.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createDb, createServer } from "@crosscheck/server";
import {
  claimLandingFetch,
  cloneKeyOf,
  recordLandingFetch,
} from "@crosscheck/connector-core/landed-changes/fetch-state.ts";
import type { LandingFetchOutcome } from "@crosscheck/connector-core/landed-changes/fetch-state.ts";
import { DOCTOR_LANDING_FETCH_FAILURES_WARN } from "@crosscheck/connector-core/constants.ts";

import { runCli } from "../src/index.ts";
import { checkLandingFetch } from "../src/cli/doctor-landing-fetch.ts";
import { makeHome } from "../../connector-core/test/helpers.ts";
import { gitIn, makeLandingRepos } from "../../connector-core/test/fixtures/landing-repos.ts";
import type { LandingRepos } from "../../connector-core/test/fixtures/landing-repos.ts";

const HEAVY_SETUP_MS = 60_000;
const MINUTE_MS = 60_000;
const NOW = new Date("2026-09-25T12:00:00Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

const cleanups: string[] = [];

afterAll(async () => {
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

interface Clone {
  readonly repos: LandingRepos;
  readonly home: string;
  readonly key: string;
}

const clone = async (label: string): Promise<Clone> => {
  const repos = await makeLandingRepos(label);
  const home = await makeHome(label);
  cleanups.push(repos.base, home);
  return { repos, home, key: (await cloneKeyOf(repos.reader)) ?? "" };
};

const ranAt = async (c: Clone, when: Date, outcome: LandingFetchOutcome): Promise<void> => {
  await claimLandingFetch(c.home, c.key, when);
  await recordLandingFetch(c.home, c.key, outcome, when);
};

const check = (c: Clone, env: Record<string, string | undefined> = {}) =>
  checkLandingFetch(c.repos.reader, c.home, env, NOW);

const FETCH_TIMED_OUT: LandingFetchOutcome = { kind: "failed", step: "fetch", timedOut: true };

describe("doctor's landing-fetch line", () => {
  test(
    "before the first run: a PASS that says when it will run",
    async () => {
      const c = await clone("lfd-never");

      const line = await check(c);

      expect(line.level).toBe("PASS");
      expect(line.name).toBe("landing fetch");
      expect(line.detail).toContain("not run yet");
    },
    HEAVY_SETUP_MS,
  );

  test(
    "after a fetch: how long ago, and which branches",
    async () => {
      const c = await clone("lfd-fetched");
      await ranAt(c, ago(3 * MINUTE_MS), { kind: "fetched", branches: ["main", "staging"] });

      const line = await check(c);

      expect(line.level).toBe("PASS");
      expect(line.detail).toContain("last fetched 3m ago (main, staging)");
    },
    HEAVY_SETUP_MS,
  );

  test(
    "a failure or two in a row is not yet a warning, but is said",
    async () => {
      const c = await clone("lfd-transient");
      await ranAt(c, ago(60 * MINUTE_MS), { kind: "fetched", branches: ["main", "staging"] });
      for (let run = 1; run < DOCTOR_LANDING_FETCH_FAILURES_WARN; run += 1) {
        await ranAt(c, ago((10 - run) * MINUTE_MS), FETCH_TIMED_OUT);
      }

      const line = await check(c);

      expect(line.level).toBe("PASS");
      expect(line.detail).toContain("last fetched 1h ago (main, staging)");
      expect(line.detail).toContain("the latest attempt failed");
    },
    HEAVY_SETUP_MS,
  );

  test(
    "failing again and again is a warning, with the reason and what to do",
    async () => {
      const c = await clone("lfd-failing");
      for (let run = 0; run < DOCTOR_LANDING_FETCH_FAILURES_WARN; run += 1) {
        await ranAt(c, ago((10 - run) * MINUTE_MS), FETCH_TIMED_OUT);
      }

      const line = await check(c);

      expect(line.level).toBe("WARN");
      expect(line.detail).toContain(
        `the last ${String(DOCTOR_LANDING_FETCH_FAILURES_WARN)} background fetches failed`,
      );
      expect(line.detail).toContain("did not finish within 120 s");
      expect(line.detail).toContain("git fetch origin");
      expect(line.detail).toContain("CROSSCHECK_LANDING_FETCH=off");
    },
    HEAVY_SETUP_MS,
  );

  test(
    "a branch origin has that the fetch keeps failing to bring is a warning naming it",
    async () => {
      const c = await clone("lfd-missed");
      await ranAt(c, ago(2 * MINUTE_MS), {
        kind: "fetched",
        branches: ["main"],
        missed: ["release/2026"],
      });

      const line = await check(c);

      expect(line.level).toBe("WARN");
      expect(line.detail).toContain("last fetched 2m ago (main)");
      // Said as what the last run saw, and when: the developer may have fixed
      // it since, and the next run clears it.
      expect(line.detail).toContain("its last run, 2m ago, could not bring release/2026");
      expect(line.detail).toContain("git fetch origin release/2026");
    },
    HEAVY_SETUP_MS,
  );

  test(
    "a git too old for the fetch is a warning, not a quiet skip",
    async () => {
      const c = await clone("lfd-old-git");
      await ranAt(c, ago(MINUTE_MS), { kind: "skipped", why: "old-git" });

      const line = await check(c);

      expect(line.level).toBe("WARN");
      expect(line.detail).toContain("older than 2.29");
    },
    HEAVY_SETUP_MS,
  );

  test(
    "a home where the record cannot be written is a warning — the fetch could never book a run",
    async () => {
      const c = await clone("lfd-unwritable");
      const state = join(c.home, "state");
      await mkdir(state, { recursive: true });
      await chmod(state, 0o555);
      try {
        const line = await check(c);

        expect(line.level).toBe("WARN");
        expect(line.detail).toContain("cannot be written");
      } finally {
        await chmod(state, 0o755);
      }
    },
    HEAVY_SETUP_MS,
  );

  test(
    "a home that does not exist yet is not unwritable: the first booking creates it",
    async () => {
      const c = await clone("lfd-fresh-home");
      const fresh = join(c.home, "not-yet", ".crosscheck");

      const line = await checkLandingFetch(c.repos.reader, fresh, {}, NOW);

      expect(line.level).toBe("PASS");
      expect(line.detail).not.toContain("cannot be written");
    },
    HEAVY_SETUP_MS,
  );

  test(
    "bookings that never report are a warning, not a 'not run yet' forever",
    async () => {
      const c = await clone("lfd-never-reports");
      for (let run = 0; run < DOCTOR_LANDING_FETCH_FAILURES_WARN; run += 1) {
        await claimLandingFetch(c.home, c.key, ago((30 - run * 10) * MINUTE_MS));
      }

      const line = await check(c);

      expect(line.level).toBe("WARN");
      expect(line.detail).toContain("started but never reported");
    },
    HEAVY_SETUP_MS,
  );

  test(
    "switched off for one person, or for the team: a PASS naming the switch",
    async () => {
      const c = await clone("lfd-off");

      const personal = await check(c, { CROSSCHECK_LANDING_FETCH: "off" });
      await writeFile(join(c.repos.reader, ".crosscheck.json"), JSON.stringify({ landingFetch: false }));
      const team = await check(c);

      expect(personal.level).toBe("PASS");
      expect(personal.detail).toContain("CROSSCHECK_LANDING_FETCH=off");
      expect(team.level).toBe("PASS");
      expect(team.detail).toContain('"landingFetch": false');
    },
    HEAVY_SETUP_MS,
  );

  test(
    "an unusable landingFetch value is a warning, and the fetch stays on",
    async () => {
      const c = await clone("lfd-invalid");
      await writeFile(join(c.repos.reader, ".crosscheck.json"), JSON.stringify({ landingFetch: "no" }));

      const line = await check(c);

      expect(line.level).toBe("WARN");
      expect(line.detail).toContain('"landingFetch" must be true or false');
    },
    HEAVY_SETUP_MS,
  );

  test(
    "a clone that never fetched from origin: nothing to fetch yet, without a warning",
    async () => {
      const c = await clone("lfd-untracked");
      await gitIn(c.repos.reader, ["remote", "remove", "origin"]);
      await gitIn(c.repos.reader, ["remote", "add", "origin", c.repos.origin]);

      const line = await check(c);

      expect(line.level).toBe("PASS");
      expect(line.detail).toContain("never fetched from origin");
    },
    HEAVY_SETUP_MS,
  );
});

describe("the full doctor", () => {
  const ADMIN_TOKEN = "landing-fetch-doctor-admin";
  let server: ReturnType<typeof Bun.serve>;
  let hubUrl: string;
  let apiKey: string;

  beforeAll(async () => {
    server = Bun.serve({ port: 0, fetch: createServer({ db: await createDb(), adminToken: ADMIN_TOKEN }).fetch });
    hubUrl = `http://127.0.0.1:${String(server.port)}`;
    const response = await fetch(`${hubUrl}/api/developers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Nick", email: "nick-landing-fetch-doctor@example.com" }),
    });
    apiKey = ((await response.json()) as { data: { apiKey: string } }).data.apiKey;
  });

  afterAll(() => {
    server.stop(true);
  });

  test(
    "prints the landing-fetch line beside the landed-changes line",
    async () => {
      const c = await clone("lfd-full");
      await writeFile(join(c.repos.reader, ".crosscheck.json"), JSON.stringify({ hubUrl }));

      const { stdout } = await runCli(
        ["doctor"],
        { CROSSCHECK_HOME: c.home, HOME: c.home, CROSSCHECK_HUB_URL: hubUrl, CROSSCHECK_API_KEY: apiKey },
        c.repos.reader,
      );

      expect(stdout).toContain("PASS  landed changes  ");
      expect(stdout).toContain("PASS  landing fetch  not run yet");
    },
    HEAVY_SETUP_MS,
  );
});
