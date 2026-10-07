import { isDetachedBranch } from "@crosscheck/schema";
import type { Envelope, LandedCommitDate } from "@crosscheck/schema";

import {
  LANDED_GIT_TIMEOUT_MS,
  MAX_LANDED_ANCESTRY_CHECKS,
} from "../constants.ts";
import { COMMIT_SHA_PATTERN } from "../git/commit-drift.ts";
import { resolveDefaultBranchRef } from "../git/default-branch.ts";
import { runGit } from "../git/git.ts";
import { buildEnvelope } from "./records.ts";
import type { Producer } from "./records.ts";

const RADIX = 10;
const FIELD_SEPARATOR = "\t";

/**
 * Is `sha` an ancestor of `defaultRef`? Three-valued on purpose:
 * true / false / null-for-unknown, because "git could not answer" must not
 * report either fact.
 *
 * `rev-list --count sha ^ref` counts commits reachable from sha but not from
 * ref — zero exactly when sha is an ancestor. Chosen over
 * `merge-base --is-ancestor` because that command answers ONLY through its
 * exit status with empty stdout, which runGit's null-on-empty contract
 * cannot carry.
 */
const isAncestorOf = async (
  root: string,
  sha: string,
  defaultRef: string,
): Promise<boolean | null> => {
  const output = await runGit(
    ["rev-list", "--count", sha, `^${defaultRef}`],
    root,
    LANDED_GIT_TIMEOUT_MS,
  );
  if (output === null) {
    return null;
  }
  const count = Number.parseInt(output, RADIX);
  return Number.isNaN(count) ? null : count === 0;
};

/**
 * WHAT REGISTER SAYS ABOUT ITS OWN BASE (pilot finding, 2026-10-05): was
 * `baseCommit` ALREADY reachable from the default branch when this session
 * started? Then its reaching the default branch later says nothing about
 * this session's work, and the hub never stamps its context landed by base
 * ancestry (server services/landed.ts). The pilot's own shape answers true:
 * a long-lived worktree detached at an old main commit, whose sessions do
 * their work in other worktrees.
 *
 * Undefined — the field is then left off the register — whenever git cannot
 * answer: no default ref, an unknown or non-sha base, a timeout. The hub
 * reads absent as "did not say", which never lands without a dated report.
 */
export const baseReachableFromDefault = async (
  root: string,
  baseCommit: string,
  defaultRef: string | null,
): Promise<boolean | undefined> => {
  if (defaultRef === null || !COMMIT_SHA_PATTERN.test(baseCommit)) {
    return undefined;
  }
  return (await isAncestorOf(root, baseCommit, defaultRef)) ?? undefined;
};

/** What the register probe reads about the session's checkout. */
export interface ProbedCheckout {
  readonly root: string;
  readonly baseCommit: string;
  readonly branch: string;
}

/**
 * The register's answer for this checkout, or undefined to send none.
 *
 * NOT PROBED ON A DETACHED HEAD: the hub never lands a detached session by
 * its base, whatever it says (server services/landed.ts), so the answer would
 * cost git calls and buy nothing — not even the default ref is resolved.
 *
 * On a named branch: the default ref (from `resolveRef`, so a caller that
 * already started resolving it shares that call), then the ancestry probe —
 * two bounded git calls in sequence, LANDED_GIT_TIMEOUT_MS each. The title
 * builder asks git nothing on a named branch, so these two ARE the
 * pre-register git cost there; on a detached HEAD it is the title's own two.
 * Either way at most two such calls precede the register (the
 * LANDED_GIT_TIMEOUT_MS directive pins the budget).
 */
export const probeBaseOnDefault = async (
  checkout: ProbedCheckout,
  resolveRef: () => Promise<string | null> = () => resolveDefaultBranchRef(checkout.root),
): Promise<boolean | undefined> => {
  if (isDetachedBranch(checkout.branch)) {
    return undefined;
  }
  return baseReachableFromDefault(checkout.root, checkout.baseCommit, await resolveRef());
};

/** The distinct, sha-shaped candidates one probe checks, rotated (below). */
const ancestryWindow = (
  commits: readonly string[],
  rotation: number,
): readonly string[] => {
  const distinct = [...new Set(commits)].filter((sha) =>
    COMMIT_SHA_PATTERN.test(sha),
  );
  const start =
    distinct.length === 0
      ? 0
      : Math.trunc(Math.abs(rotation)) % distinct.length;
  return [...distinct.slice(start), ...distinct.slice(0, start)].slice(
    0,
    MAX_LANDED_ANCESTRY_CHECKS,
  );
};

/**
 * Which of `commits` are ancestors of `defaultRef` — the landed evidence of
 * DESIGN.md §5, absence-collector style: every value validated before git
 * sees it (COMMIT_SHA_PATTERN — flag- and ref-shaped strings are dropped),
 * the fan-out deduplicated and capped (MAX_LANDED_ANCESTRY_CHECKS), each
 * probe under its own timeout, resolved in parallel so the whole collection
 * costs one git timeout of wall clock (the resolveDriftByBaseCommit shape).
 * An unanswerable probe is dropped — a missed report, never a false one.
 *
 * THE CAP ROTATES. A capped window with a fixed start starves: the hub lists
 * open contexts newest first, so with more candidates than the cap and the
 * newest ones never landing (abandoned branches), the older candidates would
 * never be probed by ANY session and would present as open forever. The
 * caller passes a `rotation` — SessionStart uses the day number — the window
 * starts at rotation % n and wraps, so every candidate is probed within
 * ⌈n / MAX_LANDED_ANCESTRY_CHECKS⌉ days while every SessionStart on one day
 * probes the same window (replays stay idempotent).
 */
export const collectLandedCommits = async (
  root: string,
  defaultRef: string,
  commits: readonly string[],
  rotation = 0,
): Promise<readonly string[]> => {
  const resolved = await Promise.all(
    ancestryWindow(commits, rotation).map(
      async (sha) => [sha, await isAncestorOf(root, sha, defaultRef)] as const,
    ),
  );
  return resolved
    .filter((entry): entry is readonly [string, true] => entry[1] === true)
    .map(([sha]) => sha);
};

/**
 * When each of `shas` was COMMITTED — git's committer date, in UTC, for the
 * ones this clone has. ONE bounded git call: `--no-walk` reads exactly these
 * commits and never their history, and `--ignore-missing` makes a commit the
 * clone lacks read nothing instead of failing the rest. Only sha-shaped
 * values reach git; an unreadable answer is no date, never a guessed one.
 */
export const readCommitDates = async (
  root: string,
  shas: readonly string[],
): Promise<readonly LandedCommitDate[]> => {
  const wanted = [...new Set(shas)].filter((sha) => COMMIT_SHA_PATTERN.test(sha));
  if (wanted.length === 0) {
    return [];
  }
  const output = await runGit(
    ["log", "--no-walk=unsorted", "--ignore-missing", "--format=%H%x09%cI", ...wanted],
    root,
    LANDED_GIT_TIMEOUT_MS,
  );
  const known = (output ?? "")
    .split("\n")
    .map((line) => line.split(FIELD_SEPARATOR))
    .flatMap(([full, committed]) =>
      full === undefined || committed === undefined || Number.isNaN(Date.parse(committed))
        ? []
        : [{ full: full.toLowerCase(), committedAt: new Date(committed).toISOString() }],
    );
  return wanted.flatMap((sha) => {
    const found = known.find((entry) => entry.full.startsWith(sha.toLowerCase()));
    return found === undefined ? [] : [{ sha, committedAt: found.committedAt }];
  });
};

/** What one SessionStart proved about the open contexts' base commits. */
export interface LandedReading {
  readonly commits: readonly string[];
  /** Committer dates for those commits, where git gave one. */
  readonly commitDates: readonly LandedCommitDate[];
}

/** The reading of a session that probed nothing — no record is sent for it. */
export const NOTHING_LANDED: LandedReading = { commits: [], commitDates: [] };

/**
 * The ancestry probe and the date read over the SAME rotated window, in
 * parallel — together still one git timeout of wall clock — kept to the
 * commits that proved landed. The dates are what lets the hub judge the
 * base of a session whose connector never said whether it was already on
 * the default branch (server services/landed.ts).
 */
export const collectLandedReading = async (
  root: string,
  defaultRef: string,
  commits: readonly string[],
  rotation = 0,
): Promise<LandedReading> => {
  const [landed, dates] = await Promise.all([
    collectLandedCommits(root, defaultRef, commits, rotation),
    readCommitDates(root, ancestryWindow(commits, rotation)),
  ]);
  return {
    commits: landed,
    commitDates: dates.filter((entry) => landed.includes(entry.sha)),
  };
};

/** The wire envelope the spool ships to the hub's cx-envelope ingest. */
export const landedEvidenceRecord = (
  repoId: string,
  defaultBranch: string,
  reading: LandedReading,
  producer: Producer,
  now: Date,
): Envelope =>
  buildEnvelope(
    "landed_evidence",
    {
      repo: repoId,
      defaultBranch,
      checkedAt: now.toISOString(),
      commits: reading.commits,
      ...(reading.commitDates.length === 0 ? {} : { commitDates: reading.commitDates }),
    },
    producer,
    now,
  );
