/**
 * WHAT A DELIVERED HINT LED TO, on the wire (1.0 spec 07 §13, 2026-10-05).
 *
 * The reader's AGENT is the one that knows: it read the hint, and it either
 * reused the teammate's decision, or set it aside for a reason, or found it
 * beside the point for the task at hand. So this is the one pilot record an
 * agent may write — through `mark_hint_outcome` — and a person may write the
 * same thing with `crosscheck followed` / `crosscheck overrode`. Both are
 * attributed to the developer's key; nothing at the hub tells the two apart,
 * and nothing here claims to.
 *
 * IT IS NOT A LABEL, and it never reaches `pilot_marks`. A label is a
 * person's verdict on whether an intervention was worth it, counted into
 * precision (07 §12); an outcome is what happened next. An agent writing the
 * first would be the product grading itself (PIL-6); an agent writing the
 * second is the only witness there is.
 *
 * `ref` IS WHAT THE HINT PRINTED — a work-context or claim id — or a delivery
 * id. The hub resolves it to the caller's own delivery of that ref, preferring
 * the session the caller names; a hint never prints an `hd_` id, so a tool
 * that took only those would name something its caller never sees (07 §11.2).
 */
import { z } from "zod";

import { HINT_OUTCOMES } from "./enums.ts";
import { MAX_PILOT_LABEL_REASON_CHARS } from "./pilot-mark.ts";
import { MAX_RECORD_ID_LENGTH, SAFE_ID_PATTERN } from "./question.ts";

/**
 * THE SAME ONE SENTENCE as a label's reason, derived rather than repeated: a
 * reader is never asked two different answers to "how much may I write here".
 * The SQL literal in `bootstrap.sql` is held to it by `ddl-sync.test.ts`.
 */
export const MAX_HINT_OUTCOME_REASON_CHARS = MAX_PILOT_LABEL_REASON_CHARS;

const idArg = z
  .string()
  .min(1)
  .max(MAX_RECORD_ID_LENGTH)
  .regex(SAFE_ID_PATTERN, "an id carries characters an id may not carry");

export const HintOutcomeSchema = z
  .looseObject({
    repo: z.string().min(1),
    ref: idArg,
    outcome: z.enum(HINT_OUTCOMES),
    /** Optional except on an override; trimmed, so a blank is no reason. */
    reason: z.string().trim().min(1).max(MAX_HINT_OUTCOME_REASON_CHARS).optional(),
    /** The caller's session, when it knows which one read the hint; omitted, the newest delivery. */
    session: idArg.optional(),
  })
  // AN OVERRIDE SAYS WHY. "I saw it and went my own way" is worth recording
  // only with the reason the reader's way was better — without it the row is
  // indistinguishable from noise, which is exactly what it is not.
  .refine((body) => body.outcome !== "overrode" || body.reason !== undefined, {
    path: ["reason"],
    message: "an override needs its reason: one sentence on why your way was better",
  });

export type HintOutcomeInput = z.infer<typeof HintOutcomeSchema>;
