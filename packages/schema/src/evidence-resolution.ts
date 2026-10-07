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
 *     ever resolves within one tree;
 *   - NO NEWER THAN THE CITING CLAIM (round 3, M2, principle 5: a revision
 *     only ever weakens): a head written after the claim that cites it is
 *     not what was cited — "Retracted: the 429s came from our own proxy" is
 *     an observation with content, and it kept a root cause backed;
 *   - not CONTRADICTED: a contradicts edge on the cited claim or its head —
 *     a teammate saying it is not so — un-backs it, whoever drew it, since
 *     un-backing only weakens.
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
  /** When the head was written (ISO-8601) — never after the citing claim (M2). */
  readonly createdAt: string;
  /** A contradicts edge points at the cited claim or at this head (M2). */
  readonly isContradicted: boolean;
}

/** The fields the rule reads of the claim that cites. */
export interface CitingClaim {
  readonly id: string;
  readonly createdAt: string;
}

/** Written no later than the citing claim; an unreadable time fails closed. */
const isNoNewerThan = (headCreatedAt: string, citingCreatedAt: string): boolean =>
  Date.parse(headCreatedAt) <= Date.parse(citingCreatedAt);

/** The ref `citedId`, resolved to `head`, counts as evidence for `citing`. */
export const isEvidenceFor = (citing: CitingClaim, citedId: string, head: CitedHead): boolean =>
  citedId !== citing.id &&
  head.id !== citing.id &&
  head.provenance === DECLARED &&
  !NOT_STANDING.has(head.status) &&
  EVIDENCE_KINDS.has(head.kind) &&
  !head.isContradicted &&
  isNoNewerThan(head.createdAt, citing.createdAt) &&
  contentWordCount(head.body) >= EVIDENCE_MIN_CONTENT_WORDS;

/**
 * The heads a claim's revisions end in: every claim nothing supersedes that
 * the revisions reach within REVISION_MAX_DEPTH steps. A cycle has no head.
 *
 * ONE LEVEL AT A TIME, EACH CLAIM ONCE PER LEVEL (hold-out review round 3,
 * M4): a walk of every PATH visited a diamond ladder — three revisions per
 * level, each superseding all three below — 3^16 times over 49 claims. Level
 * by level, the claims one step on are taken as a set, so the cost is at most
 * the claims and edges within the bound once per level, whatever their shape;
 * a cycle simply keeps its level non-empty until the bound.
 */
export const revisionHeads = (claimId: string, successorsOf: (id: string) => readonly string[]): readonly string[] => {
  const walk = (frontier: readonly string[], depth: number, heads: readonly string[]): readonly string[] => {
    if (frontier.length === 0 || depth > REVISION_MAX_DEPTH) {
      return heads;
    }
    const ends = frontier.filter((id) => successorsOf(id).length === 0);
    const next = [...new Set(frontier.flatMap(successorsOf))];
    return walk(next, depth + 1, [...heads, ...ends]);
  };
  return [...new Set(walk([claimId], 0, []))];
};
