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
 * WHAT `git diff` ALONE CANNOT SEE, stated rather than implied: changes
 * already committed during the session, and untracked new files. The
 * multi-root sweep (flows/git-lane.ts) closes both — `readGitCommits` for
 * this developer's own commits (`git_commit`), `includeUntracked` for new
 * files — and what stays out of reach is said there: a file committed and
 * then reverted, and a commit made on a branch the root has since left.
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

import {
  GIT_TOUCHES_TIMEOUT_MS,
  MAX_GIT_LANE_COMMITS,
  MAX_GIT_LANE_TARGETS_PER_ROOT,
  MAX_GIT_TOUCH_CANDIDATES,
  MAX_REFTABLE_REFLOG_ENTRIES,
} from "../constants.ts";
import { runGit, runGitOutcome } from "../git/git.ts";
import { commitsMadeAmong, commitsMadeInHeadLog, movesOfReflogShow } from "../git/head-history.ts";
import { isReftableGitDir } from "../git/repo-identity.ts";
import { sessionSlug } from "../config/paths.ts";
import { recordDrop } from "../spool/drops.ts";
import { captureFileTargets } from "./capture-targets.ts";
import type { CapturedFileTargets } from "./capture-targets.ts";
import { NO_GENERATED } from "../capture/generated.ts";
import type { GeneratedTally } from "../capture/generated.ts";
import { resolveDenylist } from "../capture/denylist.ts";
import type { DenylistConfig } from "../capture/denylist.ts";
import type { Producer } from "../capture/records.ts";
import type { SeqRange } from "../state/session-state.ts";

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
  /**
   * The block of positions Stop reserved for this lane, allocated BEFORE this
   * flow runs — the records below are spooled here, and Stop's own locked
   * `withGitTouches` write happens after them.
   */
  readonly seq?: SeqRange | null;
  /**
   * How long `git diff` may take. Absent = GIT_TOUCHES_TIMEOUT_MS, the bound
   * the Stop hook's budget needs. Only a test that builds thousands of dirty
   * files passes more, so a loaded machine cannot turn its bound check into
   * "git did not answer".
   */
  readonly gitTimeoutMs?: number;
  /**
   * Also the NEW files git does not track (`ls-files --others
   * --exclude-standard`). The multi-root sweep asks for them
   * (flows/git-lane.ts); a `cp` into a worktree leaves nothing else.
   */
  readonly includeUntracked?: boolean;
  /**
   * This root's untracked listing was already cut once in this life, and the
   * cut booked (review M8): a dump that stays is not one more loss per Stop.
   */
  readonly isUntrackedCutBooked?: boolean;
  /** Targets this call may still write; absent = the per-call cap. */
  readonly maxTargets?: number;
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
  /**
   * How the recorded paths were classified by the generated-target rule — the
   * lane that sees `bun install` and a codegen run, which is where most
   * generated files are written.
   */
  readonly generated: GeneratedTally;
}

const UNAVAILABLE: GitTouchesOutcome = { paths: [], unavailable: true, generated: NO_GENERATED };
const NOTHING_FRESH: GitTouchesOutcome = { paths: [], unavailable: false, generated: NO_GENERATED };

/** Lines git printed, trimmed, the empty ones dropped. */
const linesOf = (stdout: string): readonly string[] =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/** A denylist pattern that names a whole directory wherever it sits: `**\/<name>/**`. */
const DIRECTORY_GLOB = /^\*\*\/([^*?[\]{}!]+)\/\*\*$/;

/**
 * THE DENYLIST'S DIRECTORIES AS GIT PATHSPECS (review M8): an untracked
 * `node_modules/` nothing ignores is tens of thousands of lines the denylist
 * would refuse one by one after the bound had already cut the real new files
 * behind it. Git leaves them out instead, and never lists them at all.
 */
const untrackedExcludes = (denylist: DenylistConfig | null): readonly string[] =>
  resolveDenylist(denylist ?? undefined).flatMap((pattern) => {
    const name = DIRECTORY_GLOB.exec(pattern)?.[1];
    return name === undefined ? [] : [`:(exclude,glob)**/${name}/**`];
  });

/**
 * Untracked paths in a directory the repository already tracks come first
 * (review M8): a dump nothing ignores — a cache, a download — is a new
 * top-level directory of its own, and must not push the real new file in
 * `src/` past the bound. A file at the root counts as tracked ground. Stable
 * otherwise, in git's own order.
 */
const trackedGroundFirst = (paths: readonly string[], trackedDirs: ReadonlySet<string>): readonly string[] => {
  const isTrackedGround = (path: string): boolean => !path.includes("/") || trackedDirs.has(path.slice(0, path.indexOf("/")));
  return [...paths.filter(isTrackedGround), ...paths.filter((path) => !isTrackedGround(path))];
};

/** A working tree's changed paths: tracked ones, and the new ones git does not track yet in the order the bound reads them. */
interface ChangedPaths {
  readonly tracked: readonly string[];
  readonly untracked: readonly string[];
}

/**
 * The paths a working tree holds changed — `git diff --name-only HEAD`, and,
 * when asked, the NEW files git does not track yet (`ls-files --others
 * --exclude-standard`, ignored files and the denylist's directories left
 * out), tracked ground first. Null when git did not answer either question:
 * one answered half is not "nothing changed". The top-level listing that
 * orders them is no answer git owes: without it, git's own order stands.
 */
const changedPaths = async (input: CaptureGitTouchesInput): Promise<ChangedPaths | null> => {
  const timeoutMs = input.gitTimeoutMs ?? GIT_TOUCHES_TIMEOUT_MS;
  const isUntrackedAsked = input.includeUntracked === true;
  const [diff, untracked, tops] = await Promise.all([
    // HEAD, so staged and unstaged changes both count: an agent that ran
    // `git add` mid-turn has not made its work invisible.
    runGitOutcome(["diff", "--name-only", "HEAD"], input.repoRoot, timeoutMs),
    // A `cp` or a generator writes files git has never seen, and `git diff`
    // names none of them (DESIGN.md "One session, many topics").
    isUntrackedAsked
      ? runGitOutcome(["ls-files", "--others", "--exclude-standard", "--", ".", ...untrackedExcludes(input.denylist)], input.repoRoot, timeoutMs)
      : null,
    isUntrackedAsked ? runGitOutcome(["ls-tree", "--name-only", "-d", "HEAD"], input.repoRoot, timeoutMs) : null,
  ]);
  if (!diff.ok || (untracked !== null && !untracked.ok)) {
    return null;
  }
  const tracked = [...new Set(linesOf(diff.stdout))];
  const known = new Set(tracked);
  const fresh = untracked === null ? [] : linesOf(untracked.stdout).filter((path) => !known.has(path));
  const trackedDirs = new Set(tops?.ok === true ? linesOf(tops.stdout) : []);
  return { tracked, untracked: tops?.ok === true ? trackedGroundFirst(fresh, trackedDirs) : fresh };
};

/** Paths past the bound are never examined: whether this session touched THEM is unknown, so they are counted. */
const recordUnexamined = (input: CaptureGitTouchesInput, unexamined: number): Promise<void> =>
  recordDrop(input.home, input.repoKey, sessionSlug(input.hostSessionKey), unexamined, "capture-capped", input.now);

/** The fresh half of the git lane's answer, read and not yet spooled. */
export interface GitTouchesRead {
  readonly fresh: readonly string[];
  /** The untracked listing was cut at the bound this time (review M8): the caller remembers it for the root's life. */
  readonly isUntrackedCut: boolean;
}

/** The fresh half of the git lane's answer, read and not yet spooled — null when git did not answer. */
export const readGitTouches = async (input: CaptureGitTouchesInput): Promise<GitTouchesRead | null> => {
  const changed = await changedPaths(input);
  if (changed === null) {
    return null;
  }
  // Bounded BEFORE the stat calls: thousands of dirty files must not cost
  // thousands of filesystem round trips inside the Stop hook's budget
  // (constants.ts says where the bound's number comes from). Tracked changes
  // take the bound first; the untracked ones what is left of it.
  const tracked = changed.tracked.slice(0, MAX_GIT_TOUCH_CANDIDATES);
  const untracked = changed.untracked.slice(0, MAX_GIT_TOUCH_CANDIDATES - tracked.length);
  // REVIEW M5, NARROWED BY §10 ITEM 8: only the paths past the bound are
  // never examined, so only whether this session touched THEM is unknown —
  // counted as `capture-capped`, the per-call cap's word. A path within the
  // bound is examined below, and a stale one is no loss. An UNTRACKED cut is
  // one loss per root per life (review M8): the same dump on every Stop is
  // the same unknown, not tens of thousands more.
  const isUntrackedCut = untracked.length < changed.untracked.length;
  const untrackedBooked = isUntrackedCut && input.isUntrackedCutBooked !== true ? 1 : 0;
  await recordUnexamined(input, changed.tracked.length - tracked.length + untrackedBooked);
  const fresh: string[] = [];
  for (const path of [...tracked, ...untracked]) {
    if (await changedSince(input.repoRoot, path, input.since)) {
      fresh.push(path);
    }
  }
  return { fresh, isUntrackedCut };
};

/**
 * Spools the git-lane touches and returns them, exactly like
 * `captureFileTargets` — the caller folds them into its session state — plus
 * the one bit that says whether git answered at all.
 */
export const captureGitTouches = async (
  input: CaptureGitTouchesInput,
): Promise<GitTouchesOutcome> => {
  const read = await readGitTouches(input);
  if (read === null) {
    return UNAVAILABLE;
  }
  if (read.fresh.length === 0) {
    return NOTHING_FRESH;
  }
  const { captured: paths, generated } = await spoolGitTouches(input, read.fresh, "git_diff");
  return { paths, unavailable: false, generated };
};

/**
 * THE ONE SPOOLING CALL OF BOTH GIT HALVES — the working tree's changes
 * (`git_diff`) and this developer's commits (`git_commit`) — through the SAME
 * filter chain as the tool lane: repo-relative, denylist, seen-set, secret
 * scan, because a second lane that skipped the hot-file denylist would be a
 * way around it (capture/denylist.ts). Returns what it spooled and how the
 * generated-target rule classified it — the lane that sees `bun install` and
 * a codegen run, where most generated files are written.
 */
export const spoolGitTouches = async (
  input: CaptureGitTouchesInput,
  fresh: readonly string[],
  source: "git_diff" | "git_commit",
): Promise<CapturedFileTargets> =>
  captureFileTargets({
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
    ...(input.seq === undefined ? {} : { seq: input.seq }),
    // THE LANE'S OWN CAP, never the tool lane's per-call one: a root a long
    // session left a hundred files dirty files them in one sweep, and a
    // resumed life files again what its earlier life left (constants.ts
    // MAX_GIT_LANE_TARGETS_PER_ROOT). A caller handing over what an earlier
    // half of the same root left keeps its narrower number.
    maxTargets: input.maxTargets ?? MAX_GIT_LANE_TARGETS_PER_ROOT,
    paths: fresh,
    denylist: input.denylist,
    seenTargets: input.seenTargets,
    workContextId: input.workContextId,
    producer: input.producer,
    source,
    now: input.now,
  });

/** What separates one commit's header from the paths below it, and its two fields — bytes no path or email carries. */
const COMMIT_MARK = "\u0001";
const FIELD_MARK = "\u0002";
const MS_PER_SECOND = 1000;

/**
 * The paths of the commits `author` made since `since`, newest first, each
 * once. Read off git's own author email and author date, compared exactly —
 * never `--author`'s regular expression, which a dot in an address turns into
 * a wildcard that matches a teammate.
 */
const authoredPaths = (stdout: string, author: string, since: Date): readonly string[] => {
  const paths = new Set<string>();
  for (const block of stdout.split(COMMIT_MARK).slice(1)) {
    const [header = "", ...files] = block.split("\n");
    const [email = "", at = ""] = header.split(FIELD_MARK);
    const isOwn = email.trim().toLowerCase() === author;
    // git keeps whole seconds: a commit in the very second the window opened
    // reads as that second's start, so the window is compared in seconds too.
    const isInWindow = Number(at) >= Math.floor(since.getTime() / MS_PER_SECOND);
    if (isOwn && isInWindow) {
      for (const file of linesOf(files.join("\n"))) {
        paths.add(file);
      }
    }
  }
  return [...paths];
};

/**
 * The commits this worktree made, from its HEAD log — read from the file, or,
 * in a REFTABLE repository (review M3), where the log lives in the table
 * files, from one bounded `git reflog show`. Null when that git did not answer
 * in time; a reflog git refuses (an unborn HEAD) made nothing.
 */
const commitsMadeIn = async (input: CaptureGitTouchesInput, gitDir: string, timeoutMs: number): Promise<readonly string[] | null> => {
  if (!(await isReftableGitDir(gitDir))) {
    return commitsMadeInHeadLog(gitDir, input.since);
  }
  const reflog = await runGitOutcome(
    ["reflog", "show", "--date=unix", "--format=%H%x09%gd%x09%gs", "-n", String(MAX_REFTABLE_REFLOG_ENTRIES), "HEAD", "--"],
    input.repoRoot,
    timeoutMs,
  );
  if (!reflog.ok) {
    return reflog.timedOut ? null : [];
  }
  return commitsMadeAmong(movesOfReflogShow(reflog.stdout), input.since);
};

/**
 * THE COMMIT HALF (DESIGN.md "One session, many topics"): the files of the
 * commits THIS developer made IN THIS WORKTREE since `since` — a session that
 * commits through a shell leaves a clean tree, and `git diff` cannot see work
 * that was already committed.
 *
 * WHICH COMMITS: the ones the worktree's own HEAD log says it made
 * (git/head-history.ts `commitsMadeInHeadLog`, review H1), never HEAD's
 * history. Read from history, a merge of another topic's branch, a start
 * checkout re-detached at a newer main, a worktree re-added at the same path
 * or a second worktree on the same branch filed another topic's commits under
 * this one. A teammate's commit keeps its own author and is dropped here too.
 * Bounded at MAX_GIT_LANE_COMMITS commits and the lane's own path bound. Null
 * when git did not answer; an empty list when the worktree made nothing in the
 * window, its HEAD log is unreadable, or nobody is configured to attribute a
 * commit to.
 *
 * NO CLOCK QUESTION TO GIT (CCB-2, test/staleness-axis.test.ts). Git is asked
 * about named commits — `--no-walk`, no date filter — and the window is cut
 * on the HEAD log's own instants and each commit's AUTHOR time and this
 * developer's address. It is a question about this session's ACTIVITY, never
 * about a claim's currency, and it feeds capture, not any claim's authority.
 */
export const readGitCommits = async (
  input: CaptureGitTouchesInput & { readonly gitDir: string | null; readonly authorEmail?: string | null },
): Promise<readonly string[] | null> => {
  const timeoutMs = input.gitTimeoutMs ?? GIT_TOUCHES_TIMEOUT_MS;
  const made = input.gitDir === null ? [] : await commitsMadeIn(input, input.gitDir, timeoutMs);
  if (made === null) {
    return null;
  }
  if (made.length === 0) {
    return [];
  }
  const [log, configured] = await Promise.all([
    runGitOutcome(
      [
        "log",
        "--no-walk=unsorted",
        "--no-merges",
        `--format=${COMMIT_MARK}%ae${FIELD_MARK}%at`,
        "--name-only",
        ...made.slice(-MAX_GIT_LANE_COMMITS),
        "--",
      ],
      input.repoRoot,
      timeoutMs,
    ),
    input.authorEmail === undefined ? runGit(["config", "user.email"], input.repoRoot, timeoutMs) : input.authorEmail,
  ]);
  if (!log.ok) {
    return null;
  }
  const author = configured?.trim().toLowerCase() ?? "";
  const paths = author.length === 0 ? [] : authoredPaths(log.stdout, author, input.since);
  const candidates = paths.slice(0, MAX_GIT_TOUCH_CANDIDATES);
  await recordUnexamined(input, paths.length - candidates.length);
  return candidates;
};
