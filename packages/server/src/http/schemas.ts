import { SessionStatusSchema } from "@crosscheck/schema";
import { z } from "zod";

import {
  EVENTS_DEFAULT_LIMIT,
  SOLVED_MATCH_MAX_FINGERPRINT_CHARS,
  WORK_CONTEXT_LIST_MAX,
} from "../constants.ts";

export const CreateDeveloperBodySchema = z.object({
  name: z.string().min(1),
  email: z.email(),
});

/** Field rules consistent with AgentSessionSchema in @crosscheck/schema. */
export const RegisterSessionBodySchema = z.object({
  id: z.string().min(1),
  agentKind: z.string().min(1),
  repo: z.string().min(1),
  branch: z.string().min(1),
  baseCommit: z.string().min(1),
  status: SessionStatusSchema,
});

export const SessionStatusBodySchema = z.object({
  status: SessionStatusSchema.optional(),
});

export const PresenceQuerySchema = z.object({
  repo: z.string().min(1),
});

/** Same shape as the presence query — every repo-scoped list uses it. */
export const RepoQuerySchema = PresenceQuerySchema;

/**
 * GET /api/solved-matches: the repo, plus the optional exact-fingerprint
 * probe. Bounded rather than free text — the value goes straight into an
 * indexed equality lookup, and an unbounded string parameter on a hot path
 * is a shape this hub does not accept anywhere else (SEARCH_MAX_QUERY_CHARS
 * is the same rule one surface over). Refused with 400, never clamped: a
 * silently truncated fingerprint matches the wrong failure, or nothing, and
 * the caller is told neither.
 */
export const SolvedMatchQuerySchema = z.object({
  repo: z.string().min(1),
  fingerprint: z
    .string()
    .min(1)
    .max(SOLVED_MATCH_MAX_FINGERPRINT_CHARS)
    .optional(),
  /** `1` asks for the precision counters instead of the listing. */
  counts: z.literal("1").optional(),
});

/** Oversized limits are capped in the events service, not rejected here. */
export const EventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).default(EVENTS_DEFAULT_LIMIT),
});

/**
 * The work-context listing's window (trial finding M8), following
 * `EventsQuerySchema` above: coerce, default here, cap in the service.
 *
 * `since` is OPTIONAL with no default, which is the compatibility decision
 * itself: an old connector sends neither parameter and keeps getting the whole
 * (capped) list rather than silently losing everything older than a
 * server-chosen window. `limit` defaults to the cap for the same reason —
 * omitting it can only ever mean "as much as you will give me".
 */
export const WorkContextsQuerySchema = z.object({
  repo: z.string().min(1),
  since: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).default(WORK_CONTEXT_LIST_MAX),
});

export type WorkContextsQuery = z.infer<typeof WorkContextsQuerySchema>;

export type RegisterSessionBody = z.infer<typeof RegisterSessionBodySchema>;
export type SessionStatusBody = z.infer<typeof SessionStatusBodySchema>;
export type EventsQuery = z.infer<typeof EventsQuerySchema>;