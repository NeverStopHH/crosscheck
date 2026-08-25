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

import { developerEmails, developerMutes, developers } from "../db/schema.ts";
import { listDeveloperEmails } from "./developers.ts";
import type { DeveloperEmailView } from "./developers.ts";
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
  /**
   * The caller's OWN linked emails, primary first (trial finding #7) — the
   * self view behind doctor's and status's alias count. Self-service read
   * only; linking and unlinking stay on the admin surface
   * (routes/developers.ts).
   */
  readonly emails: readonly DeveloperEmailView[];
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
  return {
    presenceOptOut: own[0]?.presenceOptOut ?? false,
    mutes,
    emails: await listDeveloperEmails(db, developerId),
  };
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

/**
 * A same-named developer as an ambiguity refusal has to name them. The EMAIL
 * is what makes such a refusal actionable: two people called Ken differ only
 * by address, so a refusal listing names alone leaves the caller with no next
 * call to make (services/developer-lookup.ts writes the sentence).
 */
export interface DeveloperCandidate {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export type ResolveDeveloperResult =
  | { readonly outcome: "resolved"; readonly developer: MuteEntryView }
  | { readonly outcome: "not_found" }
  | {
      readonly outcome: "ambiguous";
      /** A PAGE of them — at most AMBIGUITY_PROBE_LIMIT, see below. */
      readonly candidates: readonly DeveloperCandidate[];
      /**
       * How many there really are. Separate from the page on purpose: a
       * refusal may list fewer people than it counts, and the number is the
       * one thing in the sentence that must never be the page size — see
       * `describeAmbiguousDeveloper`.
       */
      readonly totalCount: number;
    };

/**
 * How many same-name rows are read. Two is enough to DETECT ambiguity, which
 * is all the mute surfaces ever needed; the search and question filters have
 * to NAME the candidates, so the probe reads a few more and the refusal lists
 * what it found. Bounded either way — a page of Kens is not a useful sentence.
 *
 * BOUNDING THE PAGE IS NOT BOUNDING THE COUNT, and conflating the two is how
 * a hub with twelve Kims came to say it had five. The page decides how many
 * people a refusal can NAME; `countByName` below decides what it may CLAIM.
 */
const AMBIGUITY_PROBE_LIMIT = 5;

/**
 * How many developers this hub spells that way — all of them, not a page.
 *
 * Runs only on the ambiguity path, which is already a refusal rather than an
 * answer, and only after the page came back with more than one row: the hot
 * case (a reference that resolves) is still the two indexed point lookups and
 * nothing else. One team's worth of rows, over the same predicate the page
 * used, so the two numbers can never be about different sets.
 */
const countByName = async (db: Db, loweredName: string): Promise<number> => {
  const counted = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(developers)
    .where(eq(sql`lower(${developers.name})`, loweredName));
  return counted[0]?.total ?? 0;
};

/**
 * Resolves a CLI-supplied reference to one developer: exact id first, then
 * email — through developer_emails, so an ALIAS resolves the same person its
 * primary does and the table's PK keeps the answer unique (trial finding #7)
 * — then case-insensitive display name, where two matches is an error rather
 * than a guess.
 *
 * MATCHING IS STRICT, and that is the design rather than a limitation: no
 * prefix, no substring, no fuzz. A matcher that picked "Ken Weber" out of
 * "ken" would answer a question nobody asked, and nothing in the result would
 * say it had. Approximate spellings appear only as SUGGESTIONS on the miss
 * path (services/developer-lookup.ts), where being roughly right decides no
 * query.
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
    .from(developerEmails)
    .innerJoin(developers, eq(developers.id, developerEmails.developerId))
    .where(eq(developerEmails.email, trimmed.toLowerCase()))
    .limit(1);
  if (byEmail[0] !== undefined) {
    return { outcome: "resolved", developer: byEmail[0] };
  }
  const byName = await db
    .select({
      id: developers.id,
      name: developers.name,
      email: developers.email,
    })
    .from(developers)
    .where(eq(sql`lower(${developers.name})`, trimmed.toLowerCase()))
    .orderBy(asc(developers.email))
    .limit(AMBIGUITY_PROBE_LIMIT);
  if (byName.length > 1) {
    return {
      outcome: "ambiguous",
      candidates: byName,
      totalCount: await countByName(db, trimmed.toLowerCase()),
    };
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
