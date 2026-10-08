/**
 * ONE pre-pass, then the capture — the #17 worktree resolution paired with
 * `captureFileTargets`, so every connector resolves a touched file against
 * the root that governs the FILE and not merely the checkout its session
 * registered at.
 *
 * WHY THIS EXISTS AS A FLOW. The resolver has always been shared and
 * `captureFileTargets` has always taken the hook, but only the Claude hooks
 * passed it: a Cursor session and every ACP agent silently dropped an edit
 * made in a linked worktree of the same repo, uncounted — the H1 shape
 * (371 worktree edits → 0 targets). The twenty lines that join the two are
 * the part a new connector gets SILENTLY wrong: forget the
 * `rootByPath.get(p) ?? null` closure or the `paths.length === 0` guard and
 * every path drops with no counter, which is the original defect wearing a
 * new hat. Here they have one spelling.
 *
 * THE SPREAD IS LOAD-BEARING. `captureFileTargets` keys off
 * `resolveRoot === undefined` to mean "pre-#17 single-root behaviour", so an
 * absent hook and a hook that returns null are DIFFERENT answers: absent is
 * "resolve everything against the session root", null is "the caller already
 * dropped and counted this path". Passing `{ resolveRoot: undefined }`
 * happens to work today and would break the moment that check became an `in`
 * check — hence the spread, never an explicit undefined.
 *
 * SESSION STATE IS STILL THE CALLER'S. This returns both halves — what was
 * captured and the resolution — because the counters, the cache additions and
 * the seen-set belong in the caller's own single locked write, which each host
 * batches differently (state/capture-bookkeeping.ts folds the counters; the
 * refusal to share the write itself is argued there).
 *
 * No connector may call `captureFileTargets` directly. This flow builds that
 * call for every HOST-REPORTED edit, which is what keeps the resolution from
 * being forgotten again. The one other builder is
 * `flows/capture-git-touches.ts`, the Stop-time git lane, and it is not a
 * host event: git prints paths relative to the worktree it ran in and cannot
 * name a file outside it, so that lane resolves every path against that one
 * root and says so at the call site. The directive below is what keeps a
 * THIRD builder from appearing silently — a caller that names no resolution
 * prints MISSING and reddens the claims job.
 *
 * The directive that keeps that true is the pair of line comments below: a
 * block comment cannot hold it, because the glob it needs ends a block
 * comment mid-word.
 */
// VERIFY: for f in $(grep -rl --include='*.ts' 'captureFileTargets({' packages/*/src | sort); do grep -q 'resolveRoot' "$f" && echo "$f ok" || echo "$f MISSING"; done
// PRINTS: packages/connector-core/src/flows/capture-git-touches.ts ok
// PRINTS: packages/connector-core/src/flows/capture-touched-files.ts ok
import { MAX_TARGETS_PER_INVOCATION } from "../constants.ts";
import { sessionSlug } from "../config/paths.ts";
import { resolveTouchedRoots } from "../capture/touched-root.ts";
import { appendRecords } from "../spool/append.ts";
import { recordDrop } from "../spool/drops.ts";
import { recordCaptureLoss } from "../state/loss-ledger.ts";
import type {
  KnownWorktreeRoot,
  ResolveTouchedRootsInput,
  TouchedRootsResolution,
} from "../capture/touched-root.ts";
import { seqAfter } from "../capture/seq.ts";
import { captureFileTargets } from "./capture-targets.ts";
import type { CaptureFileTargetsInput } from "./capture-targets.ts";
import { plannedTopicRecords, relabelsKept, seenPathsOf, topicSeenKey } from "./topic-contexts.ts";
import type { Filing, TopicCapture, TopicLife, TopicPlan } from "./topic-contexts.ts";
import { planTopics } from "./topic-rules.ts";

/** The capture-loss detail a topic overflow is booked under (state/loss-ledger.ts). */
const TOPIC_OVERFLOW_DETAIL = "topic-cap";
/** What keeps an event's overflow apart from its own session touches, in one grouping key — no context id contains it. */
const OVERFLOW_GROUP_SUFFIX = "\u0000overflow";

export interface CaptureTouchedFilesInput
  extends Omit<CaptureFileTargetsInput, "resolveRoot"> {
  /** The repo this session is bound to; a different one is a foreign drop. */
  readonly sessionRepoId: string;
  /**
   * The already-resolved identity of the event's own directory. On Claude and
   * Cursor it can differ from the session root (the free D2 candidate); on ACP
   * it is the session root itself, so every out-of-checkout path pays the
   * bounded walk and the per-session cache is what keeps that once per root.
   */
  readonly identityRoot: string;
  readonly identityRepoId: string;
  /** The caller's per-session root cache, read at the call's start. */
  readonly knownWorktreeRoots: readonly KnownWorktreeRoot[];
  /**
   * THE LIFE THE TOUCHES FILE UNDER, BY TOPIC (flows/topic-contexts.ts). Absent,
   * every path files under `workContextId` — one context per session, the
   * shape before topics. Every connector passes it.
   */
  readonly topics?: TopicLife;
  /** The pre-pass, real by default; injected only by a test that has no git. */
  readonly resolveRoots?: (input: ResolveTouchedRootsInput) => Promise<TouchedRootsResolution>;
  /**
   * The append of the topics' contexts, real by default; injected only by a
   * test that needs it NOT to persist while the targets after it do (review
   * mutation #9) — a full or unwritable spool refuses both.
   */
  readonly appendTopicContexts?: typeof appendRecords;
}

export interface CaptureTouchedFilesResult {
  /**
   * Seen-set entries for what was actually spooled — repo-relative ids, and
   * a topic's prefixed with it (`topicSeenKey`). Fold these into the seen-set.
   */
  readonly captured: readonly string[];
  /**
   * The pre-pass result, or null when there were no paths to resolve. Feed it
   * to `withCaptureBookkeeping` inside the caller's single locked write.
   */
  readonly resolution: TouchedRootsResolution | null;
  /**
   * What the event did to the life's topics, for `withTopicCapture` in the
   * same write — null when no topics were asked for or nothing resolved.
   */
  readonly topics: TopicCapture | null;
}

/**
 * THE #17 RESOLUTION AS `captureFileTargets` TAKES IT, spelled once for both
 * paths below: absent when there was nothing to resolve, never an explicit
 * undefined (the header says why the spread is load-bearing).
 */
const resolveRootFrom = (
  resolution: TouchedRootsResolution | null,
): Pick<CaptureFileTargetsInput, "resolveRoot"> =>
  resolution === null
    ? {}
    : {
        resolveRoot: (path: string): string | null =>
          resolution.rootByPath.get(path) ?? null,
      };

/**
 * THE CONTEXTS FIRST. Each topic this event opens gets its work context in the
 * spool AHEAD of any target that names it — the hub refuses a target whose
 * context it has not been sent (`work context … not found`), so the order is
 * not a nicety. An append that did not persist leaves those topics unopened:
 * their paths file under the session's own context instead, never under a
 * context the spool does not hold. A topic a rename retitled goes in the same
 * append (review M4); a failed one leaves the old title in the state too.
 */
const spoolOpenedTopics = async (
  input: CaptureTouchedFilesInput,
  plan: TopicPlan,
  life: TopicLife,
): Promise<boolean> => {
  const records = plannedTopicRecords(plan, life, input.producer, input.now);
  if (records.length === 0) {
    return true;
  }
  const append = input.appendTopicContexts ?? appendRecords;
  const appended = await append(input.home, input.repoKey, input.hostSessionKey, records, input.now);
  return appended.persisted;
};

/** One context's share of an event: its paths, and whether the topic cap is why they file there. */
interface FilingGroup {
  readonly filing: Filing;
  readonly isOverflow: boolean;
  readonly paths: readonly string[];
}

/**
 * Paths grouped by the context they file under, in first-touch order — the
 * cap's overflow apart from the session's own touches, so what it spooled is
 * what is counted (review M7).
 */
const groupsOf = (
  paths: readonly string[],
  plan: Pick<TopicPlan, "filingByPath" | "overflowedPaths">,
  fallback: Filing,
  unopened: ReadonlySet<string>,
): readonly FilingGroup[] => {
  const groups = new Map<string, { readonly filing: Filing; readonly isOverflow: boolean; readonly paths: string[] }>();
  for (const path of paths) {
    const planned = plan.filingByPath.get(path);
    if (planned === undefined) {
      continue;
    }
    const filing = planned.key !== null && unopened.has(planned.key) ? fallback : planned;
    const isOverflow = plan.overflowedPaths.has(path);
    const groupKey = `${filing.workContextId}${isOverflow ? OVERFLOW_GROUP_SUFFIX : ""}`;
    const group = groups.get(groupKey) ?? { filing, isOverflow, paths: [] };
    group.paths.push(path);
    groups.set(groupKey, group);
  }
  return [...groups.values()];
};

/**
 * ONE EVENT, SEVERAL TOPICS: the contexts first, then one target write per
 * context, sharing the event's one cap and one position block — the second
 * group's targets take the positions after the first's, and its cap is what
 * the first left. A touch past the topic cap files under the session's own
 * context and is booked `topic_overflow`: delivered, its topic counted lost.
 */
const captureByTopic = async (
  input: CaptureTouchedFilesInput,
  resolution: TouchedRootsResolution,
  life: TopicLife,
): Promise<{ readonly captured: readonly string[]; readonly topics: TopicCapture }> => {
  const plan = await planTopics(life, resolution, input.paths, input.now, input.cwd);
  const isOpened = await spoolOpenedTopics(input, plan, life);
  const session: Filing = { key: null, workContextId: life.sessionWorkContextId };
  const unopened = new Set(isOpened ? [] : plan.opened.map((topic) => topic.key));
  const captured: string[] = [];
  let overflowed = 0;
  for (const { filing, isOverflow, paths } of groupsOf(input.paths, plan, session, unopened)) {
    const collected = await captureFileTargets({
      ...input,
      paths,
      ...resolveRootFrom(resolution),
      workContextId: filing.workContextId,
      // What an earlier group of this event spooled under the same context is seen too.
      seenTargets: seenPathsOf([...input.seenTargets, ...captured], filing.key),
      seq: seqAfter(input.seq, captured.length),
      maxTargets: MAX_TARGETS_PER_INVOCATION - captured.length,
    });
    captured.push(...collected.map((path) => topicSeenKey(filing.key, path)));
    overflowed += isOverflow ? collected.length : 0;
  }
  if (overflowed > 0 && input.editFired !== false) {
    await recordCaptureLoss(input.home, {
      kind: "topic_overflow",
      count: overflowed,
      key: input.repoKey,
      detail: TOPIC_OVERFLOW_DETAIL,
      now: input.now,
    });
  }
  return {
    captured,
    topics: {
      sessionId: life.sessionId,
      opened: isOpened ? plan.opened : [],
      relabeled: relabelsKept(plan.relabeled, isOpened),
      touched: new Map([...plan.touched].filter(([key]) => !unopened.has(key))),
      sessionTouched: plan.sessionTouched || unopened.size > 0,
      overflowed,
      at: input.now.toISOString(),
    },
  };
};

export const captureTouchedFiles = async (
  input: CaptureTouchedFilesInput,
): Promise<CaptureTouchedFilesResult> => {
  const {
    sessionRepoId,
    identityRoot,
    identityRepoId,
    knownWorktreeRoots,
    topics: life,
    resolveRoots = resolveTouchedRoots,
    ...targets
  } = input;
  // Skipped entirely when there is nothing to resolve: an event with no paths
  // must cost no fs work and book no drops.
  const resolution =
    targets.paths.length === 0
      ? null
      : await resolveRoots({
          paths: targets.paths,
          cwd: targets.cwd,
          sessionRepoRoot: targets.repoRoot,
          sessionRepoId,
          identityRoot,
          identityRepoId,
          knownWorktreeRoots,
          now: targets.now,
        });
  const byTopic =
    resolution === null || life === undefined ? null : await captureByTopic(input, resolution, life);
  const captured =
    byTopic?.captured ??
    (await captureFileTargets({ ...targets, ...resolveRootFrom(resolution) }));
  // AN EDIT OUTSIDE EVERY ROOT OF THIS REPO IS A COUNTED DROP
  // (docs/1.0/loss-accounting.md §3 row 10): the session-state counter
  // `outsideRootDrops` keeps doctor's diagnosis line, and this ledger line is
  // what reaches the hub. Edits only — an ACP read outside the repo is not a
  // lost edit — on the argument `withCaptureBookkeeping` makes for the
  // counter. Foreign-repo drops are NOT ledgered here: they are another
  // repo's loss, and that repo is not told (§4.8.1).
  if (
    resolution !== null &&
    targets.editFired !== false &&
    resolution.outsideDrops > 0
  ) {
    await recordDrop(
      targets.home,
      targets.repoKey,
      sessionSlug(targets.hostSessionKey),
      resolution.outsideDrops,
      "outside-root",
      targets.now,
    );
  }
  return { captured, resolution, topics: byTopic?.topics ?? null };
};
