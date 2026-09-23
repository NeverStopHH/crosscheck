import { MAX_CI_TEST_ID_CHARS } from "./ci-run.ts";

/**
 * THE TWO EVIDENCE AXES (1.0 spec 08 §3.1).
 *
 * A claim carried two trust labels and no third: `provenance` (declared or
 * derived) and `confidence` (a free number). A reader got `provenance declared ·
 * confidence 0.80` and nothing at all said whether anything was ever RUN.
 * `evidence_refs` is not that thing — it holds CLAIM IDS, so "what supports
 * this" meant "which other sentences the model listed" (08 §1.1).
 *
 * These two axes are ORTHOGONAL and the spec's principle 2 is why: *attribution
 * is not permission*. `human_declared` + `unsupported` is real and reachable, so
 * is `agent_derived` + `repository_verified`, and neither axis licenses the
 * other. Folding them into one "trust score" is the defect this replaces.
 *
 * DERIVED FRESH PER READ, never stored — like `CoverageRecord` (03 §3.2) and
 * SOLVED (*"derived fresh per read — no LLM, no stored flag, nothing to go
 * stale"*). The claim does not change; the world around its check does. A run
 * pruned past `CI_RETENTION_DAYS` moves a claim from `repository_verified` back
 * to `tool_observed`, and that is the honest answer at that moment, not a
 * regression.
 */

/**
 * WHO stands behind the claim.
 *
 * **In 1.0 every claim is `agent_derived`**, and that is the MEASURED truth
 * rather than a placeholder (08 §1.3): seven writers stamp a capture mode, four
 * `agent` and three `auto`, and zero `human`. Since §3.2a the wire cannot even
 * say `human` — `CLAIM_CAPTURE_MODES` excludes it — so the only way a
 * `human_declared` row could exist is a claim stored before that landed.
 *
 * The probe therefore fails CLOSED and stays closed until a human claim route
 * exists. This is principle 5's rule read forwards: missing evidence may weaken
 * a conclusion, never strengthen one. "Nobody recorded who wrote this" resolves
 * to the WEAKER label, never the stronger.
 */
export const EVIDENCE_WHO = ["human_declared", "agent_derived"] as const;

/**
 * WHAT was actually run, in three rungs of increasing strength.
 *
 *   unsupported          nothing machine-produced is attached, or the pointer
 *                        does not resolve. The DEFAULT, and the answer whenever
 *                        the question cannot be settled.
 *   tool_observed        a machine produced an observation of a named check,
 *                        the hub holds it structurally, and a reader with the
 *                        repository can re-run it (§3.3).
 *   repository_verified  red BEFORE and green AFTER, ordered by COMMIT and
 *                        never by clock (§3.5). Four legs, all required.
 *
 * **The hub re-checks nothing**, and the rung names are narrowed to fit that:
 * it holds no repository, runs no commands and makes no outbound calls. It
 * holds a pointer and resolves it against rows it already has.
 */
export const EVIDENCE_SUPPORT = [
  "unsupported",
  "tool_observed",
  "repository_verified",
] as const;

/**
 * WHY the support rung is what it is — an ENUM, never prose.
 *
 * Prose here would add an untrusted slot to every surface this label lands on,
 * and those surfaces include agent context. A reason is a closed vocabulary the
 * renderer can spell however it likes; it is never text that came from a claim,
 * a test id, or a model.
 *
 * Which rung each belongs to:
 *   no_verification_ref  unsupported          nothing was attached
 *   ref_malformed        unsupported          the pointer is not `<kind>:<value>`
 *   ref_unresolved       unsupported          the pointer names no row we hold
 *   observed_failure     tool_observed        a failure was seen; a fix was not
 *   ci_observed          tool_observed        CI saw the test; no red/green pair
 *   red_then_green       repository_verified  all four legs (§3.5)
 *   no_binding           tool_observed        the claim names no commit (02)
 *   no_ci_coverage       tool_observed        this repo has no CI lane (05)
 *   pruned_by_retention  tool_observed        the red run aged out (§10 D1)
 *   no_platform_rung     tool_observed        nothing here can verify this kind
 */
export const EVIDENCE_SUPPORT_REASONS = [
  "no_verification_ref",
  "ref_malformed",
  "ref_unresolved",
  "observed_failure",
  "ci_observed",
  "red_then_green",
  "no_binding",
  "no_ci_coverage",
  "pruned_by_retention",
  "no_platform_rung",
] as const;

/**
 * THE TWO PRODUCERS OF A MACHINE OBSERVATION THAT THIS TREE ACTUALLY HAS
 * (1.0 spec 08 §3.3). Not a taxonomy of what evidence could be — a list of what
 * exists here, and it is exactly two:
 *
 *   error_fingerprint  a connector-observed tool FAILURE, hashed. Resolves
 *                      against `work_context_targets`. Its alphabet is
 *                      `sha256:` plus hex, so it carries NO untrusted text.
 *   ci_test            a `ci_test_results` row (05 §3.3) — a non-green test, or
 *                      its ABSENCE from a `completed` run, which is how a green
 *                      is established. Its value is a test id, which is
 *                      AUTHOR-WRITTEN TEXT, and that is the reason the renderer
 *                      rule for it is pulled-only (§5).
 *
 * A profiler trace, a flame graph and a benchmark have no rung in 1.0 (§8.5).
 * Inventing one would be claiming the hub can resolve something it cannot.
 */
export const VERIFICATION_REF_KINDS = ["error_fingerprint", "ci_test"] as const;

/**
 * The kind half of a `"<kind>:<value>"` ref.
 *
 * MEASURED, not guessed: the longest member of `VERIFICATION_REF_KINDS` is
 * `error_fingerprint` at 17 characters, and 20 is that plus headroom for one
 * more kind of similar length without a migration.
 *
 * VERIFY: bun -e 'const m=await import("./packages/schema/src/evidence-axes.ts");console.log(Math.max(...m.VERIFICATION_REF_KINDS.map((k)=>k.length)))'
 * PRINTS: 17
 */
export const MAX_VERIFICATION_REF_KIND_CHARS = 20;

/**
 * The cap on a whole `"<kind>:<value>"` ref — DERIVED FROM 05's CONSTANT RATHER
 * THAN WRITTEN AS A SECOND LITERAL (00 §7.2).
 *
 * The longest legal value is a CI test id (`"<file>::<describe chain>::<name>"`,
 * `MAX_CI_TEST_ID_CHARS`), which is far longer than a `sha256:` fingerprint. A
 * hand-written number here would be a copy of 05's that nothing keeps in step,
 * and the day 05 raises its cap the refs it produces would start failing a
 * check nobody connected to it. The `+ 1` is the separating colon.
 *
 * VERIFY: bun -e 'const m=await import("./packages/schema/src/evidence-axes.ts");const c=await import("./packages/schema/src/ci-run.ts");console.log(m.MAX_VERIFICATION_REF_CHARS, c.MAX_CI_TEST_ID_CHARS + m.MAX_VERIFICATION_REF_KIND_CHARS + 1)'
 * PRINTS: 321 321
 */
export const MAX_VERIFICATION_REF_CHARS =
  MAX_CI_TEST_ID_CHARS + MAX_VERIFICATION_REF_KIND_CHARS + 1;

export type EvidenceWho = (typeof EVIDENCE_WHO)[number];
export type EvidenceSupport = (typeof EVIDENCE_SUPPORT)[number];
export type EvidenceSupportReason = (typeof EVIDENCE_SUPPORT_REASONS)[number];
export type VerificationRefKind = (typeof VERIFICATION_REF_KINDS)[number];

/**
 * What a reader is told about one claim's evidence.
 *
 * `observedAt` is NULLABLE and its null means AGE UNKNOWN, never UNOBSERVED —
 * `work_context_targets.created_at` is nullable by design, and collapsing those
 * two meanings is how "we do not know when" becomes "it never happened".
 */
export interface EvidenceAxes {
  readonly who: EvidenceWho;
  readonly support: EvidenceSupport;
  readonly supportReason: EvidenceSupportReason;
  /** When the tool ran. Null = age unknown, NOT unobserved. */
  readonly observedAt: string | null;
  /** The commit a `repository_verified` green was established at. */
  readonly verifiedAtCommit: string | null;
}
