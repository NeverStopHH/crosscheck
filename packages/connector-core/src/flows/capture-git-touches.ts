/**
 * The SECOND evidence lane (regression-guard Stage 1): a bounded
 * `git diff --name-only HEAD` at Stop, recorded as `git_diff` targets.
 *
 * WHY IT EXISTS. The tool lane records what the HOST reports as an edit —
 * on Claude Code the hook matcher is `Edit|Write|MultiEdit|NotebookEdit` —
 * so a session that ran `sed -i`, a codemod, `prettier --write` or a
 * generator leaves no trace in it whatsoever. `crosscheck suspect` would
 * then name the session that used Edit with total confidence while the
 * session that actually rewrote the file is invisible. Two lanes, both
 * labelled, is the honest shape; merging them would hide the difference.
 *
 * WHY MTIME AND NOT THE RAW DIFF. `git diff HEAD` reports every uncommitted
 * change in the worktree, and a worktree is usually already dirty when a
 * session starts. Recording that dirt as this session's work is a false
 * accusation with somebody's name one hop away, so a path counts only when
 * the file was modified after the session began. mtime beats a
 * SessionStart baseline for the case that matters most: a file that was
 * already dirty AND was changed again during the session is this session's
 * touch, and a baseline would have excluded it.
 *
 * WHAT IT CANNOT SEE, stated rather than implied: changes already committed
 * during the session, and untracked new files (`git diff` reports neither).
 * `doctor` prints the same sentence, because a lane whose blind spots are
 * undocumented reads as coverage it does not have.
 *
 * "NOTHING" AND "NO ANSWER" ARE DIFFERENT FACTS, which is why this returns an
 * outcome and not a bare list. `git diff` failing — a GIT_TOUCHES_TIMEOUT_MS
 * deadline on a loaded machine, no repository, no git binary — produces the
 * same empty list a clean worktree does, and the caller that cannot tell them
 * apart reports a lane that never answers as a lane watching a quiet tree.
 * That is the fail-silent-dead this whole feature exists to refuse, so the
 * unanswered case is flagged and the Stop hook counts it as a skip.
 *
 * NO FILE CONTENT, EVER. `--name-only` is the whole point: Tier-0 privacy
 * holds, git answers "which files", and nothing about their contents enters
 * crosscheck's address space.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { GIT_TOUCHES_TIMEOUT_MS, MAX_GIT_TOUCH_CANDIDATES } from "../constants.ts";
import { runGitOutcome } from "../git/git.ts";
import { captureFileTargets } from "./capture-targets.ts";
import type { DenylistConfig } from "../capture/denylist.ts";
import type { Producer } from "../capture/records.ts";

export interface CaptureGitTouchesInput {
  readonly home: string;
  readonly repoKey: string;
  readonly hostSessionKey: string;
  readonly repoRoot: string;
  readonly workContextId: string;
  readonly producer: Producer;
  /** Paths the tool lane already recorded — one row per file, one source. */
  readonly seenTargets: readonly string[];
  readonly denylist: DenylistConfig | null;
  /** When this session started: older mtimes are somebody else's work. */
  readonly since: Date;
  readonly now: Date;
}

/** True when the file changed after the session began. Unreadable = no. */
const changedSince = async (
  repoRoot: string,
  relativePath: string,
  since: Date,
): Promise<boolean> => {
  try {
    const stats = await stat(join(repoRoot, relativePath));
    return stats.mtimeMs >= since.getTime();
  } catch {
    // Deleted between the diff and the stat, or unreadable. Not recorded:
    // the lane errs towards saying nothing rather than towards naming a
    // session for a file it cannot even see.
    return false;
  }
};

export interface GitTouchesOutcome {
  /** Recorded paths. Empty when git answered and nothing was fresh. */
  readonly paths: readonly string[];
  /**
   * True when git DID NOT ANSWER — a deadline, no repository, no binary.
   * The caller counts it, so an always-timing-out lane is a number rather
   * than a silence that reads as health.
   */
  readonly unavailable: boolean;
}

const UNAVAILABLE: GitTouchesOutcome = { paths: [], unavailable: true };
const NOTHING_FRESH: GitTouchesOutcome = { paths: [], unavailable: false };

/**
 * Spools the git-lane touches and returns them, exactly like
 * `captureFileTargets` — the caller folds them into its session state — plus
 * the one bit that says whether git answered at all.
 */
export const captureGitTouches = async (
  input: CaptureGitTouchesInput,
): Promise<GitTouchesOutcome> => {
  const outcome = await runGitOutcome(
    // HEAD, so staged and unstaged changes both count: an agent that ran
    // `git add` mid-turn has not made its work invisible.
    ["diff", "--name-only", "HEAD"],
    input.repoRoot,
    GIT_TOUCHES_TIMEOUT_MS,
  );
  if (!outcome.ok) {
    return UNAVAILABLE;
  }
  const candidates = outcome.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // Bounded BEFORE the stat calls: a 200-file rebase in the worktree must
    // not cost 200 filesystem round trips inside a hook budget.
    .slice(0, MAX_GIT_TOUCH_CANDIDATES);
  const fresh: string[] = [];
  for (const path of candidates) {
    if (await changedSince(input.repoRoot, path, input.since)) {
      fresh.push(path);
    }
  }
  if (fresh.length === 0) {
    return NOTHING_FRESH;
  }
  // Through the SAME filter chain as the tool lane — repo-relative, denylist,
  // seen-set, secret scan — because a second lane that skipped the hot-file
  // denylist would be a way around it (capture/denylist.ts).
  const paths = await captureFileTargets({
    home: input.home,
    repoKey: input.repoKey,
    hostSessionKey: input.hostSessionKey,
    repoRoot: input.repoRoot,
    // git prints repo-relative paths already; anchoring the resolve at the
    // repo root keeps `toRepoRelative` a no-op instead of a re-derivation
    // against whatever directory the hook happened to run in.
    cwd: input.repoRoot,
    // THE #17 RESOLUTION, STATED RATHER THAN OMITTED. capture-touched-files.ts
    // is the flow that resolves a HOST-REPORTED path against the root that
    // governs the file, because a host names a path in whatever directory its
    // event fired in. This lane has no host event: `git diff` ran IN
    // `repoRoot` and git cannot name a file outside the worktree it ran in, so
    // every candidate is already governed by that root. Passing it explicitly
    // is the same value the absent hook resolves to — and it keeps the caller
    // audit in capture-touched-files.ts able to see this call site.
    resolveRoot: () => input.repoRoot,
    paths: fresh,
    denylist: input.denylist,
    seenTargets: input.seenTargets,
    workContextId: input.workContextId,
    producer: input.producer,
    source: "git_diff",
    now: input.now,
  });
  return { paths, unavailable: false };
};
