/**
 * ONE SESSION, MANY TOPICS (DESIGN.md).
 *
 * THE DEFECT. The owner works from ONE long-lived session in a worktree that
 * sits detached at an old commit, and does every topic there: subagents and
 * the main thread edit files in a dozen sibling worktrees of the same repo,
 * each on its own branch. Capture already followed the edits into those
 * worktrees (capture/touched-root.ts), but filed every one of them under the
 * session's single work context, titled after the START checkout — a stale
 * branch that happened to point at its commit. One PR's 190 files arrived as
 * one 278-target "sweep" every overlap check and the conference ignore
 * (GHOST_MAX_CONTEXT_TARGETS), under a title that named none of the work.
 *
 * THE MODEL. A touch files under a TOPIC: a piece of work in one worktree.
 * A branch is the strongest SIGNAL of which piece of work, not its identity —
 * branches are renamed, work moves to a follow-up branch, a HEAD is detached
 * on top of it — so a topic carries:
 *
 *   - a STABLE id, MINTED when its (repo, worktree root, branch) is first seen
 *     in a life (`mintTopicId`): the root's key and the topic's ordinal in
 *     that root, never the branch, so no rename can change it. Its work
 *     context is `wc_<life>~t<id>`. Deterministic, so a crash, a retry or a
 *     sibling hook opening the same topic from the same state name one
 *     context;
 *   - an AFFINITY: the root, every branch the rules attached to it, the
 *     commit it was last seen at, and the files it touched (its seen-set
 *     entries). Which topic a touch belongs to is a deterministic lookup in
 *     it, and the four rules that grow it are flows/topic-rules.ts;
 *   - a title, `<branch> @ <repo>` of the branch it was opened on, and that
 *     branch and the commit at the first touch on the wire, so the hub
 *     measures drift and landing from the topic, not from the start
 *     checkout's old commit (server services/topic-base-commit.ts).
 *
 * The session's own START topic — its checkout at registration — keeps the
 * session's own work context, so a session that never leaves its checkout
 * looks exactly as it always has. A topic's context is spooled BEFORE its
 * first target, and registered in the session state only once that append
 * persisted: a target never names a context the spool does not hold ahead of
 * it.
 *
 * PER LIFE. Topics belong to the life that opened them (`~rN`): a heal moves
 * the session to its next life and clears the registry (flows/heal-session
 * .ts), so every topic's context is owed again and goes out ahead of the next
 * target it gets — the same reason the seen-set starts empty on a heal.
 *
 * CAPPED. MAX_TOPICS_PER_SESSION per life; a touch past it files under the
 * session's own context and is counted (`topic_overflow`), never dropped. A
 * topic is never excluded for its SIZE: nothing here counts its files.
 */
import type { Envelope } from "@crosscheck/schema";

import { INTENT_TOPIC_AMBIGUITY_MS, TOPIC_KEY_HEX_CHARS } from "../constants.ts";
import { workContextRecord } from "../capture/records.ts";
import type { Producer } from "../capture/records.ts";
import type { SessionState, TopicContext } from "../state/session-state.ts";

/** What separates a topic's id from its session's work-context id, and marks a topic's seen-set entries. */
export const TOPIC_ID_SEPARATOR = "~t";

/** The status a topic opens with when the life's state names none. */
const DEFAULT_TOPIC_STATUS = "implementing";

/** sha256 of (repo, worktree root), short: a worktree's key — hashed, so no path is readable from it. */
export const rootKeyOf = (repoId: string, root: string): string =>
  new Bun.CryptoHasher("sha256")
    .update(`${repoId}\n${root}`)
    .digest("hex")
    .slice(0, TOPIC_KEY_HEX_CHARS);

/** Hex characters of the opening branch's hash a topic id carries, read as one decimal number. */
const BRANCH_KEY_HEX_CHARS = 8;

/**
 * A topic's MINTED id: its root's key, and a number derived from the branch
 * it was OPENED on — the decimal of sha256(branch)'s first 8 hex, so it stays
 * inside the id grammar's `~t<hex>.<digits>` (schema/src/question.ts). Minted
 * once, when the topic opens, and never re-derived: a rename joins the
 * affinity and keeps the id. Deterministic in what was opened (review M1):
 * two hooks planning from one state open the SAME id for one (root, branch)
 * and two ids for two branches, where an ordinal counted from that state gave
 * both branches one id.
 */
export const mintTopicId = (repoId: string, root: string, branch: string): string => {
  const branchKey = new Bun.CryptoHasher("sha256").update(branch).digest("hex").slice(0, BRANCH_KEY_HEX_CHARS);
  return `${rootKeyOf(repoId, root)}.${String(Number.parseInt(branchKey, 16))}`;
};

export const topicWorkContextIdFor = (sessionWorkContextId: string, id: string): string =>
  `${sessionWorkContextId}${TOPIC_ID_SEPARATOR}${id}`;

const seenPrefixOf = (id: string): string => `${TOPIC_ID_SEPARATOR}${id}/`;

/**
 * A captured path's SEEN-SET entry: the bare path under the session's own
 * context, as it always was, and prefixed with its topic otherwise. One path
 * edited in two worktrees on two branches is two topics' touches, and a bare
 * entry for the first would silently swallow the second.
 */
export const topicSeenKey = (id: string | null, path: string): string =>
  id === null ? path : `${seenPrefixOf(id)}${path}`;

/** The paths a context's seen-set entries name: the session's bare ones, or one topic's. */
export const seenPathsOf = (seen: readonly string[], id: string | null): readonly string[] => {
  if (id === null) {
    return seen.filter((entry) => !entry.startsWith(TOPIC_ID_SEPARATOR));
  }
  const prefix = seenPrefixOf(id);
  return seen.filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length));
};

/** Every branch a topic answers to: the one it was opened on, and its affinity's. */
export const labelsOf = (topic: Pick<TopicContext, "branch" | "branches">): readonly string[] =>
  topic.branches.includes(topic.branch) ? topic.branches : [topic.branch, ...topic.branches];

/** What the capture flow must know of the life it files under. */
export interface TopicLife {
  readonly repoId: string;
  /** The life — `cc_<key>` or `cc_<key>~rN`. */
  readonly sessionId: string;
  readonly sessionWorkContextId: string;
  /** The session's own checkout, spelled as the resolution spells it. */
  readonly sessionRoot: string;
  readonly startBranch: string | null;
  /** The start topic's affinity beyond `startBranch`, and its last commit. */
  readonly startBranches: readonly string[];
  readonly startHead: string | null;
  readonly sessionTouchedAt: string | null;
  /** The registry as the state holds it; entries of another life are ignored. */
  readonly topics: readonly TopicContext[];
  /** The files each topic touched, for the overlap rule (flows/topic-rules.ts). */
  readonly seenTargets: readonly string[];
  /** The status a topic opened now starts with: the life's own. */
  readonly status: string;
}

export const topicLifeOf = (state: SessionState): TopicLife => ({
  repoId: state.repoId,
  sessionId: state.crosscheckSessionId,
  sessionWorkContextId: state.workContextId,
  sessionRoot: state.repoRoot,
  startBranch: state.startBranch,
  startBranches: state.startBranches ?? [],
  startHead: state.startHead ?? null,
  sessionTouchedAt: state.sessionTouchedAt,
  topics: state.topicContexts,
  seenTargets: state.seenTargets,
  status: state.workContextStatus ?? DEFAULT_TOPIC_STATUS,
});

/** Where one path files: the session's own context (`key` null) or a topic's. */
export interface Filing {
  readonly key: string | null;
  readonly workContextId: string;
}

/** A branch the rules attached to an existing topic — `id` null is the start topic. */
export interface Relabel {
  readonly id: string | null;
  readonly label: string;
  readonly head: string | null;
  /**
   * The title the topic takes with it (review M4): `<new branch> @ <repo>` for
   * a RENAME (rule b) of a topic — the same branch under a new name, so the
   * old title names nothing that exists. Null for a continuation or a detach
   * (the opening branch still names the work), and for the start topic, whose
   * title is the session's own.
   */
  readonly title: string | null;
}

export interface TopicPlan {
  readonly filingByPath: ReadonlyMap<string, Filing>;
  /** Topics this event opens, in first-touch order: their contexts are spooled first. */
  readonly opened: readonly TopicContext[];
  /** Branches attached to topics that already existed (rules b, c, d). */
  readonly relabeled: readonly Relabel[];
  /** Every topic this event touched → the root it touched it in. */
  readonly touched: ReadonlyMap<string, string>;
  /** True when some path filed under the session's own context. */
  readonly sessionTouched: boolean;
  /**
   * The event's paths filed under the session's own context only because the
   * cap was reached. A set, not a count (review M7): the caller counts those
   * of them it actually SPOOLED, so a file swept on every Stop, two roots'
   * copies of one path, or a path the denylist refuses is not one more lost
   * topic each time.
   */
  readonly overflowedPaths: ReadonlySet<string>;
}

const topicRecord = (topic: TopicContext, producer: Producer, now: Date): Envelope =>
  workContextRecord(
    {
      workContextId: topic.workContextId,
      sessionId: topic.sessionId,
      title: topic.title,
      status: topic.status,
      branch: topic.branch,
      baseCommit: topic.baseCommit,
    },
    producer,
    now,
  );

/** The work_context records of topics just opened — what goes into the spool ahead of their first targets. */
export const openedTopicRecords = (
  opened: readonly TopicContext[],
  producer: Producer,
  now: Date,
): readonly Envelope[] => opened.map((topic) => topicRecord(topic, producer, now));

/**
 * THE CONTEXTS ONE PLAN OWES THE HUB, in one append: every topic it opens,
 * then every topic a rename retitled (review M4) — the hub's title replaces,
 * its `branch` stays the opening one. Only this life's topics: another life's
 * topic of the same (root, branch) has the same key and its own context.
 */
export const plannedTopicRecords = (
  plan: Pick<TopicPlan, "opened" | "relabeled">,
  life: Pick<TopicLife, "sessionId" | "topics">,
  producer: Producer,
  now: Date,
): readonly Envelope[] => {
  const live = life.topics.filter((topic) => topic.sessionId === life.sessionId);
  const retitled = plan.relabeled.flatMap((relabel) => {
    const topic = live.find((entry) => entry.key === relabel.id);
    return topic === undefined || relabel.title === null ? [] : [{ ...topic, title: relabel.title }];
  });
  return [...plan.opened, ...retitled].map((topic) => topicRecord(topic, producer, now));
};

/** The plan's relabels as the state may keep them: a retitle the spool did not take is not the hub's title (review M4). */
export const relabelsKept = (relabels: readonly Relabel[], isPersisted: boolean): readonly Relabel[] =>
  isPersisted ? relabels : relabels.map((relabel) => ({ ...relabel, title: null }));

/** One event's topic outcome, as the caller folds it into its single locked state write. */
export interface TopicCapture {
  /** The life the event filed under. */
  readonly sessionId: string;
  /** Topics whose context the spool now holds. */
  readonly opened: readonly TopicContext[];
  readonly relabeled: readonly Relabel[];
  readonly touched: ReadonlyMap<string, string>;
  readonly sessionTouched: boolean;
  /** Files the cap filed under the session's own context that this event newly spooled (review M7). */
  readonly overflowed: number;
  readonly at: string;
}

/** Several events' topic outcomes as one — a Stop sweeping several roots folds them in one write. */
export const mergeTopicCaptures = (captures: readonly TopicCapture[]): TopicCapture | null => {
  const [first] = captures;
  if (first === undefined) {
    return null;
  }
  return {
    sessionId: first.sessionId,
    opened: captures.flatMap((capture) => capture.opened),
    relabeled: captures.flatMap((capture) => capture.relabeled),
    touched: new Map(captures.flatMap((capture) => [...capture.touched])),
    sessionTouched: captures.some((capture) => capture.sessionTouched),
    overflowed: captures.reduce((sum, capture) => sum + capture.overflowed, 0),
    at: first.at,
  };
};

const withLabel = (labels: readonly string[], label: string): readonly string[] =>
  labels.includes(label) ? labels : [...labels, label];

/** A topic with the rules' attachment folded in: the branch joins its affinity, its commit moves on. */
const relabeledTopic = (topic: TopicContext, relabels: readonly Relabel[]): TopicContext =>
  relabels
    .filter((relabel) => relabel.id === topic.key)
    .reduce<TopicContext>(
      (current, relabel) => ({
        ...current,
        branches: [...withLabel(labelsOf(current), relabel.label)],
        head: relabel.head ?? current.head,
        title: relabel.title ?? current.title,
      }),
      topic,
    );

/** The start topic with the rules' attachment folded in. */
const withStartRelabels = (state: SessionState, relabels: readonly Relabel[]): SessionState => {
  const own = relabels.filter((relabel) => relabel.id === null);
  if (own.length === 0) {
    return state;
  }
  return {
    ...state,
    startBranches: [...own.reduce<readonly string[]>((labels, relabel) => withLabel(labels, relabel.label), state.startBranches ?? [])],
    startHead: own.at(-1)?.head ?? state.startHead ?? null,
  };
};

/**
 * The registry after one event: topics it opened added, branches the rules
 * attached folded into their topics' affinity, the topics it touched
 * stamped. A capture for a life the state no longer names — a heal moved the
 * session on mid-hook — registers nothing for the new life: its topics were
 * opened for the old one, and the new life owes its own. The overflow count
 * is the session's either way.
 */
export const withTopicCapture = (state: SessionState, capture: TopicCapture | null): SessionState => {
  if (capture === null) {
    return state;
  }
  const overflowCount = state.topicOverflowCount + capture.overflowed;
  if (state.crosscheckSessionId !== capture.sessionId) {
    return { ...state, topicOverflowCount: overflowCount };
  }
  const live = state.topicContexts.filter((topic) => topic.sessionId === state.crosscheckSessionId);
  const added = capture.opened.filter((topic) => !live.some((known) => known.key === topic.key));
  const stamped = [...live, ...added].map((topic) => {
    const root = capture.touched.get(topic.key);
    const relabeled = relabeledTopic(topic, capture.relabeled);
    return root === undefined ? relabeled : { ...relabeled, root, lastTouchedAt: capture.at };
  });
  return {
    ...withStartRelabels(state, capture.relabeled),
    topicContexts: stamped,
    sessionTouchedAt: capture.sessionTouched ? capture.at : state.sessionTouchedAt,
    topicOverflowCount: overflowCount,
  };
};

/** What set_intent writes to: the session's own context, or one topic's. */
export type IntentTarget =
  | { readonly kind: "session" }
  | { readonly kind: "topic"; readonly topic: TopicContext }
  | { readonly kind: "unknown"; readonly branches: readonly string[] }
  | { readonly kind: "ambiguous"; readonly branches: readonly string[] };

/** One context set_intent's default could mean, by the branch it is on now. */
interface Contender {
  readonly target: IntentTarget;
  readonly at: string;
  readonly branch: string | null;
}

const startLabelsOf = (state: SessionState): readonly string[] =>
  state.startBranch === null ? [] : [state.startBranch, ...(state.startBranches ?? [])];

/** Newest first; on a tie a topic before the session, as the default always ranked them. */
const contendersOf = (state: SessionState, live: readonly TopicContext[]): readonly Contender[] => {
  const topics: readonly Contender[] = live.map((topic) => ({
    target: { kind: "topic", topic },
    at: topic.lastTouchedAt,
    branch: labelsOf(topic).at(-1) ?? null,
  }));
  const sessionAt = state.sessionTouchedAt ?? null;
  const session: readonly Contender[] =
    sessionAt === null ? [] : [{ target: { kind: "session" }, at: sessionAt, branch: startLabelsOf(state).at(-1) ?? null }];
  return [...topics, ...session].sort((left, right) => right.at.localeCompare(left.at));
};

const isWithinAmbiguity = (newest: string, other: string): boolean =>
  Date.parse(newest) - Date.parse(other) < INTENT_TOPIC_AMBIGUITY_MS;

/**
 * The default when no topic is named: the context touched MOST RECENTLY —
 * unless another NAMEABLE one was touched within INTENT_TOPIC_AMBIGUITY_MS of
 * it (review M2: parallel subagents race for "the one touched last"). Then
 * `ambiguous`, newest first, by the branch each is on now. A session whose
 * checkout has no branch cannot be named, so it never makes a race.
 */
const defaultTargetOf = (state: SessionState, live: readonly TopicContext[]): IntentTarget => {
  const [newest, ...rest] = contendersOf(state, live);
  if (newest === undefined) {
    return { kind: "session" };
  }
  const close = [newest, ...rest.filter((other) => isWithinAmbiguity(newest.at, other.at))];
  const branches = close.map((contender) => contender.branch).filter((branch): branch is string => branch !== null);
  return branches.length > 1 && newest.branch !== null ? { kind: "ambiguous", branches } : newest.target;
};

/**
 * set_intent's TARGET (DESIGN.md "One session, many topics"): the topic whose
 * affinity holds the named branch when one is named, else the one this life
 * touched MOST RECENTLY — the session's own context when that was its own
 * checkout or when no topic was ever opened — and no default at all when two
 * were touched within a minute of each other (`ambiguous`). A branch of the
 * start topic names the session's own context. A name this life never touched
 * is `unknown`, with the branches it did.
 */
export const intentTargetOf = (state: SessionState, named?: string): IntentTarget => {
  const live = state.topicContexts.filter((topic) => topic.sessionId === state.crosscheckSessionId);
  if (named === undefined) {
    return defaultTargetOf(state, live);
  }
  const topic = live.find((entry) => labelsOf(entry).includes(named));
  if (topic !== undefined) {
    return { kind: "topic", topic };
  }
  return startLabelsOf(state).includes(named)
    ? { kind: "session" }
    : { kind: "unknown", branches: live.flatMap((entry) => labelsOf(entry)) };
};
