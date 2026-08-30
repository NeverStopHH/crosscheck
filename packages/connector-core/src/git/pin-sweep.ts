/**
 * The post-commit pin sweep (regression-guard Stage 1): does every path a pin
 * watches still exist, and if not, where did it go?
 *
 * WHY IT IS NOT OPTIONAL. A pin whose file was renamed stops matching every
 * recorded touch: nothing fires, nothing is wrong-looking, and `status` goes
 * on counting the pin as watched. Fail-silent-dead. This repo renames weekly,
 * including one 60-file end-to-end rename, so the sweep is the difference
 * between a register and a graveyard.
 *
 * WHY IT RUNS ON THE DEVELOPER'S MACHINE. The hub has no checkout — it cannot
 * ask git anything. So the answer is computed here, next to the repository,
 * and reported to the hub as a small mapping (paths in, paths out). No file
 * CONTENT is read, only names: Tier-0 privacy holds even while chasing a
 * rename.
 *
 * HOW GIT IS ASKED, and why it is asked that way. `git log -- <path>` applies
 * the pathspec BEFORE rename detection, so a rename shows up as a plain `D`
 * and the new name never appears — measured, not assumed. The reliable pair
 * is: find the newest commit that touched the path, then read THAT commit's
 * rename records with `-M`.
 *
 * THE REPOSITORY IS PROBED FIRST, and that call exists for one reason:
 * `runGit` returns null for an empty answer and for a failure alike, so "git
 * tracks none of these paths" and "git could not run" are the same value.
 * Without the probe a missing checkout would read as "every pinned file is
 * gone" and retire the whole registry. With it, a repository that does not
 * answer yields "unknown" for every path and doctor says the sweep could not
 * run.
 *
 * NOTHING HERE IS A DECISION. The sweep REPORTS; the hub records. A path
 * marked missing today is marked present again by the next sweep that finds
 * it, so a transient wrong answer heals instead of retiring a pin for good.
 */
import { GIT_TIMEOUT_MS, PIN_SWEEP_MAX_HOPS, PIN_SWEEP_MAX_PATHS } from "../constants.ts";
import { runGit } from "./git.ts";

export type PinPathStatus =
  /** git has this exact path today. */
  | "present"
  /** git followed a rename; `resolved` is the file's name now. */
  | "renamed"
  /** git has no such file and no rename that explains it. */
  | "missing"
  /** git could not answer, or the sweep's bound was reached. NOT a verdict. */
  | "unknown";

export interface PinPathOutcome {
  readonly path: string;
  /** Where the file is now — the same path, a new one, or null. */
  readonly resolved: string | null;
  readonly status: PinPathStatus;
}

/** A `-M` name-status line: `R100\told\tnew`. Copies (`C`) are NOT followed. */
const RENAME_LINE = /^R\d*\t([^\t]+)\t(.+)$/;

/** Is there a working tree here at all? See the header: null is ambiguous. */
const repositoryAvailable = async (repoRoot: string): Promise<boolean> =>
  (await runGit(
    ["rev-parse", "--is-inside-work-tree"],
    repoRoot,
    GIT_TIMEOUT_MS,
  )) === "true";

/**
 * Which of these paths git is tracking right now — ONE call for the whole
 * set, rather than one `cat-file` per path: a 30-file pin would otherwise
 * spawn 30 processes to answer one question. An empty answer means "none of
 * them", which is only safe to believe after `repositoryAvailable`.
 */
const trackedPaths = async (
  repoRoot: string,
  paths: readonly string[],
): Promise<ReadonlySet<string>> => {
  const output = await runGit(
    // `--` before the pathspecs: a pinned path is data, and a file called
    // `--exclude` must never become an option.
    ["ls-files", "--", ...paths],
    repoRoot,
    GIT_TIMEOUT_MS,
  );
  if (output === null) {
    return new Set();
  }
  return new Set(
    output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
};

/** The one rename this path underwent in the commit that removed it, if any. */
const followOnce = async (
  repoRoot: string,
  path: string,
): Promise<string | null> => {
  const sha = await runGit(
    ["rev-list", "-n", "1", "HEAD", "--", path],
    repoRoot,
    GIT_TIMEOUT_MS,
  );
  if (sha === null || sha.length === 0) {
    return null;
  }
  const show = await runGit(
    ["show", "-M", "--name-status", "--format=", sha],
    repoRoot,
    GIT_TIMEOUT_MS,
  );
  if (show === null) {
    return null;
  }
  const destinations = new Set<string>();
  for (const line of show.split("\n")) {
    const match = RENAME_LINE.exec(line.trim());
    if (match?.[1] === path && match[2] !== undefined) {
      destinations.add(match[2]);
    }
  }
  // AMBIGUOUS IS NOT FOLLOWED. Two destinations for one source means git is
  // guessing, and a pin quietly re-pointed at the wrong file is worse than a
  // pin the human is told to fix.
  const [only] = [...destinations];
  return destinations.size === 1 && only !== undefined ? only : null;
};

/**
 * Resolves each pinned path against the working repository.
 *
 * Order is preserved so a caller can zip the result back onto its input, and
 * every path gets exactly one row — including the ones past the bound, which
 * come back "unknown" rather than silently vouched for.
 */
export const sweepPinPaths = async (
  repoRoot: string,
  paths: readonly string[],
): Promise<readonly PinPathOutcome[]> => {
  const considered = paths.slice(0, PIN_SWEEP_MAX_PATHS);
  const beyond: PinPathOutcome[] = paths
    .slice(PIN_SWEEP_MAX_PATHS)
    .map((path) => ({ path, resolved: null, status: "unknown" as const }));
  if (considered.length === 0) {
    return beyond;
  }
  if (!(await repositoryAvailable(repoRoot))) {
    // git could not answer at all (no repository, no binary, a deadline).
    // Every path is UNKNOWN: doctor prints that the sweep could not run.
    return [
      ...considered.map((path) => ({
        path,
        resolved: null,
        status: "unknown" as const,
      })),
      ...beyond,
    ];
  }
  const tracked = await trackedPaths(repoRoot, considered);
  const swept: PinPathOutcome[] = [];
  for (const path of considered) {
    if (tracked.has(path)) {
      swept.push({ path, resolved: path, status: "present" });
      continue;
    }
    let current = path;
    let resolved: string | null = null;
    for (let hop = 0; hop < PIN_SWEEP_MAX_HOPS; hop += 1) {
      const next = await followOnce(repoRoot, current);
      if (next === null) {
        break;
      }
      current = next;
      // A rename chain ends where git is tracking the file again; the loop
      // bound is what stops a pathological history costing unbounded calls.
      const stillThere = await trackedPaths(repoRoot, [current]);
      if (stillThere.has(current)) {
        resolved = current;
        break;
      }
    }
    swept.push(
      resolved === null
        ? { path, resolved: null, status: "missing" }
        : { path, resolved, status: "renamed" },
    );
  }
  return [...swept, ...beyond];
};
