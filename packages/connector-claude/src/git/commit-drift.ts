import { DRIFT_GIT_TIMEOUT_MS, MAX_DRIFT_LOOKUPS } from "../constants.ts";
import { runGit } from "./git.ts";

/** Drift of a teammate's base commit against the reader's HEAD (DESIGN.md §4). */
export interface CommitDrift {
  /** Commits their base has that the reader's HEAD does not. */
  readonly ahead: number;
  /** Commits the reader's HEAD has that their base does not. */
  readonly behind: number;
}

/** Only a plain object name reaches git — never a value that could read as a flag. */
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

const RADIX = 10;

/**
 * One process answers both directions. git exits non-zero when the object is
 * unknown locally — the normal case for a teammate's unpushed commit — and that
 * is reported as "no drift to show", never as an error.
 */
export const resolveCommitDrift = async (
  cwd: string,
  baseCommit: string,
): Promise<CommitDrift | null> => {
  if (!COMMIT_SHA_PATTERN.test(baseCommit)) {
    return null;
  }
  const output = await runGit(
    ["rev-list", "--left-right", "--count", `${baseCommit}...HEAD`],
    cwd,
    DRIFT_GIT_TIMEOUT_MS,
  );
  if (output === null) {
    return null;
  }
  const [ahead, behind] = output
    .split(/\s+/)
    .map((value) => Number.parseInt(value, RADIX));
  if (
    ahead === undefined ||
    behind === undefined ||
    Number.isNaN(ahead) ||
    Number.isNaN(behind)
  ) {
    return null;
  }
  return { ahead, behind };
};

/**
 * Bounded fan-out, resolved in parallel: the whole lookup costs one git timeout
 * of wall clock, so the briefing budget is never at risk.
 */
export const resolveDriftByBaseCommit = async (
  cwd: string,
  baseCommits: readonly string[],
): Promise<Readonly<Record<string, CommitDrift>>> => {
  const distinct = [...new Set(baseCommits)].slice(0, MAX_DRIFT_LOOKUPS);
  const resolved = await Promise.all(
    distinct.map(
      async (commit) =>
        [commit, await resolveCommitDrift(cwd, commit)] as const,
    ),
  );
  return Object.fromEntries(
    resolved.filter(
      (entry): entry is readonly [string, CommitDrift] => entry[1] !== null,
    ),
  );
};