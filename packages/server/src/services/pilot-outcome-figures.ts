/**
 * THE TEAM REPORT'S ONE OUTCOMES LINE (1.0 spec 07 §13.9, D-O5; review #4):
 * what the interventions that reached someone on this repo led to — followed,
 * overrode, not relevant now, noise (the person's label), unmarked — as counts
 * the client turns into "per 100".
 *
 * DESCRIPTIVE, NOT A MEASUREMENT AGAINST A BAR. There is no target, and only
 * what an agent or a person chose to record is counted.
 *
 * NO SUBTRACTION MAY SINGLE SOMEBODY OUT (review #4). The review subtracted
 * one person's own `--mine` from a two-recipient team total and read the
 * other's exact outcomes; the author read the overrides of their own work. So:
 *
 *   · ONE FIXED, CLOSED PERIOD — the last whole calendar month (UTC) — never
 *     the report's `days`, which could be stepped to isolate a day; counted as
 *     it stood at the month's end, so a word changed later never moves it;
 *   · NUMBERS ONLY ABOVE THE DISCLOSURE MINIMUMS, each holding with any one
 *     recorder's words left out (§13.11, H1): three people's words, about
 *     three people's work, ten or more. Below them the block says only
 *     "below_minimums" and carries no count at all (M1).
 *
 * Nothing in the block names a recipient or a source.
 */
import { sql } from "drizzle-orm";
import type { HintOutcomeWithholding } from "@crosscheck/schema";

import {
  enrolledSpan,
  lastWholeMonth,
  readEnrolments,
  readPeriodAggregate,
  withholdingOf,
} from "./outcome-population.ts";
import type { Db } from "../db/client.ts";

interface Deps {
  readonly db: Db;
}

export interface OutcomeCounts {
  /** Unasked interventions that reached someone in the counted part of the period. */
  readonly interventions: number;
  readonly followed: number;
  readonly overrode: number;
  readonly notRelevantNow: number;
  readonly noise: number;
  readonly unmarked: number;
}

export interface OutcomeFigures {
  /** The closed period the block covers: the last whole calendar month, UTC. */
  readonly periodStartIso: string;
  readonly periodEndIso: string;
  /** When outcomes first became recordable on this repo; null when never. */
  readonly recordableSinceIso: string | null;
  /** Where counting starts inside the period; null when the repo was in the pilot for no moment of it. */
  readonly countedFromIso: string | null;
  /** The pilot paused inside the counted part of the period: only its enrolled time is counted (review M3). */
  readonly pausedInPeriod: boolean;
  /** The period is counted over an enrolment an upgrade reconstructed from what was recorded (review M-3). */
  readonly reconstructed: boolean;
  /** Why no figure is shown, or null when it is — and then no count rides anywhere (review M1). */
  readonly withheld: HintOutcomeWithholding | null;
  readonly figures: OutcomeCounts | null;
}

const notRecordable = (
  period: { readonly start: Date; readonly end: Date },
  recordableSinceIso: string | null,
): OutcomeFigures => ({
  periodStartIso: period.start.toISOString(),
  periodEndIso: period.end.toISOString(),
  recordableSinceIso,
  countedFromIso: null,
  pausedInPeriod: false,
  reconstructed: false,
  withheld: "not_recordable",
  figures: null,
});

/** What a repo that never enrolled reports: no instant, nothing counted. */
export const noOutcomeFigures = (now: Date): OutcomeFigures => notRecordable(lastWholeMonth(now), null);

export const readOutcomeFigures = async (
  deps: Deps,
  input: { readonly repo: string; readonly now: Date; readonly outcomesSinceIso: string | null },
): Promise<OutcomeFigures> => {
  const period = lastWholeMonth(input.now);
  const span = enrolledSpan(period.start, period.end, await readEnrolments(deps.db, input.repo));
  if (span === null) {
    return notRecordable(period, input.outcomesSinceIso);
  }
  const aggregate = await readPeriodAggregate(deps.db, {
    repo: input.repo,
    from: span.from,
    until: period.end,
    who: sql`true`,
    sourceIs: null,
    at: input.now,
  });
  const withheld = withholdingOf(aggregate, { sources: true, recorded: true, followers: false });
  return {
    periodStartIso: period.start.toISOString(),
    periodEndIso: period.end.toISOString(),
    recordableSinceIso: input.outcomesSinceIso,
    countedFromIso: span.from.toISOString(),
    pausedInPeriod: span.paused,
    reconstructed: span.reconstructed,
    withheld,
    figures:
      withheld === null
        ? {
            interventions: aggregate.interventions,
            followed: aggregate.followed,
            overrode: aggregate.overrode,
            notRelevantNow: aggregate.notRelevantNow,
            noise: aggregate.noise,
            unmarked: aggregate.unmarked,
          }
        : null,
  };
};
