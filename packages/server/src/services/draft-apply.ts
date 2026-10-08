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

export type ApplyOutcome =
  | { readonly applied: true; readonly presenceOn: boolean }
  | { readonly refusal: ApplyRefusal };

export type ApplyKind = (
  deps: ApplyDeps,
  draft: DraftRow,
  content: DraftPayload,
  stamp: HumanStamp,
) => Promise<ApplyOutcome>;

const APPLIED = { applied: true, presenceOn: false } as const;

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
  return "refusal" in written ? { refusal: written.refusal } : APPLIED;
};

export const applyOutcome: ApplyKind = async (deps, draft, content, stamp) => {
  const written = await writeHintOutcome(deps, {
    repo: draft.repo ?? "",
    ref: payloadText(content, "deliveryId"),
    outcome: payloadText(content, "word") as HintOutcome,
    reason: payloadTextOrNull(content, "reason"),
    session: payloadTextOrNull(content, "sessionId"),
    recordedBy: draft.developerId,
    // A confirmed word is the PERSON's, whichever door drafted it.
    recordedVia: "person",
    stamp,
  });
  return "refusal" in written ? { refusal: written.refusal } : APPLIED;
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
  return outcome === "not_found" ? { refusal: "unknown_pin" } : APPLIED;
};

export const applyMuteChange: ApplyKind = async (deps, draft, content, stamp) => {
  const target = payloadText(content, "developerId");
  if (draft.kind === "unmute") {
    const removed = await removeMute(deps.db, draft.developerId, target);
    return removed.outcome === "unmuted" ? APPLIED : { refusal: "unknown_developer" };
  }
  const added = await addMute(deps, draft.developerId, target, stamp);
  return added.outcome === "muted"
    ? APPLIED
    : { refusal: added.outcome === "limit_reached" ? "mute_limit_reached" : "unknown_developer" };
};

export const applyPresenceOn: ApplyKind = async (deps, draft) => {
  await applyPresenceOptOut(deps, draft.developerId, false, HUMAN_PROVENANCE);
  return { applied: true, presenceOn: true };
};
