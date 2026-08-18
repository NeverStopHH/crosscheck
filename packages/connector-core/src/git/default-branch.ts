import { LANDED_GIT_TIMEOUT_MS } from "../constants.ts";
import { runGit } from "./git.ts";

/**
 * A ref this module will pass back into git on a later command line: no
 * leading dash (flag shape), only ref-alphabet characters. Everything here
 * comes out of git's own for-each-ref, but the guard costs nothing and the
 * value crosses into other git invocations (ancestry, staleness).
 */
const SAFE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_./-]*$/;

const isSafeRef = (ref: string): boolean => SAFE_REF_PATTERN.test(ref);

/**
 * The remote-tracking ref of the repo's default branch — `origin/main` — or
 * null when it cannot be known (no remote fetched, git missing or slow).
 *
 * ONE bounded git call, absence-collector style: for-each-ref over the three
 * refs that can answer, newest convention first. `origin/HEAD` is the
 * remote's own declaration (a symref written by clone/`remote set-head`) and
 * wins when present; otherwise the conventional names are probed in order.
 * Null = fail open — callers skip landed detection and staleness for this
 * session, never guess a branch.
 */
export const resolveDefaultBranchRef = async (
  root: string,
  timeoutMs: number = LANDED_GIT_TIMEOUT_MS,
): Promise<string | null> => {
  const output = await runGit(
    [
      "for-each-ref",
      "--format=%(refname:short)\t%(symref:short)",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
      "refs/remotes/origin/master",
    ],
    root,
    timeoutMs,
  );
  if (output === null) {
    return null;
  }
  const rows = output
    .split("\n")
    .map((line) => line.split("\t"))
    .map(([refName, symrefTarget]) => ({
      refName: refName ?? "",
      symrefTarget: symrefTarget ?? "",
    }));
  const head = rows.find((row) => row.refName === "origin/HEAD");
  if (head !== undefined && isSafeRef(head.symrefTarget)) {
    return head.symrefTarget;
  }
  const named =
    rows.find((row) => row.refName === "origin/main") ??
    rows.find((row) => row.refName === "origin/master");
  return named !== undefined && isSafeRef(named.refName)
    ? named.refName
    : null;
};
