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
 * THE RULE. A touch files under the TOPIC of the root it landed in: the
 * (repo, branch) that root is on, read from its HEAD file. The session's own
 * start topic — the branch its checkout was on when the life registered —
 * keeps the session's own work context, so a session that never leaves its
 * checkout looks exactly as it always has. Every other topic gets a context
 * of its own:
 *
 *   - a DETERMINISTIC id, `wc_<life>~t<sha256(repo, branch)>` — a crash, a
 *     retry or a sibling hook opening the same topic all name one context;
 *   - titled `<branch> @ <repo>`, the session's fallback title shape; a root
 *     whose HEAD cannot be read has no branch to title, and its touch files
 *     under the session's own context — the session's own title source;
 *   - carrying its branch and the commit HEAD named at the first touch, so
 *     the hub measures drift and landing from the topic, not from the start
 *     checkout's old commit (server services/topic-base-commit.ts);
 *   - spooled BEFORE its first target, and registered in the session state
 *     only once that append persisted: a target never names a context the
 *     spool does not already hold ahead of it.
 *
 * PER LIFE. Topics belong to the life that opened them (`~rN`): a heal moves
 * the session to its next life and clears the registry (flows/heal-session
 * .ts), so every topic's context is owed again and goes out ahead of the next
 * target it gets — the same reason the seen-set starts empty on a heal.
 *
 * CAPPED. MAX_TOPICS_PER_SESSION per life; a touch past it files under the
 * session's own context and is counted (`topic_overflow`), never dropped.
 */
import type { Envelope } from "@crosscheck/schema";

import { MAX_TOPICS_PER_SESSION, TOPIC_KEY_HEX_CHARS } from "../constants.ts";
import { workContextRecord } from "../capture/records.ts";
import type { Producer } from "../capture/records.ts";
import { resolveHeadCommit } from "../git/repo-identity.ts";
import type { RootHead, TouchedRootsResolution } from "../capture/touched-root.ts";
import type { SessionState, TopicContext } from "../state/session-state.ts";
import { fallbackWorkContextTitle } from "./register-session.ts";

/** What separates a topic's key from its session's work-context id, and marks a topic's seen-set entries. */
export const TOPIC_ID_SEPARATOR = "~t";

/** The status a topic opens with when the life's state names none. */
const DEFAULT_TOPIC_STATUS = "implementing";

/** sha256 of (repo, branch), short: the same topic is the same key on every machine and every life. */
export const topicKeyOf = (repoId: string, branch: string): string =>
  new Bun.CryptoHasher("sha256")
    .update(`${repoId}\n${branch}`)
    .digest("hex")
    .slice(0, TOPIC_KEY_HEX_CHARS);

export const topicWorkContextIdFor = (sessionWorkContextId: string, key: string): string =>
  `${sessionWorkContextId}${TOPIC_ID_SEPARATOR}${key}`;

const seenPrefixOf = (key: string): string => `${TOPIC_ID_SEPARATOR}${key}/`;

/**
 * A captured path's SEEN-SET entry: the bare path under the session's own
 * context, as it always was, and prefixed with its topic otherwise. One path
 * edited in two worktrees on two branches is two topics' touches, and a bare
 * entry for the first would silently swallow the second.
 */
export const topicSeenKey = (key: string | null, path: string): string =>
  key === null ? path : `${seenPrefixOf(key)}${path}`;

/** The paths a context's seen-set entries name: the session's bare ones, or one topic's. */
export const seenPathsOf = (seen: readonly string[], key: string | null): readonly string[] => {
  if (key === null) {
    return seen.filter((entry) => !entry.startsWith(TOPIC_ID_SEPARATOR));
  }
  const prefix = seenPrefixOf(key);
  return seen.filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length));
};

/** What the capture flow must know of the life it files under. */
export interface TopicLife {
  readonly repoId: string;
  /** The life — `cc_<key>` or `cc_<key>~rN`. */
  readonly sessionId: string;
  readonly sessionWorkContextId: string;
  /** The session's own checkout, spelled as the resolution spells it. */
  readonly sessionRoot: string;
  readonly startBranch: string | null;
  /** The registry as the state holds it; entries of another life are ignored. */
  readonly topics: readonly TopicContext[];
  /** The status a topic opened now starts with: the life's own. */
  readonly status: string;
}

export const topicLifeOf = (state: SessionState): TopicLife => ({
  repoId: state.repoId,
  sessionId: state.crosscheckSessionId,
  sessionWorkContextId: state.workContextId,
  sessionRoot: state.repoRoot,
  startBranch: state.startBranch,
  topics: state.topicContexts,
  status: state.workContextStatus ?? DEFAULT_TOPIC_STATUS,
});

/** Where one path files: the session's own context (`key` null) or a topic's. */
export interface Filing {
  readonly key: string | null;
  readonly workContextId: string;
}

export interface TopicPlan {
  readonly filingByPath: ReadonlyMap<string, Filing>;
  /** Topics this event opens, in first-touch order: their contexts are spooled first. */
  readonly opened: readonly TopicContext[];
  /** Every topic this event touched → the root it touched it in. */
  readonly touched: ReadonlyMap<string, string>;
  /** True when some path filed under the session's own context. */
  readonly sessionTouched: boolean;
  /** Touches filed under the session's own context only because the cap was reached. */
  readonly overflowed: number;
}

/**
 * The START topic files under the session's own context. A state from before
 * topics knows no start branch, so there the session's own checkout does,
 * whatever branch it is on now.
 */
const isStartTopic = (life: TopicLife, root: string, key: string): boolean =>
  life.startBranch === null
    ? root === life.sessionRoot
    : key === topicKeyOf(life.repoId, life.startBranch);

const openTopic = async (
  life: TopicLife,
  key: string,
  branch: string,
  head: RootHead,
  now: Date,
): Promise<TopicContext> => ({
  key,
  sessionId: life.sessionId,
  workContextId: topicWorkContextIdFor(life.sessionWorkContextId, key),
  branch,
  title: fallbackWorkContextTitle(branch, life.repoId),
  status: life.status,
  // The commit this topic's first touch stands on — the root's HEAD now,
  // which is its first-touch commit when the root itself is new.
  baseCommit: (head.head === null ? null : await resolveHeadCommit(head.head)) ?? head.firstHead,
  root: head.root,
  registeredAt: now.toISOString(),
  lastTouchedAt: now.toISOString(),
  ackedStatus: null,
});

/**
 * WHERE EVERY PATH OF ONE EVENT FILES. Pure over the resolution the capture
 * flow already holds — the HEAD of each root was read there, so nothing here
 * spawns git; the one read is a new topic's commit, from git's own files.
 */
export const planTopics = async (
  life: TopicLife,
  resolution: TouchedRootsResolution,
  paths: readonly string[],
  now: Date,
): Promise<TopicPlan> => {
  const session: Filing = { key: null, workContextId: life.sessionWorkContextId };
  const known = new Map(
    life.topics.filter((topic) => topic.sessionId === life.sessionId).map((topic) => [topic.key, topic]),
  );
  const opened = new Map<string, TopicContext>();
  const touched = new Map<string, string>();
  const filingByPath = new Map<string, Filing>();
  let sessionTouched = false;
  let overflowed = 0;
  for (const path of paths) {
    const root = resolution.rootByPath.get(path);
    if (root === undefined) {
      continue;
    }
    const head = resolution.headByRoot.get(root);
    const branch = head?.branch ?? null;
    if (head === undefined || branch === null || isStartTopic(life, root, topicKeyOf(life.repoId, branch))) {
      filingByPath.set(path, session);
      sessionTouched = true;
      continue;
    }
    const key = topicKeyOf(life.repoId, branch);
    const existing = known.get(key) ?? opened.get(key);
    const hasRoom = known.size + opened.size < MAX_TOPICS_PER_SESSION;
    if (existing === undefined && !hasRoom) {
      filingByPath.set(path, session);
      sessionTouched = true;
      overflowed += 1;
      continue;
    }
    const topic = existing ?? (await openTopic(life, key, branch, head, now));
    if (existing === undefined) {
      opened.set(key, topic);
    }
    touched.set(key, head.root);
    filingByPath.set(path, { key, workContextId: topic.workContextId });
  }
  return { filingByPath, opened: [...opened.values()], touched, sessionTouched, overflowed };
};

/** The work_context records of topics just opened — what goes into the spool ahead of their first targets. */
export const openedTopicRecords = (
  opened: readonly TopicContext[],
  producer: Producer,
  now: Date,
): readonly Envelope[] =>
  opened.map((topic) =>
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
    ),
  );

/** Several events' topic outcomes as one — a Stop sweeping several roots folds them in one write. */
export const mergeTopicCaptures = (captures: readonly TopicCapture[]): TopicCapture | null => {
  const [first] = captures;
  if (first === undefined) {
    return null;
  }
  return {
    sessionId: first.sessionId,
    opened: captures.flatMap((capture) => capture.opened),
    touched: new Map(captures.flatMap((capture) => [...capture.touched])),
    sessionTouched: captures.some((capture) => capture.sessionTouched),
    overflowed: captures.reduce((sum, capture) => sum + capture.overflowed, 0),
    at: first.at,
  };
};

/** One event's topic outcome, as the caller folds it into its single locked state write. */
export interface TopicCapture {
  /** The life the event filed under. */
  readonly sessionId: string;
  /** Topics whose context the spool now holds. */
  readonly opened: readonly TopicContext[];
  readonly touched: ReadonlyMap<string, string>;
  readonly sessionTouched: boolean;
  readonly overflowed: number;
  readonly at: string;
}

/**
 * The registry after one event: topics it opened added, the ones it touched
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
    return root === undefined ? topic : { ...topic, root, lastTouchedAt: capture.at };
  });
  return {
    ...state,
    topicContexts: stamped,
    sessionTouchedAt: capture.sessionTouched ? capture.at : state.sessionTouchedAt,
    topicOverflowCount: overflowCount,
  };
};

/** What set_intent writes to: the session's own context, or one topic's. */
export type IntentTarget =
  | { readonly kind: "session" }
  | { readonly kind: "topic"; readonly topic: TopicContext }
  | { readonly kind: "unknown"; readonly branches: readonly string[] };

/**
 * set_intent's TARGET (DESIGN.md "One session, many topics"): the topic named
 * by branch when one is named, else the one this life touched MOST RECENTLY —
 * the session's own context when that was its own checkout or when no topic
 * was ever opened. Naming the start branch names the session's own context.
 * A name this life never touched is `unknown`, with the branches it did.
 */
export const intentTargetOf = (state: SessionState, named?: string): IntentTarget => {
  const live = state.topicContexts.filter((topic) => topic.sessionId === state.crosscheckSessionId);
  if (named !== undefined) {
    const topic = live.find((entry) => entry.branch === named);
    if (topic !== undefined) {
      return { kind: "topic", topic };
    }
    return named === state.startBranch
      ? { kind: "session" }
      : { kind: "unknown", branches: live.map((entry) => entry.branch) };
  }
  const newest = live.reduce<TopicContext | null>(
    (best, topic) => (best === null || topic.lastTouchedAt > best.lastTouchedAt ? topic : best),
    null,
  );
  const sessionAt = state.sessionTouchedAt ?? "";
  return newest === null || sessionAt > newest.lastTouchedAt ? { kind: "session" } : { kind: "topic", topic: newest };
};
