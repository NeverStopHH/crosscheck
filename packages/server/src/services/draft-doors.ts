/**
 * WHAT EVERY KEY DOOR DOES INSTEAD OF DECIDING (human provenance §3, §7, §8).
 *
 * Each route that used to write a person's judgement on the key's word now
 * runs the SAME checks it ran before — so an agent and a person both hear at
 * once that a word could never count — and then drafts it, with the class of
 * its door. Nothing here writes a record that counts: the confirmation does
 * (services/draft-apply.ts), under a passkey, and runs these checks again.
 */
import { and, eq } from "drizzle-orm";
import type { DraftProvenance, Pin, PilotMark, PilotMarkRefKind } from "@crosscheck/schema";

import { developerMutes, developers, pins } from "../db/schema.ts";
import { writeDraft } from "./human-drafts.ts";
import type { WriteDraftResult } from "./human-drafts.ts";
import { resolveHintOutcome } from "./hint-outcomes.ts";
import type { HintOutcomeRefusal, ResolveHintOutcomeInput } from "./hint-outcomes.ts";
import { checkPilotMark } from "./pilot.ts";
import type { MarkRefusal } from "./pilot.ts";
import { pointerOfDelivery } from "./pointer-standing.ts";
import { resolveDeveloperRef } from "./developer-settings.ts";
import type { MuteEntryView } from "./developer-settings.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

export type DraftRefusal = "too_many_drafts";

/**
 * What every door answers once it drafted: the draft, whether it was a repeat,
 * whether it waits on the person's page now, and the class it was given. A door
 * says "drafted" only with `waiting` true (review H2).
 */
export interface Drafted {
  readonly draftId: string;
  readonly repeated: boolean;
  readonly waiting: boolean;
  /** The agent re-offered its own word the person discarded: nothing new waits. */
  readonly discardedByPerson: boolean;
  readonly provenance: DraftProvenance;
  /** What happened, in words, for a client that prints the hub's (`DRAFT_NOTICE`). */
  readonly notice: string;
}

/**
 * THE SENTENCE EVERY DRAFTED ANSWER CARRIES (review, "old clients told
 * recorded"): a client that prints the hub's words says what is true. A 0.10
 * CLI prints only its own fixed lines and sends no version, so this cannot
 * reach its user (spec §10, stated residual).
 */
export const DRAFT_NOTICE = {
  waiting:
    "drafted: nothing changed yet — it counts only once you confirm it with your passkey on this hub's /ui/confirm page (`crosscheck confirm` opens it)",
  discardedByPerson:
    "nothing drafted: you discarded this same word on the confirm page, so offering it again changes nothing",
} as const;

const drafted = (result: WriteDraftResult, provenance: DraftProvenance): Drafted | { readonly refusal: DraftRefusal } =>
  "refusal" in result
    ? result
    : {
        draftId: result.id,
        repeated: result.repeated,
        waiting: result.waiting,
        discardedByPerson: result.discardedByPerson,
        provenance,
        notice: result.discardedByPerson ? DRAFT_NOTICE.discardedByPerson : DRAFT_NOTICE.waiting,
      };

export interface LabelDraftInput {
  readonly repo: string;
  readonly refKind: PilotMarkRefKind;
  readonly refId: string;
  readonly mark: PilotMark;
  readonly markedBy: string;
  readonly reason: string | null;
}

/** The stored word for a label: the 0.10 spelling of noise goes forward as noise. */
const labelWord = (mark: PilotMark): PilotMark => (mark === "off_target" ? "noise" : mark);

/**
 * A LABEL OR `pin --ok`, drafted. The subject is the POINTER (one intervention,
 * 07 §13.11 M4), so a label said on a twin delivery revises the same draft.
 */
export const draftLabel = async (
  deps: Deps,
  input: LabelDraftInput,
  provenance: DraftProvenance,
): Promise<Drafted | { readonly refusal: MarkRefusal | DraftRefusal }> => {
  const refusal = await checkPilotMark(deps, input);
  if (refusal !== null) {
    return { refusal };
  }
  if (input.refKind === "pin") {
    return drafted(
      await writeDraft(deps, {
        developerId: input.markedBy,
        repo: input.repo,
        kind: "pin_ok",
        subjectKey: `pin_ok:${input.refId}`,
        payload: { pinId: input.refId, word: "surface_ok" },
        provenance,
      }),
      provenance,
    );
  }
  const pointer = await pointerOfDelivery(deps.db, input.refId);
  if (pointer === undefined) {
    return { refusal: "unknown_ref" };
  }
  return drafted(
    await writeDraft(deps, {
      developerId: input.markedBy,
      repo: input.repo,
      kind: "label",
      subjectKey: `label:${pointer.sessionId}:${pointer.refId}`,
      payload: {
        deliveryId: input.refId,
        sessionId: pointer.sessionId,
        refId: pointer.refId,
        word: labelWord(input.mark),
        reason: input.reason,
      },
      provenance,
    }),
    provenance,
  );
};

export interface OutcomeDrafted extends Drafted {
  readonly deliveryId: string;
}

/** AN OUTCOME, drafted against the delivery the hub resolved for it — every 07 §13 refusal first. */
export const draftOutcome = async (
  deps: Deps,
  input: ResolveHintOutcomeInput,
  provenance: DraftProvenance,
): Promise<OutcomeDrafted | { readonly refusal: HintOutcomeRefusal | DraftRefusal }> => {
  const resolved = await resolveHintOutcome(deps, input);
  if ("refusal" in resolved) {
    return resolved;
  }
  const { delivery } = resolved;
  const result = drafted(
    await writeDraft(deps, {
      developerId: input.recordedBy,
      repo: input.repo,
      kind: "outcome",
      subjectKey: `outcome:${delivery.sessionId}:${delivery.refId}`,
      payload: {
        deliveryId: delivery.id,
        sessionId: delivery.sessionId,
        refId: delivery.refId,
        word: input.outcome,
        reason: input.reason,
      },
      provenance,
    }),
    provenance,
  );
  return "refusal" in result ? result : { ...result, deliveryId: delivery.id };
};

export type PinDraftRefusal = "pin_exists" | DraftRefusal;

/**
 * A PIN, drafted (§7). The id is the caller's, so a body under an id a pin
 * already holds is refused here as it always was — never a silent overwrite.
 * The `presence` claim is not stored: the class says what the door was.
 */
export const draftPin = async (
  deps: Deps,
  developerId: string,
  pin: Pin,
): Promise<Drafted | { readonly refusal: PinDraftRefusal }> => {
  const existing = await deps.db.select({ id: pins.id }).from(pins).where(eq(pins.id, pin.id)).limit(1);
  if (existing[0] !== undefined) {
    return { refusal: "pin_exists" };
  }
  const { presence: _claimed, ...body } = pin;
  return drafted(
    await writeDraft(deps, {
      developerId,
      repo: pin.repo,
      kind: "pin",
      subjectKey: `pin:${pin.id}`,
      payload: body,
      provenance: "interactive_terminal_asserted",
    }),
    "interactive_terminal_asserted",
  );
};

/** A BREAK, drafted — of a pin that exists in this repo; an already broken one needs nothing. */
export const draftPinBreak = async (
  deps: Deps,
  developerId: string,
  repo: string,
  pinId: string,
  brokeAtCommit: string | null,
): Promise<Drafted | { readonly alreadyBroken: true } | { readonly refusal: "not_found" | DraftRefusal }> => {
  const rows = await deps.db
    .select({ brokeAt: pins.brokeAt })
    .from(pins)
    .where(and(eq(pins.id, pinId), eq(pins.repo, repo)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return { refusal: "not_found" };
  }
  if (row.brokeAt !== null) {
    return { alreadyBroken: true };
  }
  return drafted(
    await writeDraft(deps, {
      developerId,
      repo,
      kind: "pin_broke",
      subjectKey: `pin_broke:${pinId}`,
      payload: { pinId, brokeAtCommit },
      provenance: "interactive_terminal_asserted",
    }),
    "interactive_terminal_asserted",
  );
};

export type MuteDraftOutcome =
  | ({ readonly outcome: "drafted"; readonly developer: MuteEntryView } & Drafted)
  | { readonly outcome: "unchanged"; readonly developer: MuteEntryView }
  | { readonly outcome: "not_found" | "ambiguous" | "self" }
  | { readonly refusal: DraftRefusal };

const isMuted = async (deps: Deps, readerId: string, mutedId: string): Promise<boolean> => {
  const rows = await deps.db
    .select({ id: developerMutes.mutedDeveloperId })
    .from(developerMutes)
    .where(and(eq(developerMutes.readerDeveloperId, readerId), eq(developerMutes.mutedDeveloperId, mutedId)))
    .limit(1);
  return rows[0] !== undefined;
};

/**
 * A MUTE OR AN UNMUTE, drafted (§8). The teammate is resolved now, so a
 * mistyped name is refused at once; the mute list itself only changes when
 * the person confirms. Asking for what already holds drafts nothing.
 */
export const draftMuteChange = async (
  deps: Deps,
  readerId: string,
  ref: string,
  kind: "mute" | "unmute",
): Promise<MuteDraftOutcome> => {
  const resolved = await resolveDeveloperRef(deps.db, ref);
  if (resolved.outcome === "ambiguous" || resolved.outcome !== "resolved") {
    return { outcome: resolved.outcome === "ambiguous" ? "ambiguous" : "not_found" };
  }
  const developer = resolved.developer;
  if (kind === "mute" && developer.id === readerId) {
    return { outcome: "self" };
  }
  if ((await isMuted(deps, readerId, developer.id)) === (kind === "mute")) {
    return { outcome: "unchanged", developer };
  }
  const result = drafted(
    await writeDraft(deps, {
      developerId: readerId,
      repo: null,
      kind,
      subjectKey: `mute:${developer.id}`,
      payload: { developerId: developer.id, name: developer.name },
      provenance: "agent_asserted",
    }),
    "agent_asserted",
  );
  return "refusal" in result ? result : { outcome: "drafted", developer, ...result };
};

/** PRESENCE BACK ON, drafted (§8) — only while the person is opted out; otherwise there is nothing to ask. */
export const draftPresenceOn = async (
  deps: Deps,
  developerId: string,
): Promise<Drafted | { readonly unchanged: true } | { readonly refusal: DraftRefusal }> => {
  const rows = await deps.db
    .select({ optOut: developers.presenceOptOut })
    .from(developers)
    .where(eq(developers.id, developerId))
    .limit(1);
  if (rows[0]?.optOut !== true) {
    return { unchanged: true };
  }
  return drafted(
    await writeDraft(deps, {
      developerId,
      repo: null,
      kind: "presence_on",
      subjectKey: "presence",
      payload: {},
      provenance: "agent_asserted",
    }),
    "agent_asserted",
  );
};

/** The one sentence for a refused draft, said by every door. */
export const DRAFT_REFUSAL_SENTENCE: Readonly<Record<DraftRefusal, string>> = {
  too_many_drafts:
    "too many of your drafts already wait for your passkey, so nothing was recorded — run `crosscheck confirm` to confirm or discard them first",
};
