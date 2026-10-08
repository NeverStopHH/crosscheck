/**
 * THE FROZEN CONFIRMATION BATCH (human provenance §6) — the only path by which
 * anything becomes `human_passkey_confirmed`.
 *
 * ONE TAP NEVER MEANS "CONFIRM WHATEVER IS PENDING". A page shows the pending
 * drafts of its own kinds (its SCOPE). The person decides each, editing some,
 * and the hub freezes exactly that into a batch: an id, the fingerprint of the
 * scoped pending set the page showed — a page older than that set cannot form
 * one — and a digest over every item's (draft id, version, draft digest,
 * decision, final content). The WebAuthn challenge is bound to the batch id
 * and that digest.
 *
 * TOCTOU, WITHIN THE BATCH. Verify re-reads the person's drafts UNDER LOCK and
 * refuses the WHOLE batch if any of its items changed — a newer version, a
 * decision elsewhere, a draft that died — since the snapshot. A draft that
 * arrived after the page loaded is in no batch and can never be confirmed by
 * this one; one of an unrelated subject or kind does not invalidate it.
 *
 * HELD IN HUB MEMORY, like the ceremonies it rides (services/webauthn.ts): a
 * formed batch belongs to the developer AND the browser session that formed
 * it, lives as long as its prompt (CONFIRM_BATCH_TTL_MS), and a restart drops
 * it. Only a CONFIRMED batch is written — with the assertion that confirmed it
 * — in `human_confirmations` and its items, in the transaction that applies it.
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";
import {
  DRAFT_DECISIONS,
  HINT_OUTCOMES,
  MAX_HINT_OUTCOME_REASON_CHARS,
  MAX_PILOT_LABEL_REASON_CHARS,
  PILOT_INTERVENTION_LABELS,
  containsSecret,
  reasonLength,
  unstorableTextPath,
} from "@crosscheck/schema";
import type { DraftDecision, DraftKind } from "@crosscheck/schema";

import { CONFIRM_BATCH_TTL_MS, MAX_PENDING_DRAFT_SUBJECTS } from "../constants.ts";
import { humanConfirmationItems, humanConfirmations } from "../db/schema.ts";
import { DRAFT_KIND_REGISTRY, batchAuthority } from "./draft-kinds.ts";
import type { DraftAuthority } from "./draft-kinds.ts";
import { canonicalJson, draftDigest, pendingFingerprint, readPendingDrafts, sha256Hex } from "./human-drafts.ts";
import type { DraftPayload, DraftRow } from "./human-drafts.ts";
import { humanStamp } from "./human-provenance.ts";
import type { Db, DbTransaction } from "../db/client.ts";
import type { Clock } from "../types.ts";
import type { CeremonyOwner } from "./webauthn.ts";

/**
 * BOUNDS ON WHAT ONE HUB HOLDS (review M3), every one met by EVICTION, never
 * by refusing: a session keeps its newest few; a developer, across all their
 * sessions, their newest few; at the hub's bound the oldest batch of whoever
 * holds the most goes. Sessions cost one login with the key, so the
 * developer's bound is what keeps one member's agent from filling the hub.
 */
export interface BatchLimits {
  readonly perSession: number;
  readonly perDeveloper: number;
  readonly total: number;
}

export const BATCH_LIMITS: BatchLimits = { perSession: 4, perDeveloper: 8, total: 1024 };

const MAX_ID_CHARS = 200;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export const BatchBodySchema = z.object({
  fingerprint: z.string().regex(SHA256_HEX),
  items: z
    .array(
      z.object({
        draftId: z.string().min(1).max(MAX_ID_CHARS),
        version: z.number().int().min(1),
        decision: z.enum(DRAFT_DECISIONS),
        /** An edit: a label's or an outcome's word. Absent: the draft's own. */
        word: z.string().min(1).max(MAX_ID_CHARS).optional(),
        /** An edit: the sentence beside it; null or blank removes it. Absent: the draft's own. */
        reason: z.string().nullable().optional(),
      }),
    )
    .max(MAX_PENDING_DRAFT_SUBJECTS),
});

export type BatchBody = z.infer<typeof BatchBodySchema>;

/** One frozen item: what the person decided, and the content that decision is about. */
export interface BatchItem {
  readonly draft: DraftRow;
  readonly draftDigest: string;
  readonly decision: DraftDecision;
  readonly content: DraftPayload;
}

export interface FrozenBatch {
  readonly id: string;
  readonly owner: CeremonyOwner;
  /** The kinds the page that formed it shows. */
  readonly scope: readonly DraftKind[];
  readonly fingerprint: string;
  readonly digest: string;
  readonly items: readonly BatchItem[];
  /** What confirming it needs: any passkey of the person, or one past its cool-off. */
  readonly authority: DraftAuthority;
  readonly formedAt: Date;
  readonly expiresAtMs: number;
}

/** The assertion that confirmed a batch, base64url as the browser sent it. */
export interface StoredAssertion {
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
  readonly signature: string;
  readonly userHandle: string | null;
}

/** Every refusal a person can meet forming or confirming a batch — one word each, one sentence below. */
export type BatchRefusal =
  | "pending_changed"
  | "not_editable"
  | "invalid_word"
  | "reason_required"
  | "reason_too_long"
  | "reason_unstorable"
  | "reason_secret"
  | "nothing_to_sign"
  | "unknown_batch"
  | "item_refused";

export const BATCH_SENTENCE: Readonly<Record<BatchRefusal, string>> = {
  pending_changed:
    "your drafts changed since this page loaded (one was added, revised or decided elsewhere), so nothing was confirmed — reload the page and review them again",
  not_editable: "only a label's or an outcome's word and reason can be edited here — nothing was confirmed",
  invalid_word: "that word does not fit that kind of draft — nothing was confirmed",
  reason_required: "an override needs its reason: one sentence on why your way was better — nothing was confirmed",
  reason_too_long: `a reason is one sentence of at most ${String(MAX_PILOT_LABEL_REASON_CHARS)} characters — nothing was confirmed`,
  reason_unstorable: "that reason holds a character the hub cannot store — nothing was confirmed",
  reason_secret:
    "a reason looks like it holds a secret (a key, a token, a password), so nothing was confirmed — say it again without it",
  nothing_to_sign: "these decisions leave everything for later, so there is nothing to sign — choose confirm or discard for at least one",
  unknown_batch: "that batch was already confirmed, expired, or was formed in another browser session — reload the page",
  item_refused: "one of these drafts can no longer be recorded, so nothing was confirmed — reload the page to see which",
};

const EDITABLE: ReadonlySet<string> = new Set(["label", "outcome"]);

const WORDS: Readonly<Record<string, readonly string[]>> = {
  label: PILOT_INTERVENTION_LABELS,
  outcome: HINT_OUTCOMES,
};

const MAX_REASON: Readonly<Record<string, number>> = {
  label: MAX_PILOT_LABEL_REASON_CHARS,
  outcome: MAX_HINT_OUTCOME_REASON_CHARS,
};

type Edit = BatchBody["items"][number];

type Content = { readonly content: DraftPayload } | { readonly refusal: BatchRefusal };

/** A reason as it would be stored: trimmed, a blank one none at all. */
const cleanReason = (raw: string | null): string | null => {
  const trimmed = raw?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

/** Why a reason could never be stored beside a word of this kind, or null. */
const reasonRefusal = (kind: string, reason: string | null): BatchRefusal | null => {
  if (reason === null) {
    return null;
  }
  if (reasonLength(reason) > (MAX_REASON[kind] ?? 0)) {
    return "reason_too_long";
  }
  if (unstorableTextPath({ reason }) !== null) {
    return "reason_unstorable";
  }
  return containsSecret(reason) ? "reason_secret" : null;
};

/**
 * THE CONTENT A DECISION IS ABOUT: the draft's payload, with the person's edit
 * applied and checked by the same rules the doors apply — a reason is scanned
 * for secrets HERE, before anything is signed over it.
 */
const finalContent = (draft: DraftRow, edit: Edit): Content => {
  const isEdited = edit.word !== undefined || edit.reason !== undefined;
  if (!isEdited || edit.decision !== "confirm") {
    return { content: draft.payload };
  }
  if (!EDITABLE.has(draft.kind)) {
    return { refusal: "not_editable" };
  }
  const word = edit.word ?? String(draft.payload["word"] ?? "");
  if (!(WORDS[draft.kind] ?? []).includes(word)) {
    return { refusal: "invalid_word" };
  }
  const drafted = draft.payload["reason"];
  const reason = edit.reason === undefined ? (typeof drafted === "string" ? drafted : null) : cleanReason(edit.reason);
  const refused = reasonRefusal(draft.kind, reason);
  if (refused !== null) {
    return { refusal: refused };
  }
  if (draft.kind === "outcome" && word === "overrode" && reason === null) {
    return { refusal: "reason_required" };
  }
  return { content: { ...draft.payload, word, reason } };
};

/** The digest the challenge is bound to: the fingerprint and every item, in order. */
export const batchDigest = (fingerprint: string, items: readonly BatchItem[]): string =>
  sha256Hex(
    canonicalJson([
      fingerprint,
      items.map((item) => [item.draft.id, item.draft.version, item.draftDigest, item.decision, item.content]),
    ]),
  );

/** A batch decides every draft its page showed exactly once, at the version shown — or it is no batch. */
const decidesExactly = (pending: readonly DraftRow[], body: BatchBody): boolean => {
  if (body.items.length !== pending.length) {
    return false;
  }
  const byId = new Map(body.items.map((item) => [item.draftId, item]));
  return byId.size === pending.length && pending.every((draft) => byId.get(draft.id)?.version === draft.version);
};

/** Every item still pending as frozen: same draft, same version, same content, still live. */
const isUnchanged = (pending: readonly DraftRow[], items: readonly BatchItem[]): boolean => {
  const byId = new Map(pending.map((draft) => [draft.id, draft]));
  return items.every((item) => {
    const now = byId.get(item.draft.id);
    return now !== undefined && now.version === item.draft.version && draftDigest(now) === item.draftDigest;
  });
};

const isOwnedBy = (batch: FrozenBatch, owner: CeremonyOwner): boolean =>
  batch.owner.developerId === owner.developerId && batch.owner.sessionKey === owner.sessionKey;

export interface ConfirmDeps {
  readonly db: Db;
  readonly now: Clock;
}

/** Thrown inside the applying transaction so that nothing of the batch survives a refusal. */
class BatchRefused extends Error {
  constructor(
    readonly refusal: BatchRefusal,
    readonly draftId: string | null,
    readonly itemCause: string | null,
  ) {
    super(refusal);
  }
}

export interface ConfirmedBatch {
  readonly confirmed: number;
  readonly discarded: number;
  readonly kept: number;
  /** A presence-on was among them: the caller rebuilds the person's index once this committed. */
  readonly presenceOn: boolean;
  /** What each confirmed item's writer answered, by draft id (draft-apply.ts `effect`). */
  readonly effects: ReadonlyMap<string, unknown>;
}

interface Applied {
  readonly presenceOn: boolean;
  readonly effects: ReadonlyMap<string, unknown>;
}

export type ConfirmRefused = {
  readonly refusal: BatchRefusal;
  readonly draftId: string | null;
  readonly cause: string | null;
};

/** Every confirmed item, applied by its kind's registered writer with the batch's stamp. */
const applyConfirmed = async (deps: { readonly db: DbTransaction; readonly now: Clock }, batch: FrozenBatch): Promise<Applied> => {
  const stamp = humanStamp(batch.id);
  let presenceOn = false;
  const effects = new Map<string, unknown>();
  for (const item of batch.items.filter((each) => each.decision === "confirm")) {
    const applied = await DRAFT_KIND_REGISTRY[item.draft.kind].apply(deps, item.draft, item.content, stamp);
    if ("refusal" in applied) {
      throw new BatchRefused("item_refused", item.draft.id, applied.refusal);
    }
    presenceOn ||= applied.presenceOn;
    effects.set(item.draft.id, applied.effect);
  }
  return { presenceOn, effects };
};

/** The confirmation's own rows: who, which device, what was signed, and the assertion that signed it. */
const recordConfirmation = async (
  tx: DbTransaction,
  batch: FrozenBatch,
  credential: { readonly id: string; readonly rpId: string },
  assertion: StoredAssertion,
  confirmedAt: Date,
): Promise<void> => {
  await tx.insert(humanConfirmations).values({
    id: batch.id,
    developerId: batch.owner.developerId,
    credentialId: credential.id,
    rpId: credential.rpId,
    digest: batch.digest,
    pendingFingerprint: batch.fingerprint,
    itemCount: batch.items.length,
    formedAt: batch.formedAt,
    confirmedAt,
    authenticatorData: assertion.authenticatorData,
    clientDataJson: assertion.clientDataJSON,
    signature: assertion.signature,
    userHandle: assertion.userHandle,
  });
  if (batch.items.length > 0) {
    await tx.insert(humanConfirmationItems).values(
      batch.items.map((item, position) => ({
        confirmationId: batch.id,
        position,
        draftId: item.draft.id,
        draftVersion: item.draft.version,
        draftDigest: item.draftDigest,
        decision: item.decision,
        content: item.content,
      })),
    );
  }
};

export const createBatchStore = (nowMs: () => number, limits: BatchLimits = BATCH_LIMITS) => {
  const batches = new Map<string, FrozenBatch>();

  const purgeExpired = (): void => {
    const now = nowMs();
    for (const [id, batch] of batches) {
      if (batch.expiresAtMs <= now) {
        batches.delete(id);
      }
    }
  };

  /** Drop the oldest batch `matches` selects when it holds `bound` or more (the map keeps forming order). */
  const evictOldestPast = (matches: (batch: FrozenBatch) => boolean, bound: number): void => {
    const held = [...batches.values()].filter(matches);
    if (held.length >= bound && held[0] !== undefined) {
      batches.delete(held[0].id);
    }
  };

  /** At the hub's bound, the oldest batch of the developer holding the most goes — never the newcomer's turn. */
  const evictFromHeaviest = (): void => {
    if (batches.size < limits.total) {
      return;
    }
    const held = new Map<string, number>();
    for (const batch of batches.values()) {
      held.set(batch.owner.developerId, (held.get(batch.owner.developerId) ?? 0) + 1);
    }
    const most = Math.max(...held.values());
    const victim = [...batches.values()].find((batch) => held.get(batch.owner.developerId) === most);
    if (victim !== undefined) {
      batches.delete(victim.id);
    }
  };

  /** Make room for one more batch of `owner`'s: their session's oldest, their own oldest, then the heaviest holder's. */
  const makeRoom = (owner: CeremonyOwner): void => {
    evictOldestPast((batch) => isOwnedBy(batch, owner), limits.perSession);
    evictOldestPast((batch) => batch.owner.developerId === owner.developerId, limits.perDeveloper);
    evictFromHeaviest();
  };

  /**
   * FREEZE what the person decided (step 3 of §6). Refused whole when the page
   * is older than its scoped pending set, when it does not decide every draft
   * it showed exactly once, or when an edit could never be stored.
   */
  const form = async (
    deps: ConfirmDeps,
    owner: CeremonyOwner,
    body: BatchBody,
    scope: readonly DraftKind[],
  ): Promise<FrozenBatch | { readonly refusal: BatchRefusal }> => {
    const pending = await readPendingDrafts(deps, owner.developerId, { scope });
    if (pendingFingerprint(pending) !== body.fingerprint || !decidesExactly(pending, body)) {
      return { refusal: "pending_changed" };
    }
    const edits = new Map(body.items.map((item) => [item.draftId, item]));
    const items: BatchItem[] = [];
    for (const draft of pending) {
      const edit = edits.get(draft.id);
      if (edit === undefined) {
        return { refusal: "pending_changed" };
      }
      const decided = finalContent(draft, edit);
      if ("refusal" in decided) {
        return decided;
      }
      items.push({ draft, draftDigest: draftDigest(draft), decision: edit.decision, content: decided.content });
    }
    // Nothing confirmed and nothing discarded: there is nothing to sign, and nothing to hold (review M3).
    if (!items.some((item) => item.decision !== "keep")) {
      return { refusal: "nothing_to_sign" };
    }
    purgeExpired();
    makeRoom(owner);
    const formedAt = deps.now();
    const batch: FrozenBatch = Object.freeze({
      id: `hb_${randomUUID()}`,
      owner,
      scope: Object.freeze([...scope]),
      fingerprint: body.fingerprint,
      digest: batchDigest(body.fingerprint, items),
      items: Object.freeze(items),
      authority: batchAuthority(items.map((item) => DRAFT_KIND_REGISTRY[item.draft.kind])),
      formedAt,
      expiresAtMs: formedAt.getTime() + CONFIRM_BATCH_TTL_MS,
    });
    batches.set(batch.id, batch);
    return batch;
  };

  /** The caller's own unexpired batch, or null: another session's batch reads as no batch. */
  const read = (owner: CeremonyOwner, batchId: string): FrozenBatch | null => {
    purgeExpired();
    const batch = batches.get(batchId);
    return batch === undefined || !isOwnedBy(batch, owner) ? null : batch;
  };

  /**
   * CONFIRM, after the signature over the batch verified (step 5 of §6). One
   * transaction: the person's drafts locked, every item compared with its
   * snapshot, the confirmation and its assertion written, every confirmed item
   * applied with its stamp. Spent whatever happens: a refused batch is never
   * retried.
   */
  const confirm = async (
    deps: ConfirmDeps,
    batch: FrozenBatch,
    credential: { readonly id: string; readonly rpId: string },
    assertion: StoredAssertion,
  ): Promise<ConfirmedBatch | ConfirmRefused> => {
    batches.delete(batch.id);
    try {
      const { presenceOn, effects } = await deps.db.transaction(async (tx) => {
        const scoped = { db: tx, now: deps.now };
        const pending = await readPendingDrafts(scoped, batch.owner.developerId, { lock: true, scope: batch.scope });
        if (!isUnchanged(pending, batch.items)) {
          throw new BatchRefused("pending_changed", null, null);
        }
        await recordConfirmation(tx, batch, credential, assertion, deps.now());
        return applyConfirmed(scoped, batch);
      });
      const count = (decision: DraftDecision): number =>
        batch.items.filter((item) => item.decision === decision).length;
      return { confirmed: count("confirm"), discarded: count("discard"), kept: count("keep"), presenceOn, effects };
    } catch (error) {
      if (error instanceof BatchRefused) {
        return { refusal: error.refusal, draftId: error.draftId, cause: error.itemCause };
      }
      throw error;
    }
  };

  return { form, read, confirm };
};

export type BatchStore = ReturnType<typeof createBatchStore>;
