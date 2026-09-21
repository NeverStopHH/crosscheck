/**
 * HAS THE CODE UNDER THIS CLAIM MOVED SINCE IT WAS OBSERVED (1.0 spec 02 §3.6).
 *
 * THE HUB HAS NO CHECKOUT. Like the pin sweep, the computing half runs on a
 * developer's machine and the hub only records what a clone reported. Only
 * path names and abbreviated commit hashes ever cross the wire — no file
 * content, no author, no message, no timestamps.
 *
 * THE AXIS IS GIT ANCESTRY, NOT A CLOCK. `X..<ref>` is happens-before over
 * commits inside one repository; the existing `checkSolvedFileDrift` asks
 * `--since=<iso>` about a WORK CONTEXT's files and is only run for solved
 * trees. "A claim is old" is not evidence "the code moved", which is the
 * confusion this module exists to end.
 *
 * TWO GIT CALLS, WORST CASE, and the two second calls are mutually exclusive:
 *
 *   1. rev-list --abbrev-commit --max-count=<cap+1> X..<ref> -- <paths>
 *      Non-empty ⇒ `changed`, newest-first (rev-list's own order).
 *   2a. …and if that filled the cap, rev-list --count over the same range, so
 *       "and N more" is a measured number rather than a shrug. It only runs
 *       on the truncated branch, where 2b never does.
 *   2b. Empty ⇒ ls-tree --name-only <ref> -- <paths>. Empty output ⇒
 *       `unknown` — the CROSS-REPO case get_diagnosis serves, where the
 *       author's paths need not exist in the reader's clone at all; a
 *       non-empty answer ⇒ `unchanged`.
 *
 * `runGitOutcome`, not `runGit`: the whole question turns on telling "the
 * command answered, and said nothing" from "the command did not answer", and
 * `runGit` collapses both to null. Every failure — a bad ref, a missing
 * binary, a deadline, an object this clone does not have (a teammate's
 * unpushed commit) — lands on `unknown`, never on `unchanged` and never on an
 * exception.
 */
import { COMMIT_SHA_PATTERN, isBindableCommit } from "@crosscheck/schema";

import {
  MAX_CLAIM_SURFACE_PATHS,
  MAX_CLAIM_TOUCHING_COMMITS,
  STALENESS_GIT_TIMEOUT_MS,
} from "../constants.ts";
import { runGitOutcome } from "./git.ts";
import type { SolvedFileDrift } from "./solved-staleness.ts";

const RADIX = 10;

/** A pathspec must never read as a flag or an empty argument. */
const isSafePath = (path: string): boolean =>
  path.length > 0 && !path.startsWith("-");

/** A ref is passed straight to git; it may not read as a flag either. */
const isSafeRef = (ref: string): boolean =>
  ref.length > 0 && !ref.startsWith("-");

export interface ClaimDrift {
  /** `SolvedFileDrift`'s three states verbatim — one vocabulary, not two. */
  readonly result: SolvedFileDrift;
  /**
   * Abbreviated hashes of the commits that touched the surface, NEWEST FIRST,
   * at most MAX_CLAIM_TOUCHING_COMMITS. Nothing else is kept: no author, no
   * email, no message, no parents, no paths (non-negotiable #6).
   */
  readonly touchingCommits: readonly string[];
  /**
   * How many commits touched it in total, or null when there are more than
   * the cap and the count could not be taken. Never a number larger than what
   * was measured: a bound must not claim more than it saw.
   */
  readonly touchingTotal: number | null;
  /** Paths actually handed to git, after the safety filter and the cap. */
  readonly pathsChecked: number;
  /** Paths the caller offered — `pathsChecked` below this is a narrowed answer. */
  readonly pathsGiven: number;
}

const unknownDrift = (pathsChecked: number, pathsGiven: number): ClaimDrift => ({
  result: "unknown",
  touchingCommits: [],
  touchingTotal: null,
  pathsChecked,
  pathsGiven,
});

/**
 * How many commits touched the surface in total, asked ONLY when the hash leg
 * filled its cap. Null when git could not answer — the renderer then says
 * "and more" instead of inventing a number.
 */
const countTouching = async (
  root: string,
  range: string,
  paths: readonly string[],
): Promise<number | null> => {
  const counted = await runGitOutcome(
    ["rev-list", "--count", range, "--", ...paths],
    root,
    STALENESS_GIT_TIMEOUT_MS,
  );
  if (!counted.ok) {
    return null;
  }
  const total = Number.parseInt(counted.stdout.trim(), RADIX);
  return Number.isNaN(total) ? null : total;
};

/**
 * The commit a default ref names RIGHT NOW, or null when git cannot say.
 *
 * ONE call per pull, and every drift range of that pull is then asked against
 * this sha rather than against the moving ref name. Two reasons, and the
 * second is the one that matters: `claim_revalidations.ref_commit` promises
 * which ref STATE a reading was taken against, and a range written as
 * `X..origin/main` would let a fetch landing mid-pull split one report across
 * two states while every row named one of them.
 */
export const resolveRefCommit = async (
  root: string,
  ref: string,
): Promise<string | null> => {
  if (!isSafeRef(ref)) {
    return null;
  }
  const resolved = await runGitOutcome(
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    root,
    STALENESS_GIT_TIMEOUT_MS,
  );
  if (!resolved.ok) {
    return null;
  }
  const sha = resolved.stdout.trim();
  return COMMIT_SHA_PATTERN.test(sha) ? sha : null;
};

export const checkClaimDrift = async (
  root: string,
  defaultRef: string,
  observedAtCommit: string,
  paths: readonly string[],
): Promise<ClaimDrift> => {
  const safePaths = [...new Set(paths)]
    .filter(isSafePath)
    // MAX_CLAIM_SURFACE_PATHS, not STALENESS_MAX_PATHS: a claim's declared
    // surface is capped at 30 by the wire schema, and slicing to the older
    // check's 20 here would silently ignore a third of what the author
    // declared — a downgrade computed over a surface nobody asked about.
    .slice(0, MAX_CLAIM_SURFACE_PATHS);
  if (
    safePaths.length === 0 ||
    !isBindableCommit(observedAtCommit) ||
    !isSafeRef(defaultRef)
  ) {
    return unknownDrift(safePaths.length, paths.length);
  }
  const range = `${observedAtCommit}..${defaultRef}`;
  const listed = await runGitOutcome(
    [
      "rev-list",
      "--abbrev-commit",
      `--max-count=${String(MAX_CLAIM_TOUCHING_COMMITS + 1)}`,
      range,
      "--",
      ...safePaths,
    ],
    root,
    STALENESS_GIT_TIMEOUT_MS,
  );
  if (!listed.ok) {
    return unknownDrift(safePaths.length, paths.length);
  }
  const hashes = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    // Re-checked on the way OUT as well as on the way in: these hashes are
    // about to be stored, shipped and rendered.
    .filter((line) => COMMIT_SHA_PATTERN.test(line));
  if (hashes.length === 0) {
    // rev-list prints nothing both for "no commits touched these paths" and
    // for "this ref never held any of them". ls-tree is what separates the
    // two, so `unchanged` is only ever vouched for after a path resolves.
    const present = await runGitOutcome(
      ["ls-tree", "--name-only", defaultRef, "--", ...safePaths],
      root,
      STALENESS_GIT_TIMEOUT_MS,
    );
    // A NARROWED SURFACE MAY CONFIRM A CHANGE AND MAY NEVER CONFIRM ITS
    // ABSENCE. `unchanged` asserts that nothing under this claim moved, and
    // that assertion is only as wide as the paths git was actually handed:
    // the ones past the cap were never looked at, so they cannot be vouched
    // for.
    //
    // The cut is neither random nor rare. `contextTargets` slices a work
    // context's file targets to MAX_CLAIM_SURFACE_PATHS while the hub serves
    // up to DIAGNOSIS_MAX_TARGETS of them, ordered by value — so a tree with
    // 40 targets always keeps the alphabetically first 30, and a rewrite of
    // `src/f039.ts` is invisible to every pull. `context_targets` is the
    // DEFAULT basis, so this is the ordinary path rather than an edge case.
    //
    // Measured before this guard existed: 40 targets, only `src/f039.ts`
    // rewritten, and the pull answered `unchanged`. The claim then rendered
    // "current: recorded at 81b092d; those files have not changed since" and
    // kept the unsolicited substance lane — about a file that had been
    // rewritten. Missing evidence moving a claim from `unknown` to `current`
    // is principle 5 inverted, and AT-2's own first "fails if".
    //
    // `changed` above needs no such guard: finding a commit in a SUBSET is
    // still finding one. A narrower look can only ever miss a change, never
    // invent one — which is the whole asymmetry principle 5 describes.
    const complete = safePaths.length === paths.length;
    return present.ok && present.stdout.trim().length > 0 && complete
      ? {
          result: "unchanged",
          touchingCommits: [],
          touchingTotal: 0,
          pathsChecked: safePaths.length,
          pathsGiven: paths.length,
        }
      : unknownDrift(safePaths.length, paths.length);
  }
  const truncated = hashes.length > MAX_CLAIM_TOUCHING_COMMITS;
  return {
    result: "changed",
    touchingCommits: hashes.slice(0, MAX_CLAIM_TOUCHING_COMMITS),
    touchingTotal: truncated
      ? await countTouching(root, range, safePaths)
      : hashes.length,
    pathsChecked: safePaths.length,
    pathsGiven: paths.length,
  };
};
