/**
 * THE GIT LANE OVER EVERY ROOT THE SESSION TOUCHED (DESIGN.md "One session,
 * many topics").
 *
 * THE DEFECT. The Stop-time lane diffed ONE root — the checkout the hook's cwd
 * sat in — and only its uncommitted changes. One long-lived session edits a
 * dozen sibling worktrees, much of it through a shell (`cp`, `mv`, redirects,
 * generators, `git commit`), and the edits no Edit tool reported were lost in
 * every root but one; work committed during a turn, and new files git does not
 * track yet, were lost even there.
 *
 * THE SWEEP. At Stop — and at SubagentStop, for the subagent's own root — the
 * lane visits the session's own root, the hook's cwd root and every root of
 * this repo in the session's cache (`knownWorktreeRoots`), bash-touched ones
 * first (hooks/post-tool-use.ts marks them), up to MAX_GIT_LANE_ROOTS. For each,
 * in parallel, each git call on its own GIT_TOUCHES_TIMEOUT_MS deadline:
 *
 *   (a) `git diff --name-only HEAD` — the working tree's changes (`git_diff`);
 *   (b) the commits THIS developer authored on the root's branch since the
 *       session first touched the root, bounded (`git_commit`) — a teammate's
 *       commit keeps its own author and never counts;
 *   (c) the new files git does not track yet (`git_diff`).
 *
 * Every path the root yields files under THAT ROOT'S TOPIC — its branch, read
 * from its HEAD file — opening the topic's work context ahead of its first
 * target exactly as the tool lane does (flows/topic-contexts.ts).
 *
 * THE WINDOW. Files modified, and commits authored, since the session started
 * — its FIRST start, kept across compacts and resumes, and reaching back over
 * the conversation's earlier lives (`windowStartOf`, review batch 2, H1) —
 * for a root the session reached later, since its first recorded touch less
 * GIT_LANE_TOUCH_SLACK_MS, because a shell command is marked only after it
 * ran. Never earlier: a sibling worktree's history before this session
 * touched it is somebody's, and naming this session for it is the false
 * accusation the lane exists to avoid.
 *
 * WHAT STAYS INVISIBLE, stated: a file changed and changed back inside one
 * turn, and a commit on a branch the root has since left (`git log HEAD`
 * walks the branch the root is on now).
 */
import { GIT_LANE_TOUCH_SLACK_MS, MAX_GIT_LANE_ROOTS, MAX_TARGETS_PER_INVOCATION } from "../constants.ts";
import { hasGitEntry } from "../config/connected-repo.ts";
import { realpathBestEffort } from "../config/paths.ts";
import type { DenylistConfig } from "../capture/denylist.ts";
import type { Producer } from "../capture/records.ts";
import { seqAfter, seqSlice } from "../capture/seq.ts";
import type { RootHead, TouchedRootsResolution } from "../capture/touched-root.ts";
import { gitDirOf, readHeadFile } from "../git/repo-identity.ts";
import { changedWorktreesOf, commonDirOfRoot } from "../git/shell-roots.ts";
import type { HeadFile } from "../git/repo-identity.ts";
import { appendRecords } from "../spool/append.ts";
import { recordCaptureLoss } from "../state/loss-ledger.ts";
import { withSweptRoot } from "../state/session-state.ts";
import type { SeqRange, SessionState } from "../state/session-state.ts";
import { readGitCommits, readGitTouches, spoolGitTouches } from "./capture-git-touches.ts";
import type { CaptureGitTouchesInput } from "./capture-git-touches.ts";
import type { CapturedFileTargets } from "./capture-targets.ts";
import { NO_GENERATED, addGeneratedTally } from "../capture/generated.ts";
import type { GeneratedTally } from "../capture/generated.ts";
import { mergeTopicCaptures, plannedTopicRecords, relabelsKept, seenPathsOf, topicLifeOf, topicSeenKey } from "./topic-contexts.ts";
import type { Filing, TopicCapture, TopicKeySource, TopicLife } from "./topic-contexts.ts";
import { topicKeyFrom } from "../state/topic-key.ts";
import { planTopics } from "./topic-rules.ts";
import { topicBaseProbe, withTopicBaseWords } from "./topic-base-word.ts";
import type { TopicBaseProbe } from "./topic-base-word.ts";

/** One root the lane sweeps, and the window it reads it in. */
export interface GitLaneRoot {
  readonly root: string;
  /** Commits authored, and files modified, at or after this instant count. */
  readonly since: Date;
  /** The commit at the session's first touch of the root, for a topic opened here. */
  readonly firstHead: string | null;
  /** The session's own checkout — a state from before topics files it under the session whatever its branch. */
  readonly isSessionRoot: boolean;
}

export interface GitLaneChoice {
  /** The root the hook's own cwd resolved to, when it is this session's repo. */
  readonly cwdRoot: string | null;
  /**
   * SubagentStop: the subagent's own root first, then only the roots a shell
   * touched — a subagent ends many times a session, and the full sweep is
   * Stop's to make.
   */
  readonly subagent?: boolean;
  /** The repo's worktrees a shell may have worked in, changed since their last sweep (`discoverShellRoots`). */
  readonly discovered?: readonly string[];
}

/**
 * WHERE A SHELL MAY HAVE WORKED, when its words could not tell (review H2):
 * after a Bash call, every worktree of the session's repo whose index or HEAD
 * log changed since the session began and since its own last sweep. Fs only
 * (git/shell-roots.ts); nothing when no shell ran since the last full sweep.
 */
export const discoverShellRoots = async (state: SessionState): Promise<readonly string[]> => {
  if (state.shellSweepSince === null || state.shellSweepSince === undefined) {
    return [];
  }
  const commonDir = await commonDirOfRoot(await realpathBestEffort(state.repoRoot));
  if (commonDir === null) {
    return [];
  }
  const changed = await changedWorktreesOf(commonDir, windowStartOf(state));
  return changed
    .filter((entry) => {
      const sweptAt = state.knownWorktreeRoots.find((known) => known.root === entry.root)?.gitSweptAt ?? null;
      return sweptAt === null || entry.changedAtMs > Date.parse(sweptAt);
    })
    .map((entry) => entry.root);
};

/** How many of the roots a shell asked for — marked or discovered — the cap left for a later Stop (review H2). */
export const deferredRootsOf = async (
  state: SessionState,
  choice: GitLaneChoice,
  roots: readonly GitLaneRoot[],
): Promise<number> => {
  const { pressing } = await orderedCandidates(state, choice);
  const swept = new Set(roots.map((lane) => lane.root));
  return pressing.filter((root) => !swept.has(root)).length;
};

type KnownRoot = SessionState["knownWorktreeRoots"][number];

/**
 * WHERE THE WINDOW OPENS (review batch 2, H1): the conversation's first
 * start when an earlier life of it ended (`captureSince`, carried from its
 * lineage), else this session's own start — which a compact or resume
 * re-fire keeps (state/session-state.ts routingFieldsOf). A restamped start
 * dropped every Bash-only file written before the fire from the turn's
 * Stop, and a resumed conversation's next life filed nothing its earlier
 * life had left dirty or committed.
 */
export const windowStartOf = (state: SessionState): Date => new Date(state.captureSince ?? state.startedAt);

/** Newest first; a root never stamped sorts last. */
const newestFirst = (left: string | null, right: string | null): number =>
  (right ?? "").localeCompare(left ?? "");

const windowOf = (isSessionRoot: boolean, entry: KnownRoot | undefined, started: Date): Date => {
  const firstTouch = entry?.firstTouchedAt ?? null;
  if (isSessionRoot || firstTouch === null) {
    return started;
  }
  const opened = Date.parse(firstTouch) - GIT_LANE_TOUCH_SLACK_MS;
  return Number.isNaN(opened) ? started : new Date(Math.max(started.getTime(), opened));
};

/** Swept longest ago first — never swept before all — then touched most recently. */
const byTurn = (left: KnownRoot, right: KnownRoot): number =>
  (left.gitSweptAt ?? "").localeCompare(right.gitSweptAt ?? "") ||
  newestFirst(left.lastTouchedAt, right.lastTouchedAt);

/** The roots that must be swept, in order — before the cap cuts the list. */
const orderedCandidates = async (
  state: SessionState,
  choice: GitLaneChoice,
): Promise<{ readonly ordered: readonly string[]; readonly pressing: readonly string[]; readonly sessionRoot: string }> => {
  const sessionRoot = await realpathBestEffort(state.repoRoot);
  const cwd = choice.cwdRoot === null ? [] : [await realpathBestEffort(choice.cwdRoot)];
  const own = state.knownWorktreeRoots.filter((entry) => entry.repoId === state.repoId);
  const bashed = own
    .filter((entry) => entry.bashTouchedAt !== null)
    .sort((left, right) => newestFirst(left.bashTouchedAt, right.bashTouchedAt))
    .map((entry) => entry.root);
  const discovered = choice.discovered ?? [];
  const recent = [...own].sort(byTurn).map((entry) => entry.root);
  const ordered =
    choice.subagent === true
      ? [...cwd, ...bashed, ...discovered]
      : [...bashed, ...cwd, ...discovered, sessionRoot, ...recent];
  return { ordered: [...new Set(ordered)], pressing: [...new Set([...bashed, ...discovered])], sessionRoot };
};

/**
 * WHICH ROOTS, IN WHICH ORDER: bash-touched first (a shell wrote what no edit
 * event named there), then the cwd's, then the worktrees a shell may have
 * worked in where its words could not tell (`discovered`, review H2), then
 * the session's own, then every other root of this repo the session touched,
 * the one swept longest ago first — each once, at most MAX_GIT_LANE_ROOTS, so
 * a session past the cap sweeps its other roots in turn rather than never. A
 * foreign root is never swept.
 */
export const selectGitLaneRoots = async (
  state: SessionState,
  choice: GitLaneChoice,
): Promise<readonly GitLaneRoot[]> => {
  const { ordered, sessionRoot } = await orderedCandidates(state, choice);
  const own = state.knownWorktreeRoots.filter((entry) => entry.repoId === state.repoId);
  const started = windowStartOf(state);
  return ordered.slice(0, MAX_GIT_LANE_ROOTS).map((root) => {
    const entry = own.find((known) => known.root === root);
    const isSessionRoot = root === sessionRoot;
    return { root, since: windowOf(isSessionRoot, entry, started), firstHead: entry?.firstHead ?? null, isSessionRoot };
  });
};

export interface SweepGitRootsInput {
  readonly home: string;
  readonly repoKey: string;
  readonly hostSessionKey: string;
  /** The life the sweep files under, read at the hook's start. */
  readonly state: SessionState;
  readonly roots: readonly GitLaneRoot[];
  readonly producer: Producer;
  readonly denylist: DenylistConfig | null;
  readonly now: Date;
  /**
   * ONE block for the whole sweep, allocated before it: root i owns positions
   * [i × MAX_TARGETS_PER_INVOCATION, (i + 1) × MAX_TARGETS_PER_INVOCATION).
   */
  readonly seq: SeqRange | null;
  /** Each git call's deadline; absent = GIT_TOUCHES_TIMEOUT_MS. */
  readonly gitTimeoutMs?: number;
  /** The key the topics the sweep opens are minted under: this machine's (state/topic-key.ts) by default. */
  readonly topicKey?: TopicKeySource;
}

export interface GitLaneSweep {
  /** Seen-set entries for what was spooled, topic-keyed (`topicSeenKey`). */
  readonly captured: readonly string[];
  readonly topics: TopicCapture | null;
  /** Some root's git did not answer: the turn counts as a skip, and the loss is booked. */
  readonly unavailable: boolean;
  /** Roots git answered for: their bash marks are spent (`withSweptRoots`). */
  readonly swept: readonly string[];
  /** Roots whose untracked listing the bound cut (review M8): booked once, remembered for the life. */
  readonly untrackedCut: readonly string[];
  /** How every root's spooled paths were classified by the generated-target rule, summed (capture/generated.ts). */
  readonly generated: GeneratedTally;
}

/** What one root's reads found, before anything is spooled. */
interface RootRead {
  readonly lane: GitLaneRoot;
  readonly head: HeadFile | null;
  /** The worktree is gone (`git worktree remove`): nothing to read, and nothing lost. */
  readonly gone: boolean;
  readonly commits: readonly string[] | null;
  readonly touches: readonly string[] | null;
  readonly isUntrackedCut: boolean;
}

const laneInput = (input: SweepGitRootsInput, lane: GitLaneRoot): CaptureGitTouchesInput => ({
  home: input.home,
  repoKey: input.repoKey,
  hostSessionKey: input.hostSessionKey,
  repoRoot: lane.root,
  workContextId: input.state.workContextId,
  producer: input.producer,
  seenTargets: [],
  denylist: input.denylist,
  since: lane.since,
  now: input.now,
  ...(input.gitTimeoutMs === undefined ? {} : { gitTimeoutMs: input.gitTimeoutMs }),
});

const readRoot = async (input: SweepGitRootsInput, lane: GitLaneRoot): Promise<RootRead> => {
  const head = await readHeadFile(lane.root);
  if (head === null && !(await hasGitEntry(lane.root))) {
    return { lane, head, gone: true, commits: [], touches: [], isUntrackedCut: false };
  }
  const base = laneInput(input, lane);
  // A HEAD the files cannot tell — a reftable's placeholder (review M3) — is
  // still a worktree git answers for: its work files under the session, and
  // its commits come from its own HEAD log all the same.
  const gitDir = head?.gitDir ?? (await gitDirOf(lane.root));
  const known = input.state.knownWorktreeRoots.find((entry) => entry.root === lane.root);
  const isUntrackedCutBooked = known?.untrackedCutLife === input.state.crosscheckSessionId;
  const [commits, touches] = await Promise.all([
    readGitCommits({ ...base, gitDir }),
    readGitTouches({ ...base, includeUntracked: true, isUntrackedCutBooked }),
  ]);
  return { lane, head, gone: false, commits, touches: touches?.fresh ?? null, isUntrackedCut: touches?.isUntrackedCut ?? false };
};

/**
 * Every path of one root resolves against that root, on the branch its HEAD
 * names — the session's own spelled as its state spells it, which is how the
 * topic rules recognise its start topic (flows/topic-rules.ts `candidatesOf`).
 */
const resolutionOf = (read: RootRead, paths: readonly string[], state: SessionState, now: Date): TouchedRootsResolution => {
  const root = read.lane.isSessionRoot ? state.repoRoot : read.lane.root;
  const head: RootHead = {
    root: read.lane.root,
    repoId: state.repoId,
    branch: read.head?.branch ?? null,
    headStamp: read.head?.content ?? null,
    firstHead: read.lane.firstHead,
    head: read.head,
    touchedAt: now.toISOString(),
  };
  return {
    rootByPath: new Map(paths.map((path) => [path, root])),
    foreignDrops: 0,
    outsideDrops: 0,
    newlyResolved: [],
    firstResolvedRoot: null,
    headByRoot: new Map([[root, head]]),
  };
};

interface RootSpooled {
  readonly captured: readonly string[];
  readonly generated: GeneratedTally;
  readonly topic: TopicCapture;
}

/** A half of a root that had nothing to spool. */
const NOTHING_SPOOLED: CapturedFileTargets = { captured: [], generated: NO_GENERATED };

/**
 * WHAT ANOTHER TOPIC OF THIS ROOT ALREADY HOLDS (review M5): every path in the
 * seen-set of one of this life's other topics of the same worktree. A dirty
 * file carried across `git switch -c` is the old topic's work, already sent
 * under it; filing it under the new topic too made one move two different
 * models depending on which hook fired first. Filed under its holder it would
 * be a re-sighting the seen-set drops, so it is left out here instead.
 */
const heldElsewhere = (life: TopicLife, root: string, filing: Filing): ReadonlySet<string> =>
  new Set(
    life.topics
      .filter((topic) => topic.sessionId === life.sessionId && topic.root === root && topic.key !== filing.key)
      .flatMap((topic) => seenPathsOf(life.seenTargets, topic.key)),
  );

/**
 * ONE ROOT'S FINDINGS INTO THE SPOOL: its topic's context first when the
 * topic is new (a failed append files the root under the session's own
 * context instead), then its working-tree changes, then its commits — one
 * slice of the block, one cap, shared; a path another topic of the root holds
 * is left to it (review M5). Changes first, because a file both committed and
 * changed again is still being changed: `git_diff` is the fresher sighting,
 * and the commit half adds what a clean tree hides.
 */
const spoolRoot = async (
  input: SweepGitRootsInput,
  read: RootRead,
  index: number,
  life: TopicLife,
  probe: TopicBaseProbe,
  topicKey: TopicKeySource,
): Promise<RootSpooled | null> => {
  const commits = read.commits ?? [];
  const touches = read.touches ?? [];
  const paths = [...commits, ...touches];
  const [first] = paths;
  if (first === undefined) {
    return null;
  }
  // The topics this root opens, each with its own word about its base (topic
  // review C1; flows/topic-base-word.ts).
  const plan = await withTopicBaseWords(
    await planTopics(life, resolutionOf(read, paths, input.state, input.now), paths, input.now, topicKey, read.lane.root),
    probe,
  );
  const session: Filing = { key: null, workContextId: life.sessionWorkContextId };
  const records = plannedTopicRecords(plan, life, input.producer, input.now);
  const isOpened =
    records.length === 0 || (await appendRecords(input.home, input.repoKey, input.hostSessionKey, records, input.now)).persisted;
  const filing = isOpened ? (plan.filingByPath.get(first) ?? session) : session;
  const held = heldElsewhere(life, read.lane.root, filing);
  const block = seqSlice(input.seq, index, MAX_TARGETS_PER_INVOCATION);
  const base = {
    ...laneInput(input, read.lane),
    workContextId: filing.workContextId,
    seenTargets: [...seenPathsOf(input.state.seenTargets, filing.key), ...held],
  };
  const changedSpooled =
    touches.length === 0 ? NOTHING_SPOOLED : await spoolGitTouches({ ...base, seq: block }, touches, "git_diff");
  const changed = changedSpooled.captured;
  const committed =
    commits.length === 0
      ? NOTHING_SPOOLED
      : await spoolGitTouches(
          {
            ...base,
            seenTargets: [...base.seenTargets, ...changed],
            seq: seqAfter(block, changed.length),
            maxTargets: MAX_TARGETS_PER_INVOCATION - changed.length,
          },
          commits,
          "git_commit",
        );
  const spooled = [...changed, ...committed.captured];
  return {
    captured: spooled.map((path) => topicSeenKey(filing.key, path)),
    generated: addGeneratedTally(changedSpooled.generated, committed.generated),
    topic: {
      sessionId: life.sessionId,
      opened: isOpened ? plan.opened : [],
      relabeled: relabelsKept(plan.relabeled, isOpened),
      touched: filing.key === null ? new Map() : new Map([[filing.key, read.lane.root]]),
      sessionTouched: filing.key === null,
      // One root, one decision: past the cap every path of it overflowed, and
      // what counts is what this sweep newly spooled (review M7) — never the
      // same dirty files again on every Stop.
      overflowed: plan.overflowedPaths.size > 0 ? spooled.length : 0,
      at: input.now.toISOString(),
    },
  };
};

/**
 * Reads every root at once, then spools root by root — the reads are the
 * cost, and doing them in parallel keeps the lane inside ONE git deadline
 * whatever the count; the spooling is sequential so a topic two roots share
 * is opened once and each root's records stay in order.
 */
export const sweepGitRoots = async (input: SweepGitRootsInput): Promise<GitLaneSweep> => {
  const reads = await Promise.all(input.roots.map((lane) => readRoot(input, lane)));
  let life = topicLifeOf(input.state);
  const captured: string[] = [];
  const topics: TopicCapture[] = [];
  let generated = NO_GENERATED;
  // One probe for the sweep: the topics its roots open share one default-ref
  // lookup, the repo's (flows/topic-base-word.ts).
  const probe = topicBaseProbe();
  // ...and one key read: every root's topics are minted under it.
  const topicKey = input.topicKey ?? topicKeyFrom(input.home);
  for (const [index, read] of reads.entries()) {
    const spooled = await spoolRoot(input, read, index, life, probe, topicKey);
    if (spooled !== null) {
      captured.push(...spooled.captured);
      generated = addGeneratedTally(generated, spooled.generated);
      topics.push(spooled.topic);
      life = { ...life, topics: [...life.topics, ...spooled.topic.opened] };
    }
  }
  const merged = mergeTopicCaptures(topics);
  if (merged !== null && merged.overflowed > 0) {
    await recordCaptureLoss(input.home, {
      kind: "topic_overflow",
      count: merged.overflowed,
      key: input.repoKey,
      detail: "topic-cap",
      now: input.now,
    });
  }
  const answered = reads.filter((read) => read.gone || (read.commits !== null && read.touches !== null));
  return {
    captured,
    topics: merged,
    unavailable: answered.length < reads.length,
    swept: answered.map((read) => read.lane.root),
    untrackedCut: reads.filter((read) => read.isUntrackedCut).map((read) => read.lane.root),
    generated,
  };
};

/**
 * A root git answered for has spent its bash mark — the next Stop need not
 * sweep it FIRST — and takes its turn at the back (`gitSweptAt`); one whose
 * untracked listing the bound cut keeps that its cut is booked for this life
 * (review M8). Its other fields are the cache's and stay.
 */
export const withSweptRoots = (
  state: SessionState,
  swept: readonly string[],
  at: string,
  untrackedCut: readonly string[] = [],
): SessionState => swept.reduce((written, root) => withSweptRoot(written, root, at, untrackedCut.includes(root)), state);
