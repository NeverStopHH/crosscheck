/**
 * THE COVERAGE RECORD'S `order` BLOCK (1.0 spec 01a §3.7) — what the sessions
 * a coverage answer is about could say about ORDER, beside the five sources
 * that say whether anybody was watching. Never a sixth source (01a D-C), never
 * read by `isJudgeable`, and carrying no count (03 COV-6): `doctor` holds the
 * counts.
 *
 * THE FOLD: the minimum, over the sessions in scope and the kinds the question
 * needs, of each session's effective guarantee — its stored declaration,
 * already capped by its own rows (services/causal-guarantees.ts). Two cases
 * outrank the minimum because a plain minimum gets them backwards:
 *   - no session in scope   → `undeclared / no_session_in_scope` — a minimum
 *                             over nothing returns the strongest value;
 *   - a needed kind missing → `undeclared / provider_undeclared` — a session
 *     for any session           that declared nothing has no row to minimise.
 *
 * WHICH KINDS A QUESTION NEEDS, for the coverage reads that exist on
 * 2026-10-01 (01a §13 records the decision):
 *   - GET /api/suspect computes 04's verdict, whose `predeclared` / `post_hoc`
 *     answer is `explanationTimingFor` — an edit against intent versions:
 *     EXPLANATION_TIMING_KINDS.
 *   - GET /api/absences reads the commit census: COMMIT_KINDS.
 *   - every other read (search, hints, work contexts, the pilot snapshot) asks
 *     no ordering question of its own: ALL nine — the weakest reading, because
 *     a minimum over more kinds can only be lower.
 */
import { sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import { GUARANTEE_KINDS, ORDER_REASON_STRENGTH, stateOfOrderReason } from "@crosscheck/schema";
import type { CoverageOrder, GuaranteeKind } from "@crosscheck/schema";

import type { DbExecutor } from "../db/client.ts";

export const ALL_ORDER_KINDS: readonly GuaranteeKind[] = GUARANTEE_KINDS;
/** "Who touched this file" — the touch itself. */
export const TOUCH_KINDS: readonly GuaranteeKind[] = ["file.modified"];
/** 04's explanation timing: an edit against the intent versions it is compared with. */
export const EXPLANATION_TIMING_KINDS: readonly GuaranteeKind[] = [
  "file.modified",
  "intent.declared",
  "intent.amended",
];
/** The commit census the absence finding reads. */
export const COMMIT_KINDS: readonly GuaranteeKind[] = ["commit.observed"];

const NO_SESSION: CoverageOrder = { state: "undeclared", reason: "no_session_in_scope" };
const UNDECLARED: CoverageOrder = { state: "undeclared", reason: "provider_undeclared" };

/**
 * The strength rank of a stored reason, in SQL. A stored value this hub does
 * not know (a newer hub wrote it) ranks as `provider_undeclared` — weaker
 * than every declared reason, never skipped, and never misnamed as one of the
 * reader's own words. Built from the schema's constant: no author text.
 */
const UNKNOWN_STORED_RANK = ORDER_REASON_STRENGTH.indexOf("provider_undeclared");
const RANK_ARMS = sql.raw(
  `${ORDER_REASON_STRENGTH.map((reason, rank) => `WHEN '${reason}' THEN ${String(rank)}`).join(
    " ",
  )} ELSE ${String(UNKNOWN_STORED_RANK)} END`,
);

/**
 * The strength rank of a stored reason column, in SQL — the one CASE both the
 * scope fold here and the re-register's conditional weaken
 * (services/causal-guarantees.ts) compare by.
 */
export const reasonRankSql = (column: SQL | AnyColumn): SQL => sql`CASE ${column} ${RANK_ARMS}`;

const STRENGTH_RANK = reasonRankSql(sql.raw("g.reason"));

const toCount = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * `scope` is the agent_event rung's own session predicate over
 * `agent_sessions` (services/coverage.ts), so the two read the same sessions.
 */
export const readCoverageOrder = async (
  db: DbExecutor,
  scope: SQL,
  kinds: readonly GuaranteeKind[],
): Promise<CoverageOrder> => {
  const needed = kinds.length === 0 ? ALL_ORDER_KINDS : kinds;
  const kindList = sql.join(
    needed.map((kind) => sql`${kind}`),
    sql`, `,
  );
  const result = await db.execute(sql`
    SELECT count(*) AS sessions,
           coalesce(sum(d.declared), 0) AS declared,
           min(d.weakest) AS weakest
      FROM agent_sessions
      LEFT JOIN LATERAL (
        SELECT count(*) AS declared, min(${STRENGTH_RANK}) AS weakest
          FROM session_causal_guarantees g
         WHERE g.session_id = agent_sessions.id AND g.kind IN (${kindList})
      ) d ON true
     WHERE ${scope}`);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  const sessions = toCount(row?.["sessions"]);
  if (sessions === 0) {
    return NO_SESSION;
  }
  if (toCount(row?.["declared"]) < sessions * needed.length) {
    return UNDECLARED;
  }
  // A NULL minimum is "no row", never rank 0: `Number(null)` is 0, and rank 0
  // would name the empty scope for a scope that has sessions.
  const weakest = row?.["weakest"];
  const reason =
    weakest === null || weakest === undefined
      ? UNDECLARED.reason
      : (ORDER_REASON_STRENGTH[toCount(weakest)] ?? UNDECLARED.reason);
  return { state: stateOfOrderReason(reason), reason };
};
