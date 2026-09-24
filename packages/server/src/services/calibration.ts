/**
 * THE CALIBRATION MEASUREMENT (1.0 spec 08 §3.7).
 *
 * It answers the one question that would make `confidence` worth printing
 * again: over months, how often did an agent-recorded root cause that started
 * `unsupported` later become `repository_verified` — PER PROVIDER. Until
 * something can answer that, two decimals on a claim are a number nothing
 * measured, and §3.6 keeps them out of every predicate for exactly that
 * reason.
 *
 * DERIVED ON READ. No table, no job, no cron, no retention. The report is a
 * reading of rows this hub already holds, so there is nothing to go stale,
 * nothing to backfill and nothing to prune. A STORED calibration would be a
 * number that was true on the day it was computed and silently wrong after.
 *
 * FOUR RULES, each refusing a familiar mistake:
 *
 * 1. COUNTS ONLY — no rate, percentage, score or badge. A ratio over twelve
 *    observations is the 0.80-at-55 % problem wearing a denominator, and the
 *    scalar ban applies here for the reason it applies to coverage. Whether a
 *    rate is ever printed is decided AFTER the data exists.
 * 2. `withoutVerificationRef` IS ALWAYS PRESENT, beside the rest. A claim that
 *    never named a check can never be verified, so hiding it turns the
 *    verified count into a flattering hit rate — #50 wrote the same lesson
 *    about lanes: *"a lane that never runs looks exactly like a quiet one"*.
 * 3. PER `agent_kind`, PER REPO. NEVER PER DEVELOPER. No developer id, name or
 *    email and no session id reaches a cell. #50's suspect rules draw this
 *    line one notch looser — sessions and intents, never people; here not even
 *    sessions, because a calibration is a statement about a PROVIDER and
 *    naming a person turns it into a performance review.
 * 4. THE BOUND IS NOT SPENT AT RANDOM — newest-first before the cap, and
 *    `claimsRead` against `claimsTotal` so a surface can say the cut happened
 *    rather than presenting a truncated answer as a whole one.
 *
 * NO MINIMUM-OBSERVATIONS FLOOR IS MINTED. Nothing here prints a rate, so
 * nothing needs one; a threshold invented before the data exists is a number
 * from nowhere, which is the defect the corpora's floor rule prevents.
 */
import { and, desc, eq, gte } from "drizzle-orm";

import {
  CALIBRATION_MAX_CELLS,
  CALIBRATION_MAX_CLAIMS,
  CALIBRATION_WINDOW_DAYS,
} from "../constants.ts";
import { agentSessions, claims } from "../db/schema.ts";
import type { DbExecutor } from "../db/client.ts";
import { readEvidenceAxes } from "./evidence-axes.ts";

const MS_PER_DAY = 86_400_000;

/** The claim kind a calibration is about: what somebody said the cause WAS. */
const ROOT_CAUSE_KIND = "root_cause";

export interface CalibrationCell {
  /**
   * The provider, as the connector stated it (`agent_sessions.agent_kind`).
   *
   * THE WHOLE POINT OF THE CELL and the only identity in it. A reader wants to
   * know whether one provider's root causes hold up better than another's;
   * they must not be able to learn WHOSE.
   */
  readonly agentKind: string;
  /** Root causes this provider recorded in the window, after the cap. */
  readonly rootCausesObserved: number;
  /** Of those, how many named a check — the ones that COULD ever be verified. */
  readonly withVerificationRef: number;
  /**
   * How many named none, and therefore can NEVER be verified.
   *
   * PRINTED ALWAYS, beside the rest. Without it the verified count is a hit
   * rate over a denominator somebody chose by omission.
   */
  readonly withoutVerificationRef: number;
  /** Where they stand TODAY — the axes derived fresh, like every other read. */
  readonly nowToolObserved: number;
  readonly nowRepositoryVerified: number;
  readonly stillUnsupported: number;
  /**
   * How many can no longer be re-derived because the red run aged out.
   *
   * ITS OWN NUMBER rather than folded into `stillUnsupported`: "we cannot tell
   * any more" is a different sentence from "nothing was run", and collapsing
   * them would let retention quietly deflate the verified count.
   */
  readonly unresolvableByRetention: number;
  readonly windowDays: number;
  readonly computedAt: string;
}

export interface CalibrationReport {
  readonly repo: string;
  readonly cells: readonly CalibrationCell[];
  /** How many claims the report actually read. */
  readonly claimsRead: number;
  /** How many were in the window — equal to `claimsRead` when nothing was cut. */
  readonly claimsTotal: number;
}

export interface CalibrationInput {
  readonly db: DbExecutor;
  readonly repo: string;
  readonly now: Date;
}

interface Tally {
  rootCausesObserved: number;
  withVerificationRef: number;
  withoutVerificationRef: number;
  nowToolObserved: number;
  nowRepositoryVerified: number;
  stillUnsupported: number;
  unresolvableByRetention: number;
}

const emptyTally = (): Tally => ({
  rootCausesObserved: 0,
  withVerificationRef: 0,
  withoutVerificationRef: 0,
  nowToolObserved: 0,
  nowRepositoryVerified: 0,
  stillUnsupported: 0,
  unresolvableByRetention: 0,
});

/**
 * The report for one repo.
 *
 * TWO QUERIES AND ONE DERIVATION, all bounded: the window plus the row cap
 * bound the claims, the derivation is the same batched one every other surface
 * calls, and the cells are bounded by the providers that appear in what was
 * read. Nothing here scans the hub.
 */
export const calibrationReport = async (
  input: CalibrationInput,
): Promise<CalibrationReport> => {
  const { db, repo, now } = input;
  const since = new Date(now.getTime() - CALIBRATION_WINDOW_DAYS * MS_PER_DAY);
  const where = and(
    eq(agentSessions.repo, repo),
    eq(claims.kind, ROOT_CAUSE_KIND),
    gte(claims.createdAt, since),
  );

  // NEWEST FIRST, THEN THE CAP. A page taken in storage order would spend the
  // bound on whatever the planner happened to hand back, and a calibration
  // built from an arbitrary half of the window is worse than one that says it
  // was cut.
  const rows = await db
    .select({
      claim: claims,
      agentKind: agentSessions.agentKind,
    })
    .from(claims)
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .where(where)
    .orderBy(desc(claims.createdAt))
    .limit(CALIBRATION_MAX_CLAIMS);

  // How many there WERE, so the cut is visible. Counted rather than inferred
  // from a full page: `rows.length === CALIBRATION_MAX_CLAIMS` cannot tell a
  // window of exactly the cap from one that overflowed it.
  const totalRows = await db
    .select({ id: claims.id })
    .from(claims)
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .where(where);

  const axes = await readEvidenceAxes({
    db,
    repo,
    claims: rows.map((row) => row.claim),
  });

  const byKind = new Map<string, Tally>();
  for (const row of rows) {
    const tally = byKind.get(row.agentKind) ?? emptyTally();
    tally.rootCausesObserved += 1;
    if (row.claim.verificationRef === null) {
      tally.withoutVerificationRef += 1;
    } else {
      tally.withVerificationRef += 1;
    }
    const derived = axes.get(row.claim.id);
    if (derived !== undefined) {
      if (derived.supportReason === "pruned_by_retention") {
        tally.unresolvableByRetention += 1;
      }
      if (derived.support === "repository_verified") {
        tally.nowRepositoryVerified += 1;
      } else if (derived.support === "tool_observed") {
        tally.nowToolObserved += 1;
      } else {
        tally.stillUnsupported += 1;
      }
    }
    byKind.set(row.agentKind, tally);
  }

  const computedAt = now.toISOString();
  // Busiest provider first, so the cap — if a hub ever carries more than eight
  // kinds — keeps the cells a reader would have used.
  const cells = [...byKind.entries()]
    .sort((a, b) => b[1].rootCausesObserved - a[1].rootCausesObserved)
    .slice(0, CALIBRATION_MAX_CELLS)
    .map(
      ([agentKind, tally]): CalibrationCell => ({
        agentKind,
        ...tally,
        windowDays: CALIBRATION_WINDOW_DAYS,
        computedAt,
      }),
    );

  return {
    repo,
    cells,
    claimsRead: rows.length,
    claimsTotal: totalRows.length,
  };
};
