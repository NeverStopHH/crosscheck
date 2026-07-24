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
export const ArtifactSensitivitySchema = z.enum(ARTIFACT_SENSITIVITIES);

export type ClaimKind = z.infer<typeof ClaimKindSchema>;
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;
export type EdgeKind = z.infer<typeof EdgeKindSchema>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type CaptureMode = z.infer<typeof CaptureModeSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type TargetKind = z.infer<typeof TargetKindSchema>;
export type ArtifactSensitivity = z.infer<typeof ArtifactSensitivitySchema>;