import { z } from "zod";

import { DERIVED_CONFIDENCE_CAP } from "./claim.ts";
import {
  ProvenanceSchema,
  SessionStatusSchema,
  TargetKindSchema,
  TargetSourceSchema,
} from "./enums.ts";

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

/**
 * One sentence of what a session is trying to accomplish (trial finding
 * #15/#16): bounded like a claim body's little sibling, and carrying the same
 * trust labels a claim does. `declared` is the session's own statement
 * through the `set_intent` MCP tool (confidence 1); `derived` is the
 * connector's one-sentence model summary of the FIRST substantive prompt —
 * never the prompt itself — and is hard-capped at DERIVED_CONFIDENCE_CAP
 * exactly like a derived claim (DESIGN.md §3): machine inference does not get
 * to outrank a person here either.
 */
export const MAX_INTENT_SUMMARY_CHARS = 200;

export const IntentSchema = z
  .looseObject({
    summary: z.string().min(1).max(MAX_INTENT_SUMMARY_CHARS),
    provenance: ProvenanceSchema,
    confidence: z.number().min(0).max(1),
    capturedAt: z.iso.datetime(),
  })
  .check((ctx) => {
    const intent = ctx.value;
    if (
      intent.provenance === "derived" &&
      intent.confidence > DERIVED_CONFIDENCE_CAP
    ) {
      ctx.issues.push({
        code: "custom",
        message: `derived intents must not exceed confidence ${DERIVED_CONFIDENCE_CAP}`,
        input: intent.confidence,
        path: ["confidence"],
      });
    }
  });

export const WorkContextSchema = z.looseObject({
  id: nonEmptyId,
  sessionId: nonEmptyId,
  title: z.string().min(1),
  description: z.string().optional(),
  /**
   * Optional and NOT nullable on the wire: a work_context record without the
   * field says nothing about the intent (the hub keeps what it has — a
   * SessionStart re-fire or a recovery must never wipe a captured intent),
   * and a record carrying one replaces it under the hub's merge rule
   * (declared is never overwritten by derived).
   */
  intent: IntentSchema.optional(),
  status: SessionStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime().optional(),
});

export const TargetSchema = z.looseObject({
  workContextId: nonEmptyId,
  kind: TargetKindSchema,
  value: z.string().min(1),
  /**
   * WHICH lane saw this file (regression-guard Stage 1). Optional and
   * defaulted, because every connector shipped before Stage 1 sends targets
   * without it and those ARE tool-reported edits — the only lane that existed.
   * Defaulting keeps a replayed spool from an older connector honest instead
   * of relabelling its history as something it never claimed.
   */
  source: TargetSourceSchema.optional().default("tool_edit"),
});

export type AgentSession = z.infer<typeof AgentSessionSchema>;
export type Intent = z.infer<typeof IntentSchema>;
export type WorkContext = z.infer<typeof WorkContextSchema>;
export type Target = z.infer<typeof TargetSchema>;
