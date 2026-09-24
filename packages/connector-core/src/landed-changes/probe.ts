/**
 * Which teammate changes to ONE FILE have landed, and does this checkout
 * contain them (docs/1.0/landed-changes.md)? The reader's own clone answers,
 * from commits, trusting nobody; the git itself lives in git-queries.ts.
 *
 *   MISSING, at any age: on a landing branch, not in HEAD, not patch-equal
 *   to anything HEAD has, and not the work a merge or cherry-pick in progress
 *   is bringing in. Dropped when the file has nothing net an edit could undo
 *   — its content already equals the landing branch's, or the landing branch
 *   made no net change to it (a change and its revert).
 *
 *   RECENT AND PRESENT: a change in HEAD whose FIRST arrival on any landing
 *   branch falls inside the working-day window. First arrival, because a
 *   release merge (staging into main) or a back-merge (main into staging)
 *   re-lands old work on a second branch, and that work is not new: a change
 *   some landing branch already had when the scan window opened is dropped,
 *   and one seen on several branches inside it is dated by the earliest.
 *
 * UNREADABLE MEANS UNKNOWN. A shallow clone's boundary commit "touches" every
 * path, so it answers null rather than "every file changed yesterday"; so
 * does a probe that runs past its deadline — which also stops it spawning
 * further git. The caller treats unknown as silence, so a slow or odd repo
 * costs a warning, never an edit.
 *
 * The reader's own commits never warn the reader, and they are filtered only
 * AFTER git has been asked for a generous number, so they cannot use up the
 * probe's reach and hide a teammate's change behind them.
 *
 * KNOWN LIMITS, both in the low-stakes direction or documented in the design
 * note: a fast-forward push keeps old commit dates, so such a change can
 * read as older than it is; and a file the reader RENAMED is probed under
 * its new name only, so a teammate's change to the old name is not seen.
 */
import { LANDED_GIT_TIMEOUT_MS, LANDED_PROBE_BUDGET_MS, LANDED_RECENT_SCAN_DAYS } from "../constants.ts";
import { readLandingBranches, resolveLandingRefs } from "./landing-branches.ts";
import type { LandingRef } from "./landing-branches.ts";
import {
  changesLandedBy,
  hasNothingNetToUndo,
  isAncestorOfHead,
  isPartialClone,
  landedBefore,
  landingsOn,
  missingOn,
  readOwnEmail,
  readRepoState,
  tipAt,
} from "./git-queries.ts";
import type { GitContext, LandingCommit, MissingAnswer, ParsedCommit } from "./git-queries.ts";
import { isRecentLanding } from "./working-days.ts";

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
}

const DAY_MS = 86_400_000;
const EMPTY: LandedChanges = { missing: [], recent: [], moreMissing: false };

interface RefAnswer {
  readonly ref: LandingRef;
  readonly missing: MissingAnswer | null;
  readonly landings: readonly LandingCommit[] | null;
  /** The branch as it stood when the scan window opened. */
  readonly oldTip: string | null;
}

interface RefOptions {
  readonly cherryPick: boolean;
  readonly arriving: readonly string[];
  readonly since: Date;
}

const answerFor = async (context: GitContext, ref: LandingRef, options: RefOptions): Promise<RefAnswer> => {
  const [missing, landings, oldTip] = await Promise.all([
    missingOn(context, ref, options),
    landingsOn(context, ref, options.since),
    tipAt(context, ref, options.since),
  ]);
  const isMoot =
    missing !== null && missing.commits.length > 0 && (await hasNothingNetToUndo(context, ref));
  return { ref, missing: isMoot ? { commits: [], isCapped: false } : missing, landings, oldTip };
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

interface Window {
  readonly now: Date;
  readonly timeZone: string;
}

const recentPresent = async (
  context: GitContext,
  answers: readonly RefAnswer[],
  selfEmail: string | null,
  window: Window,
): Promise<readonly LandedCommit[]> => {
  const sightings = (
    await Promise.all(
      answers.flatMap(({ ref, landings }) =>
        (landings ?? []).map(async (landing) =>
          (await changesLandedBy(context, landing)).map((change) => ({
            branch: ref.branch,
            change,
            landedAt: landing.itself.committedAt,
          })),
        ),
      ),
    )
  ).flat();
  const oldTips = answers.map(({ oldTip }) => oldTip).filter((tip): tip is string => tip !== null);
  const inWindow = grouped(sightings, selfEmail, (commit) => commit.landedAt?.getTime() ?? 0).filter(
    (commit) => commit.landedAt !== null && isRecentLanding(commit.landedAt, window.now, window.timeZone),
  );
  const kept = await Promise.all(
    inWindow.map(async (commit) => {
      const [wasAlreadyLanded, isPresent] = await Promise.all([
        landedBefore(context, commit.sha, oldTips),
        isAncestorOfHead(context, commit.sha),
      ]);
      return wasAlreadyLanded === false && isPresent ? commit : null;
    }),
  );
  return kept.filter((commit): commit is LandedCommit => commit !== null);
};

export interface LandedProbeInput {
  /** The root of the worktree the edited file lives in. */
  readonly root: string;
  /** Repo-relative, as git names it. */
  readonly file: string;
  readonly now: Date;
  /** The reader's timezone — the calendar "recent" is counted on. */
  readonly timeZone: string;
  readonly timeoutMs?: number;
  /** The whole probe's deadline; past it the answer is unknown (null). */
  readonly budgetMs?: number;
}

const probe = async (input: LandedProbeInput, isCancelled: () => boolean): Promise<LandedChanges | null> => {
  const context: GitContext = {
    root: input.root,
    file: input.file,
    timeoutMs: input.timeoutMs ?? LANDED_GIT_TIMEOUT_MS,
    isCancelled,
  };
  const setting = await readLandingBranches(input.root);
  const [refs, state, isPartial, selfEmail] = await Promise.all([
    resolveLandingRefs(input.root, setting, context.timeoutMs),
    readRepoState(context),
    isPartialClone(context),
    readOwnEmail(context),
  ]);
  if (refs === null || state === null || state.isShallow) {
    return null;
  }
  if (refs.length === 0) {
    return EMPTY;
  }
  const options: RefOptions = {
    cherryPick: !isPartial,
    arriving: state.arriving,
    since: new Date(input.now.getTime() - LANDED_RECENT_SCAN_DAYS * DAY_MS),
  };
  const answers = await Promise.all(refs.map((ref) => answerFor(context, ref, options)));
  if (answers.every(({ missing, landings }) => missing === null && landings === null)) {
    return null;
  }
  return {
    missing: grouped(
      answers.flatMap(({ ref, missing }) =>
        (missing?.commits ?? []).map((change) => ({ branch: ref.branch, change, landedAt: null })),
      ),
      selfEmail,
      (commit) => commit.committedAt.getTime(),
    ),
    recent: await recentPresent(context, answers, selfEmail, { now: input.now, timeZone: input.timeZone }),
    moreMissing: answers.some(({ missing }) => missing?.isCapped === true),
  };
};

/**
 * The landed changes to `file` this checkout is missing, and the recent ones
 * it has — or null when that cannot be known in time.
 */
export const findLandedChanges = async (input: LandedProbeInput): Promise<LandedChanges | null> => {
  let isPastDeadline = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      isPastDeadline = true;
      resolve(null);
    }, input.budgetMs ?? LANDED_PROBE_BUDGET_MS);
  });
  try {
    return await Promise.race([probe(input, () => isPastDeadline).catch(() => null), deadline]);
  } finally {
    clearTimeout(timer);
  }
};
