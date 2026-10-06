/**
 * WHAT A HINT MAY SHOW AS A TEAMMATE'S FINDING — the trust half of the
 * substance gate (DESIGN.md §4), here so the hub can WITHHOLD every other
 * body on the hint wire (hold-out review, M1). A connector older than the
 * substance rules — 0.10.0 inlines a rejected approach or a proposed root
 * cause — then has nothing to inline; the current connector's selector
 * applies the same rule again (connector-core hints/select.ts, pinned to
 * this one by hint-substance-trust-parity.test.ts) beside what only it can
 * judge: the match, and whether the code moved.
 *
 * Substance is a DECLARED claim, not superseded, of a substance shape — a
 * root cause whose status is settled, or a decision its author stated and
 * nobody took back — whose evidence RESOLVES (evidence-resolution.ts) and
 * whose body holds a sentence worth showing (substance-sentence.ts).
 */
import { substanceSentence } from "./substance-sentence.ts";

/** The statuses that settle a root cause enough to show it. */
export const SUBSTANCE_ROOT_CAUSE_STATUSES: ReadonlySet<string> = new Set(["likely_root_cause", "partially_confirmed"]);
export const SUBSTANCE_MIN_EVIDENCE_REFS = 1;

export interface SubstanceCandidate {
  readonly provenance: string;
  readonly kind: string;
  readonly status: string;
  readonly body: string;
  /** Refs that resolve to evidence — never the stored count. */
  readonly resolvedEvidenceRefs: number;
}

/** A settled root cause, or a decision still as its author stated it. */
export const isSubstanceShape = (kind: string, status: string): boolean =>
  (kind === "root_cause" && SUBSTANCE_ROOT_CAUSE_STATUSES.has(status)) || (kind === "decision" && status === "proposed");

export const qualifiesAsSubstance = (claim: SubstanceCandidate): boolean =>
  claim.provenance === "declared" &&
  claim.status !== "superseded" &&
  isSubstanceShape(claim.kind, claim.status) &&
  claim.resolvedEvidenceRefs >= SUBSTANCE_MIN_EVIDENCE_REFS &&
  substanceSentence(claim.body).length > 0;
