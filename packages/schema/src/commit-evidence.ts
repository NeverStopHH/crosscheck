import { z } from "zod";

/**
 * One connector's reading of recent commit authorship in a repo (DESIGN.md §3
 * Tier 0: deterministic, zero LLM). This is the evidence the absence check
 * rests on, and it deliberately needs NOTHING from the developer it is about:
 * a pushed commit proves they worked, whether or not their connector ever ran.
 *
 * The author's git identity travels here because it is the hub's matching key
 * against `developers.email`. It is already-shared team data — every clone of
 * the repo carries the same `git log` — so shipping it to the hub widens
 * nothing. What the hub does with it is the narrowing step: absence responses
 * carry names only, never emails (server services/absences.ts).
 */
export const MAX_COMMIT_EVIDENCE_AUTHORS = 50;

/** Longest git window a connector may claim to have scanned. */
const MAX_WINDOW_DAYS = 90;

const MAX_AUTHOR_NAME_CHARS = 200;
/** RFC 5321 path ceiling; git enforces nothing, so the wire contract must. */
const MAX_AUTHOR_EMAIL_CHARS = 320;

export const CommitAuthorEvidenceSchema = z.looseObject({
  name: z.string().min(1).max(MAX_AUTHOR_NAME_CHARS),
  email: z.string().min(1).max(MAX_AUTHOR_EMAIL_CHARS),
  latestCommitAt: z.iso.datetime(),
  commitCount: z.number().int().min(1),
});

export const CommitEvidenceSchema = z.looseObject({
  repo: z.string().min(1),
  collectedAt: z.iso.datetime(),
  windowDays: z.number().int().min(1).max(MAX_WINDOW_DAYS),
  // min(1): a repo with no recent commits produces no record at all — an empty
  // author list carries no evidence and would only cost an ingest round trip.
  authors: z
    .array(CommitAuthorEvidenceSchema)
    .min(1)
    .max(MAX_COMMIT_EVIDENCE_AUTHORS),
});

export type CommitAuthorEvidence = z.infer<typeof CommitAuthorEvidenceSchema>;
export type CommitEvidence = z.infer<typeof CommitEvidenceSchema>;
