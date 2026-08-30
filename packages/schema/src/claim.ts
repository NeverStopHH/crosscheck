import { z } from "zod";

import {
  CaptureModeSchema,
  ClaimKindSchema,
  ClaimStatusSchema,
  EdgeKindSchema,
  ProvenanceSchema,
} from "./enums.ts";

export const MAX_CLAIM_BODY_LENGTH = 10_000;

/** Machine-derived claims may never assert more confidence than this (DESIGN.md §3). */
export const DERIVED_CONFIDENCE_CAP = 0.5;

const nonEmptyId = z.string().min(1);

export const ClaimSchema = z
  .looseObject({
    id: nonEmptyId,
    workContextId: nonEmptyId,
    authorSessionId: nonEmptyId,
    kind: ClaimKindSchema,
    body: z.string().min(1).max(MAX_CLAIM_BODY_LENGTH),
    status: ClaimStatusSchema,
    confidence: z.number().min(0).max(1),
    captureMode: CaptureModeSchema,
    provenance: ProvenanceSchema,
    evidenceRefs: z.array(nonEmptyId).default([]),
    createdAt: z.iso.datetime(),
  })
  .check((ctx) => {
    const claim = ctx.value;
    if (
      claim.provenance === "derived" &&
      claim.confidence > DERIVED_CONFIDENCE_CAP
    ) {
      ctx.issues.push({
        code: "custom",
        message: `derived claims must not exceed confidence ${DERIVED_CONFIDENCE_CAP}`,
        input: claim.confidence,
        path: ["confidence"],
      });
    }
    if (
      claim.status === "likely_root_cause" &&
      claim.evidenceRefs.length === 0
    ) {
      ctx.issues.push({
        code: "custom",
        message: "likely_root_cause requires at least one evidence ref",
        input: claim.evidenceRefs,
        path: ["evidenceRefs"],
      });
    }
  });

export const ClaimEdgeSchema = z
  .looseObject({
    id: nonEmptyId,
    fromClaimId: nonEmptyId,
    toClaimId: nonEmptyId,
    kind: EdgeKindSchema,
    authorSessionId: nonEmptyId,
    note: z.string().optional(),
    createdAt: z.iso.datetime(),
  })
  .check((ctx) => {
    const edge = ctx.value;
    if (edge.fromClaimId === edge.toClaimId) {
      ctx.issues.push({
        code: "custom",
        message: "an edge must connect two different claims",
        input: edge.toClaimId,
        path: ["toClaimId"],
      });
    }
  });

export type Claim = z.infer<typeof ClaimSchema>;
export type ClaimEdge = z.infer<typeof ClaimEdgeSchema>;