/**
 * WHAT A CITED CLAIM MUST BE TO COUNT AS EVIDENCE (DESIGN.md §4, hold-out
 * review H5 + M2) — one rule, read at read time, for the hint's
 * `evidenceBacked`, the hub's solved label and the connector's solved
 * mirror. Two spellings were two rules: the solved label counted any ref at
 * all, so a root cause citing itself, a draft, a refuted observation or a
 * decision that cites it back read SOLVED.
 *
 * A ref resolves to the HEAD of the cited claim's revision chain — what it
 * was revised into through supersedes edges, if it was (`revisionHeads`) —
 * and counts when that head is:
 *   - declared: somebody vouched for it, never a derived or unreviewed draft;
 *   - standing: not rejected and not superseded;
 *   - of an EVIDENCE KIND, an observation or a piece of evidence — never a
 *     root cause, a decision, a hypothesis or a rejected approach: a
 *     conclusion backs no conclusion, so no citing cycle can back itself;
 *   - neither the citing claim nor in its revision chain: a revision citing
 *     the claim it retracts resolves to itself;
 *   - real content, at least EVIDENCE_MIN_CONTENT_WORDS content words — "x"
 *     and "See above." back nothing;
 *   - in the citing claim's repo: the hub checks it, and the connector only
 *     ever resolves within one tree.
 * Recomputed on every read, so a cited claim refuted or retracted later
 * flips every claim that leaned on it.
 */
import { contentWordCount } from "./substance-sentence.ts";

export const EVIDENCE_KINDS: ReadonlySet<string> = new Set(["observation", "evidence"]);
export const EVIDENCE_MIN_CONTENT_WORDS = 3;
/** How far a ref follows revisions; a chain this long is a cycle or abuse. */
export const REVISION_MAX_DEPTH = 16;

const DECLARED = "declared";
const NOT_STANDING: ReadonlySet<string> = new Set(["rejected", "superseded"]);

/** The fields the rule reads of the head a ref resolved to. */
export interface CitedHead {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly provenance: string;
  readonly body: string;
}

/** The ref `citedId`, resolved to `head`, counts as evidence for `citingId`. */
export const isEvidenceFor = (citingId: string, citedId: string, head: CitedHead): boolean =>
  citedId !== citingId &&
  head.id !== citingId &&
  head.provenance === DECLARED &&
  !NOT_STANDING.has(head.status) &&
  EVIDENCE_KINDS.has(head.kind) &&
  contentWordCount(head.body) >= EVIDENCE_MIN_CONTENT_WORDS;

/**
 * The heads a claim's revisions end in: follow every claim that supersedes
 * it until one nothing supersedes. A cycle has no head, and the walk stops
 * at REVISION_MAX_DEPTH either way.
 */
export const revisionHeads = (
  claimId: string,
  successorsOf: (id: string) => readonly string[],
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): readonly string[] => {
  if (seen.has(claimId) || depth > REVISION_MAX_DEPTH) {
    return [];
  }
  const successors = successorsOf(claimId);
  if (successors.length === 0) {
    return [claimId];
  }
  const visited = new Set([...seen, claimId]);
  return [...new Set(successors.flatMap((next) => revisionHeads(next, successorsOf, depth + 1, visited)))];
};
