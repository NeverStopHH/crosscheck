import type { Envelope } from "@crosscheck/schema";

import {
  LANDED_GIT_TIMEOUT_MS,
  MAX_LANDED_ANCESTRY_CHECKS,
} from "../constants.ts";
import { COMMIT_SHA_PATTERN } from "../git/commit-drift.ts";
import { runGit } from "../git/git.ts";
import { buildEnvelope } from "./records.ts";
import type { Producer } from "./records.ts";

const RADIX = 10;

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
 * Which of `commits` are ancestors of `defaultRef` — the landed evidence of
 * DESIGN.md §5, absence-collector style: every value validated before git
 * sees it (COMMIT_SHA_PATTERN — flag- and ref-shaped strings are dropped),
 * the fan-out deduplicated and capped (MAX_LANDED_ANCESTRY_CHECKS), each
 * probe under its own timeout, resolved in parallel so the whole collection
 * costs one git timeout of wall clock (the resolveDriftByBaseCommit shape).
 * An unanswerable probe is dropped — a missed report, never a false one.
 */
export const collectLandedCommits = async (
  root: string,
  defaultRef: string,
  commits: readonly string[],
): Promise<readonly string[]> => {
  const distinct = [...new Set(commits)]
    .filter((sha) => COMMIT_SHA_PATTERN.test(sha))
    .slice(0, MAX_LANDED_ANCESTRY_CHECKS);
  const resolved = await Promise.all(
    distinct.map(
      async (sha) => [sha, await isAncestorOf(root, sha, defaultRef)] as const,
    ),
  );
  return resolved
    .filter((entry): entry is readonly [string, true] => entry[1] === true)
    .map(([sha]) => sha);
};

/** The wire envelope the spool ships to the hub's cx-envelope ingest. */
export const landedEvidenceRecord = (
  repoId: string,
  defaultBranch: string,
  commits: readonly string[],
  producer: Producer,
  now: Date,
): Envelope =>
  buildEnvelope(
    "landed_evidence",
    {
      repo: repoId,
      defaultBranch,
      checkedAt: now.toISOString(),
      commits,
    },
    producer,
    now,
  );
