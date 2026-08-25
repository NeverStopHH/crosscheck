/**
 * The solved-pointer precision loop, counted (VISION.md §1 + DESIGN.md §4
 * "telemetry from day one").
 *
 * A "solved before" line is this product asserting relevance UNASKED — the
 * highest-risk thing it does. `hint_deliveries` already records every
 * injected ref and marks it `pulled_at` when the reader later opens that
 * tree with `get_diagnosis`, so the honest question "did these lines help,
 * or are they wallpaper?" is answerable from rows that already exist. What
 * was missing is the READING: nothing counted them anywhere, which left the
 * whole surface a PASS-only story — it could be useless for months and every
 * instrument would stay green.
 *
 * SOLVEDNESS IS NOT STORED ON THE DELIVERY, so it is resolved the way every
 * other surface resolves it: `listSolvedInfo` over the delivered ids, one
 * bounded lookup, one spelling of the rule. A delivery whose tree has since
 * stopped being solved simply stops counting — the honest direction, because
 * the counter describes what a reader would be shown today.
 *
 * BOUNDED TWICE, like every listing here: a time window and a row cap. The
 * cap is why these numbers are a FLOOR on a very busy hub rather than a
 * total, and why the surfaces that print them say "in the last N days"
 * instead of "ever".
 */
import { and, desc, eq, gte } from "drizzle-orm";

import {
  SOLVED_COUNT_MAX_DELIVERY_ROWS,
  SOLVED_COUNT_WINDOW_DAYS,
} from "../constants.ts";
import { agentSessions, hintDeliveries } from "../db/schema.ts";
import { listSolvedInfo } from "./solved.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

const MS_PER_DAY = 86_400_000;

export interface SolvedMatchCounts {
  /** Solved-tree pointers this developer was handed on this repo. */
  readonly shown: number;
  /** How many of those they then opened with `get_diagnosis`. */
  readonly pulled: number;
  /** The window both numbers describe, so a surface can say it out loud. */
  readonly windowDays: number;
}

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

export const countSolvedDeliveries = async (
  deps: Deps,
  developerId: string,
  repo: string,
): Promise<SolvedMatchCounts> => {
  const cutoff = new Date(
    deps.now().getTime() - SOLVED_COUNT_WINDOW_DAYS * MS_PER_DAY,
  );
  // Work-context refs only: a claim delivery is an ordinary teammate hint,
  // and a solved tree is always pointed at by its context id.
  const rows = await deps.db
    .select({
      refId: hintDeliveries.refId,
      pulledAt: hintDeliveries.pulledAt,
    })
    .from(hintDeliveries)
    .innerJoin(agentSessions, eq(hintDeliveries.sessionId, agentSessions.id))
    .where(
      and(
        eq(agentSessions.developerId, developerId),
        eq(agentSessions.repo, repo),
        eq(hintDeliveries.refKind, "work_context"),
        gte(hintDeliveries.deliveredAt, cutoff),
      ),
    )
    .orderBy(desc(hintDeliveries.deliveredAt))
    .limit(SOLVED_COUNT_MAX_DELIVERY_ROWS);
  if (rows.length === 0) {
    return { shown: 0, pulled: 0, windowDays: SOLVED_COUNT_WINDOW_DAYS };
  }
  const solved = await listSolvedInfo(deps.db, [
    ...new Set(rows.map((row) => row.refId)),
  ]);
  const delivered = rows.filter((row) => solved.has(row.refId));
  return {
    shown: delivered.length,
    pulled: delivered.filter((row) => row.pulledAt !== null).length,
    windowDays: SOLVED_COUNT_WINDOW_DAYS,
  };
};
