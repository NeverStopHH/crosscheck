import { z } from "zod";

import { COMMIT_SHA_PATTERN } from "./commit-sha.ts";

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
 * A commit named on the wire must already look like an object name — nothing
 * flag- or prose-shaped may reach git or SQL.
 *
 * RE-EXPORTED, NOT REDECLARED, and the merge is why. 05 defined the pattern
 * here so its CI wire could reuse it "instead of minting a third copy"; 02
 * had meanwhile moved the pattern into `commit-sha.ts` as one authority.
 * Union the two and there are two declarations of one name — the very drift
 * 05's own comment warned about, produced by the fix for it. The definition
 * lives in `commit-sha.ts`; this line keeps 05's importers working without a
 * second copy to widen.
 */
export { COMMIT_SHA_PATTERN } from "./commit-sha.ts";

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
