/**
 * THE DRAFT STORE (human provenance §4).
 *
 * Every write a key may make about something only a person may decide lands
 * HERE, never in the record that counts: a label, `pin --ok`, an outcome, a
 * pin, its retraction, a mute, an unmute, presence back on. A draft has no
 * effect and no human standing. A passkey confirmation of a frozen batch
 * (services/confirmation-batch.ts) is the only way one becomes a person's.
 *
 * APPEND-ONLY, BY SUBJECT. A subject is what one decision is about — one
 * pointer's outcome, one pin, one teammate's mute. A newer draft on it is its
 * next VERSION and supersedes the older as the pending item; nothing is ever
 * updated.
 *
 * A REPEAT WRITES NOTHING — and is a repeat only while the subject's newest
 * version still WAITS, saying the same thing in the same class: an agent
 * re-reading a hint never refills the person's page. Once a version was
 * DECIDED, saying it again is a new draft (review H2, H3): the person says
 * noise again (07 §13.11 H-B), repeats their word after their own label, says
 * a word they discarded when the agent said it, asks again for a mute or for
 * presence they once confirmed or discarded. The one exception: the agent's
 * door re-offering an outcome the person discarded when the agent said it is
 * not put back on the page, and the answer says why.
 *
 * PENDING = its subject's newest version, resolved by no confirmed batch
 * (decision `confirm` or `discard`; `keep` leaves it pending).
 */
import { createHash, randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type { DraftKind, DraftProvenance } from "@crosscheck/schema";

import { MAX_PENDING_DRAFT_SUBJECTS } from "../constants.ts";
import { humanDrafts } from "../db/schema.ts";
import { staysPending } from "./draft-kinds.ts";
import { confirmationInEffect } from "./human-provenance.ts";
import type { Db, DbExecutor } from "../db/client.ts";
import type { Clock } from "../types.ts";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

export type DraftPayload = Readonly<Record<string, unknown>>;

export interface WriteDraftInput {
  readonly developerId: string;
  readonly repo: string | null;
  readonly kind: DraftKind;
  readonly subjectKey: string;
  readonly payload: DraftPayload;
  readonly provenance: DraftProvenance;
}

export type WriteDraftResult =
  | {
      readonly id: string;
      readonly version: number;
      readonly repeated: boolean;
      /** Whether this draft waits on the person's page now — never a "drafted" answer without one. */
      readonly waiting: boolean;
      /** A repeat of the agent's own word the person discarded: not offered again. */
      readonly discardedByPerson: boolean;
    }
  | { readonly refusal: "too_many_drafts" };

export interface DraftRow {
  readonly id: string;
  readonly developerId: string;
  readonly repo: string | null;
  readonly kind: DraftKind;
  readonly subjectKey: string;
  readonly version: number;
  readonly payload: DraftPayload;
  readonly provenance: DraftProvenance;
  readonly createdAt: Date;
}

/** JSON with every object's keys sorted, so equal content always digests alike. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
};

export const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * WHAT A DRAFT SAYS, for "is this a repeat": a word and its reason for a label
 * or an outcome — the delivery a twin carries is the same pointer (07 §13.11,
 * M4) — and the whole payload for everything else, with the kind, so a mute
 * and an unmute of one teammate are different words on one subject.
 */
const sayingOf = (kind: DraftKind, payload: DraftPayload): string =>
  kind === "label" || kind === "outcome"
    ? canonicalJson([kind, payload["word"] ?? null, payload["reason"] ?? null])
    : canonicalJson([kind, payload]);

/** One draft as the batch digest covers it: everything that could make it say something else. */
export const draftDigest = (draft: DraftRow): string =>
  sha256Hex(
    canonicalJson([draft.id, draft.kind, draft.subjectKey, draft.version, draft.provenance, draft.payload]),
  );

/** The pending set as a person reviewed it: which drafts, at which versions, saying what. */
export const pendingFingerprint = (drafts: readonly DraftRow[]): string =>
  sha256Hex(
    canonicalJson(
      [...drafts]
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        .map((draft) => [draft.id, draft.version, draftDigest(draft)]),
    ),
  );

type RawDraft = {
  readonly id: string;
  readonly developer_id: string;
  readonly repo: string | null;
  readonly kind: DraftKind;
  readonly subject_key: string;
  readonly version: number;
  readonly payload: DraftPayload;
  readonly provenance: DraftProvenance;
  readonly created_at: string | Date;
  readonly resolved: boolean;
};

const rowOf = (raw: RawDraft): DraftRow => ({
  id: raw.id,
  developerId: raw.developer_id,
  repo: raw.repo,
  kind: raw.kind,
  subjectKey: raw.subject_key,
  version: Number(raw.version),
  payload: raw.payload,
  provenance: raw.provenance,
  createdAt: new Date(raw.created_at),
});

/**
 * Resolved: some CONFIRMED batch decided it (a batch exists only once its
 * passkey verified) and that confirmation is still in effect. A void one — its
 * passkey revoked in the cool-off, or declared compromised — decided nothing:
 * its drafts return to the person's page (round-2 R2-H3).
 */
const RESOLVED = sql`EXISTS (
  SELECT 1 FROM human_confirmation_items i
  WHERE i.draft_id = d.id AND i.decision IN ('confirm', 'discard') AND ${confirmationInEffect("i.confirmation_id")})`;

export interface PendingOptions {
  /** Take the person's drafts FOR UPDATE: the confirmation compares under it. */
  readonly lock?: boolean;
  /** Only these kinds — the ones a page shows. Absent: every kind. */
  readonly scope?: readonly DraftKind[];
}

/**
 * THE PERSON'S PENDING DRAFTS, oldest first: each subject's newest version,
 * undecided, and still LIVE by its kind's registry entry (services/
 * draft-kinds.ts) — a break of a pin already broken is no decision anybody can
 * make, so it leaves the list on its own. `scope` keeps a page's own kinds.
 */
export const readPendingDrafts = async (
  deps: { readonly db: DbExecutor; readonly now: Clock },
  developerId: string,
  options: PendingOptions = {},
): Promise<readonly DraftRow[]> => {
  const rows = await readPendingRows(deps.db, developerId, options);
  const scoped = options.scope === undefined ? rows : rows.filter((draft) => options.scope?.includes(draft.kind));
  const kept: DraftRow[] = [];
  for (const draft of scoped) {
    if (await staysPending(deps, draft)) {
      kept.push(draft);
    }
  }
  return kept;
};

/** The undecided newest versions, liveness unread: what the bound on pending subjects counts first. */
const readPendingRows = async (
  db: DbExecutor,
  developerId: string,
  options: { readonly lock?: boolean } = {},
): Promise<readonly DraftRow[]> => {
  if (options.lock === true) {
    await db.execute(sql`SELECT d.id FROM human_drafts d WHERE d.developer_id = ${developerId} ORDER BY d.id FOR UPDATE`);
  }
  const rows = await db.execute<RawDraft>(sql`
    SELECT d.*, false AS resolved FROM human_drafts d
    WHERE d.developer_id = ${developerId}
      AND d.version = (SELECT max(v.version) FROM human_drafts v
                       WHERE v.developer_id = d.developer_id AND v.subject_key = d.subject_key)
      AND NOT ${RESOLVED}
    ORDER BY d.created_at, d.id`);
  return rows.rows.map(rowOf);
};

type DecidedAs = "confirm" | "discard";

interface Newest {
  readonly draft: DraftRow;
  /** What a confirmed batch decided about it; null while it waits. */
  readonly decision: DecidedAs | null;
}

/** The newest version of one subject, and what a confirmed batch decided about it, if anything. */
const readNewest = async (db: DbExecutor, developerId: string, subjectKey: string): Promise<Newest | undefined> => {
  const rows = await db.execute<RawDraft & { readonly decision: DecidedAs | null }>(sql`
    SELECT d.*, false AS resolved,
      (SELECT i.decision FROM human_confirmation_items i
       WHERE i.draft_id = d.id AND i.decision IN ('confirm', 'discard')
         AND ${confirmationInEffect("i.confirmation_id")} LIMIT 1) AS decision
    FROM human_drafts d
    WHERE d.developer_id = ${developerId} AND d.subject_key = ${subjectKey}
    ORDER BY d.version DESC LIMIT 1 FOR UPDATE`);
  const raw = rows.rows[0];
  return raw === undefined ? undefined : { draft: rowOf(raw), decision: raw.decision ?? null };
};

/**
 * WHETHER A DRAFT REPEATS ITS SUBJECT'S NEWEST VERSION (see the header). The
 * same saying in the same class while that version waits; or the agent's door
 * saying again an outcome of its own the person discarded. Never a word
 * against a decided version otherwise — that would eat the person's word.
 */
const repeatOf = (newest: Newest | undefined, input: WriteDraftInput): "waiting" | "discarded" | null => {
  if (newest === undefined || sayingOf(newest.draft.kind, newest.draft.payload) !== sayingOf(input.kind, input.payload)) {
    return null;
  }
  if (newest.decision === null) {
    return newest.draft.provenance === input.provenance ? "waiting" : null;
  }
  const isAgentReoffer =
    newest.decision === "discard" &&
    input.kind === "outcome" &&
    input.provenance === "agent_asserted" &&
    newest.draft.provenance === "agent_asserted";
  return isAgentReoffer ? "discarded" : null;
};

/**
 * Whether the person's page is full. The raw count first, which is all a write
 * pays while there is room; only at the bound are the dead drafts left out, so
 * drafts that died on their own never hold the page shut.
 */
const isPageFull = async (deps: { readonly db: DbExecutor; readonly now: Clock }, developerId: string): Promise<boolean> =>
  (await readPendingRows(deps.db, developerId)).length >= MAX_PENDING_DRAFT_SUBJECTS &&
  (await readPendingDrafts(deps, developerId)).length >= MAX_PENDING_DRAFT_SUBJECTS;

/**
 * THE SUPERSEDED VERSIONS NOTHING SIGNED GO (review M8, probe P12). A newer
 * version replaces them on the page, and no confirmed batch named them, so no
 * record or item points at them: they are dropped, and one subject holds only
 * its newest version plus those a passkey ceremony named (confirmed,
 * discarded or kept for later) — each one a tap of the person's. A batch formed
 * over a dropped version is refused at signing like any stale page.
 */
const pruneSuperseded = async (db: DbExecutor, developerId: string, subjectKey: string, newestVersion: number): Promise<void> => {
  await db.execute(sql`
    DELETE FROM human_drafts d
    WHERE d.developer_id = ${developerId} AND d.subject_key = ${subjectKey} AND d.version < ${newestVersion}
      AND NOT EXISTS (SELECT 1 FROM human_confirmation_items i WHERE i.draft_id = d.id)`);
};

/**
 * ONE DRAFT. A repeat (repeatOf) writes nothing; a new subject past
 * MAX_PENDING_DRAFT_SUBJECTS is refused; a newer version of a subject that is
 * still pending is always taken (it replaces nothing a person decided — they
 * decided nothing about it yet), and the versions it supersedes that nothing
 * signed are dropped (pruneSuperseded).
 */
export const writeDraft = (deps: Deps, input: WriteDraftInput): Promise<WriteDraftResult> =>
  deps.db.transaction(async (tx) => {
    const newest = await readNewest(tx, input.developerId, input.subjectKey);
    const repeat = repeatOf(newest, input);
    if (newest !== undefined && repeat !== null) {
      return {
        id: newest.draft.id,
        version: newest.draft.version,
        repeated: true,
        waiting: repeat === "waiting",
        discardedByPerson: repeat === "discarded",
      };
    }
    const opensSubject = newest === undefined || newest.decision !== null;
    if (opensSubject && (await isPageFull({ db: tx, now: deps.now }, input.developerId))) {
      return { refusal: "too_many_drafts" as const };
    }
    const id = `dr_${randomUUID()}`;
    const version = (newest?.draft.version ?? 0) + 1;
    await tx.insert(humanDrafts).values({
      id,
      developerId: input.developerId,
      repo: input.repo,
      kind: input.kind,
      subjectKey: input.subjectKey,
      version,
      payload: input.payload,
      provenance: input.provenance,
      createdAt: deps.now(),
    });
    await pruneSuperseded(tx, input.developerId, input.subjectKey, version);
    return { id, version, repeated: false, waiting: true, discardedByPerson: false };
  });

/** How many drafts await this person, by kind — the count `crosscheck confirm` and doctor print. */
export const countPendingByKind = async (
  deps: { readonly db: DbExecutor; readonly now: Clock },
  developerId: string,
): Promise<Readonly<Partial<Record<DraftKind, number>>>> => {
  const counts: Partial<Record<DraftKind, number>> = {};
  for (const draft of await readPendingDrafts(deps, developerId)) {
    counts[draft.kind] = (counts[draft.kind] ?? 0) + 1;
  }
  return counts;
};
