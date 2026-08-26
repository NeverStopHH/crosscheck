import { SessionStatusSchema } from "@crosscheck/schema";
import { z } from "zod";

import { EVENTS_DEFAULT_LIMIT, WORK_CONTEXT_LIST_MAX } from "../constants.ts";

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