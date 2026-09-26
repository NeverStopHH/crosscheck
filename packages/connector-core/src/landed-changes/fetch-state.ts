/**
 * What the background landing fetch has done for ONE CLONE, and whether
 * another is due (docs/1.0/landed-changes.md, step 2).
 *
 * KEYED BY THE CLONE — its git common directory — because that is what the
 * fetch writes into: every worktree of a clone shares its refs, so two
 * worktrees fetching on their own would fetch the same thing twice and race
 * for the same ref locks; two separate clones share nothing and each needs
 * its own fetch.
 *
 * BOOK, THEN START. A hook books the attempt under the lock and only then
 * starts the worker, so hooks that race start one worker between them, and a
 * worker that dies before recording anything costs one interval — never a
 * fetch on every hook. The worker's own record never moves the booking.
 *
 * FAIL-OPEN everywhere, like every other counter here: a record that cannot
 * be read reads as "never fetched", and a home where it cannot be written
 * books nothing, so nothing starts — never a hook failure, and `doctor`
 * names the unwritable directory.
 */
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import {
  landingFetchLockPath,
  landingFetchRecordPath,
  readJsonOrNull,
  writePrivateFile,
} from "../config/paths.ts";
import {
  LANDED_GIT_TIMEOUT_MS,
  LANDING_FETCH_INTERVAL_MS,
  MAX_LANDING_BRANCHES,
  REPO_KEY_CHARS,
} from "../constants.ts";
import { runGitOutcome } from "../git/git.ts";
import { withLock } from "../spool/lock.ts";
import { QUIET_GIT_ENV } from "./git-queries.ts";

export type LandingFetchSkip = "off" | "no-origin" | "shallow" | "none-on-origin" | "old-git";
export type LandingFetchStep = "ls-remote" | "fetch";

/** What one worker run did. Named apart so `doctor` can say which. */
export type LandingFetchOutcome =
  | {
      readonly kind: "fetched";
      readonly branches: readonly string[];
      /**
       * Branches origin has that this run could NOT bring — present only when
       * some did. One ref git refuses (a stale `origin/release` in the way of
       * `release/2026`) fails git's whole answer while the others moved; this
       * keeps the others' success true and names the one that is stuck.
       */
      readonly missed?: readonly string[] | undefined;
    }
  /** Nothing was tried against origin, so this is neither success nor failure. */
  | { readonly kind: "skipped"; readonly why: LandingFetchSkip }
  | { readonly kind: "failed"; readonly step: LandingFetchStep; readonly timedOut: boolean };

export interface LandingFetchRecord {
  /** When a hook last BOOKED an attempt — what the interval is measured from. */
  readonly lastAttemptAt: string | null;
  /**
   * Bookings since the worker last reported. A worker that never starts (or
   * dies before recording) leaves `last` as it was, and "not run yet" would
   * read as health forever; this is what lets `doctor` tell the two apart.
   */
  readonly bookedSinceReport: number;
  readonly lastSuccessAt: string | null;
  /** What that success fetched — kept when later runs fail, for `doctor`. */
  readonly lastFetchedBranches: readonly string[];
  readonly failuresInARow: number;
  readonly last: { readonly at: string; readonly outcome: LandingFetchOutcome } | null;
}

const NEVER_FETCHED: LandingFetchRecord = {
  lastAttemptAt: null,
  bookedSinceReport: 0,
  lastSuccessAt: null,
  lastFetchedBranches: [],
  failuresInARow: 0,
  last: null,
};

const OutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("fetched"),
    branches: z.array(z.string()).max(MAX_LANDING_BRANCHES),
    missed: z.array(z.string()).max(MAX_LANDING_BRANCHES).optional(),
  }),
  z.object({
    kind: z.literal("skipped"),
    why: z.enum(["off", "no-origin", "shallow", "none-on-origin", "old-git"]),
  }),
  z.object({
    kind: z.literal("failed"),
    step: z.enum(["ls-remote", "fetch"]),
    timedOut: z.boolean(),
  }),
]);

/** Tolerant per field: a garbled field costs that field, never the record. */
const RecordSchema = z.object({
  lastAttemptAt: z.string().nullable().catch(null),
  bookedSinceReport: z.number().int().min(0).catch(0),
  lastSuccessAt: z.string().nullable().catch(null),
  lastFetchedBranches: z.array(z.string()).max(MAX_LANDING_BRANCHES).catch([]),
  failuresInARow: z.number().int().min(0).catch(0),
  last: z.object({ at: z.string(), outcome: OutcomeSchema }).nullable().catch(null),
});

/**
 * The clone's key: its git common directory, resolved and hashed, so it is
 * path-safe and the same from every worktree. Null when git does not answer
 * — not a clone, or no git — which costs the fetch and nothing else.
 */
export const cloneKeyOf = async (
  root: string,
  timeoutMs: number = LANDED_GIT_TIMEOUT_MS,
): Promise<string | null> => {
  const outcome = await runGitOutcome(["rev-parse", "--git-common-dir"], root, timeoutMs, QUIET_GIT_ENV);
  if (!outcome.ok || outcome.stdout.length === 0) {
    return null;
  }
  try {
    // Relative from the main worktree (".git"), absolute from a linked one.
    const commonDir = await realpath(resolve(root, outcome.stdout));
    return new Bun.CryptoHasher("sha256").update(commonDir).digest("hex").slice(0, REPO_KEY_CHARS);
  } catch {
    return null;
  }
};

export const readLandingFetchRecord = async (
  home: string,
  cloneKey: string,
): Promise<LandingFetchRecord> => {
  const parsed = RecordSchema.safeParse(await readJsonOrNull(landingFetchRecordPath(home, cloneKey)));
  return parsed.success ? parsed.data : NEVER_FETCHED;
};

/**
 * Due once the interval has passed since the last BOOKED attempt. A booking
 * more than one interval in the FUTURE means the clock was set back, and
 * waiting for it to catch up could stop the fetch for days; a booking a few
 * seconds ahead is only a racing hook that read the clock first, and must not
 * count as "set back" — that would start a second worker.
 */
export const isLandingFetchDue = (record: LandingFetchRecord, now: Date): boolean => {
  const booked = record.lastAttemptAt === null ? Number.NaN : Date.parse(record.lastAttemptAt);
  if (Number.isNaN(booked)) {
    return true;
  }
  const elapsed = now.getTime() - booked;
  return elapsed >= LANDING_FETCH_INTERVAL_MS || elapsed < -LANDING_FETCH_INTERVAL_MS;
};

/**
 * No waiting for the lock: a busy one means another hook is booking, or a
 * worker is recording, at this very moment — either way there is nothing
 * for this hook to start.
 */
const BOOKING_LOCK_RETRIES = 0;

/** Books an attempt if one is due; true only for the hook that booked it. */
export const claimLandingFetch = async (
  home: string,
  cloneKey: string,
  now: Date,
): Promise<boolean> => {
  try {
    return await withLock(
      landingFetchLockPath(home, cloneKey),
      false,
      async () => {
        const current = await readLandingFetchRecord(home, cloneKey);
        if (!isLandingFetchDue(current, now)) {
          return false;
        }
        const booked: LandingFetchRecord = {
          ...current,
          lastAttemptAt: now.toISOString(),
          bookedSinceReport: current.bookedSinceReport + 1,
        };
        await writePrivateFile(landingFetchRecordPath(home, cloneKey), JSON.stringify(booked));
        return true;
      },
      BOOKING_LOCK_RETRIES,
    );
  } catch {
    // A home that cannot be written: no booking, so no worker either —
    // starting one unbooked is exactly the storm the booking prevents.
    return false;
  }
};

const failuresAfter = (current: LandingFetchRecord, outcome: LandingFetchOutcome): number => {
  if (outcome.kind === "failed") {
    return current.failuresInARow + 1;
  }
  return outcome.kind === "fetched" ? 0 : current.failuresInARow;
};

/** The worker's result, under the lock; the booking is left as it was. */
export const recordLandingFetch = async (
  home: string,
  cloneKey: string,
  outcome: LandingFetchOutcome,
  now: Date,
): Promise<void> => {
  try {
    await withLock(landingFetchLockPath(home, cloneKey), undefined, async () => {
      const current = await readLandingFetchRecord(home, cloneKey);
      const next: LandingFetchRecord = {
        lastAttemptAt: current.lastAttemptAt,
        bookedSinceReport: 0,
        lastSuccessAt: outcome.kind === "fetched" ? now.toISOString() : current.lastSuccessAt,
        lastFetchedBranches: outcome.kind === "fetched" ? outcome.branches : current.lastFetchedBranches,
        failuresInARow: failuresAfter(current, outcome),
        last: { at: now.toISOString(), outcome },
      };
      await writePrivateFile(landingFetchRecordPath(home, cloneKey), JSON.stringify(next));
    });
  } catch {
    // Fail open: the fetch happened (or did not) either way; only its line
    // in `doctor` is lost.
  }
};
