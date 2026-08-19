import { and, asc, desc, eq } from "drizzle-orm";

import { generateApiKey, hashApiKey } from "../auth/keys.ts";
import { EVENT_KINDS } from "../constants.ts";
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
