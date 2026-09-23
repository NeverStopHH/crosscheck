import { z } from "zod";

import { DERIVED_CONFIDENCE_CAP } from "./claim.ts";
import { SeqStampSchema } from "./seq.ts";
import { MAX_PIN_FILES, MAX_PIN_PATH_CHARS } from "./pin.ts";
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

/**
 * THE ONLY KIND AN INTENT MAY NAME (spec 06 §8.2).
 *
 * Connectors emit exactly two target kinds — `file` and `error_fingerprint`
 * (`flows/capture-targets.ts`) — and nothing in the tree writes `symbol` or
 * `component`. A declared surface no captured event could ever intersect is a
 * silent absence dressed as a feature, so the enum is the intersection of what
 * can be DECLARED with what is actually CAPTURED, not a copy of TARGET_KINDS.
 * `error_fingerprint` is left out separately: an intent naming a failure it
 * expects is a different feature.
 */
export const INTENT_SCOPE_KINDS = ["file"] as const;

/**
 * WHAT A DECLARED PATH MEANS, and the two meanings answer differently.
 *
 *   expected — the session says it intends to touch this.
 *   non_goal — the session says it intends NOT to touch this.
 *
 * Both are read. A non-goal that was then edited is the most post-hoc thing a
 * session can do, so it takes its own answer rather than being folded into the
 * expectation branch, where it would report a sentence that said the opposite
 * as a reason declared BEFORE the change (§10.4a).
 */
export const INTENT_SCOPE_ROLES = ["expected", "non_goal"] as const;

export const IntentScopeKindSchema = z.enum(INTENT_SCOPE_KINDS);
export const IntentScopeRoleSchema = z.enum(INTENT_SCOPE_ROLES);

/**
 * REUSED, NOT RE-MINTED. A second cap on the size of a declared file set, or
 * on how long a repo-relative path may be, would be a second argument about
 * the same thing — and the pin registry already settled both.
 */
export const MAX_INTENT_SCOPE_ENTRIES = MAX_PIN_FILES;
export const MAX_INTENT_AMEND_REASON_CHARS = 200;

/**
 * HOW LONG A CHAIN MAY GROW. The bound is what replaces a retention job: the
 * ledger has no background pass, so the cap is the only thing that keeps one
 * work context's history finite.
 */
export const MAX_INTENT_CHAIN_VERSIONS = 20;

export const IntentScopeEntrySchema = z.object({
  kind: IntentScopeKindSchema,
  value: z.string().min(1).max(MAX_PIN_PATH_CHARS),
});

const scopeList = z.array(IntentScopeEntrySchema).max(MAX_INTENT_SCOPE_ENTRIES);

export const IntentSchema = z
  .looseObject({
    summary: z.string().min(1).max(MAX_INTENT_SUMMARY_CHARS),
    provenance: ProvenanceSchema,
    confidence: z.number().min(0).max(1),
    capturedAt: z.iso.datetime(),
    /**
     * THE CHECKABLE HALF. Bounded PER ROLE, because the two lists answer
     * different questions and a shared budget would let a long expectation
     * list silently crowd out the non-goals.
     */
    expectedSurface: scopeList.optional(),
    nonGoals: scopeList.optional(),
    /**
     * WHERE THIS SENTENCE SITS IN ITS OWN SESSION — 01's `{ epoch, n }` PAIR,
     * never a bare integer.
     *
     * A bare integer compares two positions that may have come from different
     * counters and answers confidently from unrelated numbers: a SessionStart
     * re-fire, a busy-lock fallback and two homes on one host key all restart
     * the sequence, and 01 SEQ-5 requires a cross-epoch pair to be refused.
     * `null` is the honest value when no position could be taken, and it
     * propagates all the way to `absent` / `not_comparable`.
     */
    seq: SeqStampSchema.nullable().optional(),
    /** Null on the first intent; the hub assigns it on every amendment. */
    amendsVersion: z.number().int().min(1).nullable().optional(),
    /**
     * WHY THIS SENTENCE SUPERSEDES THE ONE BEFORE IT.
     *
     * NEITHER DIRECTION IS REFUSABLE HERE, and that is forced rather than
     * lax. A connector sends a `reason` WITHOUT a version, because
     * `amendsVersion` is hub-assigned — its own work-context handle carries no
     * version, and reading one would be the HTTP call §6 forbids. And a stored
     * head carries a hub-stamped `amendsVersion` with NO reason whenever the
     * connector that wrote it predates this field. Refusing either shape here
     * would refuse a legitimate record.
     *
     * THE RULE IS STILL BINDING; it is enforced where it can be acted on. An
     * amendment with no reason is the field this ledger exists to capture left
     * blank, and `set_intent` refuses it — that is the one writer that knows
     * it is amending, and the one place an author can be told why.
     */
    reason: z
      .string()
      .min(1)
      .max(MAX_INTENT_AMEND_REASON_CHARS)
      .nullable()
      .optional(),
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
export type IntentScopeEntry = z.infer<typeof IntentScopeEntrySchema>;
export type IntentScopeKind = (typeof INTENT_SCOPE_KINDS)[number];
export type IntentScopeRole = (typeof INTENT_SCOPE_ROLES)[number];
export type WorkContext = z.infer<typeof WorkContextSchema>;
export type Target = z.infer<typeof TargetSchema>;
