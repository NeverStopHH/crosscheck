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

export const ARTIFACT_SENSITIVITIES = [
  "team_visible",
  "needs_approval",
] as const;

export const ClaimKindSchema = z.enum(CLAIM_KINDS);
export const ClaimStatusSchema = z.enum(CLAIM_STATUSES);
export const EdgeKindSchema = z.enum(EDGE_KINDS);
export const SessionStatusSchema = z.enum(SESSION_STATUSES);
export const CaptureModeSchema = z.enum(CAPTURE_MODES);
export const ProvenanceSchema = z.enum(PROVENANCES);
export const TargetKindSchema = z.enum(TARGET_KINDS);
export const TargetSourceSchema = z.enum(TARGET_SOURCES);
export const ArtifactSensitivitySchema = z.enum(ARTIFACT_SENSITIVITIES);

export type ClaimKind = z.infer<typeof ClaimKindSchema>;
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;
export type EdgeKind = z.infer<typeof EdgeKindSchema>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type CaptureMode = z.infer<typeof CaptureModeSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type TargetKind = z.infer<typeof TargetKindSchema>;
export type TargetSource = z.infer<typeof TargetSourceSchema>;
export type StoredTargetSource = (typeof STORED_TARGET_SOURCES)[number];
export type ArtifactSensitivity = z.infer<typeof ArtifactSensitivitySchema>;