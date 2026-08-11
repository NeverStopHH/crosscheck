/**
 * Per-developer privacy settings CRUD (DESIGN.md §2.1): the presence opt-out
 * flag on the developer row and the reader-side mute list.
 *
 * STORAGE CHOICES, justified: opt-out is a COLUMN on developers (one boolean
 * per developer — a settings table would be speculative structure), and mutes
 * are a HUB-side table keyed by reader (a mute that lived in the connector's
 * local config would silently stop working on the developer's second
 * machine). Enforcement lives in services/visibility.ts; this module only
 * reads and writes the state.
 *
 * No outbox events are appended here on purpose: broadcasting "X just opted
 * out" would itself be a presence signal about X.
 */
import { asc, eq, sql } from "drizzle-orm";

import { developerMutes, developers } from "../db/schema.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

/**
 * Upper bound on one reader's mute list — keeps the settings read and every
 * notMutedCondition subquery bounded by a constant, not by write volume.
 */
export const MAX_MUTES_PER_READER = 100;

export interface MuteEntryView {
  readonly id: string;
  readonly name: string;
}

export interface DeveloperSettingsView {
  readonly presenceOptOut: boolean;
  readonly mutes: readonly MuteEntryView[];
}

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

export const getDeveloperSettings = async (
  db: Db,
  developerId: string,
): Promise<DeveloperSettingsView> => {
  const own = await db
    .select({ presenceOptOut: developers.presenceOptOut })
    .from(developers)
    .where(eq(developers.id, developerId))
    .limit(1);
  const mutes = await db
    .select({ id: developers.id, name: developers.name })
    .from(developerMutes)
    .innerJoin(developers, eq(developerMutes.mutedDeveloperId, developers.id))
    .where(eq(developerMutes.readerDeveloperId, developerId))
    .orderBy(asc(developers.name), asc(developers.id))
    .limit(MAX_MUTES_PER_READER);
  return { presenceOptOut: own[0]?.presenceOptOut ?? false, mutes };
};

export const setPresenceOptOut = async (
  db: Db,
  developerId: string,
  optOut: boolean,
): Promise<void> => {
  await db
    .update(developers)
    .set({ presenceOptOut: optOut })
    .where(eq(developers.id, developerId));
};

export type ResolveDeveloperResult =
  | { readonly outcome: "resolved"; readonly developer: MuteEntryView }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "ambiguous" };

/** How many same-name rows are read to detect ambiguity — two is enough. */
const AMBIGUITY_PROBE_LIMIT = 2;

/**
 * Resolves a CLI-supplied reference to one developer: exact id first, then
 * email (stored lowercased — services/developers.ts), then case-insensitive
 * display name, where two matches is an error rather than a guess.
 */
export const resolveDeveloperRef = async (
  db: Db,
  ref: string,
): Promise<ResolveDeveloperResult> => {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    return { outcome: "not_found" };
  }
  const byId = await db
    .select({ id: developers.id, name: developers.name })
    .from(developers)
    .where(eq(developers.id, trimmed))
    .limit(1);
  if (byId[0] !== undefined) {
    return { outcome: "resolved", developer: byId[0] };
  }
  const byEmail = await db
    .select({ id: developers.id, name: developers.name })
    .from(developers)
    .where(eq(developers.email, trimmed.toLowerCase()))
    .limit(1);
  if (byEmail[0] !== undefined) {
    return { outcome: "resolved", developer: byEmail[0] };
  }
  const byName = await db
    .select({ id: developers.id, name: developers.name })
    .from(developers)
    .where(eq(sql`lower(${developers.name})`, trimmed.toLowerCase()))
    .limit(AMBIGUITY_PROBE_LIMIT);
  if (byName.length > 1) {
    return { outcome: "ambiguous" };
  }
  const match = byName[0];
  if (match !== undefined) {
    return { outcome: "resolved", developer: match };
  }
  return { outcome: "not_found" };
};

export type AddMuteResult =
  | {
      readonly outcome: "muted";
      readonly developer: MuteEntryView;
      readonly alreadyMuted: boolean;
    }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "ambiguous" }
  | { readonly outcome: "self" }
  | { readonly outcome: "limit_reached" };

export const addMute = async (
  deps: Deps,
  readerDeveloperId: string,
  ref: string,
): Promise<AddMuteResult> => {
  const resolved = await resolveDeveloperRef(deps.db, ref);
  if (resolved.outcome !== "resolved") {
    return resolved;
  }
  if (resolved.developer.id === readerDeveloperId) {
    return { outcome: "self" };
  }
  const counted = await deps.db
    .select({ total: sql<number>`count(*)::int` })
    .from(developerMutes)
    .where(eq(developerMutes.readerDeveloperId, readerDeveloperId));
  if ((counted[0]?.total ?? 0) >= MAX_MUTES_PER_READER) {
    return { outcome: "limit_reached" };
  }
  const inserted = await deps.db
    .insert(developerMutes)
    .values({
      readerDeveloperId,
      mutedDeveloperId: resolved.developer.id,
      createdAt: deps.now(),
    })
    .onConflictDoNothing()
    .returning({ id: developerMutes.mutedDeveloperId });
  return {
    outcome: "muted",
    developer: resolved.developer,
    alreadyMuted: inserted.length === 0,
  };
};

export type RemoveMuteResult =
  | {
      readonly outcome: "unmuted";
      readonly developer: MuteEntryView;
      readonly wasMuted: boolean;
    }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "ambiguous" };

export const removeMute = async (
  db: Db,
  readerDeveloperId: string,
  ref: string,
): Promise<RemoveMuteResult> => {
  const resolved = await resolveDeveloperRef(db, ref);
  if (resolved.outcome !== "resolved") {
    return resolved;
  }
  const deleted = await db
    .delete(developerMutes)
    .where(
      sql`${developerMutes.readerDeveloperId} = ${readerDeveloperId}
        AND ${developerMutes.mutedDeveloperId} = ${resolved.developer.id}`,
    )
    .returning({ id: developerMutes.mutedDeveloperId });
  return {
    outcome: "unmuted",
    developer: resolved.developer,
    wasMuted: deleted.length > 0,
  };
};
