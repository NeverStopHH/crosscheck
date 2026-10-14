/**
 * A TOPIC'S OWN WORD ABOUT ITS BASE (topic review C1).
 *
 * The hub stamps a work context landed when a teammate's clone reports its
 * base commit on the default branch — and a base that was ALREADY there
 * when the work began is no evidence of anything (server services/
 * landed.ts). A session says so of its start checkout at register
 * (capture/landed.ts probeBaseOnDefault); a TOPIC opens later, in another
 * worktree, on another branch, and its base is the commit HEAD named at its
 * first touch — for a branch freshly cut from main, main's own tip. So each
 * topic the rules open asks the same question of its own root, once, and
 * every record of the topic carries the answer (flows/topic-contexts.ts).
 *
 * THE COST, AND WHERE IT IS PAID: the topic rules spawn no git (flows/
 * topic-rules.ts); this runs after them, only for the topics an event OPENS
 * — at most MAX_TOPICS_PER_SESSION per life — and never on a detached HEAD,
 * which the hub never lands by its base anyway. The register probe's two
 * bounded calls, LANDED_GIT_TIMEOUT_MS each — the default ref, then the
 * ancestry check — with the default ref resolved ONCE per event: every topic
 * an event opens is a worktree of the session's one repo (a foreign repo's
 * path is a drop, never a topic), and its remote refs are the repo's. So an
 * event that opens seven sibling topics at Stop costs one ref lookup and
 * seven ancestry checks in parallel — two calls of wall clock, as one topic
 * does. A repo with no default ref costs the one call and says nothing. An
 * answer git could not give is no word at all (null), which the hub reads as
 * "did not say".
 */
import { probeBaseOnDefault } from "../capture/landed.ts";
import { resolveDefaultBranchRef } from "../git/default-branch.ts";
import type { TopicContext } from "../state/session-state.ts";

/** What one topic's word is asked of: its root, its branch, its base. */
export type TopicBaseProbe = (topic: TopicContext) => Promise<boolean | undefined>;

/**
 * One event's probe: the default ref asked once, of the first root that needs
 * it, shared by every topic — a Stop's sweep passes one probe to every root it
 * spools (flows/git-lane.ts), so its siblings share the lookup too.
 */
export const topicBaseProbe = (): TopicBaseProbe => {
  let defaultRef: Promise<string | null> | undefined;
  return (topic) =>
    topic.baseCommit === null
      ? Promise.resolve(undefined)
      : probeBaseOnDefault({ root: topic.root, baseCommit: topic.baseCommit, branch: topic.branch }, () => {
          defaultRef ??= resolveDefaultBranchRef(topic.root);
          return defaultRef;
        });
};

/** The plan's opened topics, each with its own word about its base; nothing else moves. */
export const withTopicBaseWords = async <P extends { readonly opened: readonly TopicContext[] }>(
  plan: P,
  probe: TopicBaseProbe = topicBaseProbe(),
): Promise<P> => {
  if (plan.opened.length === 0) {
    return plan;
  }
  const words = await Promise.all(plan.opened.map((topic) => probe(topic)));
  return {
    ...plan,
    opened: plan.opened.map((topic, index) => ({ ...topic, baseOnDefault: words[index] ?? null })),
  };
};
