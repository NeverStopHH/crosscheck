import { z } from "zod";

/**
 * One connector's bounded git reading of which commits are ancestors of the
 * repo's default branch (DESIGN.md §5 merged-branch detection). Like commit
 * evidence, this is Tier-0 fact about already-shared git history: every clone
 * can run the same ancestry check, so it is not owner-gated — the hub maps
 * commits to work contexts through the owning session's base_commit itself,
 * and a report can therefore only ever assert "this sha is on the default
 * branch", never "this context is done".
 */
export const MAX_LANDED_COMMITS = 20;

/**
 * A commit named on the wire must already look like an object name — the
 * same guard the connector's own git callers apply (COMMIT_SHA_PATTERN in
 * git/commit-drift.ts): nothing flag- or prose-shaped may reach git or SQL.
 */
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

/** Longest ref label a connector may claim it checked against. */
const MAX_DEFAULT_BRANCH_CHARS = 200;

export const LandedEvidenceSchema = z.looseObject({
  repo: z.string().min(1),
  /** Which ref the ancestry was checked against — context, not a key. */
  defaultBranch: z.string().min(1).max(MAX_DEFAULT_BRANCH_CHARS).optional(),
  checkedAt: z.iso.datetime(),
  // min(1): nothing landed produces no record at all — an empty list carries
  // no evidence and would only cost an ingest round trip.
  commits: z
    .array(z.string().regex(COMMIT_SHA_PATTERN))
    .min(1)
    .max(MAX_LANDED_COMMITS),
});

export type LandedEvidence = z.infer<typeof LandedEvidenceSchema>;
