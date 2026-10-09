/**
 * THE DRAFT-KIND REGISTRY (human provenance §4, §6). Every kind a key may draft
 * registers how it is applied, whether a draft of it is still live, and what
 * authority confirming it needs. A `Record<DraftKind, …>`, so a kind added to
 * `DRAFT_KINDS` without an entry here does not compile — and nothing about a
 * kind lives in a `switch` somewhere else.
 *
 *   apply      the kind's ordinary writer, with the confirmation's stamp
 *              (services/draft-apply.ts);
 *   isLive     whether the draft can still mean anything: a break of a pin
 *              already broken, a mute that already holds, an outcome no
 *              figure could count any more, presence-on while presence is on.
 *              A dead draft is no decision a person can make;
 *   authority  `normal` — any enrolled, unrevoked passkey of the person may
 *              confirm it, cooling off or not (Q19: one's own labels,
 *              ratings, pins, mutes, presence-on and consent) — or
 *              `privileged`, which needs a passkey past its cool-off (04a
 *              §4.4); a future `code_disclosure` is one;
 *   retirable  a dead draft leaves the pending list on its own (`true`), or
 *              stays listed for the person to discard explicitly (`false`) —
 *              for a kind whose withdrawal the person must see.
 */
import { and, eq } from "drizzle-orm";
import type { DraftKind, HintOutcome, PilotMark } from "@crosscheck/schema";

import { developerMutes, developers, pins } from "../db/schema.ts";
import {
  applyBreak,
  applyLabel,
  applyMuteChange,
  applyOutcome,
  applyPin,
  applyPresenceOn,
  payloadText,
  payloadTextOrNull,
} from "./draft-apply.ts";
import type { ApplyDeps, ApplyKind } from "./draft-apply.ts";
import { resolveHintOutcome } from "./hint-outcomes.ts";
import type { DraftRow } from "./human-drafts.ts";
import { checkPilotMark } from "./pilot.ts";
import { pinInEffect } from "./pins.ts";

export type DraftAuthority = "normal" | "privileged";

export interface DraftKindSpec {
  readonly apply: ApplyKind;
  readonly isLive: (deps: ApplyDeps, draft: DraftRow) => Promise<boolean>;
  readonly authority: DraftAuthority;
  readonly retirable: boolean;
}

const labelIsLive = async (deps: ApplyDeps, draft: DraftRow): Promise<boolean> => {
  const isPin = draft.kind === "pin_ok";
  const refusal = await checkPilotMark(deps, {
    repo: draft.repo ?? "",
    refKind: isPin ? "pin" : "hint_delivery",
    refId: isPin ? payloadText(draft.payload, "pinId") : payloadText(draft.payload, "deliveryId"),
    mark: (isPin ? "surface_ok" : payloadText(draft.payload, "word")) as PilotMark,
    markedBy: draft.developerId,
    reason: null,
  });
  return refusal === null;
};

const outcomeIsLive = async (deps: ApplyDeps, draft: DraftRow): Promise<boolean> => {
  const resolved = await resolveHintOutcome(deps, {
    repo: draft.repo ?? "",
    ref: payloadText(draft.payload, "deliveryId"),
    outcome: payloadText(draft.payload, "word") as HintOutcome,
    reason: null,
    session: payloadTextOrNull(draft.payload, "sessionId"),
    recordedBy: draft.developerId,
    recordedVia: "person",
  });
  return !("refusal" in resolved);
};

/** The pin a draft names, as long as it protects (a void confirmation's pin does not: round-2 R2-M3). */
const pinRow = async (deps: ApplyDeps, draft: DraftRow, key: string) => {
  const rows = await deps.db
    .select({ brokeAt: pins.brokeAt })
    .from(pins)
    .where(and(eq(pins.id, payloadText(draft.payload, key)), eq(pins.repo, draft.repo ?? ""), pinInEffect))
    .limit(1);
  return rows[0];
};

const isMuted = async (deps: ApplyDeps, draft: DraftRow): Promise<boolean> => {
  const rows = await deps.db
    .select({ id: developerMutes.mutedDeveloperId })
    .from(developerMutes)
    .where(
      and(
        eq(developerMutes.readerDeveloperId, draft.developerId),
        eq(developerMutes.mutedDeveloperId, payloadText(draft.payload, "developerId")),
      ),
    )
    .limit(1);
  return rows[0] !== undefined;
};

const isOptedOut = async (deps: ApplyDeps, draft: DraftRow): Promise<boolean> => {
  const rows = await deps.db
    .select({ optOut: developers.presenceOptOut })
    .from(developers)
    .where(eq(developers.id, draft.developerId))
    .limit(1);
  return rows[0]?.optOut === true;
};

export const DRAFT_KIND_REGISTRY: Readonly<Record<DraftKind, DraftKindSpec>> = {
  label: { apply: applyLabel, isLive: labelIsLive, authority: "normal", retirable: true },
  pin_ok: { apply: applyLabel, isLive: labelIsLive, authority: "normal", retirable: true },
  outcome: { apply: applyOutcome, isLive: outcomeIsLive, authority: "normal", retirable: true },
  pin: {
    apply: applyPin,
    // A pin under that id already exists: this draft can never be one.
    isLive: async (deps, draft) => (await pinRow(deps, draft, "id")) === undefined,
    authority: "normal",
    retirable: true,
  },
  pin_broke: {
    apply: applyBreak,
    isLive: async (deps, draft) => (await pinRow(deps, draft, "pinId"))?.brokeAt === null,
    authority: "normal",
    retirable: true,
  },
  mute: { apply: applyMuteChange, isLive: async (deps, draft) => !(await isMuted(deps, draft)), authority: "normal", retirable: true },
  unmute: { apply: applyMuteChange, isLive: isMuted, authority: "normal", retirable: true },
  presence_on: { apply: applyPresenceOn, isLive: isOptedOut, authority: "normal", retirable: true },
};

/**
 * THE AUTHORITY A BATCH NEEDS: privileged when any of its kinds is — a batch
 * never confirms a privileged item on the strength of a cooling passkey
 * because ordinary items rode beside it.
 */
export const batchAuthority = (specs: readonly Pick<DraftKindSpec, "authority">[]): DraftAuthority =>
  specs.some((spec) => spec.authority === "privileged") ? "privileged" : "normal";

/** Whether a pending draft stays on the person's list: live, or of a kind whose dead drafts must be seen. */
export const staysPending = async (deps: ApplyDeps, draft: DraftRow): Promise<boolean> => {
  const spec = DRAFT_KIND_REGISTRY[draft.kind];
  return !spec.retirable || (await spec.isLive(deps, draft));
};
