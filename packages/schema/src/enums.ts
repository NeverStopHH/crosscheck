import { z } from "zod";

export const CLAIM_KINDS = [
  "observation",
  "hypothesis",
  "evidence",
  "root_cause",
  "decision",
  "rejected_approach",
] as const;

export const CLAIM_STATUSES = [
  "proposed",
  "partially_confirmed",
  "likely_root_cause",
  "rejected",
  "superseded",
] as const;

export const EDGE_KINDS = [
  "supports",
  "contradicts",
  "deeper_cause_of",
  "supersedes",
  "relates_to",
] as const;

export const SESSION_STATUSES = [
  "analyzing",
  "planning",
  "implementing",
  "testing",
  "blocked",
  "done",
] as const;

export const CAPTURE_MODES = ["auto", "agent", "human"] as const;

/**
 * The capture modes a CLAIM may carry (1.0 spec 08 §3.2a, AT-3's write path).
 *
 * `human` IS ABSENT, AND ITS ABSENCE IS THE POINT. `capture_mode` is a TRUST
 * LABEL: a reader meeting `human` reads the sentence as a person's word. No
 * writer in this tree has ever produced it on a claim — seven stamp a mode,
 * four `agent` and three `auto`, and zero `human` (08 §1.3) — but the field
 * rode the wire verbatim into the row (`record-handlers.ts`), so a hand-rolled
 * POST under a developer bearer key could mint one, and that key sits in
 * plaintext in `~/.crosscheck/config.json` where any agent on the machine can
 * read it. Narrowing the vocabulary makes the forgery UNSAYABLE rather than
 * merely unsaid: a body naming it fails at the boundary with the field named.
 *
 * REFUSED, NOT DOWNGRADED — the second half of AT-3's sentence. A claim body
 * is parsed by `ClaimSchema` before ingest, so `human` is a parse failure and
 * never reaches a row. It is NOT quietly rewritten to `agent`, which would
 * leave the caller believing a human's word had been recorded.
 *
 * WHY THIS IS A NARROWER ENUM AND NOT THE HUB STAMP 08 §3.2a ASKS FOR.
 * The spec says the hub should stamp the mode "from the route and the
 * producer", modelled on #50's pins, where the hub stamps `human` and the body
 * may never carry it. That does not transfer, and the difference is measurable
 * rather than a matter of taste. A pin has ONE legal value, so a stamp needs no
 * information. A claim has two, and nothing at the boundary separates them:
 * both lanes land on the same route — the MCP tools post to `/api/records`
 * through `postRecords`, the derived writers reach the same handler through the
 * spool flush — and both carry the identical `producer` block, because the same
 * session runs both. A hub stamping this field would be guessing.
 *
 * Nor is it derivable from `provenance`, which is the obvious next idea: six of
 * the seven writers do pair `derived→auto` and `declared→agent`, but
 * `review-draft.ts` breaks it deliberately. A DISCARDED draft is `agent` +
 * `derived` — the agent ACTED on it but did not VOUCH for it — and that pairing
 * is the record of a real event. Deriving the label from provenance would
 * relabel every discard as `auto` and erase the agent from it.
 *
 * So the two values stay sender-chosen, and the honest statement of what that
 * buys is narrow: this stops the forgery of a HUMAN's word, which is the trust
 * escalation, and it does not stop a lying agent from writing `auto` on its own
 * declaration. That second one is a step DOWN in authority, and it is the WHO
 * axis of 08 §3.1 — derived fresh per read — that answers it, not this enum.
 */
export const CLAIM_CAPTURE_MODES = ["auto", "agent"] as const;

export const PROVENANCES = ["declared", "derived"] as const;

export const TARGET_KINDS = [
  "file",
  "symbol",
  "component",
  "error_fingerprint",
] as const;

/**
 * WHERE a file target came from (regression-guard Stage 1). Two sources,
 * because they fail in opposite directions: the tool lane sees an `Edit` the
 * host reported and nothing a Bash command did, while the git lane sees every
 * working-tree change at Stop and cannot tell which tool made it. `sed -i`,
 * codemods, `prettier --write` and generators are invisible to the first,
 * which is exactly how a ranking built on it alone names the session that
 * used Edit while the codemod session leaves no trace at all.
 */
export const TARGET_SOURCES = ["tool_edit", "git_diff"] as const;

/**
 * What the HUB may hold. "both" is derived on ingest — never sent — when the
 * same (context, kind, value) arrives from the other lane: the primary key
 * collapses the two rows into one, and without this third value whichever
 * lane arrived first would silently own the label.
 */
export const STORED_TARGET_SOURCES = [...TARGET_SOURCES, "both"] as const;

/**
 * HOW PRECISELY we know which commit a claim was observed at (1.0 spec 02).
 *
 * Not a lane and not a source — `work_context_targets.source` says WHICH
 * OBSERVER saw a file, and folding the two into one enum is the defect spec
 * 02 §9 names. This says how much the "when" is worth:
 *
 *   reported      — the emitter sent its own HEAD with the claim.
 *   session_base  — ingest fell back to the author session's base_commit.
 *                   An APPROXIMATION in BOTH directions, deliberately not
 *                   called a lower bound: a session re-registers on recovery
 *                   and on SessionStart re-fires, and each re-registration
 *                   REWRITES base_commit (server services/sessions.ts), so the
 *                   stored value can be later than the observation as easily
 *                   as earlier.
 *   none          — nothing usable reached the row, so the claim can never be
 *                   revalidated and is never unsolicited substance. Unknown
 *                   fails CLOSED on the code axis.
 */
export const CLAIM_COMMIT_BINDINGS = [
  "reported",
  "session_base",
  "none",
] as const;

/** Where a revalidation's file set came from — declared by the author, or the
 * whole work context's file targets, which OVER-fires by construction. */
export const CLAIM_REVALIDATION_BASES = ["declared", "context_targets"] as const;

/**
 * What a revalidation found. `SolvedFileDrift`'s three states VERBATIM
 * (connector-core git/solved-staleness.ts) — one vocabulary for "did the code
 * move", with `unknown` first-class, and deliberately NOT `PinPathStatus`
 * (present|missing|unknown), which is a different question about a different
 * object.
 */
export const CLAIM_REVALIDATION_RESULTS = [
  "changed",
  "unchanged",
  "unknown",
] as const;

/**
 * HOW MUCH A RECORDED CLAIM IS STILL WORTH ABOUT THE CODE (1.0 spec 02 §3.5).
 *
 * Five states, derived on read by ONE function — server
 * services/claim-validity.ts — and never stored. The vocabulary lives here so
 * the hub and every connector spell it identically; the RESOLUTION lives there
 * so there is one place that decides.
 *
 *   current      a revalidation looked and the surface had not moved
 *   superseded   a `supersedes` edge points at this claim
 *   invalidated  the author set status `rejected`
 *   stale        a revalidation looked and the surface HAD moved
 *   unknown      nobody looked, the look failed, or the claim is bound to
 *                no commit at all
 */
export const CLAIM_VALIDITY_STATES = [
  "current",
  "superseded",
  "invalidated",
  "stale",
  "unknown",
] as const;

export const ARTIFACT_SENSITIVITIES = [
  "team_visible",
  "needs_approval",
] as const;

export const ClaimKindSchema = z.enum(CLAIM_KINDS);
export const ClaimCommitBindingSchema = z.enum(CLAIM_COMMIT_BINDINGS);
export const ClaimValidityStateSchema = z.enum(CLAIM_VALIDITY_STATES);
export const ClaimRevalidationBasisSchema = z.enum(CLAIM_REVALIDATION_BASES);
export const ClaimRevalidationResultSchema = z.enum(CLAIM_REVALIDATION_RESULTS);
export const ClaimStatusSchema = z.enum(CLAIM_STATUSES);
export const EdgeKindSchema = z.enum(EDGE_KINDS);
export const SessionStatusSchema = z.enum(SESSION_STATUSES);
export const CaptureModeSchema = z.enum(CAPTURE_MODES);
export const ClaimCaptureModeSchema = z.enum(CLAIM_CAPTURE_MODES);
export const ProvenanceSchema = z.enum(PROVENANCES);
export const TargetKindSchema = z.enum(TARGET_KINDS);
export const TargetSourceSchema = z.enum(TARGET_SOURCES);
export const ArtifactSensitivitySchema = z.enum(ARTIFACT_SENSITIVITIES);

export type ClaimKind = z.infer<typeof ClaimKindSchema>;
export type ClaimCommitBinding = z.infer<typeof ClaimCommitBindingSchema>;
export type ClaimValidityState = z.infer<typeof ClaimValidityStateSchema>;
export type ClaimRevalidationBasis = z.infer<typeof ClaimRevalidationBasisSchema>;
export type ClaimRevalidationResult = z.infer<typeof ClaimRevalidationResultSchema>;
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;
export type EdgeKind = z.infer<typeof EdgeKindSchema>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type CaptureMode = z.infer<typeof CaptureModeSchema>;
export type ClaimCaptureMode = z.infer<typeof ClaimCaptureModeSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type TargetKind = z.infer<typeof TargetKindSchema>;
export type TargetSource = z.infer<typeof TargetSourceSchema>;
export type StoredTargetSource = (typeof STORED_TARGET_SOURCES)[number];
export type ArtifactSensitivity = z.infer<typeof ArtifactSensitivitySchema>;