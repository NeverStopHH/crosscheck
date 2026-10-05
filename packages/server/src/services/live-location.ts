/**
 * LIVE LOCATION, WITHHELD — the one place the hub decides what an opted-out
 * developer's teammates are not told (services/visibility.ts states the
 * policy): a session's current branch, its HEAD/base commit, and its
 * heartbeat/last-active time. Their work contexts, claims and diagnoses stay
 * shared; only these fields go.
 *
 * Withheld per FIELD, not per row, and per VIEWER: the subject's own reads
 * are untouched, and every other viewer reads the same rows with the
 * location fields gone. The set is computed once per request — opted-out
 * developers are few and the query is one indexed scan.
 *
 * A FALLBACK TITLE IS A BRANCH. When the host supplied no title, the
 * connector named the context `<branch> @ <repo>` (@crosscheck/schema
 * isFallbackTitle), so that title is withheld exactly as the branch is and
 * reads as WITHHELD_TITLE on every surface. Done here, on the hub, so a
 * connector too old to know about it cannot print the branch anyway.
 */
import { and, eq, ne } from "drizzle-orm";
import { WITHHELD_TITLE, isFallbackTitle } from "@crosscheck/schema";

import { developers } from "../db/schema.ts";
import type { Db } from "../db/client.ts";

/** Developers whose live location THIS viewer may not be told. */
export type HiddenLocations = ReadonlySet<string>;

export const locationHiddenFrom = async (
  db: Db,
  viewerDeveloperId: string,
): Promise<HiddenLocations> => {
  const rows = await db
    .select({ id: developers.id })
    .from(developers)
    .where(
      and(
        eq(developers.presenceOptOut, true),
        ne(developers.id, viewerDeveloperId),
      ),
    );
  return new Set(rows.map((row) => row.id));
};

/**
 * A work context's title as this viewer may read it: whole, unless its owner's
 * location is hidden from them AND the title is the fallback that names the
 * branch. A title a person or a host wrote is published knowledge and stays.
 */
export const titleSeenBy = (
  hidden: HiddenLocations,
  ownerDeveloperId: string,
  title: string,
  repo: string,
): string =>
  hidden.has(ownerDeveloperId) && isFallbackTitle(title, repo)
    ? WITHHELD_TITLE
    : title;
