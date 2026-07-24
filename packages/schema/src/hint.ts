import { z } from "zod";

import { ClaimStatusSchema, ProvenanceSchema } from "./enums.ts";

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