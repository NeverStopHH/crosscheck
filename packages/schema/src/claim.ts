import { z } from "zod";

import { COMMIT_SHA_PATTERN } from "./commit-sha.ts";
import { MAX_VERIFICATION_REF_CHARS } from "./evidence-axes.ts";
import { repoRelativePath } from "./repo-path.ts";
import {
  ClaimCaptureModeSchema,
  ClaimKindSchema,
  ClaimStatusSchema,
  EdgeKindSchema,
  ProvenanceSchema,
} from "./enums.ts";

export const MAX_CLAIM_BODY_LENGTH = 10_000;

/**
 * Hard cap on the file set ONE CLAIM may declare as its affected surface
 * (1.0 spec 02 §3.2). The same number MAX_PIN_FILES uses, and it is stated
 * here rather than imported from pin.ts because claim.ts importing pin.ts
 * closes a module cycle (pin → question → claim); ddl-sync keeps the two in
 * step. Both answer "how big may a hand-declared surface be before it is an
 * area", and an area-sized surface makes every commit in the area a downgrade.
 */
export const MAX_CLAIM_SURFACE_PATHS = 30;

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
    /**
     * WHO captured this claim, from a vocabulary that cannot say `human`
     * (1.0 spec 08 §3.2a). `CLAIM_CAPTURE_MODES` carries the reasoning,
     * including why this is a narrower enum rather than the hub stamp the
     * spec asks for — the hub cannot tell the two lanes apart.
     */
    captureMode: ClaimCaptureModeSchema,
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
    /**
     * WHICH FILES this claim is about, when the author said so (spec 02 §3.2).
     *
     * Absent or empty is the normal case and is NOT a statement that the claim
     * touches nothing: the revalidation then falls back to the work context's
     * own `file` targets, which over-fires by design. The two are told apart
     * on the hub by `claim_revalidations.basis`.
     *
     * Same repo-relative POSIX rule and the same cap as a pin's file set,
     * inherited by name — an area-sized surface makes every commit in the area
     * a downgrade.
     */
    affectedPaths: z
      .array(repoRelativePath)
      .max(MAX_CLAIM_SURFACE_PATHS)
      .default([]),
    /**
     * ONE POINTER AT A MACHINE-PRODUCED OBSERVATION (1.0 spec 08 §3.4).
     *
     * `"<kind>:<value>"`, kind from `VERIFICATION_REF_KINDS`. This is the only
     * new byte 08 stores, and it is a POINTER rather than content: no tool
     * output, no stack trace, no failure message (non-negotiable #6). It
     * resolves against rows the hub already holds — a `work_context_targets`
     * error fingerprint, or a `ci_test_results` row.
     *
     * ABSENT MEANS `unsupported` / `no_verification_ref`, NEVER "unknown,
     * assume good". That is principle 5 as a field default: missing evidence
     * may weaken a conclusion, it must never strengthen one.
     *
     * STORED WITHOUT BEING RESOLVED, for the same reason `evidenceRefs` are:
     * the row it names may arrive later in the same spool flush, so refusing an
     * unresolvable ref at ingest would reject the correct records of anyone
     * whose batch happens to be ordered the other way. Resolution is a
     * READ-time question, and it is allowed to answer "no" — that is what
     * `ref_unresolved` is for.
     *
     * ONE REF PER CLAIM. A second verification is a second CLAIM: claims are
     * append-only and a revision means a new row (`services/hints.ts:68-70`).
     * REFUSED — widening `evidenceRefs` to carry these instead, which would
     * give one live `jsonb` array two different meanings.
     *
     * Bounded by a constant DERIVED from 05's test-id cap, never a second
     * literal (`MAX_VERIFICATION_REF_CHARS`).
     */
    verificationRef: z.string().max(MAX_VERIFICATION_REF_CHARS).optional(),
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