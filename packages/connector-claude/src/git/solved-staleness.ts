import {
  STALENESS_GIT_TIMEOUT_MS,
  STALENESS_MAX_PATHS,
} from "../constants.ts";
import { runGit } from "./git.ts";

/**
 * Three honest answers, never two: "unknown" is a first-class state because
 * the check is fail-open (honest presentation — a solved tree whose
 * staleness could not be determined must say so, not read as current).
 */
export type SolvedFileDrift = "changed" | "unchanged" | "unknown";

const RADIX = 10;

/** A pathspec must never read as a flag or an empty argument. */
const isSafePath = (path: string): boolean =>
  path.length > 0 && !path.startsWith("-");

/**
 * Have any of `paths` been touched by a commit on `defaultRef` since
 * `sinceIso`? At most TWO bounded git calls at MCP pull time (the reader
 * asked for the tree; this is not a hook budget):
 *
 *   rev-list --count --since=<iso> <ref> -- <paths>
 *   ls-tree --name-only <ref> -- <paths>        (only when the count is 0)
 *
 * `--count` always prints a number on success, so runGit's null-on-empty
 * contract cannot swallow the "no commits" answer — zero prints "0". The
 * `--since` filter runs on commit dates, which is the right axis here: what
 * changed ON THE BRANCH after the diagnosis was recorded, whoever authored
 * it when.
 *
 * THE ZERO IS AMBIGUOUS AND MUST NOT BE VOUCHED FOR AS-IS: rev-list prints 0
 * both for an untouched file and for a pathspec that does not exist on `ref`
 * at all — and get_diagnosis explicitly serves cross-repo reads, where the
 * AUTHOR's file paths need not exist in the READER's repo. So "unchanged" is
 * only reported after ls-tree proves at least one of the paths resolves on
 * that ref; its output is the matching paths and nothing for absent ones, so
 * the null-on-empty contract turns "this branch never held any of these
 * files" into "unknown". Every failure — bad ref, no repo, slow git, all
 * paths filtered or absent — lands on "unknown".
 */
export const checkSolvedFileDrift = async (
  root: string,
  defaultRef: string,
  paths: readonly string[],
  sinceIso: string,
): Promise<SolvedFileDrift> => {
  const safePaths = [...new Set(paths)]
    .filter(isSafePath)
    .slice(0, STALENESS_MAX_PATHS);
  if (safePaths.length === 0 || Number.isNaN(Date.parse(sinceIso))) {
    return "unknown";
  }
  const output = await runGit(
    [
      "rev-list",
      "--count",
      `--since=${sinceIso}`,
      defaultRef,
      "--",
      ...safePaths,
    ],
    root,
    STALENESS_GIT_TIMEOUT_MS,
  );
  if (output === null) {
    return "unknown";
  }
  const count = Number.parseInt(output, RADIX);
  if (Number.isNaN(count)) {
    return "unknown";
  }
  if (count > 0) {
    return "changed";
  }
  const present = await runGit(
    ["ls-tree", "--name-only", defaultRef, "--", ...safePaths],
    root,
    STALENESS_GIT_TIMEOUT_MS,
  );
  return present === null ? "unknown" : "unchanged";
};
