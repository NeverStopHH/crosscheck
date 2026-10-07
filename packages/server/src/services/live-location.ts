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

import { agentSessions, developers, workContexts } from "../db/schema.ts";
import type { Db, DbExecutor } from "../db/client.ts";
import { branchesOf } from "./developer-branches.ts";
import { visiblePresenceCondition } from "./visibility.ts";

/**
 * Developers whose live location THIS viewer may not be told, each with
 * every branch their sessions ever reported (a session that re-registered
 * moved its branch, and an unmarked bare-branch title still names the old
 * one; review round 4, L2) — read from developer_branches by developer
 * (services/developer-branches.ts), never by scanning the events table
 * (review round 5, H3).
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
  return branchesOf(db, rows.map((row) => row.id));
};

/**
 * IS THIS CONTEXT'S TITLE KEPT OUT OF THE SEARCH INDEX (review round 4, H4)?
 *
 * The normalized doc is ONE copy every viewer searches, so it cannot be
 * projected per viewer: a colleague who searched a guessed branch was shown
 * her work, the page withholding the title the index had matched. So an
 * opted-out owner's location title — the same title projectRow withholds —
 * stays out of the doc for everyone, herself included: her own search by
 * branch name misses it, which is the cost, and stated. Opting back in
 * rebuilds her docs with the titles (services/developer-settings.ts).
 */
export const isTitleWithheldFromIndex = async (
  db: DbExecutor,
  workContextId: string,
): Promise<boolean> => {
  const rows = await db
    .select({
      title: workContexts.title,
      titleSource: workContexts.titleSource,
      branch: agentSessions.branch,
      repo: agentSessions.repo,
      developerId: agentSessions.developerId,
      optedOut: developers.presenceOptOut,
    })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .innerJoin(developers, eq(agentSessions.developerId, developers.id))
    .where(eq(workContexts.id, workContextId))
    .limit(1);
  const row = rows[0];
  if (row === undefined || !row.optedOut) {
    return false;
  }
  const titleSource = titleSourceOf(row.titleSource);
  // The connector's marker decides on its own (fallback goes, host and
  // person stay): only an unmarked title needs her branches, and the lookup
  // runs inside every record of her ingest (review round 5, H3).
  const branches = titleSource === null ? await branchesOf(db, [row.developerId]) : new Map<string, readonly string[]>();
  return isLocationTitle({
    title: row.title,
    titleSource,
    branch: row.branch,
    branches: branches.get(row.developerId) ?? [],
    repo: row.repo,
  });
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
 *   refCommit,       a claim's revalidation reading is its REPORTER's, not
 *   lastRevalidatedAt  its author's: withheld by the reporter when the
 *                    reading is loaded (services/claim-validity.ts
 *                    loadRevalidations), so a teammate's own reading of her
 *                    claim reaches him whole
 *   value            a target's: what her session worked on, shown as it is
 *                    and never shape-tested (review round 5, L3)
 *
 * A row of no listed kind shows NONE of its instants.
 *
 * PATHS, NOT NAMES (review round 5, L1): an entry is the field's path from
 * the row's root. Matched by name at any depth, a claim's `createdAt` let
 * through a `createdAt` nested in the claim — her session's, say — under the
 * name the claim's own creation goes by. A claim's validity is listed where
 * it sits inside a claim view, and as `claim_validity` where it is a row of
 * its own (the referee's, a solved match's root cause).
 */
const SHOWN_FOR_HIDDEN = {
  claim: ["createdAt", "validity.touchingCommits", "validity.refCommit", "validity.lastRevalidatedAt"],
  claim_validity: ["touchingCommits", "refCommit", "lastRevalidatedAt"],
  work_context: ["createdAt", "solvedAt"],
  edge: ["createdAt"],
  question: ["createdAt", "expiresAt"],
  // What her session worked on (review round 5, L3): a file, a symbol, an
  // error fingerprint — never a shape, however it looks; a release cut named
  // by its date is a date only by spelling. Its `createdAt` is when her
  // session touched it, and stays withheld.
  target: ["value"],
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
 *   an instant   a Date, or text that is ENTIRELY a calendar time — ISO,
 *                the Postgres text form, minute or day precision — and
 *                parses as one; nothing before it or after it
 *   a commit     7 to 64 hex digits, a digits-only epoch, or an epoch-sized
 *   or epoch     number — ONLY in a field whose type is an instant or a
 *                commit (INSTANT_OR_COMMIT_FIELD): elsewhere a bare sha or
 *                number is somebody's words or an id
 *
 * HER WORDS ARE NOT A SHAPE (review round 5, H1). The first version withheld
 * any text that OPENED like a date, and any bare sha: a description, an
 * intent, a question or a claim body that starts with a log line's
 * timestamp, or a claim whose body is the bisected commit, reached her
 * colleagues as LOCATION_WITHHELD. Prose fields are never shape-tested;
 * location by NAME (LOCATION_BY_NAME) still applies to them.
 */
const WHOLE_CALENDAR_TIME =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;
const HEX_OR_DIGITS = /^[0-9a-f]{7,64}$/i;
/** 2001-09-09 in epoch seconds: no count or score on a row gets this large. */
const EPOCH_SIZED = 1_000_000_000;
/** The wire's names for instant and commit fields: `…At`, `…Ms`, `…Commit(s)`, `sha`, `head`. */
const INSTANT_OR_COMMIT_FIELD = /(?:At|Ms|Commit|Commits|Sha)$|^(?:sha|head)$/;
/** Words a person or an agent wrote: never withheld for their shape. */
const PROSE_FIELDS: ReadonlySet<string> = new Set([
  "body",
  "description",
  "summary",
  "reason",
  "note",
  "surface",
  "check",
  "question",
  "text",
]);

/**
 * REFERENCES, never shapes (review round 5, H2): a claim's evidence names
 * other claims, CI runs or commits it rests on, and its affected paths name
 * files — an evidence ref that looks like a commit IS one, of published
 * history. Dropping one made the connector read her solved tree as open
 * (mcp/render.ts solvedAtFromTree counts evidence refs) while the hub said
 * solved.
 */
const REFERENCE_FIELDS: ReadonlySet<string> = new Set(["evidenceRefs", "affectedPaths"]);

/** Postgres text `2026-07-24 10:12:07+00` and a zone-less time, as Date.parse reads ISO. */
const asIsoText = (text: string): string => {
  const iso = text.replace(" ", "T");
  // A date alone has no zone to read: its dashes are not an offset.
  if (!iso.includes("T") || /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso)) {
    return iso;
  }
  return /[+-]\d{2}$/.test(iso) ? `${iso}:00` : `${iso}Z`;
};

const isWholeInstant = (value: unknown): boolean =>
  value instanceof Date ||
  (typeof value === "string" && WHOLE_CALENDAR_TIME.test(value) && !Number.isNaN(Date.parse(asIsoText(value))));

const isBareHexOrEpoch = (value: unknown): boolean =>
  (typeof value === "string" && HEX_OR_DIGITS.test(value)) ||
  (typeof value === "number" && Math.abs(value) >= EPOCH_SIZED);

/** Is `value`, held in field `key`, an instant or a commit by its shape? */
export const isWithheldShape = (key: string, value: unknown): boolean =>
  !PROSE_FIELDS.has(key) &&
  !REFERENCE_FIELDS.has(key) &&
  (isWholeInstant(value) || (INSTANT_OR_COMMIT_FIELD.test(key) && isBareHexOrEpoch(value)));

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
  /** Where in the row this part sits: "" at the root, `validity` inside it. */
  readonly path: string;
}

const pathOf = (p: Projection, key: string): string => (p.path === "" ? key : `${p.path}.${key}`);

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !(value instanceof Date) && !Array.isArray(value);

const projectObject = (p: Projection, row: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(row).flatMap((entry) => projectEntry(p, entry)));

/**
 * A list's withheld members are dropped: no list on the wire is positional.
 * Each member is judged by the LIST's field (`key`): a list of commits is a
 * commit field, a list of words is not.
 */
const projectList = (p: Projection, key: string, list: readonly unknown[]): readonly unknown[] =>
  list.flatMap((item) => {
    if (isWithheldShape(key, item)) {
      return [];
    }
    if (Array.isArray(item)) {
      return [projectList(p, key, item)];
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
  const path = pathOf(p, key);
  if (value === undefined || value === null || p.shown.has(path)) {
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
  if (LOCATION_BY_NAME.has(key) || isWithheldShape(key, value)) {
    const form = formOf(p.forms, key, value);
    return form === "omit" ? [] : [[key, withheldValue(form)]];
  }
  if (Array.isArray(value)) {
    return [[key, projectList({ ...p, path }, key, value)]];
  }
  return [[key, isPlainObject(value) ? projectObject({ ...p, path }, value) : value]];
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
  return projectObject({ owner, forms, reportedBranches, shown, path: "" }, row) as R;
};
