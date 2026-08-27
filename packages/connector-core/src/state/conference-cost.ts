/**
 * What conferences have cost and what they produced (VISION.md §2), made
 * visible — the ghost check's cost module one level out, because a conference
 * has no session to keep its counters in.
 *
 * THE COUNTERS OUTLIVE THE RUN, and that is the difference from every other
 * model-cost counter here. `crosscheck conference` is a command a human types,
 * possibly from a scheduler at 03:00, and there is no session state to sum:
 * the numbers live in one small file per repo+hub, so `crosscheck status` on a
 * machine with no live session still answers "what did the last four
 * conferences do".
 *
 * FOUR OUTCOMES, NAMED APART, for the reason the ghost module names its own
 * apart: a run that found nothing to compare, a run whose model said NONE, a
 * run whose answer this machine could not READ, and a run that failed. Only
 * the last two are faults. Folding the first two into them would make a quiet
 * team look like a broken runner; folding the third into NONE would make a
 * drifted prompt look like a quiet team, which is the more expensive mistake
 * because nothing else on any surface would ever say so.
 *
 * Fail-open everywhere: a counter file that cannot be read or written costs a
 * number, never a run.
 */
import { z } from "zod";

import { DOCTOR_CONFERENCE_UNREADABLE_WARN, SUMMARIZER_FAILURE_MAX_CHARS } from "../constants.ts";
import { cutWellFormed } from "../briefing/cut.ts";
import {
  conferenceCostLockPath,
  conferenceCostPath,
  readJsonOrNull,
  writePrivateFile,
} from "../config/paths.ts";
import { withLock } from "../spool/lock.ts";

export interface ConferenceCost {
  /** Runs that reached the hub at all. */
  readonly runs: number;
  /** Findings written into a report — the only number that is an outcome. */
  readonly findings: number;
  /** Findings posted to the hub as derived drafts (--publish). */
  readonly published: number;
  /** Runs whose model said the sessions share no cause. */
  readonly nones: number;
  /** Runs with nothing to compare: no model call, no tokens. */
  readonly skipped: number;
  /** Runs where the HUB could not answer — deployment state, not a fault. */
  readonly noHubAnswer: number;
  /** Answers in a shape this machine could not read: a drifted contract. */
  readonly unreadable: number;
  /** Runs that lost their model call, with one booked reason. */
  readonly fails: number;
  readonly lastFailure: string | null;
  readonly lastRunAt: string | null;
}

export const EMPTY_CONFERENCE_COST: ConferenceCost = {
  runs: 0,
  findings: 0,
  published: 0,
  nones: 0,
  skipped: 0,
  noHubAnswer: 0,
  unreadable: 0,
  fails: 0,
  lastFailure: null,
  lastRunAt: null,
};

/**
 * Tolerant per FIELD like every other state schema here: a file written by an
 * older connector, or half-edited by a human, costs the fields it garbled and
 * never the whole count.
 */
const ConferenceCostSchema = z.looseObject({
  runs: z.number().int().min(0).catch(0),
  findings: z.number().int().min(0).catch(0),
  published: z.number().int().min(0).catch(0),
  nones: z.number().int().min(0).catch(0),
  skipped: z.number().int().min(0).catch(0),
  noHubAnswer: z.number().int().min(0).catch(0),
  unreadable: z.number().int().min(0).catch(0),
  fails: z.number().int().min(0).catch(0),
  lastFailure: z.string().nullable().catch(null),
  lastRunAt: z.string().nullable().catch(null),
});

export const readConferenceCost = async (
  home: string,
  key: string,
): Promise<ConferenceCost> => {
  const parsed = ConferenceCostSchema.safeParse(
    await readJsonOrNull(conferenceCostPath(home, key)),
  );
  return parsed.success ? parsed.data : EMPTY_CONFERENCE_COST;
};

/** What ONE run adds. Everything absent is zero — a run books what it did. */
export interface ConferenceRunOutcome {
  readonly findings?: number;
  readonly published?: number;
  readonly none?: boolean;
  readonly skipped?: boolean;
  readonly noHubAnswer?: boolean;
  readonly unreadable?: boolean;
  readonly failure?: string;
}

/**
 * Books one run under the lock — read, add, write. Two conferences started at
 * once (a human and their scheduler on the same minute) would otherwise lose
 * whichever read first, and a counter that quietly under-reports is worse than
 * no counter: the doctor rule below is read off these numbers.
 *
 * A run that cannot take the lock still HAPPENED, so the report is written
 * either way; only its count is lost, which is the cheap half.
 */
export const recordConferenceRun = async (
  home: string,
  key: string,
  outcome: ConferenceRunOutcome,
  now: Date,
): Promise<void> => {
  try {
    await bookRun(home, key, outcome, now);
  } catch {
    // FAIL-OPEN, and it has to be HERE rather than only in the doc comment
    // above: `withLock` mkdirs the lock's directory, so a home that is
    // read-only, full or owned by somebody else threw straight out of this
    // function and out of `crosscheck conference` with it — the counter cost
    // the run instead of the run costing the counter.
  }
};

const bookRun = async (
  home: string,
  key: string,
  outcome: ConferenceRunOutcome,
  now: Date,
): Promise<void> => {
  await withLock(conferenceCostLockPath(home, key), undefined, async () => {
    const current = await readConferenceCost(home, key);
    const next: ConferenceCost = {
      runs: current.runs + 1,
      findings: current.findings + (outcome.findings ?? 0),
      published: current.published + (outcome.published ?? 0),
      nones: current.nones + (outcome.none === true ? 1 : 0),
      skipped: current.skipped + (outcome.skipped === true ? 1 : 0),
      noHubAnswer: current.noHubAnswer + (outcome.noHubAnswer === true ? 1 : 0),
      unreadable: current.unreadable + (outcome.unreadable === true ? 1 : 0),
      fails: current.fails + (outcome.failure === undefined ? 0 : 1),
      lastFailure:
        outcome.failure === undefined
          ? current.lastFailure
          : // Bounded by THIS writer, like both its siblings, so one chatty
            // binary can never grow the state file.
            cutWellFormed(outcome.failure, SUMMARIZER_FAILURE_MAX_CHARS),
      lastRunAt: now.toISOString(),
    };
    await writePrivateFile(conferenceCostPath(home, key), JSON.stringify(next));
  });
};

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

/** Coarse and honest — the exact minute of a nightly run helps nobody. */
const ageOf = (iso: string, now: Date): string => {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return "at an unreadable time";
  }
  const minutes = Math.max(
    0,
    Math.floor((now.getTime() - ms) / (MS_PER_SECOND * SECONDS_PER_MINUTE)),
  );
  if (minutes < MINUTES_PER_HOUR) {
    return `${String(minutes)}m ago`;
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  return hours < HOURS_PER_DAY
    ? `${String(hours)}h ago`
    : `${String(Math.floor(hours / HOURS_PER_DAY))}d ago`;
};

/**
 * The one sentence both CLI surfaces print. Never run is a STATE, not a fault
 * — this command is opt-in by design (VISION §2: "never automatic"), and a
 * line nagging a team for not running it would be the autonomous background
 * process the feature deliberately is not.
 */
export const formatConferenceCost = (
  cost: ConferenceCost,
  now: Date,
): string => {
  if (cost.runs === 0) {
    return "never run (crosscheck conference is opt-in)";
  }
  const runs = `${String(cost.runs)} run${cost.runs === 1 ? "" : "s"}`;
  const last = cost.lastRunAt === null ? "" : ` (last ${ageOf(cost.lastRunAt, now)})`;
  const published =
    cost.published === 0 ? "" : `, ${String(cost.published)} published`;
  const failed =
    cost.fails === 0
      ? ""
      : `, ${String(cost.fails)} failed${cost.lastFailure === null ? "" : `: last "${cost.lastFailure}"`}`;
  const unreadable =
    cost.unreadable === 0
      ? ""
      : `, ${String(cost.unreadable)} unreadable answer${cost.unreadable === 1 ? "" : "s"}`;
  const noHub =
    cost.noHubAnswer === 0
      ? ""
      : `, ${String(cost.noHubAnswer)} not measured (the hub could not answer)`;
  return (
    `${runs}${last} · ${String(cost.findings)} findings ` +
    `(${String(cost.nones)} NONE, ${String(cost.skipped)} nothing to synthesize` +
    `${published}${failed}${unreadable}${noHub})`
  );
};

/**
 * Doctor's WARN rule. Two faults and only two: a model call this machine lost,
 * and an answer this machine could not read.
 *
 * WHAT IS DELIBERATELY NOT A WARNING: a run that found nothing to compare, a
 * NONE, a hub that could not answer, and — loudest of all — a team that has
 * never run one. Each of those is either the feature working as designed or a
 * deployment state, and a warning fired on any of them is the cried wolf that
 * makes a reader stop reading `doctor` (the finding-#14 lesson cuts both ways).
 */
export const isConferenceSilentlyDead = (cost: ConferenceCost): boolean =>
  cost.fails > 0 || cost.unreadable >= DOCTOR_CONFERENCE_UNREADABLE_WARN;
