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
 * SIX OUTCOMES, AND ONLY TWO OF THEM SCORE. `hit` and `miss` are verdicts on
 * the answer; the other four are statements that no verdict exists, and each
 * is printed as itself rather than folded into a miss:
 *
 *   · `not_discriminating` — the fix changed pinned files and nothing only the
 *     named session had touched. Every candidate touched a pinned file — that
 *     is what made it a candidate — so this fix cannot tell one candidate
 *     from another. Corrected: the first version scored the pinned overlap,
 *     and every ranked answer on a one-file pin read as a hit, including one
 *     naming a session that never broke anything.
 *
 *   · `empty` — nothing in history changed between the two verifications.
 *     Whatever broke was not in the code the answer searched (a flag, a
 *     deploy, data), and counting a miss would blame the answer for it.
 *   · `too_broad` — the fix named more files than PILOT_FIX_DIFF_MAX_FILES. A
 *     five-hundred-file clean-up touches the named file by accident, and a hit
 *     scored on it would reward the answer for the size of the fix.
 *   · `unresolvable` — this clone cannot answer: a commit it never fetched, a
 *     git that did not answer in time, or an id that is not a commit id.
 *
 * THE RANGE IS THE FIX, NOT THE BREAK: from the commit where the break was
 * RECORDED to the commit where it was re-verified. From the last-working
 * commit it contained the breaking change itself, and a revert fix netted to
 * nothing.
 */
import { COMMIT_SHA_PATTERN } from "@crosscheck/schema";

import { GIT_TIMEOUT_MS, PILOT_FIX_DIFF_MAX_FILES } from "../constants.ts";
import { runGitOutcome } from "./git.ts";

export const FIX_DIFF_OUTCOMES = [
  "hit",
  "miss",
  "not_discriminating",
  "empty",
  "too_broad",
  "unresolvable",
] as const;

export type FixDiffOutcome = (typeof FIX_DIFF_OUTCOMES)[number];

export interface FixRange {
  /** Where the break was recorded — the fix range starts after the break. */
  readonly brokenCommit: string;
  /** Where a human re-verified it after the fix. */
  readonly repairCommit: string;
  /** The pin's files, which every candidate touched. */
  readonly pinnedFiles: readonly string[];
  /** Files ONLY the named session touched, outside the pin — what tells it apart. */
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
    !COMMIT_SHA_PATTERN.test(range.repairCommit)
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
  // POSITIVE EVIDENCE OR NOTHING. A hit needs the fix to have gone into work
  // only the named session did; a miss needs the fix to have gone entirely
  // elsewhere. Between the two — the fix touched the pinned files everyone
  // touched — the answer is neither right nor wrong on this evidence.
  const named = new Set(range.namedFiles);
  if (changed.some((path) => named.has(path))) {
    return "hit";
  }
  const pinned = new Set(range.pinnedFiles);
  return changed.some((path) => pinned.has(path)) ? "not_discriminating" : "miss";
};
