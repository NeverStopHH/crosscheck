import { z } from "zod";

import { hubRequest } from "./client.ts";
import type { HubContext, HubResult } from "./client.ts";

export const PresenceEntrySchema = z.looseObject({
  sessionId: z.string().min(1),
  developerId: z.string().min(1),
  developerName: z.string().min(1),
  branch: z.string().min(1),
  /** Optional: an older hub may not send it, and drift is then simply omitted. */
  baseCommit: z.string().min(1).optional(),
  status: z.string().min(1),
  lastHeartbeatAt: z.string().min(1),
  isSelf: z.boolean(),
});

export type PresenceEntry = z.infer<typeof PresenceEntrySchema>;

export const WorkContextEntrySchema = z.looseObject({
  id: z.string().min(1),
  developerId: z.string().min(1),
  /** Authoritative author label; presence is only the fallback (DESIGN.md §4). */
  developerName: z.string().min(1).optional(),
  title: z.string().min(1),
  status: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().nullable().optional(),
});

export type WorkContextEntry = z.infer<typeof WorkContextEntrySchema>;

/**
 * One malformed row must not cost the whole briefing, so rows are validated
 * individually and unparseable ones are dropped.
 */
const tolerantList = <T>(
  field: string,
  itemSchema: z.ZodType<T>,
): z.ZodType<readonly T[]> =>
  z
    .looseObject({ [field]: z.array(z.unknown()) })
    .transform((value) =>
      (value[field] as unknown[])
        .map((item) => itemSchema.safeParse(item))
        .filter((parsed) => parsed.success)
        .map((parsed) => parsed.data),
    );

const SessionResponseSchema = z.looseObject({
  session: z.looseObject({
    id: z.string().min(1),
    developerId: z.string().min(1),
  }),
});

const IngestSummarySchema = z.looseObject({
  accepted: z.number().int().min(0),
  duplicates: z.number().int().min(0),
  ignored: z.number().int().min(0),
  rejected: z.number().int().min(0),
});

export type IngestSummary = z.infer<typeof IngestSummarySchema>;

export interface RegisterSessionInput {
  readonly id: string;
  readonly agentKind: string;
  readonly repo: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly status: string;
}

const encodeRepo = (repo: string): string =>
  `?repo=${encodeURIComponent(repo)}`;

export const registerSession = (
  ctx: HubContext,
  input: RegisterSessionInput,
): Promise<HubResult<z.infer<typeof SessionResponseSchema>>> =>
  hubRequest(ctx, {
    method: "POST",
    path: "/api/sessions",
    schema: SessionResponseSchema,
    body: input,
  });

export const heartbeatSession = (
  ctx: HubContext,
  sessionId: string,
  status?: string,
): Promise<HubResult<unknown>> =>
  hubRequest(ctx, {
    method: "POST",
    path: `/api/sessions/${encodeURIComponent(sessionId)}/heartbeat`,
    schema: z.unknown(),
    body: status === undefined ? {} : { status },
  });

export const endSession = (
  ctx: HubContext,
  sessionId: string,
): Promise<HubResult<unknown>> =>
  hubRequest(ctx, {
    method: "POST",
    path: `/api/sessions/${encodeURIComponent(sessionId)}/end`,
    schema: z.unknown(),
    body: { status: "done" },
  });

export const postRecords = (
  ctx: HubContext,
  records: readonly unknown[],
): Promise<HubResult<IngestSummary>> =>
  hubRequest(ctx, {
    method: "POST",
    path: "/api/records",
    schema: IngestSummarySchema,
    body: { records },
  });

export const getPresence = (
  ctx: HubContext,
  repo: string,
): Promise<HubResult<readonly PresenceEntry[]>> =>
  hubRequest(ctx, {
    method: "GET",
    path: `/api/presence${encodeRepo(repo)}`,
    schema: tolerantList("sessions", PresenceEntrySchema),
  });

export const getWorkContexts = (
  ctx: HubContext,
  repo: string,
): Promise<HubResult<readonly WorkContextEntry[]>> =>
  hubRequest(ctx, {
    method: "GET",
    path: `/api/work-contexts${encodeRepo(repo)}`,
    schema: tolerantList("workContexts", WorkContextEntrySchema),
  });
