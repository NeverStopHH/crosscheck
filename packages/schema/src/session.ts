import { z } from "zod";

import { SessionStatusSchema, TargetKindSchema } from "./enums.ts";

const nonEmptyId = z.string().min(1);

export const AgentSessionSchema = z.looseObject({
  id: nonEmptyId,
  developerId: nonEmptyId,
  agentKind: z.string().min(1),
  repo: z.string().min(1),
  branch: z.string().min(1),
  baseCommit: z.string().min(1),
  status: SessionStatusSchema,
  startedAt: z.iso.datetime(),
  lastHeartbeatAt: z.iso.datetime().optional(),
  endedAt: z.iso.datetime().optional(),
});

export const WorkContextSchema = z.looseObject({
  id: nonEmptyId,
  sessionId: nonEmptyId,
  title: z.string().min(1),
  description: z.string().optional(),
  intent: z.record(z.string(), z.unknown()).optional(),
  status: SessionStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime().optional(),
});

export const TargetSchema = z.looseObject({
  workContextId: nonEmptyId,
  kind: TargetKindSchema,
  value: z.string().min(1),
});

export type AgentSession = z.infer<typeof AgentSessionSchema>;
export type WorkContext = z.infer<typeof WorkContextSchema>;
export type Target = z.infer<typeof TargetSchema>;