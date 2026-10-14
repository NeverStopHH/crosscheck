/**
 * A TEAMMATE'S WORK, GROUPED BY TOPIC — the one grouping every surface that
 * lists a teammate's work runs: the briefing's "Teammate work contexts" and
 * "Teammate sessions active now" (briefing/render.ts) and the `teammates:`
 * block of `crosscheck status` (cli/status.ts). One function, so the three can
 * never disagree about what one piece of work is.
 *
 * WHAT WENT WRONG WITHOUT IT. A work context is created per SESSION. Grouping
 * per developer (audit row M15-rest) stopped one busy teammate filling the
 * section, but folded everything else into "N other pieces of work" — and on
 * the pilot hub one developer running subagent and git-worktree sessions owned
 * 471 contexts, 470 of them `analyzing`, many under the identical title minutes
 * apart. His line read "469 other pieces of work": true, and useless.
 *
 * A TOPIC IS WHAT A READER RECOGNISES: the session's own branch — sent with
 * every work-context row (server services/diagnosis.ts) and named by every
 * presence row — so free-form titles on one branch are one topic. The title
 * (`<branch> @ <repo>`, flows/register-session.ts) is the fallback only where
 * the branch says nothing: an older hub that sends none, or a detached HEAD;
 * and every detached session of a repo shares ONE topic, never one per sha.
 * The caller derives the label (briefing/render.ts); this module only keys on
 * it. Many sessions on one branch are ONE topic with a session count and its
 * newest activity, so identical titles minutes apart collapse by construction.
 *
 * SUBAGENTS ARE GROUPED BY BRANCH ONLY, because nothing records a parent: an
 * `agent_sessions` row carries no parent or subagent field, and 1.0 spec 00
 * §10 Q2 leaves subagent parentage open. A subagent working on its parent's
 * branch therefore lands in the parent's topic through the branch, and one on
 * a branch of its own is a topic of its own. Parentage is never inferred from
 * timing: two sessions that started a minute apart are two sessions.
 *
 * WHICH ROW SPEAKS FOR A TOPIC (its intent, its base commit), in order: one
 * with recorded work — a claim or a captured target, because starting a
 * session is what creates a context and the freshest is often the one that
 * did nothing — then the freshest, then the smaller session key, so the
 * answer never depends on the order rows arrived in.
 *
 * WHICH STATUS A TOPIC SHOWS: the highest any of its rows reports in
 * TOPIC_STATUS_PRECEDENCE — what is LIVE, so blocked > testing >
 * implementing > planning > analyzing > done. Ranked, never rewritten: the
 * shown status is always one a row in the topic carries, and a status this
 * client does not know ranks below every known one, so with none known the
 * speaking row's own is shown.
 *
 * WHICH TOPIC COMES FIRST: one with recorded work, then the freshest, then the
 * one with more sessions, then the smaller label. Teammates come in order of
 * their newest activity.
 *
 * IT IS PURE DATA. Nothing here renders, frames or sanitizes: the caller hands
 * in RAW keys to group by and labels and statuses ALREADY sanitized for its
 * own surface — grouping never happens on sanitized text — and gets back the
 * groups. That is why this module is not in the §4.4
 * render-surface registry — it names no render identifier and emits no text.
 */
import type { SessionStatus } from "@crosscheck/schema";

/** What grouping needs from a row; the caller may carry anything else along. */
export interface TopicRow {
  readonly developerId: string;
  /**
   * What the row is GROUPED by: RAW, never a sanitized label. Keyed on the
   * label, two branches that both trip the phrase filter were one topic under
   * one redaction with one status, and two branches differing only past the
   * title cap were one. The caller namespaces it (briefing/render.ts), so a
   * branch, a title and the detached-HEAD topic can never equal each other.
   */
  readonly topicKey: string;
  /** What the row is CALLED: already sanitized, non-empty, display only. */
  readonly label: string;
  /** What "N sessions" counts: one per session, however many rows it owns. */
  readonly sessionKey: string;
  /** Already sanitized; ranked by SESSION_STATUSES, never rewritten. */
  readonly status: string;
  readonly ageMs: number;
  /** A claim or a captured target: this session did something. */
  readonly hasRecordedWork: boolean;
}

export interface Topic<T extends TopicRow> {
  /** The raw grouping key; two topics may share a `label`, never a key. */
  readonly key: string;
  readonly label: string;
  /** In speaking order: `rows[0]` is the row that speaks for the topic. */
  readonly rows: readonly T[];
  /** Distinct sessions, not rows. */
  readonly sessions: number;
  /** The newest activity in the topic. */
  readonly ageMs: number;
  /** The highest-ranked status any of its rows reports (TOPIC_STATUS_PRECEDENCE). */
  readonly status: string;
  readonly hasRecordedWork: boolean;
}

export interface TeammateTopics<T extends TopicRow> {
  readonly developerId: string;
  /** Most active first: the order every surface prints them in. */
  readonly topics: readonly Topic<T>[];
  /** Distinct sessions across all of this teammate's topics. */
  readonly sessions: number;
  /** The newest activity across all of them. */
  readonly ageMs: number;
}

/**
 * The order a topic's status is DISPLAYED in, LOWEST first — deliberately
 * not SESSION_STATUSES, which is the lifecycle order (analyzing → planning →
 * implementing → testing → blocked → done). A reader of a teammate listing is
 * asking what is LIVE: in the lifecycle order `done` is last, so one finished
 * subagent on a branch three others are still implementing made the whole
 * topic read done. Here `done` ranks below every live status and shows only
 * when nothing in the topic is live, and `blocked` ranks above them all,
 * because a stuck session is the one fact about a topic a teammate most needs
 * to see. `planning` and `testing` keep their lifecycle places among the live
 * ones. Every enum value appears exactly once (test/briefing-contexts.test.ts),
 * so a status added to the enum cannot silently rank as unknown.
 */
export const TOPIC_STATUS_PRECEDENCE: readonly SessionStatus[] = [
  "done",
  "analyzing",
  "planning",
  "implementing",
  "testing",
  "blocked",
];

const RANKED_STATUSES: readonly string[] = TOPIC_STATUS_PRECEDENCE;

/** -1 for a status this client does not know: below every known one. */
const statusRank = (status: string): number => RANKED_STATUSES.indexOf(status);

/**
 * True when `candidate` should speak for the topic instead of `current`.
 * Order-independent by construction: every comparison is a total order on the
 * row's own fields, so the same set of rows in any order groups identically.
 */
const speaksInstead = <T extends TopicRow>(
  candidate: T,
  current: T,
): boolean => {
  if (candidate.hasRecordedWork !== current.hasRecordedWork) {
    return candidate.hasRecordedWork;
  }
  if (candidate.ageMs !== current.ageMs) {
    return candidate.ageMs < current.ageMs;
  }
  return candidate.sessionKey < current.sessionKey;
};

const bySpeakingOrder = <T extends TopicRow>(left: T, right: T): number => {
  if (speaksInstead(left, right)) {
    return -1;
  }
  return speaksInstead(right, left) ? 1 : 0;
};

/** Starts from the speaking row's own, so an all-unknown topic keeps it. */
const displayedStatus = <T extends TopicRow>(rows: readonly T[]): string =>
  rows.reduce(
    (best, row) => (statusRank(row.status) > statusRank(best) ? row.status : best),
    rows[0]?.status ?? "",
  );

const distinctSessions = <T extends TopicRow>(rows: readonly T[]): number =>
  new Set(rows.map((row) => row.sessionKey)).size;

const newestAge = <T extends TopicRow>(rows: readonly T[]): number =>
  rows.reduce((newest, row) => Math.min(newest, row.ageMs), Number.POSITIVE_INFINITY);

const toTopic = <T extends TopicRow>(key: string, rows: readonly T[]): Topic<T> => {
  const ordered = [...rows].sort(bySpeakingOrder);
  return {
    key,
    label: ordered[0]?.label ?? "",
    rows: ordered,
    sessions: distinctSessions(ordered),
    ageMs: newestAge(ordered),
    status: displayedStatus(ordered),
    hasRecordedWork: ordered.some((row) => row.hasRecordedWork),
  };
};

const compareText = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

const byActivity = <T extends TopicRow>(left: Topic<T>, right: Topic<T>): number =>
  Number(right.hasRecordedWork) - Number(left.hasRecordedWork) ||
  left.ageMs - right.ageMs ||
  right.sessions - left.sessions ||
  compareText(left.label, right.label) ||
  compareText(left.key, right.key);

/**
 * Rows bucketed by a key. The Map is this function's own builder and never
 * escapes mutable; every bucket it holds is a fresh array per insert.
 */
const bucket = <T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
): ReadonlyMap<string, readonly T[]> => {
  const buckets = new Map<string, readonly T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  return buckets;
};

const toTeammate = <T extends TopicRow>(
  developerId: string,
  rows: readonly T[],
): TeammateTopics<T> => ({
  developerId,
  topics: [...bucket(rows, (row) => row.topicKey)]
    .map(([key, topicRows]) => toTopic(key, topicRows))
    .sort(byActivity),
  sessions: distinctSessions(rows),
  ageMs: newestAge(rows),
});

const byNewestActivity = <T extends TopicRow>(
  left: TeammateTopics<T>,
  right: TeammateTopics<T>,
): number => left.ageMs - right.ageMs || compareText(left.developerId, right.developerId);

export const groupTopicsByDeveloper = <T extends TopicRow>(
  rows: readonly T[],
): readonly TeammateTopics<T>[] =>
  [...bucket(rows, (row) => row.developerId)]
    .map(([developerId, developerRows]) => toTeammate(developerId, developerRows))
    .sort(byNewestActivity);
