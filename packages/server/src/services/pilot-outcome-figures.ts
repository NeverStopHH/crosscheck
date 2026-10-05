/**
 * THE TEAM REPORT'S ONE OUTCOMES LINE (1.0 spec 07 §13.9, D-O5): what the
 * interventions that reached someone on this repo led to — followed, overrode,
 * not relevant now, noise (the person's label), unmarked — as counts the
 * client turns into "per 100".
 *
 * DESCRIPTIVE, NOT A MEASUREMENT AGAINST A BAR. There is no target: an
 * outcome is recorded only when an agent or a person chose to say it, so
 * every figure is a FLOOR, like the noise marks, and "unmarked" is silence,
 * never a verdict.
 *
 * PER REPO, NEVER PER PERSON (§8.4). The block is counts and one instant;
 * nothing in it names a recipient or a source. The per-person view is the
 * caller's own (`hint-outcome-view.ts`), and this reads the same states with
 * the same query so the two cannot disagree about what a delivery stands at.
 */
import { sql } from "drizzle-orm";
import type { HintOutcome } from "@crosscheck/schema";

import { EMPTY_TALLY, addToTally, deliveryStates, outcomePopulationStart } from "./hint-outcome-view.ts";
import type { Db } from "../db/client.ts";

interface Deps {
  readonly db: Db;
}

export interface OutcomeFigures {
  /** Where the figures start: the later of the window and when outcomes became recordable; null when never. */
  readonly sinceIso: string | null;
  /** Unasked deliveries that reached someone on this repo in the population. */
  readonly interventions: number;
  readonly followed: number;
  readonly overrode: number;
  readonly notRelevantNow: number;
  readonly noise: number;
  readonly unmarked: number;
}

/** What a repo that never enrolled reports: no instant, nothing counted. */
export const NO_OUTCOME_FIGURES: OutcomeFigures = {
  sinceIso: null,
  interventions: 0,
  followed: 0,
  overrode: 0,
  notRelevantNow: 0,
  noise: 0,
  unmarked: 0,
};

type StateRow = { readonly state: HintOutcome | "noise" | "unmarked"; readonly n: number };

export const readOutcomeFigures = async (
  deps: Deps,
  input: {
    readonly repo: string;
    readonly windowStart: Date;
    readonly now: Date;
    readonly outcomesSinceIso: string | null;
  },
): Promise<OutcomeFigures> => {
  if (input.outcomesSinceIso === null) {
    return NO_OUTCOME_FIGURES;
  }
  const since = outcomePopulationStart(input.windowStart, input.outcomesSinceIso, input.now);
  const rows = await deps.db.execute<StateRow>(sql`
    ${deliveryStates(input.repo, since, sql`true`)}
    SELECT st.state, count(*)::int AS n FROM states st GROUP BY st.state`);
  const { received, ...tally } = rows.rows.reduce(
    (sum, row) => addToTally(sum, row.state, Number(row.n)),
    EMPTY_TALLY,
  );
  return { sinceIso: since.toISOString(), interventions: received, ...tally };
};
