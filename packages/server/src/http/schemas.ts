import {
  SeqFieldSchema,
  SessionStatusSchema,
  TelemetryLossReportSchema,
} from "@crosscheck/schema";
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

/**
 * THE TWO SESSION EVENTS DO NOT TRAVEL AN ENVELOPE (spec 01 §3.2), and these
 * two bodies are where they actually go. A field has to be declared here as
 * well as on the envelope to be READ at all: zod 4's `z.object` STRIPS a key
 * it was not told about and answers 200 (docs/1.0/loss-accounting.md §4.2
 * carries the directive), so a `seq` sent against the old shape would have
 * been silently dropped rather than refused — an earlier version of this
 * comment said "refused", which is not what a strip does.
 *
 * `SeqFieldSchema` is the same union the wire uses: a stamp, or the refusal a
 * seq-capable connector sends when it could not allocate. Optional forever, so
 * a connector from before the field registers exactly as it always did.
 */
const SeqBodyField = { seq: SeqFieldSchema.optional() };

/**
 * THE CONNECTOR'S LOSS REPORT (docs/1.0/loss-accounting.md §4.2) rides the
 * same three bodies: counts and kinds of the telemetry it knows it did not
 * deliver. Optional forever for the same reason as `seq` — and the two
 * absences mean different things, so the service reads them apart: no
 * `losses` is a connector from before the field, never a report of zero.
 * A block from a NEWER connector than this hub parses too, because the kinds
 * map is loose on the wire and folded in the service (schema/telemetry-loss.ts).
 */
const LossBodyField = { losses: TelemetryLossReportSchema.optional() };

/** Field rules consistent with AgentSessionSchema in @crosscheck/schema. */
export const RegisterSessionBodySchema = z.object({
  id: z.string().min(1),
  agentKind: z.string().min(1),
  repo: z.string().min(1),
  branch: z.string().min(1),
  baseCommit: z.string().min(1),
  status: SessionStatusSchema,
  ...SeqBodyField,
  ...LossBodyField,
});

export const SessionStatusBodySchema = z.object({
  status: SessionStatusSchema.optional(),
  ...SeqBodyField,
  ...LossBodyField,
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