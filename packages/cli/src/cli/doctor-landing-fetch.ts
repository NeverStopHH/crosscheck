/**
 * `doctor`'s landing-fetch line: whether the background fetch of the landing
 * branches is doing its job in THIS clone (docs/1.0/landed-changes.md, step 2).
 *
 * NEVER SILENT, for the reason the landed-changes line is not: the fetch
 * starts from a hook and nobody waits for it, so a fetch that has failed for
 * a day reads exactly like "nothing landed" at the pre-edit stop. Here that
 * silence gets a name — how old the last fetch is, and a WARN once it has
 * failed DOCTOR_LANDING_FETCH_FAILURES_WARN times in a row, with the two ways
 * out. Fewer failures stay a PASS that says so: a laptop on a train is not a
 * broken setup.
 */
import { access, constants } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import {
  DOCTOR_LANDING_FETCH_FAILURES_WARN,
  LANDING_FETCH_ENV,
  LANDING_FETCH_INTERVAL_MS,
  LANDING_FETCH_OFF,
  LANDING_FETCH_TIMEOUT_MS,
  LANDING_LS_REMOTE_TIMEOUT_MS,
  REPO_CONFIG_FILE,
} from "@crosscheck/connector-core/constants.ts";
import { LANDING_FETCH_FIELD, readLandingFetchPlan } from "@crosscheck/connector-core/landed-changes/fetch-switch.ts";
import type { LandingFetchSwitch } from "@crosscheck/connector-core/landed-changes/fetch-switch.ts";
import { cloneKeyOf, readLandingFetchRecord } from "@crosscheck/connector-core/landed-changes/fetch-state.ts";
import type {
  LandingFetchOutcome,
  LandingFetchRecord,
} from "@crosscheck/connector-core/landed-changes/fetch-state.ts";
import { tracksOrigin } from "@crosscheck/connector-core/landed-changes/fetch-trigger.ts";
import { LANDING_BRANCHES_FIELD } from "@crosscheck/connector-core/landed-changes/landing-branches.ts";
import { ageOf } from "@crosscheck/connector-core/state/age.ts";

import type { Check } from "./doctor.ts";

const NAME = "landing fetch";
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;

const pass = (detail: string): Check => ({ level: "PASS", name: NAME, detail });
const warn = (detail: string): Check => ({ level: "WARN", name: NAME, detail });

const ONLY_OWN_FETCH = "the landed-change stop only sees what your own git fetch brings";

const offDetail = (by: Extract<LandingFetchSwitch, { kind: "off" }>["by"]): string => {
  switch (by) {
    case "person":
      return `off for you (${LANDING_FETCH_ENV}=${LANDING_FETCH_OFF}): ${ONLY_OWN_FETCH}`;
    case "team":
      return `off for this repo ("${LANDING_FETCH_FIELD}": false in ${REPO_CONFIG_FILE}): ${ONLY_OWN_FETCH}`;
    case "no-landing-branches":
      return `off, with the landed-change stop ("${LANDING_BRANCHES_FIELD}": [] in ${REPO_CONFIG_FILE})`;
  }
};

const seconds = (ms: number): string => `${String(ms / MS_PER_SECOND)} s`;

const failureReason = (outcome: Extract<LandingFetchOutcome, { kind: "failed" }>): string => {
  if (outcome.step === "ls-remote") {
    return outcome.timedOut
      ? `asking origin for its branches did not finish within ${seconds(LANDING_LS_REMOTE_TIMEOUT_MS)}`
      : "origin could not be asked for its branches";
  }
  return outcome.timedOut
    ? `git fetch did not finish within ${seconds(LANDING_FETCH_TIMEOUT_MS)}`
    : "git fetch failed";
};

const SKIP_DETAIL: Readonly<Record<Extract<LandingFetchOutcome, { kind: "skipped" }>["why"], string>> = {
  off: "switched off at its last run",
  "no-origin": "nothing to fetch: this clone has no origin",
  shallow: "not fetched: this is a shallow clone, where the landed-change stop is silent anyway",
  "none-on-origin": "nothing to fetch: origin has none of the landing branches",
  "old-git":
    "not fetched: this git is older than 2.29, which a fetch that leaves FETCH_HEAD alone needs " +
    "(--no-write-fetch-head) — update git, or switch it off",
};

/** The one skip that means "this will never work here" rather than "nothing to do". */
const SKIP_IS_A_FAULT: ReadonlySet<string> = new Set(["old-git"]);

/** "last fetched 3m ago (main, staging)": the last SUCCESS, whatever failed since. */
const lastFetched = (record: LandingFetchRecord, now: Date): string | null => {
  if (record.lastSuccessAt === null) {
    return null;
  }
  const branches =
    record.lastFetchedBranches.length === 0 ? "" : ` (${record.lastFetchedBranches.join(", ")})`;
  return `last fetched ${ageOf(record.lastSuccessAt, now)}${branches}`;
};

const EVERY = `in the background, at most every ${String(LANDING_FETCH_INTERVAL_MS / MS_PER_MINUTE)} minutes`;

const fromRecord = (record: LandingFetchRecord, now: Date): Check => {
  const last = record.last;
  if (record.bookedSinceReport >= DOCTOR_LANDING_FETCH_FAILURES_WARN) {
    return warn(
      `the last ${String(record.bookedSinceReport)} background fetches were started but never reported, ` +
        "so the worker is not starting or not finishing — the landed-change stop only sees what your own " +
        `git fetch brings; switch it off with ${LANDING_FETCH_ENV}=${LANDING_FETCH_OFF} if this persists`,
    );
  }
  if (last === null) {
    return pass(`not run yet — it runs ${EVERY}, from the next session start, prompt or edit`);
  }
  const fetched = lastFetched(record, now);
  if (last.outcome.kind === "skipped") {
    const detail = SKIP_DETAIL[last.outcome.why];
    return SKIP_IS_A_FAULT.has(last.outcome.why) ? warn(detail) : pass(detail);
  }
  if (last.outcome.kind === "fetched") {
    const missed = last.outcome.missed ?? [];
    return missed.length === 0
      ? pass(`${fetched ?? "fetched"} — ${EVERY}`)
      : warn(
          `${fetched ?? "fetched"}; its last run, ${ageOf(last.at, now)}, could not bring ` +
            `${missed.join(", ")}, which origin has — run git fetch origin ${missed.join(" ")} to see why`,
        );
  }
  const reason = failureReason(last.outcome);
  if (record.failuresInARow < DOCTOR_LANDING_FETCH_FAILURES_WARN) {
    return pass(
      `${fetched ?? "never fetched yet"}; the latest attempt failed (${reason}) — it is tried again ${EVERY}`,
    );
  }
  return warn(
    `the last ${String(record.failuresInARow)} background fetches failed (${reason}), so the landed-change ` +
      `stop only sees what was fetched before (${fetched ?? "nothing yet"}) — run git fetch origin to see why, ` +
      `or switch it off with ${LANDING_FETCH_ENV}=${LANDING_FETCH_OFF}`,
  );
};

/**
 * A home where the record cannot be written books nothing, so the fetch
 * NEVER starts — and "not run yet" would pass for it forever. Checked on the
 * nearest directory that exists: the first write creates `state/`, and the
 * home itself, recursively.
 */
const canWriteRecord = async (home: string): Promise<boolean> => {
  let dir = join(home, "state");
  for (;;) {
    try {
      await access(dir, constants.W_OK);
      return true;
    } catch (error) {
      const parent = dirname(dir);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === dir) {
        return false;
      }
      dir = parent;
    }
  }
};

export const checkLandingFetch = async (
  repoRoot: string,
  home: string,
  env: Env,
  now: Date,
): Promise<Check> => {
  const plan = await readLandingFetchPlan(repoRoot, env);
  if (plan.switch.kind === "off") {
    return pass(offDetail(plan.switch.by));
  }
  const key = await cloneKeyOf(repoRoot);
  if (key === null) {
    return warn("git did not answer, so the background fetch cannot run in this clone");
  }
  if (!(await canWriteRecord(home))) {
    return warn(
      `${join(home, "state")} cannot be written, so the background fetch can never book an attempt and ` +
        "never runs — make it writable",
    );
  }
  const line = (await tracksOrigin(repoRoot))
    ? fromRecord(await readLandingFetchRecord(home, key), now)
    : pass("nothing to fetch yet: this clone has never fetched from origin — it starts once it has");
  return plan.switch.kind === "invalid"
    ? warn(`"${LANDING_FETCH_FIELD}" must be true or false in ${REPO_CONFIG_FILE}, so it stays on; ${line.detail}`)
    : line;
};
