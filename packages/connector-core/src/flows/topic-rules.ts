/**
 * WHICH TOPIC A TOUCH BELONGS TO — the four rules (DESIGN.md "One session,
 * many topics"; the model is flows/topic-contexts.ts).
 *
 * A worktree's branch is the strongest signal of the piece of work a touch
 * belongs to, and only a signal. The rules run per touched ROOT, once per
 * event, in this order:
 *
 *   KNOWN  a topic of this root whose affinity holds the root's branch: that
 *          topic. The lookup every later touch takes — a branch the rules
 *          attached below is in the affinity from then on, so they run once
 *          per (root, branch) per life.
 *   (b)    RENAME: git's own HEAD log records the root's last-active topic's
 *          newest branch renamed to the root's current branch (`Branch:
 *          renamed refs/heads/<old> to refs/heads/<new>`), and HEAD is that
 *          topic's commit or descends from it — the same topic, the new
 *          branch joins its affinity. A branch that is merely gone, deleted
 *          after the next one was cut at its tip, is no rename (review H3):
 *          that move falls through to (c).
 *   (c)    CONTINUED: HEAD descends from the last-active topic's commit and
 *          this event's files overlap the topic's files — the same topic,
 *          the branch joins its affinity.
 *   (d)    DETACHED: a detached HEAD that descends from the last-active
 *          topic's commit — that topic, the `detached@<sha>` label joins it.
 *   (a)    otherwise a NEW topic, minted for (repo, root, branch) — a
 *          detached one titled `detached@<sha>`.
 *
 * "Last-active" is the root's most recently touched topic; the start topic is
 * one of the session root's. "Descends" is git/head-history.ts: the root's own
 * HEAD log, read from disk — the rules spawn NO git, and they read anything at
 * all only for a branch the root's topics do not already name. A root whose
 * HEAD cannot be read files under the session's own context.
 */
import { MAX_TOPICS_PER_SESSION } from "../constants.ts";
import { toRepoRelative } from "../capture/target-paths.ts";
import type { RootHead, TouchedRootsResolution } from "../capture/touched-root.ts";
import { descendsInHeadLog, isRenamedInHeadLog } from "../git/head-history.ts";
import { DETACHED_BRANCH_PREFIX, resolveHeadCommit } from "../git/repo-identity.ts";
import type { TopicContext } from "../state/session-state.ts";
import { fallbackWorkContextTitle } from "./register-session.ts";
import { labelsOf, mintTopicId, seenPathsOf, topicWorkContextIdFor } from "./topic-contexts.ts";
import type { Filing, Relabel, TopicLife, TopicPlan } from "./topic-contexts.ts";

/** One topic as the rules see it — `id` null is the session's own start topic. */
interface Candidate {
  readonly id: string | null;
  readonly workContextId: string;
  readonly labels: readonly string[];
  readonly head: string | null;
  readonly lastTouchedAt: string;
}

/** What the rules decided for one root. */
type Decision =
  | { readonly kind: "file"; readonly filing: Filing; readonly relabel: Relabel | null }
  | { readonly kind: "open"; readonly branch: string; readonly commit: string | null }
  | { readonly kind: "session" };

const isDetached = (branch: string): boolean => branch.startsWith(DETACHED_BRANCH_PREFIX);

const newestFirst = (left: Candidate, right: Candidate): number => right.lastTouchedAt.localeCompare(left.lastTouchedAt);

const asCandidate = (topic: TopicContext): Candidate => ({
  id: topic.key,
  workContextId: topic.workContextId,
  labels: labelsOf(topic),
  head: topic.head ?? topic.baseCommit,
  lastTouchedAt: topic.lastTouchedAt,
});

/** The topics a root holds: this life's topics opened in it, and — in the session's own root — the start topic. */
const candidatesOf = (life: TopicLife, rootKey: string, head: RootHead, opened: readonly TopicContext[]): readonly Candidate[] => {
  const topics = [...life.topics.filter((topic) => topic.sessionId === life.sessionId), ...opened]
    .filter((topic) => topic.root === head.root)
    .map(asCandidate);
  const start: readonly Candidate[] =
    rootKey === life.sessionRoot && life.startBranch !== null
      ? [
          {
            id: null,
            workContextId: life.sessionWorkContextId,
            labels: [life.startBranch, ...life.startBranches],
            head: life.startHead,
            lastTouchedAt: life.sessionTouchedAt ?? "",
          },
        ]
      : [];
  return [...topics, ...start].sort(newestFirst);
};

const keep = (candidate: Candidate, relabel: Relabel | null): Decision => ({
  kind: "file",
  filing: { key: candidate.id, workContextId: candidate.workContextId },
  relabel,
});

/** Rule (b)'s test: git recorded the topic's NEWEST branch renamed to the root's current one (review H3). */
const isRenamedTo = async (candidate: Candidate, branch: string, gitDir: string): Promise<boolean> => {
  const newest = [...candidate.labels].reverse().find((label) => !isDetached(label));
  return newest !== undefined && (await isRenamedInHeadLog(gitDir, newest, branch));
};

const overlaps = (paths: readonly string[], files: readonly string[]): boolean => {
  const known = new Set(files);
  return paths.some((path) => known.has(path));
};

/** The rules, for one root of one event (header). `paths` are this event's files in that root, repo-relative. */
const decide = async (
  life: TopicLife,
  rootKey: string,
  head: RootHead,
  paths: readonly string[],
  opened: readonly TopicContext[],
): Promise<Decision> => {
  const branch = head.branch;
  if (branch === null || (life.startBranch === null && rootKey === life.sessionRoot)) {
    return { kind: "session" };
  }
  const candidates = candidatesOf(life, rootKey, head, opened);
  const known = candidates.find((candidate) => candidate.labels.includes(branch));
  if (known !== undefined) {
    return keep(known, null);
  }
  const [last] = candidates;
  const commit = head.head === null ? null : await resolveHeadCommit(head.head);
  const gitDir = head.head?.gitDir ?? null;
  if (last === undefined || last.head === null || commit === null || gitDir === null) {
    return { kind: "open", branch, commit };
  }
  if (!(await descendsInHeadLog(gitDir, last.head, commit))) {
    return { kind: "open", branch, commit };
  }
  const relabel: Relabel = { id: last.id, label: branch, head: commit, title: null };
  if (isDetached(branch)) {
    return keep(last, relabel);
  }
  if (await isRenamedTo(last, branch, gitDir)) {
    // The same branch under a new name: the old title names nothing that
    // exists any more (review M4). The start topic's title is the session's.
    return keep(last, { ...relabel, title: last.id === null ? null : fallbackWorkContextTitle(branch, life.repoId) });
  }
  return overlaps(paths, seenPathsOf(life.seenTargets, last.id)) ? keep(last, relabel) : { kind: "open", branch, commit };
};

/** The paths of one event grouped by the root each resolved against, in first-touch order. */
const pathsByRoot = (resolution: TouchedRootsResolution, paths: readonly string[]): ReadonlyMap<string, readonly string[]> => {
  const grouped = new Map<string, string[]>();
  for (const path of paths) {
    const root = resolution.rootByPath.get(path);
    if (root !== undefined) {
      grouped.set(root, [...(grouped.get(root) ?? []), path]);
    }
  }
  return grouped;
};

const relativePaths = async (root: string, cwd: string, paths: readonly string[]): Promise<readonly string[]> =>
  (await Promise.all(paths.map((path) => toRepoRelative(root, cwd, path)))).filter((path): path is string => path !== null);

/**
 * WHERE EVERY PATH OF ONE EVENT FILES. Over the resolution the capture flow
 * already holds — each root's HEAD was read there — so the KNOWN path costs
 * nothing more; the rules read the root's refs and HEAD log only for a branch
 * its topics do not name yet.
 */
export const planTopics = async (
  life: TopicLife,
  resolution: TouchedRootsResolution,
  paths: readonly string[],
  now: Date,
  cwd: string = life.sessionRoot,
): Promise<TopicPlan> => {
  const session: Filing = { key: null, workContextId: life.sessionWorkContextId };
  const live = life.topics.filter((topic) => topic.sessionId === life.sessionId);
  const opened: TopicContext[] = [];
  const relabeled: Relabel[] = [];
  const touched = new Map<string, string>();
  const filingByPath = new Map<string, Filing>();
  let sessionTouched = false;
  const overflowedPaths = new Set<string>();
  for (const [rootKey, rootPaths] of pathsByRoot(resolution, paths)) {
    const head = resolution.headByRoot.get(rootKey);
    const decision =
      head === undefined
        ? ({ kind: "session" } as const)
        : await decide(life, rootKey, head, await relativePaths(rootKey, cwd, rootPaths), opened);
    let filing: Filing = session;
    if (decision.kind === "file") {
      filing = decision.filing;
      if (decision.relabel !== null) {
        relabeled.push(decision.relabel);
      }
    } else if (decision.kind === "open" && head !== undefined) {
      if (live.length + opened.length >= MAX_TOPICS_PER_SESSION) {
        for (const path of rootPaths) {
          overflowedPaths.add(path);
        }
      } else {
        const id = mintTopicId(life.repoId, head.root, decision.branch);
        opened.push({
          key: id,
          sessionId: life.sessionId,
          workContextId: topicWorkContextIdFor(life.sessionWorkContextId, id),
          branch: decision.branch,
          branches: [decision.branch],
          head: decision.commit,
          title: fallbackWorkContextTitle(decision.branch, life.repoId),
          status: life.status,
          baseCommit: decision.commit ?? head.firstHead,
          root: head.root,
          registeredAt: now.toISOString(),
          lastTouchedAt: now.toISOString(),
          ackedStatus: null,
        });
        filing = { key: id, workContextId: topicWorkContextIdFor(life.sessionWorkContextId, id) };
      }
    }
    if (filing.key === null) {
      sessionTouched = true;
    } else if (head !== undefined) {
      touched.set(filing.key, head.root);
    }
    for (const path of rootPaths) {
      filingByPath.set(path, filing);
    }
  }
  return { filingByPath, opened, relabeled, touched, sessionTouched, overflowedPaths };
};
