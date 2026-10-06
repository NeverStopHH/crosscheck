import { z } from "zod";

import {
  ClaimStatusSchema,
  DeliveryChannelSchema,
  ProvenanceSchema,
} from "./enums.ts";

/** Hard cap for injected hint text — noise budget, DESIGN.md §4. */
export const MAX_HINT_TEXT_LENGTH = 1200;

const nonEmptyId = z.string().min(1);

/**
 * Trust labels are mandatory on every hint (DESIGN.md §4): the receiving agent
 * must always see who claimed it, how old it is, and how trustworthy it is.
 */
export const HintTrustSchema = z.looseObject({
  authorName: z.string().min(1),
  ageSeconds: z.number().int().min(0),
  status: ClaimStatusSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  provenance: ProvenanceSchema.optional(),
  commitsBehindHead: z.number().int().optional(),
});

export const HintSchema = z.looseObject({
  id: nonEmptyId,
  receiverSessionId: nonEmptyId,
  refKind: z.enum(["claim", "work_context"]),
  refId: nonEmptyId,
  renderedText: z.string().min(1).max(MAX_HINT_TEXT_LENGTH),
  trust: HintTrustSchema,
  deliveredAt: z.iso.datetime(),
});

export type HintTrust = z.infer<typeof HintTrustSchema>;
export type Hint = z.infer<typeof HintSchema>;

export const HINT_REF_KINDS = ["claim", "work_context"] as const;

/**
 * What a delivered hint was matched on (review 1006b, M7): the prompt, the
 * session's intent (a hub that still reports one), or a question this
 * developer asked — so the per-person followed/overrode measurement can tell
 * an answer they waited for from a pointer they never asked for.
 */
export const HINT_MATCHED_ON_VALUES = ["prompt", "intent", "answer"] as const;

export type DeliveryMatchedOn = (typeof HINT_MATCHED_ON_VALUES)[number];

/** Who wrote the receiving session's intent: `set_intent`, or the intent worker. */
export const INTENT_PROVENANCES = ["declared", "derived"] as const;
export type IntentProvenance = (typeof INTENT_PROVENANCES)[number];

/**
 * Delivery telemetry for one injected hint (DESIGN.md §4): refs only, never
 * the rendered text — the hub already holds the claim, and what the precision
 * loop needs is WHICH ref reached WHICH session, not a second copy of the
 * words. Produced by the connector's UserPromptSubmit hook and spooled like
 * any other record; the deterministic `id` is what makes a spool replay a
 * duplicate instead of a second delivery.
 */
export const HintDeliverySchema = z.looseObject({
  id: nonEmptyId,
  /** The RECEIVING session — the one whose prompt the hint landed in. */
  sessionId: nonEmptyId,
  refKind: z.enum(HINT_REF_KINDS),
  refId: nonEmptyId,
  /**
   * WHICH SURFACE handed this ref over (07 §3.1).
   *
   * OPTIONAL AND DEFAULTED, the forward-compat shape `TargetSchema.source`
   * already uses: a connector older than this spec sends no channel, and the
   * honest reading of that is `unknown` rather than a rejected record. A
   * required field here would make the hub refuse every delivery from an
   * install nobody has upgraded yet — losing the very rows the pilot counts.
   */
  channel: DeliveryChannelSchema.default("unknown"),
  /**
   * What the hint was matched on (M7). OPTIONAL and never defaulted: a
   * connector older than the field says nothing, and the hub stores nothing
   * rather than a guess. A value this hub does not know is read as nothing
   * too (hold-out review, L3) — never a refusal, which would drop the very
   * delivery row the measurement counts over one word it cannot read.
   */
  matchedOn: z.enum(HINT_MATCHED_ON_VALUES).optional().catch(undefined),
  /** Who wrote the receiving session's intent at delivery; null when it had none, or said something unknown. */
  intentProvenance: z.enum(INTENT_PROVENANCES).nullable().optional().catch(null),
  deliveredAt: z.iso.datetime(),
});

export type HintDelivery = z.infer<typeof HintDeliverySchema>;