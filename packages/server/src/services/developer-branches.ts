/**
 * EVERY BRANCH A DEVELOPER'S SESSIONS EVER REPORTED (review round 5, H3) —
 * the table (db/schema.ts developerBranches), its writer and its reader.
 *
 * The live-location projection withholds an opted-out owner's unmarked
 * title when it equals ANY branch of hers (services/live-location.ts,
 * review round 4, L2): a session that re-registered moved its branch, and
 * the title still names the old one. Round 4 learned those branches by
 * scanning the events table on every call, which cost every colleague read
 * (hint candidates p50 107 ms at 500k events), her own ingest and her
 * toggle; and the events table's retention would have made the hub forget a
 * branch she left. Here a branch is written ONCE, when a session registers
 * on it, and read by developer through the primary key. What a hub knew
 * before the table existed is backfilled at every boot by db/bootstrap.sql.
 */
import { inArray } from "drizzle-orm";

import { developerBranches } from "../db/schema.ts";
import type { DbExecutor } from "../db/client.ts";

/** A developer's sessions reported this branch at `at`; a repeat changes nothing. */
export const recordDeveloperBranch = async (
  db: DbExecutor,
  developerId: string,
  branch: string,
  at: Date,
): Promise<void> => {
  await db
    .insert(developerBranches)
    .values({ developerId, branch, firstSeen: at })
    .onConflictDoNothing();
};

/** Every branch each of these developers' sessions ever reported, by developer. */
export const branchesOf = async (
  db: DbExecutor,
  developerIds: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> => {
  if (developerIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({ developerId: developerBranches.developerId, branch: developerBranches.branch })
    .from(developerBranches)
    .where(inArray(developerBranches.developerId, [...developerIds]));
  return new Map(
    developerIds.map((id) => [id, rows.filter((row) => row.developerId === id).map((row) => row.branch)]),
  );
};

