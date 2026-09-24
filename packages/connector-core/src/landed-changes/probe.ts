/**
 * Which teammate changes to ONE FILE have landed, and does this checkout
 * contain them (docs/1.0/landed-changes.md)? The reader's own clone answers,
 * from commits, trusting nobody; the git itself lives in git-queries.ts.
 *
 *   MISSING, at any age — asked FIRST, because it is the half that matters:
 *   on a landing branch, not in HEAD, not patch-equal to anything HEAD has,
 *   and not arriving (the work of a merge in progress, or the one commit of a
 *   cherry-pick in progress). Dropped only when the file certainly has
 *   nothing an edit could undo (git-queries.ts hasNothingNetToUndo). A
 *   landing branch git cannot answer for is named in `unchecked` — what the
 *   others know is still said, never silenced by the one that is slow.
 *
 *   RECENT AND PRESENT — asked second, and allowed to run out of time: a
 *   change in HEAD whose FIRST arrival on any landing branch falls inside
 *   the working-day window. Not reachable from any landing branch as it
 *   stood when the window opened (a release merge or back-merge re-lands old
 *   work), and not merely re-landing content a landing branch already had
 *   (a squash release) — where a match with the change's OWN ancestry is a
 *   revert, and a revert is new. Past the deadline, the missing half stands.
 *
 * UNREADABLE MEANS UNKNOWN. A shallow clone's boundary commit "touches" every
 * path, so it answers null rather than "every file changed yesterday".
 *
 * ONLY A COMPLETE "NOTHING" IS CACHED. Every answer is computed under a key
 * over what it depends on — the file, HEAD, the merge or pick in progress (by
 * its commits), every landing branch's tip, the reader's identity and
 * `.mailmap`, and the reader's calendar day. Only an answer that is COMPLETE
 * and found NOTHING carries it (`cleanKey`), and a caller that saw it before
 * gets "nothing" back after the five git calls that compute the key, instead
 * of the whole walk. An answer with an unchecked branch, a failed, capped or
 * timed-out half, or anything to say carries no key.
 *
 * The reader's own commits never warn the reader, and they are filtered only
 * AFTER git has been asked for a generous number, so they cannot use up the
 * probe's reach and hide a teammate's change behind them.
 *
 * KNOWN LIMITS (docs/1.0/landed-changes.md): a first-parent commit with an
 * old or skewed date ends git's `--since` walk, so a change can read as older
 * than it is (recent half only); a file the reader RENAMED is probed under
 * its new name only; a `merge --squash` in progress leaves no marker, so its
 * incoming commits read as missing.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";

import { LANDED_GIT_TIMEOUT_MS, LANDED_PROBE_BUDGET_MS, MAX_LANDED_COMMITS_SCANNED } from "../constants.ts";
import { readLandingBranches, resolveLandingRefs } from "./landing-branches.ts";
import type { LandingRef } from "./landing-branches.ts";
import {
  changesLandedBy,
  fileAt,
  hasNothingNetToUndo,
  isPartialClone,
  isReachableFromAny,
  isSameContent,
  landingsOn,
  missingOn,
  quietGitRunner,
  readOwnEmail,
  readRepoState,
  stillMissingAfterMerge,
  tipAt,
} from "./git-queries.ts";
import type { FileAtRev, GitContext, GitRunner, MissingAnswer, ParsedCommit, RepoState } from "./git-queries.ts";
import { isRecentLanding, localDayKey, recentWindowStart } from "./working-days.ts";

export interface LandedCommit extends ParsedCommit {
  /** Landing branches it was seen on, in the team's order. */
  readonly branches: readonly string[];
  /** When it first arrived on a landing branch — known for RECENT changes only. */
  readonly landedAt: Date | null;
}

export interface LandedChanges {
  /** Landed, and not in this checkout — at any age. */
  readonly missing: readonly LandedCommit[];
  /** First landed within the working-day window, and in this checkout. */
  readonly recent: readonly LandedCommit[];
  /** A landing branch had more missing commits than one probe reads. */
  readonly moreMissing: boolean;
  /** Landing branches git could not answer for: changes there may be missing too. */
  readonly unchecked: readonly string[];
  /**
   * Set only on a COMPLETE answer that found NOTHING — the only kind a caller
   * may cache, and so the only kind that carries a key at all.
   */
  readonly cleanKey: string | null;
}

/** Git processes one probe runs at once: a hot file must not fork a storm. */
const MAX_PARALLEL_GIT = 8;
const KEY_CHARS = 32;
const MAILMAP_FILE = ".mailmap";

const nothing = (cleanKey: string | null): LandedChanges => ({
  missing: [],
  recent: [],
  moreMissing: false,
  unchecked: [],
  cleanKey,
});

/**
 * Whether an answer is worth stopping an edit for: something missing, at any
 * age — or recent work alone, but only once the missing half is COMPLETE. A
 * landing branch git could not answer for, or a limit reached with nothing
 * shown, means the half that matters may be incomplete, and a stop about
 * recent work alone would spend the once-per-file marker on the half that
 * matters least; it waits, and the next edit asks again.
 */
export const worthStopping = (landed: LandedChanges | null): LandedChanges | null => {
  if (landed === null) {
    return null;
  }
  if (landed.missing.length > 0) {
    return landed;
  }
  const isMissingIncomplete = landed.unchecked.length > 0 || landed.moreMissing;
  return !isMissingIncomplete && landed.recent.length > 0 ? landed : null;
};

/** At most `size` tasks at once; the rest wait their turn, in order. */
const semaphore = (size: number): (<T>(task: () => Promise<T>) => Promise<T>) => {
  const waiting: (() => void)[] = [];
  const state = { active: 0 };
  return async (task) => {
    if (state.active >= size) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    state.active += 1;
    try {
      return await task();
    } finally {
      state.active -= 1;
      waiting.shift()?.();
    }
  };
};

interface Sighting {
  readonly branch: string;
  readonly change: ParsedCommit;
  readonly landedAt: Date | null;
}

const earliest = (dates: readonly Date[]): Date | null =>
  dates.length === 0 ? null : new Date(Math.min(...dates.map((date) => date.getTime())));

/**
 * One entry per commit across every landing branch it was seen on, in the
 * team's branch order, with the reader's own commits left out. Newest first.
 */
const grouped = (
  sightings: readonly Sighting[],
  selfEmail: string | null,
  timeOf: (commit: LandedCommit) => number,
): readonly LandedCommit[] => {
  const self = selfEmail?.toLowerCase() ?? null;
  const theirs = sightings.filter(({ change }) => change.authorEmail.toLowerCase() !== self);
  const shas = [...new Set(theirs.map(({ change }) => change.sha))];
  return shas
    .map((sha): LandedCommit | null => {
      const forSha = theirs.filter(({ change }) => change.sha === sha);
      const [first] = forSha;
      return first === undefined
        ? null
        : {
            ...first.change,
            branches: [...new Set(forSha.map(({ branch }) => branch))],
            landedAt: earliest(
              forSha.map(({ landedAt }) => landedAt).filter((date): date is Date => date !== null),
            ),
          };
    })
    .filter((commit): commit is LandedCommit => commit !== null)
    .sort((a, b) => timeOf(b) - timeOf(a));
};

interface Probe {
  readonly context: GitContext;
  readonly state: RepoState;
  readonly refs: readonly LandingRef[];
  readonly selfEmail: string | null;
  readonly cherryPick: boolean;
  readonly now: Date;
  readonly timeZone: string;
}

/** One landing branch's missing commits — `answer` null when it cannot say. */
const missingFor = async (
  probe: Probe,
  ref: LandingRef,
): Promise<{ readonly branch: string; readonly answer: MissingAnswer | null }> => {
  const { context, state } = probe;
  const unknown = { branch: ref.branch, answer: null };
  const isMerging = state.mergeHeads.length > 0;
  const [answer, stillMissing] = await Promise.all([
    missingOn(context, ref, { cherryPick: probe.cherryPick, headSha: state.headSha }),
    isMerging ? stillMissingAfterMerge(context, ref, state) : Promise.resolve(null),
  ]);
  if (answer === null || (isMerging && stillMissing === null)) {
    return unknown;
  }
  const notArriving = answer.commits.filter(
    (commit) => commit.sha !== state.pickedSha && (stillMissing === null || stillMissing.has(commit.sha)),
  );
  const settled =
    answer.isCapped && notArriving.length < answer.commits.length
      ? await askPastArriving(probe, ref, notArriving)
      : { commits: notArriving, isCapped: answer.isCapped };
  if (settled === null) {
    return unknown;
  }
  const isMoot =
    settled.commits.length > 0 &&
    (await hasNothingNetToUndo(context, ref, { headSha: state.headSha, selfEmail: probe.selfEmail }));
  // "Nothing to undo" is certain whatever the limit: nothing past it can be
  // undone either, so it is not "possibly more".
  return { branch: ref.branch, answer: isMoot ? { commits: [], isCapped: false } : settled };
};

/**
 * The limit was spent partly on work that is ARRIVING — a merge's commits, or
 * the one being picked — so what lies past it was never looked at. Ask again
 * with the merge's heads excluded inside git and room for the picked commit,
 * so the limit counts only what can still be missing. If that fails, what is
 * CERTAINLY missing is still said, as a floor: it is never thrown away. With
 * nothing certain, the branch cannot say — null, and it is named unchecked.
 */
const askPastArriving = async (
  probe: Probe,
  ref: LandingRef,
  certain: readonly ParsedCommit[],
): Promise<MissingAnswer | null> => {
  const { state } = probe;
  const again = await missingOn(probe.context, ref, {
    cherryPick: probe.cherryPick,
    headSha: state.headSha,
    exclude: state.mergeHeads,
    limit: MAX_LANDED_COMMITS_SCANNED + (state.pickedSha === null ? 0 : 1),
  });
  if (again === null) {
    return certain.length > 0 ? { commits: certain, isCapped: true } : null;
  }
  return { commits: again.commits.filter((commit) => commit.sha !== state.pickedSha), isCapped: again.isCapped };
};

/**
 * Did `sha` only re-land content a landing branch already had before the
 * window — a squash release of staging into main, say? True when the file as
 * `sha` left it equals the file at an old tip that is NOT in `sha`'s own
 * ancestry: matching an ancestor's content is a revert back to it, and a
 * revert is new. Unknown is not "yes".
 */
const isRelanding = async (
  context: GitContext,
  sha: string,
  atCommit: FileAtRev,
  oldTipFiles: readonly { readonly tip: string; readonly file: FileAtRev }[],
): Promise<boolean> => {
  const matching = oldTipFiles.filter(({ file }) => atCommit.kind !== "unknown" && isSameContent(atCommit, file));
  const ancestry = await Promise.all(matching.map(({ tip }) => isReachableFromAny(context, tip, [sha])));
  return ancestry.some((isAncestor) => isAncestor === false);
};

const recentFor = async (
  probe: Probe,
): Promise<{ readonly commits: readonly LandedCommit[]; readonly isComplete: boolean }> => {
  const { context } = probe;
  const windowStart = recentWindowStart(probe.now, probe.timeZone);
  const perRef = await Promise.all(
    probe.refs.map(async (ref) => {
      const [landings, old] = await Promise.all([landingsOn(context, ref, windowStart), tipAt(context, ref, windowStart)]);
      return { ref, landings, old };
    }),
  );
  const inWindow = perRef.flatMap(({ ref, landings }) =>
    (landings ?? [])
      .filter((landing) => isRecentLanding(landing.itself.committedAt, probe.now, probe.timeZone))
      .map((landing) => ({ ref, landing })),
  );
  const landed = await Promise.all(
    inWindow.map(async ({ ref, landing }) => ({ ref, landing, changes: await changesLandedBy(context, landing) })),
  );
  const oldTips = perRef.map(({ old }) => old.tip).filter((tip): tip is string => tip !== null);
  const oldTipFiles = await Promise.all(oldTips.map(async (tip) => ({ tip, file: await fileAt(context, tip) })));
  const sightings = landed.flatMap(({ ref, landing, changes }) =>
    (changes ?? []).map((change) => ({ branch: ref.branch, change, landedAt: landing.itself.committedAt })),
  );
  const judged = await Promise.all(
    grouped(sightings, probe.selfEmail, (commit) => commit.landedAt?.getTime() ?? 0).map(async (commit) => {
      const [wasAlreadyLanded, isPresent, atCommit] = await Promise.all([
        isReachableFromAny(context, commit.sha, oldTips),
        isReachableFromAny(context, commit.sha, [probe.state.headSha]),
        fileAt(context, commit.sha),
      ]);
      if (wasAlreadyLanded === null || isPresent === null) {
        return { commit: null, isKnown: false };
      }
      const isNew = !wasAlreadyLanded && isPresent;
      const relands = isNew && (await isRelanding(context, commit.sha, atCommit, oldTipFiles));
      return { commit: isNew && !relands ? commit : null, isKnown: true };
    }),
  );
  // A query that reached its limit may have more past it: that is not "complete".
  const isUnderLimit = (items: readonly unknown[] | null): boolean =>
    items !== null && items.length < MAX_LANDED_COMMITS_SCANNED;
  const isComplete =
    perRef.every(({ landings, old }) => isUnderLimit(landings) && old.isAnswered) &&
    landed.every(({ changes }) => isUnderLimit(changes)) &&
    judged.every(({ isKnown }) => isKnown);
  return {
    commits: judged.map(({ commit }) => commit).filter((commit): commit is LandedCommit => commit !== null),
    isComplete,
  };
};

const readMailmap = async (root: string): Promise<string> => {
  const file = Bun.file(join(root, MAILMAP_FILE));
  return (await file.exists()) ? file.text() : "";
};

const cacheKey = (
  input: LandedProbeInput,
  depends: {
    readonly state: RepoState;
    readonly refs: readonly LandingRef[];
    readonly selfEmail: string | null;
    readonly mailmap: string;
  },
): string =>
  createHash("sha256")
    .update(
      [
        input.file,
        depends.state.headSha,
        `merging:${depends.state.mergeHeads.join(",")}`,
        `picking:${depends.state.pickedSha ?? ""}`,
        ...depends.refs.map((ref) => `${ref.branch}=${ref.tip}`),
        `self:${depends.selfEmail ?? ""}`,
        `mailmap:${createHash("sha256").update(depends.mailmap).digest("hex")}`,
        localDayKey(input.now, input.timeZone),
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, KEY_CHARS);

export interface LandedProbeInput {
  /** The root of the worktree the edited file lives in. */
  readonly root: string;
  /** Repo-relative, as git names it. */
  readonly file: string;
  readonly now: Date;
  /** The reader's timezone — the calendar "recent" is counted on. */
  readonly timeZone: string;
  readonly timeoutMs?: number;
  /** The whole probe's deadline; past it the answer is what is known by then. */
  readonly budgetMs?: number;
  /** Keys this caller already saw answer "nothing" (LandedChanges.cleanKey). */
  readonly knownCleanKeys?: readonly string[];
  /**
   * How one git command runs. Injectable like repo identity's `resolveHost`:
   * the tests delay or fail single calls to reach the deadline and failure
   * paths deterministically, and count calls to prove the cache is used.
   */
  readonly runGit?: GitRunner;
}

interface RefResult {
  readonly branch: string;
  readonly answer: MissingAnswer | null;
}

/**
 * The missing half from the landing branches that have answered so far; a
 * branch that has not answered, or could not, is named unchecked.
 */
const missingHalfOf = (
  refs: readonly LandingRef[],
  answeredInAnyOrder: readonly RefResult[],
  selfEmail: string | null,
): LandedChanges => {
  // In the TEAM's branch order, never the order git happened to answer in.
  const results = refs
    .map((ref) => answeredInAnyOrder.find((result) => result.branch === ref.branch))
    .filter((result): result is RefResult => result !== undefined);
  return missingHalfIn(refs, results, selfEmail);
};

const missingHalfIn = (
  refs: readonly LandingRef[],
  results: readonly RefResult[],
  selfEmail: string | null,
): LandedChanges => ({
  missing: grouped(
    results.flatMap(({ branch, answer }) =>
      (answer?.commits ?? []).map((change) => ({ branch, change, landedAt: null })),
    ),
    selfEmail,
    (commit) => commit.committedAt.getTime(),
  ),
  recent: [],
  moreMissing: results.some(({ answer }) => answer?.isCapped === true),
  unchecked: refs
    .map((ref) => ref.branch)
    .filter((branch) => !results.some((result) => result.branch === branch && result.answer !== null)),
  cleanKey: null,
});

/** Where the deadline finds what is known: the missing half, branch by branch. */
interface Progress {
  snapshot: (() => LandedChanges) | null;
}

/** Answers null for unknown; `progress` can say the missing half at any moment. */
const run = async (
  input: LandedProbeInput,
  isCancelled: () => boolean,
  progress: Progress,
): Promise<LandedChanges | null> => {
  const timeoutMs = input.timeoutMs ?? LANDED_GIT_TIMEOUT_MS;
  const limit = semaphore(MAX_PARALLEL_GIT);
  const runGit = input.runGit ?? quietGitRunner(input.root, timeoutMs);
  const context: GitContext = {
    root: input.root,
    file: input.file,
    // Checked again when the slot is granted: a call that waited past the
    // deadline must not start at all.
    run: (args) => limit(() => (isCancelled() ? Promise.resolve(null) : runGit(args))),
    isCancelled,
  };
  const setting = await readLandingBranches(input.root);
  const [refs, state, isPartial, selfEmail, mailmap] = await Promise.all([
    resolveLandingRefs(input.root, setting, timeoutMs),
    readRepoState(context),
    isPartialClone(context),
    readOwnEmail(context),
    readMailmap(input.root),
  ]);
  if (refs === null || state === null || state.isShallow) {
    return null;
  }
  if (refs.length === 0) {
    return nothing(null);
  }
  const key = cacheKey(input, { state, refs, selfEmail, mailmap });
  if (input.knownCleanKeys?.includes(key) === true) {
    return nothing(key);
  }
  const probe: Probe = { context, state, refs, selfEmail, cherryPick: !isPartial, now: input.now, timeZone: input.timeZone };
  // Branch by branch, as each answers: a slow one past the deadline is named
  // unchecked, and never silences what the others already know.
  const answered: RefResult[] = [];
  progress.snapshot = () => missingHalfOf(refs, answered, selfEmail);
  await Promise.all(
    refs.map(async (ref) => {
      answered.push(await missingFor(probe, ref));
    }),
  );
  const missingHalf = missingHalfOf(refs, answered, selfEmail);
  const { missing } = missingHalf;
  const recent = await recentFor(probe);
  const isComplete =
    missingHalf.unchecked.length === 0 &&
    !(missingHalf.moreMissing && missing.length === 0) &&
    recent.isComplete &&
    !isCancelled();
  const isNothing = missing.length === 0 && recent.commits.length === 0;
  return { ...missingHalf, recent: recent.commits, cleanKey: isComplete && isNothing ? key : null };
};

/**
 * The landed changes to `file` this checkout is missing, and the recent ones
 * it has. Past the deadline: the missing half from every landing branch that
 * answered in time, the rest named unchecked, and no key (an answer cut short
 * is never cached) — or null when not even the landing branches were known.
 */
export const findLandedChanges = async (input: LandedProbeInput): Promise<LandedChanges | null> => {
  let isPastDeadline = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const progress: Progress = { snapshot: null };
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => {
      isPastDeadline = true;
      resolve("deadline");
    }, input.budgetMs ?? LANDED_PROBE_BUDGET_MS);
  });
  try {
    const outcome = await Promise.race([run(input, () => isPastDeadline, progress).catch(() => null), deadline]);
    return outcome === "deadline" ? (progress.snapshot?.() ?? null) : outcome;
  } finally {
    clearTimeout(timer);
  }
};
