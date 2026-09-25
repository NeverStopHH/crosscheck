/**
 * The wire contract of the why behind a landed change
 * (docs/1.0/landed-changes.md, step 3): the connector asks, for the commits
 * a pre-edit stop names, whose work on the file they were; `doctor` asks which
 * commit author addresses belong to nobody on the hub.
 *
 * ADDRESSES GO IN, NEVER OUT. The request carries each commit's author
 * address — the reader's own clone already has it — so the hub can map it to
 * a developer; nothing the hub answers carries one. A POST, because an
 * address in a URL ends up in access logs.
 */
import { z } from "zod";

import { COMMIT_SHA_PATTERN } from "./commit-sha.ts";

/** Commits one stop names: MAX_LANDED_COMMITS_SHOWN is 3, so this is room, not a target. */
export const LANDED_CONTEXT_MAX_COMMITS = 10;
/** Distinct author addresses one doctor run asks about. */
export const LANDED_AUTHORS_MAX_EMAILS = 200;

const MAX_EMAIL_CHARS = 320;
const MAX_PATH_CHARS = 4096;

const AuthorEmailSchema = z
  .string()
  .min(3)
  .max(MAX_EMAIL_CHARS)
  .refine((value) => value.includes("@"), "an author address");

export const LandedContextCommitSchema = z.object({
  sha: z.string().regex(COMMIT_SHA_PATTERN),
  /** After the repo's .mailmap: the probe's own matching key. */
  authorEmail: AuthorEmailSchema,
  /** The commit's committer time — for a squash, when it landed. */
  committedAt: z.iso.datetime(),
});

export const LandedContextRequestSchema = z.object({
  repo: z.string().min(1),
  /** Repo-relative, as git names it. */
  path: z.string().min(1).max(MAX_PATH_CHARS),
  commits: z.array(LandedContextCommitSchema).min(1).max(LANDED_CONTEXT_MAX_COMMITS),
});

export type LandedContextRequest = z.infer<typeof LandedContextRequestSchema>;
export type LandedContextCommit = z.infer<typeof LandedContextCommitSchema>;

export const LandedAuthorsRequestSchema = z.object({
  emails: z.array(AuthorEmailSchema).max(LANDED_AUTHORS_MAX_EMAILS),
});

export type LandedAuthorsRequest = z.infer<typeof LandedAuthorsRequestSchema>;
