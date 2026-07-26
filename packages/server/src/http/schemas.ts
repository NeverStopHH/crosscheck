import { SessionStatusSchema } from "@crosscheck/schema";
import { z } from "zod";

import { EVENTS_DEFAULT_LIMIT } from "../constants.ts";

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

export type RegisterSessionBody = z.infer<typeof RegisterSessionBodySchema>;
export type SessionStatusBody = z.infer<typeof SessionStatusBodySchema>;
export type EventsQuery = z.infer<typeof EventsQuerySchema>;