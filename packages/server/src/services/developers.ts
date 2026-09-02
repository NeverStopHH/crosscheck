import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { generateApiKey, hashApiKey } from "../auth/keys.ts";
import { DEVELOPERS_MAX_LISTED, EVENT_KINDS } from "../constants.ts";
import { developerEmails, developers } from "../db/schema.ts";
import { appendEvent } from "./events.ts";
import { normalizeEmail } from "./commit-evidence.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

const DEVELOPER_ID_PREFIX = "dev_";

/**
 * Upper bound on one developer's linked emails (primary + aliases) — keeps
 * the settings read and the admin list bounded by a constant, the
 * MAX_MUTES_PER_READER discipline. Far above what "work address plus one or
 * two personal git identities" needs.
 */
export const MAX_EMAILS_PER_DEVELOPER = 10;

/** Thrown inside the create transaction to unwind the developer row. */
const EMAIL_TAKEN = Symbol("crosscheck.developers.email-taken");

export interface DeveloperView {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface DeveloperEmailView {
  readonly email: string;
  readonly isPrimary: boolean;
}

export interface CreateDeveloperInput {
  readonly name: string;
  readonly email: string;
}

export type CreateDeveloperResult =
  | {
      readonly outcome: "created";
      readonly developer: DeveloperView;
      readonly apiKey: string;
    }
  | { readonly outcome: "email_taken" };

export const createDeveloper = async (
  deps: { readonly db: Db; readonly now: Clock },
  input: CreateDeveloperInput,
): Promise<CreateDeveloperResult> => {
  const apiKey = generateApiKey();
  const id = `${DEVELOPER_ID_PREFIX}${crypto.randomUUID()}`;
  // Stored lowercased: the absence check joins case-insensitively on the
  // email rows (services/absences.ts), and the UNIQUE guards must agree with
  // that join — two case-variant accounts would each match the same commit
  // author and yield duplicate findings for one person.
  const email = normalizeEmail(input.email);
  try {
    // One transaction: the developer row and its primary email row land
    // together or not at all. developer_emails' PK on email is the "at most
    // one developer per email" invariant, and it covers a primary colliding
    // with another developer's ALIAS — which developers.email UNIQUE alone
    // never could — so a refused email unwinds the developer insert too.
    await deps.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(developers)
        .values({
          id,
          name: input.name,
          email,
          apiKeyHash: hashApiKey(apiKey),
          createdAt: deps.now(),
        })
        .onConflictDoNothing()
        .returning({ id: developers.id });
      if (inserted[0] === undefined) {
        throw EMAIL_TAKEN;
      }
      const emailRow = await tx
        .insert(developerEmails)
        .values({
          email,
          developerId: id,
          isPrimary: true,
          createdAt: deps.now(),
        })
        .onConflictDoNothing()
        .returning({ email: developerEmails.email });
      if (emailRow[0] === undefined) {
        throw EMAIL_TAKEN;
      }
      await appendEvent(
        { db: tx, now: deps.now },
        EVENT_KINDS.DEVELOPER_CREATED,
        { developerId: id },
      );
    });
  } catch (error) {
    if (error === EMAIL_TAKEN) {
      return { outcome: "email_taken" };
    }
    throw error;
  }

  return {
    outcome: "created",
    developer: { id, name: input.name, email },
    apiKey,
  };
};

/** Primary first, then aliases oldest-first — the order every surface shows. */
export const listDeveloperEmails = async (
  db: Db,
  developerId: string,
): Promise<readonly DeveloperEmailView[]> => {
  const rows = await db
    .select({
      email: developerEmails.email,
      isPrimary: developerEmails.isPrimary,
    })
    .from(developerEmails)
    .where(eq(developerEmails.developerId, developerId))
    .orderBy(
      desc(developerEmails.isPrimary),
      asc(developerEmails.createdAt),
      asc(developerEmails.email),
    )
    .limit(MAX_EMAILS_PER_DEVELOPER);
  return rows;
};

export interface ListedDeveloperView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly emails: readonly DeveloperEmailView[];
}

export interface DeveloperListing {
  readonly developers: readonly ListedDeveloperView[];
  /** True when the hub holds more developers than this page could carry. */
  readonly truncated: boolean;
}

export interface DeveloperPageRow {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
}

/**
 * The bounded read, on its own and exported, because the bound is the whole
 * safety property here and NOTHING OUTSIDE THIS FUNCTION CAN SEE IT.
 * `listDevelopers` slices the page to the cap in memory, so widening or
 * dropping the LIMIT changes which rows the process materialises and not one
 * field of the answer: the same 200 developers come back, with the same
 * `truncated`, to a caller who has no way to ask how many rows were read.
 * That is why "cost is bounded by DEVELOPERS_MAX_LISTED rather than by team
 * size" could only ever be checked at this seam — and it is worth checking,
 * because the hub is a single-connection in-process PGlite where one
 * unbounded materialisation stalls every other request behind it.
 *
 * Exactly ONE row past the cap, never more: that extra row is the whole
 * evidence that the page was cut, and it is all the caller needs to say so.
 */
export const readDeveloperPage = async (
  db: Db,
): Promise<readonly DeveloperPageRow[]> =>
  db
    .select({
      id: developers.id,
      name: developers.name,
      createdAt: developers.createdAt,
    })
    .from(developers)
    .orderBy(asc(developers.createdAt), asc(developers.id))
    .limit(DEVELOPERS_MAX_LISTED + 1);

/**
 * The admin's way back to an id. `createDeveloper` hands one out exactly once
 * and every other admin route takes it as a path parameter, so without this a
 * lost id meant a developer whose git aliases could never be linked again —
 * and absence matching then keeps attributing their commits to nobody.
 *
 * Two queries, never one per developer: the second reads every email of the
 * page at once, so cost is bounded by DEVELOPERS_MAX_LISTED rather than by
 * team size. The api key hash is not selected here and must never be — the key
 * is shown once, at creation, and this listing is not a second chance at it.
 */
export const listDevelopers = async (db: Db): Promise<DeveloperListing> => {
  const rows = await readDeveloperPage(db);

  const truncated = rows.length > DEVELOPERS_MAX_LISTED;
  const page = truncated ? rows.slice(0, DEVELOPERS_MAX_LISTED) : rows;
  if (page.length === 0) {
    return { developers: [], truncated: false };
  }

  const emailRows = await db
    .select({
      developerId: developerEmails.developerId,
      email: developerEmails.email,
      isPrimary: developerEmails.isPrimary,
    })
    .from(developerEmails)
    .where(
      inArray(
        developerEmails.developerId,
        page.map((row) => row.id),
      ),
    )
    .orderBy(
      desc(developerEmails.isPrimary),
      asc(developerEmails.createdAt),
      asc(developerEmails.email),
    )
    .limit(DEVELOPERS_MAX_LISTED * MAX_EMAILS_PER_DEVELOPER);

  const byDeveloper = new Map<string, DeveloperEmailView[]>();
  for (const row of emailRows) {
    const existing = byDeveloper.get(row.developerId);
    const view = { email: row.email, isPrimary: row.isPrimary };
    if (existing === undefined) {
      byDeveloper.set(row.developerId, [view]);
    } else if (existing.length < MAX_EMAILS_PER_DEVELOPER) {
      existing.push(view);
    }
  }

  return {
    developers: page.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      emails: byDeveloper.get(row.id) ?? [],
    })),
    truncated,
  };
};

const developerExists = async (db: Db, developerId: string): Promise<boolean> => {
  const rows = await db
    .select({ id: developers.id })
    .from(developers)
    .where(eq(developers.id, developerId))
    .limit(1);
  return rows[0] !== undefined;
};

export type AddDeveloperEmailResult =
  | {
      readonly outcome: "added";
      readonly alreadyLinked: boolean;
      readonly emails: readonly DeveloperEmailView[];
    }
  | { readonly outcome: "developer_not_found" }
  | { readonly outcome: "taken_by_other" }
  | { readonly outcome: "limit_reached" };

/**
 * Links one more email to a developer (admin surface, trial finding #7).
 * Case-normalized; idempotent for an email the developer already has; a 409
 * for one ANY other developer has — the caller must hear about a
 * cross-developer duplicate, because silently skipping it would leave absence
 * matching attributing commits to the wrong person. No outbox event: emails
 * never leave the hub (services/absences.ts), and an event payload is the
 * feed — the developer_created event carries ids only for the same reason.
 */
export const addDeveloperEmail = async (
  deps: { readonly db: Db; readonly now: Clock },
  developerId: string,
  rawEmail: string,
): Promise<AddDeveloperEmailResult> => {
  if (!(await developerExists(deps.db, developerId))) {
    return { outcome: "developer_not_found" };
  }
  const email = normalizeEmail(rawEmail);
  const existing = await listDeveloperEmails(deps.db, developerId);
  if (existing.some((row) => row.email === email)) {
    return { outcome: "added", alreadyLinked: true, emails: existing };
  }
  if (existing.length >= MAX_EMAILS_PER_DEVELOPER) {
    return { outcome: "limit_reached" };
  }
  const inserted = await deps.db
    .insert(developerEmails)
    .values({ email, developerId, isPrimary: false, createdAt: deps.now() })
    .onConflictDoNothing()
    .returning({ email: developerEmails.email });
  if (inserted[0] === undefined) {
    // The PK refused it and it is not ours (checked above): someone else's.
    return { outcome: "taken_by_other" };
  }
  return {
    outcome: "added",
    alreadyLinked: false,
    emails: await listDeveloperEmails(deps.db, developerId),
  };
};

export type RemoveDeveloperEmailResult =
  | {
      readonly outcome: "removed";
      readonly emails: readonly DeveloperEmailView[];
    }
  | { readonly outcome: "developer_not_found" }
  | { readonly outcome: "not_linked" }
  | { readonly outcome: "is_primary" };

/**
 * Unlinks an alias. Scoped to THIS developer's rows — an email held by a
 * different developer answers "not_linked" rather than deleting across
 * accounts. The primary is the account's identity — auth surfaces and
 * `developers.email` carry it — so removing it is refused rather than
 * silently re-pointing the account.
 */
export const removeDeveloperEmail = async (
  db: Db,
  developerId: string,
  rawEmail: string,
): Promise<RemoveDeveloperEmailResult> => {
  if (!(await developerExists(db, developerId))) {
    return { outcome: "developer_not_found" };
  }
  const email = normalizeEmail(rawEmail);
  const ownRow = and(
    eq(developerEmails.email, email),
    eq(developerEmails.developerId, developerId),
  );
  const rows = await db
    .select({ isPrimary: developerEmails.isPrimary })
    .from(developerEmails)
    .where(ownRow)
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return { outcome: "not_linked" };
  }
  if (row.isPrimary) {
    return { outcome: "is_primary" };
  }
  await db.delete(developerEmails).where(ownRow);
  return {
    outcome: "removed",
    emails: await listDeveloperEmails(db, developerId),
  };
};
