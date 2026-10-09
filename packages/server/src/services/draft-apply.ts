/**
 * WHAT A CONFIRMED ITEM BECOMES (human provenance §6): one draft, applied
 * through the ordinary writer of its kind, with the confirmation's stamp, in
 * the transaction that confirms its batch. Every writer runs its own checks
 * again — enrolment, the delivery, the pin policy, the mute limit — because
 * what was true when a key drafted it may not be true when the person taps.
 * Any refusal throws the whole batch back.
 *
 * The CONTENT is the batch's — what the person saw, edited and signed — never
 * the draft's payload, which the confirmation never rewrites.
 *
 * One function per kind; services/draft-kinds.ts registers each beside the
 * kind's liveness and authority.
 */
import { HUMAN_PROVENANCE, PIN_PRESENCE_TERMINAL } from "@crosscheck/schema";
import type { HintOutcome, Pin, PilotMark } from "@crosscheck/schema";

import { addMute, applyPresenceOptOut, removeMute } from "./developer-settings.ts";
import { writeHintOutcome } from "./hint-outcomes.ts";
import type { DraftPayload, DraftRow } from "./human-drafts.ts";
import type { HumanStamp } from "./human-provenance.ts";
import { writePilotMark } from "./pilot.ts";
import { createPin, markPinBroke, untouchedByDeveloper } from "./pins.ts";
import { readTeamSettings } from "./team-settings.ts";
import type { DbExecutor } from "../db/client.ts";
import type { Clock } from "../types.ts";

export interface ApplyDeps {
  readonly db: DbExecutor;
  readonly now: Clock;
}

/** Why one item could not be applied — the writer's own refusal word. */
export type ApplyRefusal = string;

/**
 * WHAT ONE CONFIRMED ITEM WROTE (round-2 review R2-M2): a writer may write
 * nothing — one label per hint, a word already said, a teammate already
 * muted — and the person is told so, with the writer's reason, never a
 * blanket "confirmed".
 */
export type ItemResult = { readonly wrote: true; readonly why: null } | { readonly wrote: false; readonly why: string };

/** Why a writer wrote nothing for a confirmed item, per kind — the sentence the confirm page shows. */
export const NOTHING_WRITTEN = {
  label: "you had already labelled that hint (one label per hint is yours)",
  pin_ok: "you had already marked that pin ok",
  outcome: "you had already said exactly that about that hint",
  pin_broke: "that pin was already marked broken",
  mute: "that teammate was already muted",
  unmute: "that teammate was not muted",
  presence_on: "your presence was already on",
} as const;

const WROTE: ItemResult = { wrote: true, why: null };

const resultOf = (didWrite: boolean, why: string): ItemResult => (didWrite ? WROTE : { wrote: false, why });

export type ApplyOutcome =
  | {
      readonly applied: true;
      readonly presenceOn: boolean;
      /** Whether the writer wrote anything, and why not (R2-M2): reported per item to the person. */
      readonly result: ItemResult;
      /**
       * What the kind's writer answered — what stands now, what it replaced,
       * whether it was a repeat. Nothing decides on it.
       */
      readonly effect?: unknown;
    }
  | { readonly refusal: ApplyRefusal };

export type ApplyKind = (
  deps: ApplyDeps,
  draft: DraftRow,
  content: DraftPayload,
  stamp: HumanStamp,
) => Promise<ApplyOutcome>;

const APPLIED = { applied: true, presenceOn: false, result: WROTE } as const;

/** Applied, with the writer's answer of whether it wrote anything. */
const appliedAs = (didWrite: boolean, why: string, effect?: unknown): ApplyOutcome => ({
  applied: true,
  presenceOn: false,
  result: resultOf(didWrite, why),
  ...(effect === undefined ? {} : { effect }),
});

export const payloadText = (payload: DraftPayload, key: string): string => String(payload[key] ?? "");

export const payloadTextOrNull = (payload: DraftPayload, key: string): string | null => {
  const value = payload[key];
  return typeof value === "string" ? value : null;
};

/** A label on a delivery, or `pin --ok` — both rows of `pilot_marks`. */
export const applyLabel: ApplyKind = async (deps, draft, content, stamp) => {
  const isPin = draft.kind === "pin_ok";
  const written = await writePilotMark(deps, {
    repo: draft.repo ?? "",
    refKind: isPin ? "pin" : "hint_delivery",
    refId: isPin ? payloadText(content, "pinId") : payloadText(content, "deliveryId"),
    mark: (isPin ? "surface_ok" : payloadText(content, "word")) as PilotMark,
    markedBy: draft.developerId,
    reason: isPin ? null : payloadTextOrNull(content, "reason"),
    stamp,
  });
  return "refusal" in written
    ? { refusal: written.refusal }
    : appliedAs(!written.repeated, isPin ? NOTHING_WRITTEN.pin_ok : NOTHING_WRITTEN.label, written);
};

export const applyOutcome: ApplyKind = async (deps, draft, content, stamp) => {
  const written = await writeHintOutcome(deps, {
    repo: draft.repo ?? "",
    ref: payloadText(content, "deliveryId"),
    outcome: payloadText(content, "word") as HintOutcome,
    reason: payloadTextOrNull(content, "reason"),
    session: payloadTextOrNull(content, "sessionId"),
    // A confirmed word is the PERSON's, whichever door drafted it (the writer writes it so, J8).
    recordedBy: draft.developerId,
    stamp,
  });
  return "refusal" in written ? { refusal: written.refusal } : appliedAs(!written.repeated, NOTHING_WRITTEN.outcome, written);
};

export const applyPin: ApplyKind = async (deps, draft, content, stamp) => {
  const pin = { ...content, presence: PIN_PRESENCE_TERMINAL } as unknown as Pin;
  // THE TEAM'S PIN POLICY, checked again at the tap: it may have changed since.
  const settings = await readTeamSettings(deps, pin.repo);
  if (settings.pinPolicy === "touched_files") {
    const unseen = await untouchedByDeveloper(deps, draft.developerId, pin.repo, pin.files);
    if (unseen.length > 0) {
      return { refusal: "pin_policy" };
    }
  }
  const created = await createPin(deps, draft.developerId, pin, stamp);
  return created.outcome === "duplicate" ? { refusal: "pin_exists" } : APPLIED;
};

export const applyBreak: ApplyKind = async (deps, draft, content, stamp) => {
  const outcome = await markPinBroke(
    deps,
    draft.developerId,
    draft.repo ?? "",
    payloadText(content, "pinId"),
    payloadTextOrNull(content, "brokeAtCommit"),
    stamp,
  );
  return outcome === "not_found" ? { refusal: "unknown_pin" } : appliedAs(outcome === "broken", NOTHING_WRITTEN.pin_broke);
};

export const applyMuteChange: ApplyKind = async (deps, draft, content, stamp) => {
  const target = payloadText(content, "developerId");
  if (draft.kind === "unmute") {
    const removed = await removeMute(deps.db, draft.developerId, target);
    return removed.outcome === "unmuted" ? appliedAs(removed.wasMuted, NOTHING_WRITTEN.unmute) : { refusal: "unknown_developer" };
  }
  const added = await addMute(deps, draft.developerId, target, stamp);
  return added.outcome === "muted"
    ? appliedAs(!added.alreadyMuted, NOTHING_WRITTEN.mute)
    : { refusal: added.outcome === "limit_reached" ? "mute_limit_reached" : "unknown_developer" };
};

export const applyPresenceOn: ApplyKind = async (deps, draft) => {
  const changed = await applyPresenceOptOut(deps, draft.developerId, false, HUMAN_PROVENANCE);
  return { applied: true, presenceOn: true, result: resultOf(changed, NOTHING_WRITTEN.presence_on) };
};
