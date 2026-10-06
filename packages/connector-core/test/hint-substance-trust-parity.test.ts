/**
 * The hub withholds every body a hint may not show (hold-out review, M1),
 * deciding with `qualifiesAsSubstance` (@crosscheck/schema
 * substance-trust.ts); the connector's selector decides again with its own
 * gate (hints/select.ts). Two spellings of one trust rule must answer
 * alike, or the hub withholds a body the selector would show (a silent
 * pointer) or ships one it would refuse. This runs the whole matrix of
 * kinds, statuses, provenances, resolved evidence and bodies through both.
 */
import { describe, expect, test } from "bun:test";
import { CLAIM_KINDS, CLAIM_STATUSES, qualifiesAsSubstance } from "@crosscheck/schema";

import { HINT_MIN_SHARED_TERMS } from "../src/constants.ts";
import { selectHint } from "../src/hints/select.ts";
import type { HintClaimCandidate, HintContextCandidate } from "../src/http/hub.ts";

const ISO = "2026-08-10T08:00:00.000Z";
const SENTENCE = "Keep the chunked upload; the single PUT hits the gateway body limit above 2 GB.";

const claim = (kind: string, status: string, provenance: string, resolved: number, body: string): HintClaimCandidate => ({
  id: "clm_matrix",
  workContextId: "wc_1",
  kind,
  status,
  confidence: 0.7,
  provenance,
  captureMode: "agent",
  evidenceRefCount: resolved,
  evidenceBacked: resolved > 0,
  authorDeveloperId: "dev_nick",
  authorDeveloperName: "Ken",
  body,
  matchedTerms: HINT_MIN_SHARED_TERMS,
  createdAt: ISO,
});

const context = (only: HintClaimCandidate): HintContextCandidate => ({
  workContext: {
    id: "wc_1",
    title: "Upload stalls",
    status: "implementing",
    tier: "fts",
    developerId: "dev_nick",
    developerName: "Ken",
    baseCommit: "a1b2c3d4",
    createdAt: ISO,
    updatedAt: null,
  },
  claims: [only],
  matchedTargets: [],
  matchedOn: "prompt",
  sharedTerms: HINT_MIN_SHARED_TERMS,
});

const MATRIX = CLAIM_KINDS.flatMap((kind) =>
  CLAIM_STATUSES.flatMap((status) =>
    ["declared", "derived"].flatMap((provenance) =>
      [0, 1].flatMap((resolved) => [SENTENCE, "1."].map((body) => ({ kind, status, provenance, resolved, body }))),
    ),
  ),
);

describe("the hub's withholding rule and the selector's gate answer alike", () => {
  test(`over all ${String(MATRIX.length)} shapes, a body the hub keeps is a body the selector shows, and only those`, () => {
    // Act
    const disagreements = MATRIX.filter(({ kind, status, provenance, resolved, body }) => {
      const selection = selectHint({
        candidates: [context(claim(kind, status, provenance, resolved, body))],
        seenRefIds: [],
        deliveredCount: 0,
        selfDeveloperId: "dev_self",
        promptTerms: [],
      });
      const shows = selection.kind === "claim";
      return shows !== qualifiesAsSubstance({ kind, status, provenance, body, resolvedEvidenceRefs: resolved });
    });

    // Assert
    expect(disagreements).toEqual([]);
  });
});
