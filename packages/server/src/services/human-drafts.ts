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
 * updated. A draft that says exactly what its subject's newest version says —
 * pending, confirmed or discarded — is a repeat and writes nothing: an agent
 * re-reading a hint never refills the person's page, and a word the person
 * discarded is not offered again by being said again.
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
  | { readonly id: string; readonly version: number; readonly repeated: boolean }
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

/** Resolved: some CONFIRMED batch decided it (a batch exists only once its passkey verified). */
const RESOLVED = sql`EXISTS (
  SELECT 1 FROM human_confirmation_items i
  WHERE i.draft_id = d.id AND i.decision IN ('confirm', 'discard'))`;

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

/** The newest version of one subject, and whether a confirmed batch resolved it. */
const readNewest = async (
  db: DbExecutor,
  developerId: string,
  subjectKey: string,
): Promise<{ readonly draft: DraftRow; readonly resolved: boolean } | undefined> => {
  const rows = await db.execute<RawDraft>(sql`
    SELECT d.*, ${RESOLVED} AS resolved FROM human_drafts d
    WHERE d.developer_id = ${developerId} AND d.subject_key = ${subjectKey}
    ORDER BY d.version DESC LIMIT 1 FOR UPDATE`);
  const raw = rows.rows[0];
  return raw === undefined ? undefined : { draft: rowOf(raw), resolved: raw.resolved };
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
 * ONE DRAFT. A repeat of the subject's newest version writes nothing; a new
 * subject past MAX_PENDING_DRAFT_SUBJECTS is refused; a newer version of a
 * subject that is still pending is always taken (it replaces nothing a person
 * decided — they decided nothing about it yet).
 */
export const writeDraft = (deps: Deps, input: WriteDraftInput): Promise<WriteDraftResult> =>
  deps.db.transaction(async (tx) => {
    const newest = await readNewest(tx, input.developerId, input.subjectKey);
    if (newest !== undefined && sayingOf(newest.draft.kind, newest.draft.payload) === sayingOf(input.kind, input.payload)) {
      return { id: newest.draft.id, version: newest.draft.version, repeated: true };
    }
    const opensSubject = newest === undefined || newest.resolved;
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
    return { id, version, repeated: false };
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
