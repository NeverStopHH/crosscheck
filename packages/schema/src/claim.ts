import { z } from "zod";

import { COMMIT_SHA_PATTERN } from "./commit-sha.ts";
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
    /**
     * The author's HEAD at the moment the claim was made (1.0 spec 02 §3.1).
     *
     * OPTIONAL is the forward-compat seam, and it means exactly one thing
     * here: an old connector sends nothing and ingest stamps `session_base`.
     * It does NOT mean "keep what you have" — that is `IntentSchema`'s rule
     * for a MUTABLE object, and a claim is INSERTed once and never updated,
     * so absent means null forever on that row.
     *
     * Free to produce: every claim-writing tool path already holds
     * `identity.baseCommit` (connector-core mcp/context.ts resolves a
     * RepoIdentity per call), so this is bytes on a body already being built
     * rather than a round trip or a git call.
     */
    observedAtCommit: z.string().regex(COMMIT_SHA_PATTERN).optional(),
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