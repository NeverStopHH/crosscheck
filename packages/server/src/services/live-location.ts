/**
 * LIVE LOCATION, WITHHELD — the ONE projection every location-bearing row
 * passes through on its way to a viewer (services/visibility.ts states the
 * policy): a session's current branch, its HEAD/base commit, and its
 * heartbeat/last-active instants. Their work contexts, claims and diagnoses
 * stay shared; only these fields go.
 *
 * ONE FUNCTION, WITHHOLDING BY DEFAULT. The first shape was a helper per
 * field called by hand at each route, and each review found a route that had
 * not called it; the second named the fields to withhold, and each review
 * found a field nobody had named. `projectRow` now walks the row it is
 * handed, nested rows and lists included, and withholds every value that is
 * an instant or a commit unless the row's KIND lists that field as the time
 * the shared work itself carries (SHOWN_FOR_HIDDEN) — so a field added to an
 * already-projected row is withheld without anybody remembering to.
 * test/live-location-privacy.test.ts walks every route the app registers to
 * catch a serializer that does not hand its row over at all, and
 * test/live-location-projection.test.ts pins the rule itself.
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
  WorkContextTitleSourceSchema,
  isLocationTitle,
} from "@crosscheck/schema";
import type { TitleFacts, WorkContextTitleSource } from "@crosscheck/schema";

import { developers } from "../db/schema.ts";
import type { Db } from "../db/client.ts";
import { visiblePresenceCondition } from "./visibility.ts";

/**
 * Developers whose live location THIS viewer may not be told, each with
 * every branch their sessions ever reported — the current branch of every
 * session, and the branch each `session_started` row recorded (a session
 * that re-registered moved its branch, and an unmarked bare-branch title
 * still names the old one; review round 4, L2).
 */
export type HiddenLocations = ReadonlyMap<string, readonly string[]>;

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
  if (rows.length === 0) {
    return new Map();
  }
  const ids = rows.map((row) => row.id);
  const branches = await db.execute<{ developer_id: string; branch: string }>(sql`
    SELECT developer_id, branch FROM agent_sessions WHERE developer_id IN ${ids}
    UNION
    SELECT payload->>'developerId', payload->>'branch' FROM events
     WHERE kind = 'session_started' AND payload->>'developerId' IN ${ids}
       AND payload->>'branch' IS NOT NULL`);
  return new Map(
    ids.map((id) => [id, branches.rows.filter((row) => row.developer_id === id).map((row) => row.branch)]),
  );
};

/**
 * THE ALLOWLIST: the instants a hidden owner's row may still carry, by the
 * KIND of row, because one name means different things on different rows —
 * a claim's `createdAt` is when the finding was written, a target's is when
 * her session touched the file. Each entry is the time her shared work itself
 * carries, which services/visibility.ts accepts in words:
 *
 *   createdAt        when the claim, context, edge or question was created
 *   solvedAt         the newest createdAt of the claims that solved a
 *                    context (services/solved.ts) — the same time, derived
 *   expiresAt        a question's createdAt plus its fixed term
 *   touchingCommits  default-branch commits that touched a claim's files:
 *                    published history, not her branch (visibility.ts)
 *
 * A row of no listed kind shows NONE of its instants.
 */
const SHOWN_FOR_HIDDEN = {
  claim: ["createdAt", "touchingCommits"],
  work_context: ["createdAt", "solvedAt"],
  edge: ["createdAt"],
  question: ["createdAt", "expiresAt"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type SharedRowKind = keyof typeof SHOWN_FOR_HIDDEN;

/** Whose row this is, and what its title is judged against. */
export interface RowOwner {
  readonly developerId: string;
  /**
   * What the row's work-context title is judged against (@crosscheck/schema
   * isLocationTitle): the connector's own marker, and for an unmarked row
   * the owning session's repo and branch. Absent on a row that carries no
   * title (a claim's validity); a title on such a row is withheld whole,
   * because nothing says it is not the branch.
   */
  readonly titleFacts?: Omit<TitleFacts, "title">;
  /** Which allowlist above the row's instants are judged by; none when absent. */
  readonly kind?: SharedRowKind;
}

/**
 * A `title_source` read by raw SQL, as the marker it is or null. A value
 * this build does not know is no marker at all, so the title is judged by
 * its shape — never trusted as `host`.
 */
export const titleSourceOf = (raw: unknown): WorkContextTitleSource | null => {
  const parsed = WorkContextTitleSourceSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

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
 * WITHHELD BY DEFAULT (review round 4). For a hidden owner, every field whose
 * VALUE is an instant or looks like a commit goes — whatever it is called,
 * at any depth of the row — unless the row's kind lists it (SHOWN_FOR_HIDDEN).
 * The earlier shape named the fields to withhold, and each review found one
 * nobody had named (a re-observation's `lastSeenAt`, a matched target's
 * `createdAt`, a pin's `verifiedAt`). A field added later is withheld before
 * anybody remembers it.
 *
 *   an instant   a Date; text that opens with a calendar date (ISO, the
 *                Postgres text form, minute precision); a number of epoch
 *                size, in seconds or milliseconds
 *   a commit     7 to 64 hex digits and nothing else — every abbreviation
 *                git prints, and a digits-only epoch spelled as text
 */
const INSTANT_TEXT = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}|$)/;
const COMMIT_LIKE = /^[0-9a-f]{7,64}$/i;
/** 2001-09-09 in epoch seconds: no count or score on a row gets this large. */
const EPOCH_SIZED = 1_000_000_000;

export const isInstantOrCommit = (value: unknown): boolean =>
  value instanceof Date ||
  (typeof value === "number" && Math.abs(value) >= EPOCH_SIZED) ||
  (typeof value === "string" && (INSTANT_TEXT.test(value) || COMMIT_LIKE.test(value)));

/**
 * THE FORMS, by wire field name: HOW a withheld field is written, never
 * WHETHER — that is the value's business above, or the name's for the two
 * location fields no value test can recognise (`branch`, and `baseCommit`
 * read as "" where it is unknown). A route whose wire needs another form
 * says so at its call (`forms`), never by skipping the projection. A field
 * named nowhere takes the marker when it is text (every shipped reader of a
 * text field accepts a non-empty string) and null when it is still a Date.
 */
const FIELD_FORMS = {
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
  /** When she re-observed a claim (a dedup bump). */
  lastSeenAt: "null",
  /**
   * A revalidation's instant — the marker, not null: null reads "never
   * re-checked" beside a state the reading decided — and the ref it was read
   * at, which every reader takes as a nullable sha.
   */
  lastRevalidatedAt: "marker",
  refCommit: "null",
  /** An evidence rung's age, and the commit it was verified at: null is "unknown". */
  observedAt: "null",
  verifiedAtCommit: "null",
  /** A session's last heartbeat — every reader requires a non-empty string. */
  lastHeartbeatAt: "marker",
  /** When she declared an intent: optional on every reader. */
  capturedAt: "omit",
} as const satisfies Readonly<Record<string, WithheldForm>>;

/** Fields withheld by NAME — values no test above can tell from any other. */
const LOCATION_BY_NAME: ReadonlySet<string> = new Set(["branch", "baseCommit", "observedAtCommit", "refCommit"]);

/**
 * COUNTS OF HER ACTIVITY, read as the count a row has before any: how often
 * she re-observed a claim says how often she was there.
 */
const ACTIVITY_COUNTERS: Readonly<Record<string, number>> = { dedupCount: 1 };

/**
 * Shown TO THE DAY. Her work landing is shared — the stop and the page say
 * it — but the stamp is the instant HER session reported it
 * (services/landed.ts), so the hour goes.
 */
const DAY_PRECISION: ReadonlySet<string> = new Set(["landedAt"]);

export type WithheldForms = Readonly<Record<string, WithheldForm>>;

/** Title fields: withheld only when the title IS the branch. */
const TITLE_FIELDS: ReadonlySet<string> = new Set(["title", "workContextTitle"]);

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

const formOf = (forms: WithheldForms, key: string, value: unknown): WithheldForm =>
  forms[key] ??
  (Object.hasOwn(FIELD_FORMS, key) ? FIELD_FORMS[key as keyof typeof FIELD_FORMS] : undefined) ??
  (value instanceof Date ? "null" : "marker");

/** Midnight UTC of the same day, in the type it came in; null when unreadable. */
const toDay = (value: unknown): Date | string | null => {
  const ms = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) {
    return null;
  }
  const day = new Date(ms);
  const midnight = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  return value instanceof Date ? midnight : midnight.toISOString();
};

/** One projection's fixed inputs, carried down the row. */
interface Projection {
  readonly owner: RowOwner;
  readonly forms: WithheldForms;
  readonly reportedBranches: readonly string[];
  readonly shown: ReadonlySet<string>;
}

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !(value instanceof Date) && !Array.isArray(value);

const projectObject = (p: Projection, row: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(row).flatMap((entry) => projectEntry(p, entry)));

/** A list's withheld members are dropped: no list on the wire is positional. */
const projectList = (p: Projection, list: readonly unknown[]): readonly unknown[] =>
  list.flatMap((item) => {
    if (isInstantOrCommit(item)) {
      return [];
    }
    if (Array.isArray(item)) {
      return [projectList(p, item)];
    }
    return [isPlainObject(item) ? projectObject(p, item) : item];
  });

const projectTitle = (p: Projection, value: unknown): unknown => {
  const isBranch =
    typeof value === "string" &&
    (p.owner.titleFacts === undefined ||
      isLocationTitle({ title: value, ...p.owner.titleFacts, branches: p.reportedBranches }));
  return isBranch ? WITHHELD_TITLE : value;
};

const projectEntry = (
  p: Projection,
  [key, value]: readonly [string, unknown],
): readonly (readonly [string, unknown])[] => {
  if (value === undefined || value === null || p.shown.has(key)) {
    return [[key, value]];
  }
  if (TITLE_FIELDS.has(key)) {
    return [[key, projectTitle(p, value)]];
  }
  const counter = ACTIVITY_COUNTERS[key];
  if (counter !== undefined) {
    return [[key, counter]];
  }
  if (DAY_PRECISION.has(key)) {
    return [[key, toDay(value)]];
  }
  if (LOCATION_BY_NAME.has(key) || isInstantOrCommit(value)) {
    const form = formOf(p.forms, key, value);
    return form === "omit" ? [] : [[key, withheldValue(form)]];
  }
  if (Array.isArray(value)) {
    return [[key, projectList(p, value)]];
  }
  return [[key, isPlainObject(value) ? projectObject(p, value) : value]];
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
 * location is not hidden from them, else a copy with every location field
 * and every instant or commit its kind does not list withheld, nested
 * objects and lists included. Never mutates `row`.
 *
 * ONE OWNER PER CALL. A row that carries somebody else's rows — a context's
 * claims, a candidate's matched targets — is projected in parts by the
 * caller, each part by its own owner; handed over whole, the nested rows
 * would be judged by the outer owner.
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
): R => {
  const reportedBranches = hidden.get(owner.developerId);
  if (reportedBranches === undefined) {
    return row;
  }
  const shown: ReadonlySet<string> = new Set(owner.kind === undefined ? [] : SHOWN_FOR_HIDDEN[owner.kind]);
  return projectObject({ owner, forms, reportedBranches, shown }, row) as R;
};
