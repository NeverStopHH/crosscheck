/**
 * THE HUB HALF of the generated-target rule (@crosscheck/schema
 * generated-target.ts): a file target labelled MECHANICALLY GENERATED AND
 * NON-AUTHORITATIVE is KEPT — `suspect` and coverage read every touch — and is
 * NEVER overlap evidence. The label is the connector's, which alone can read
 * the repo: an authoritative generated file (declared in the repo's
 * `authoritativeGenerated`, or a contract or migration) arrives unlabelled
 * with `authoritative: true` and stays evidence. One predicate,
 * `ordinaryTargetCondition`, sits in the WHERE of every overlap read:
 *
 *   ghost       the reader's probe, the hot count, the foreign pair rows
 *               (services/ghost-overlap.ts);
 *   conference  the page's probes, its hot count, its members (conference.ts);
 *   tripwire    the teammate sessions on the edited file (hints.ts);
 *   size        `largeChangeFiles` counts ordinary files only, so a 400-file
 *               `bun install` does not make a focused change read as a sweep.
 *
 * IN THE WHERE, NEVER AFTER A LIMIT — the rule the opt-out and mute filters
 * already follow: a value dropped after the probe's bound would have spent a
 * slot a real file needed.
 *
 * EITHER SIDE LABELLED IS ENOUGH. A value is shared evidence only when BOTH
 * rows carrying it are ordinary, because the probe and the looked-up side both
 * ask the predicate. The label is positive evidence about the FILE — a
 * lockfile is a lockfile in both worktrees — and an UNKNOWN never produces it:
 * the connector sends no label for a classification that could not run.
 *
 * HONEST COVERAGE: a row that qualified on ordinary files also says how many
 * generated files the two sides share (`generatedSharedCount`), so "2 of your
 * files" is never read as "2 of everything you both touched".
 */
import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { isGeneratedPath } from "@crosscheck/schema";
import type { GeneratedSignal } from "@crosscheck/schema";

import { workContextTargets } from "../db/schema.ts";
import type { Db } from "../db/client.ts";

/** The only kind the rule labels: a generated SYMBOL or failure is not a thing. */
const FILE_KIND = "file";

/** A target row that is overlap evidence: not labelled mechanically generated and non-authoritative. */
export const ordinaryTargetCondition = (): SQL => isNull(workContextTargets.generated);

/**
 * The label ingest stores. The connector's when it sent one; for a target
 * that carries none — an older connector, or a classification that found
 * nothing — the PATH signal applied here, so the well-known names are covered
 * whoever sent them. NEVER for a target the connector marked authoritative:
 * the repo said it counts, and the hub cannot read the repo to disagree. Only
 * file targets are ever labelled.
 */
export const hubGeneratedSignal = (
  kind: string,
  value: string,
  sent: GeneratedSignal | undefined,
  authoritative: boolean | undefined,
): GeneratedSignal | null => {
  if (kind !== FILE_KIND || authoritative === true) {
    return null;
  }
  return sent ?? (isGeneratedPath(value) ? "path" : null);
};

/**
 * Per foreign context, the generated files it shares with ANY of the reader's
 * own contexts — the `generatedSharedCount` a ghost row carries beside its
 * `sharedTargetCount`. Driven from LABELLED rows only, on either side, and
 * looked up by (kind, value) on the other: a qualifier read after the
 * candidates are chosen, never a factor of the pair computation, and bounded
 * by the candidates the caller passes (GHOST_MAX_FINDINGS at most).
 */
export const listGeneratedSharedWithReader = async (
  db: Db,
  ownIds: readonly string[],
  candidateIds: readonly string[],
): Promise<ReadonlyMap<string, number>> => {
  if (ownIds.length === 0 || candidateIds.length === 0) {
    return new Map();
  }
  const labelled = alias(workContextTargets, "generated_labelled");
  const other = alias(workContextTargets, "generated_other");
  const labelledIsTheirs = inArray(labelled.workContextId, [...candidateIds]);
  const theirId = sql<string>`case when ${labelledIsTheirs} then ${labelled.workContextId} else ${other.workContextId} end`;
  const rows = await db
    .select({ theirId, shared: sql<number>`count(distinct ${labelled.value})::int` })
    .from(labelled)
    .innerJoin(other, and(eq(other.kind, labelled.kind), eq(other.value, labelled.value)))
    .where(
      and(
        eq(labelled.kind, FILE_KIND),
        isNotNull(labelled.generated),
        sql`((${labelledIsTheirs} and ${inArray(other.workContextId, [...ownIds])}) or (${inArray(labelled.workContextId, [...ownIds])} and ${inArray(other.workContextId, [...candidateIds])}))`,
      ),
    )
    // BY POSITION: the expression carries its id list as bound parameters,
    // and the same expression re-bound in a GROUP BY is a different one to
    // the planner.
    .groupBy(sql`1`);
  return new Map(rows.map((row) => [row.theirId, Number(row.shared)]));
};

/** The key a conference pair's generated count is filed under, either order. */
export const pairKey = (left: string, right: string): string =>
  left < right ? `${left}\n${right}` : `${right}\n${left}`;

/**
 * Per pair of the page's contexts, the generated files both carry — the
 * conference pair's `generatedSharedCount`. Same shape as the reader's count:
 * labelled rows drive, the other side is looked up, and the page bounds it
 * (CONFERENCE_MAX_CONTEXTS).
 */
export const listGeneratedSharedPairs = async (
  db: Db,
  ids: readonly string[],
): Promise<ReadonlyMap<string, number>> => {
  if (ids.length < 2) {
    return new Map();
  }
  const labelled = alias(workContextTargets, "generated_labelled");
  const other = alias(workContextTargets, "generated_other");
  const low = sql<string>`least(${labelled.workContextId}, ${other.workContextId})`;
  const high = sql<string>`greatest(${labelled.workContextId}, ${other.workContextId})`;
  const rows = await db
    .select({ low, high, shared: sql<number>`count(distinct ${labelled.value})::int` })
    .from(labelled)
    .innerJoin(
      other,
      and(
        eq(other.kind, labelled.kind),
        eq(other.value, labelled.value),
        ne(other.workContextId, labelled.workContextId),
      ),
    )
    .where(
      and(
        eq(labelled.kind, FILE_KIND),
        isNotNull(labelled.generated),
        inArray(labelled.workContextId, [...ids]),
        inArray(other.workContextId, [...ids]),
      ),
    )
    .groupBy(low, high);
  return new Map(rows.map((row) => [pairKey(row.low, row.high), Number(row.shared)]));
};
