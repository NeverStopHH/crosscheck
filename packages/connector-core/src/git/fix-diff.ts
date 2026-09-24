/**
 * DID THE FIX TOUCH WHAT THE ANSWER NAMED (1.0 spec 07 §3.4).
 *
 * Proof 3 asks whether an attribution was right, and the only evidence that
 * can answer it is the fix: what changed between the commit a human last
 * verified the surface working and the commit a human re-verified it after
 * repairing it. The hub knows both commits and holds no repository, so the
 * diff runs HERE, on the reader's clone, inside `crosscheck pilot` — one
 * bounded `git diff --name-only` per repaired attribution.
 *
 * FIVE OUTCOMES, AND ONLY TWO OF THEM SCORE. `hit` and `miss` are verdicts on
 * the answer; the other three are statements that no verdict exists, and each
 * is printed as itself rather than folded into a miss:
 *
 *   · `empty` — nothing in history changed between the two verifications.
 *     Whatever broke was not in the code the answer searched (a flag, a
 *     deploy, data), and counting a miss would blame the answer for it.
 *   · `too_broad` — the fix named more files than PILOT_FIX_DIFF_MAX_FILES. A
 *     five-hundred-file clean-up touches the named file by accident, and a hit
 *     scored on it would reward the answer for the size of the fix.
 *   · `unresolvable` — this clone cannot answer: a commit it never fetched, a
 *     git that did not answer in time, an id that is not a commit id, or an
 *     answer that named no file at all.
 */
import { COMMIT_SHA_PATTERN } from "@crosscheck/schema";

import { GIT_TIMEOUT_MS, PILOT_FIX_DIFF_MAX_FILES } from "../constants.ts";
import { runGitOutcome } from "./git.ts";

export const FIX_DIFF_OUTCOMES = [
  "hit",
  "miss",
  "empty",
  "too_broad",
  "unresolvable",
] as const;

export type FixDiffOutcome = (typeof FIX_DIFF_OUTCOMES)[number];

export interface FixRange {
  /** Where the broken invariant was last verified working. */
  readonly brokenCommit: string;
  /** Where a human re-verified it after the fix. */
  readonly repairCommit: string;
  /** The pinned files the named session had touched — what the answer named. */
  readonly namedFiles: readonly string[];
}

/**
 * NUL-separated, because git QUOTES a path with a non-ASCII byte in the
 * newline form (`"src/\303\244.ts"`), and a quoted spelling never equals the
 * pinned path it names — a right answer about a file with an umlaut in it
 * would score as a miss.
 */
const NUL = "\u0000";

export const scoreFix = async (
  repoRoot: string,
  range: FixRange,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<FixDiffOutcome> => {
  // THE IDS COME OFF THE WIRE. `--output=<file>` is a real `git diff` option,
  // so an id that is not a commit id never reaches the command line — the
  // alphabet check is what keeps "a hub answered" from meaning "a hub chose
  // this machine's git arguments".
  if (
    !COMMIT_SHA_PATTERN.test(range.brokenCommit) ||
    !COMMIT_SHA_PATTERN.test(range.repairCommit) ||
    range.namedFiles.length === 0
  ) {
    return "unresolvable";
  }
  const diff = await runGitOutcome(
    [
      "diff",
      "--name-only",
      "-z",
      // RENAMES OFF, so a fix that moved the named file lists the OLD path as
      // deleted. With detection on, `--name-only` prints only the new name,
      // the named path never appears, and a right answer scores as wrong.
      "--no-renames",
      range.brokenCommit,
      range.repairCommit,
      "--",
    ],
    repoRoot,
    timeoutMs,
  );
  if (!diff.ok) {
    return "unresolvable";
  }
  const changed = diff.stdout.split(NUL).filter((path) => path.length > 0);
  if (changed.length === 0) {
    return "empty";
  }
  if (changed.length > PILOT_FIX_DIFF_MAX_FILES) {
    return "too_broad";
  }
  const named = new Set(range.namedFiles);
  return changed.some((path) => named.has(path)) ? "hit" : "miss";
};
