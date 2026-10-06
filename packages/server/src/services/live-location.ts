/**
 * LIVE LOCATION, WITHHELD — the ONE projection every location-bearing row
 * passes through on its way to a viewer (services/visibility.ts states the
 * policy): a session's current branch, its HEAD/base commit, and its
 * heartbeat/last-active instants. Their work contexts, claims and diagnoses
 * stay shared; only these fields go.
 *
 * ONE FUNCTION, ONE FIELD VOCABULARY. The previous shape was a helper per
 * field called by hand at each route, and each review found a route that had
 * not called it. `projectRow` instead walks the row it is handed and treats
 * every field whose NAME is in the vocabulary below, so a serializer that
 * hands its row over cannot forget one field of it, and a field added to an
 * already-projected row is withheld without anybody remembering to.
 * test/live-location-privacy.test.ts walks every route the app registers to
 * catch a serializer that does not hand its row over at all.
 *
 * Withheld per FIELD, not per row, and per VIEWER: the subject's own reads
 * are untouched, and every other viewer reads the same rows with the
 * location fields gone. The hidden set is computed once per request —
 * opted-out developers are few and the query is one indexed scan.
 *
 * A FALLBACK TITLE IS A BRANCH. When the host supplied no title, the
 * connector named the context `<branch> @ <repo>` (@crosscheck/schema
 * isFallbackTitle), so that title is withheld exactly as the branch is and
 * reads as WITHHELD_TITLE on every surface. Done here, on the hub, so a
 * connector too old to know about it cannot print the branch anyway.
 */
import { and, eq, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  LOCATION_WITHHELD,
  WITHHELD_TITLE,
  isFallbackTitle,
} from "@crosscheck/schema";

import { developers } from "../db/schema.ts";
import type { Db } from "../db/client.ts";
import { visiblePresenceCondition } from "./visibility.ts";

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

/** Whose row this is, and what its title is judged against. */
export interface RowOwner {
  readonly developerId: string;
  /**
   * The repo of the owning session — a fallback title ends in its label.
   * Absent on a row that carries no title (a claim's validity); a title on
   * such a row is withheld whole, because nothing says it is not the branch.
   */
  readonly repo?: string;
}

/**
 * How a withheld field is written, chosen by what every SHIPPED reader of
 * that field parses — a value an old connector rejects would fail the whole
 * row, or the whole answer, instead of one field:
 *
 *   omit    the key goes; for fields every reader takes as optional
 *   null    for nullable fields
 *   empty   "" — a reader that takes "" as unknown (hint candidates' base)
 *   marker  LOCATION_WITHHELD, for fields every reader requires as a
 *           non-empty string
 */
export type WithheldForm = "omit" | "null" | "empty" | "marker";

/**
 * THE VOCABULARY, by wire field name, with each field's default form. A
 * route whose wire needs another form for one of them says so at its call
 * (`forms`), never by skipping the projection.
 */
const LOCATION_FIELDS = {
  /** The session's CURRENT branch — re-registering moves it. */
  branch: "omit",
  /** `rev-parse HEAD` of the live branch. */
  baseCommit: "omit",
  /** A claim's commit: `session_base`, or the HEAD it was read at. */
  observedAtCommit: "null",
  /** The newest activity on a context or session: when its author was there. */
  lastActiveAt: "marker",
  /** When the session behind a piece of work started: when its author arrived. */
  workStartedAt: "marker",
  /** A context's last update — its author's last touch, so where she was then. */
  updatedAt: "null",
} as const satisfies Readonly<Record<string, WithheldForm>>;

export type LocationField = keyof typeof LOCATION_FIELDS;

export type WithheldForms = Readonly<Partial<Record<LocationField, WithheldForm>>>;

/** Title fields: withheld only when the title IS the branch. */
const TITLE_FIELDS: ReadonlySet<string> = new Set(["title", "workContextTitle"]);

const isLocationField = (key: string): key is LocationField =>
  Object.hasOwn(LOCATION_FIELDS, key);

const withheldValue = (form: Exclude<WithheldForm, "omit">): string | null => {
  switch (form) {
    case "null":
      return null;
    case "empty":
      return "";
    case "marker":
      return LOCATION_WITHHELD;
  }
};

const projectEntry = (
  owner: RowOwner,
  forms: WithheldForms,
  [key, value]: readonly [string, unknown],
): readonly (readonly [string, unknown])[] => {
  if (value === undefined || value === null) {
    return [[key, value]];
  }
  if (TITLE_FIELDS.has(key)) {
    const isBranch =
      typeof value === "string" &&
      (owner.repo === undefined || isFallbackTitle(value, owner.repo));
    return [[key, isBranch ? WITHHELD_TITLE : value]];
  }
  if (!isLocationField(key)) {
    return [[key, value]];
  }
  const form = forms[key] ?? LOCATION_FIELDS[key];
  return form === "omit" ? [] : [[key, withheldValue(form)]];
};

/**
 * THE SAME RULE IN SQL, for the reads that FILTER or RANK by when a context
 * was last touched. Withholding `updatedAt` from the row is not enough when
 * a `since=` window admits the row because of it, or a freshest-first order
 * puts it first because of it: the answer's membership and order would say
 * what the field no longer does.
 *
 * `updated_at` for an owner whose location the viewer may see; null for a
 * hidden one — so their activity is their `created_at`, which is published
 * with the row anyway.
 */
export const updatedAtSeenBy = (
  viewerDeveloperId: string,
  ownerDeveloperId: AnyPgColumn | SQL,
  updatedAt: AnyPgColumn,
): SQL<Date | null> =>
  // Decoded by the column's own mapper: a raw CASE comes back from the
  // driver as a string, and every reader of a selected field expects a Date.
  sql`(case when ${visiblePresenceCondition(viewerDeveloperId, ownerDeveloperId)} then ${updatedAt} else null end)`
    .mapWith(updatedAt) as SQL<Date | null>;

/** `coalesce(updated_at, created_at)` as this viewer may filter and rank by it. */
export const activitySeenBy = (
  viewerDeveloperId: string,
  ownerDeveloperId: AnyPgColumn | SQL,
  updatedAt: AnyPgColumn,
  createdAt: AnyPgColumn,
): SQL<Date> =>
  sql`coalesce(${updatedAtSeenBy(viewerDeveloperId, ownerDeveloperId, updatedAt)}, ${createdAt})`
    .mapWith(createdAt) as SQL<Date>;

/**
 * `row` as THIS viewer may read it: the same object when its owner's
 * location is not hidden from them, else a copy with every vocabulary field
 * withheld. Never mutates `row`.
 *
 * The caller keeps the row's type: `forms` is how it states that its wire
 * takes a field in a form other than the default, and the choice of form is
 * what keeps the type honest (an omitted field must be optional on the wire).
 */
export const projectRow = <R extends object>(
  hidden: HiddenLocations,
  owner: RowOwner,
  row: R,
  forms: WithheldForms = {},
): R =>
  hidden.has(owner.developerId)
    ? (Object.fromEntries(
        Object.entries(row).flatMap((entry) => projectEntry(owner, forms, entry)),
      ) as R)
    : row;
