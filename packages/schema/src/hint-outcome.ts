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

/**
 * WHEN A SHARED OUTCOME FIGURE MAY PRINT AT ALL (07 §13.9, review #4/#10).
 *
 * A team total minus one's own `--mine` is everybody else's — with one other
 * person, that person's exact outcomes; an author's credit falling 1 → 0 is a
 * teammate switching to "overrode". And a minimum that counts the viewer's own
 * words is one the viewer can meet alone and then subtract (07 §13.11, H1). So
 * every minimum holds WITH ANY ONE RECORDER LEFT OUT, whoever reads it: at
 * least three other people's words, about at least three people's work, ten
 * or more of them. A team of three never meets them. Shared here because the
 * hub decides and the CLI writes the sentence.
 */
export const HINT_OUTCOME_DISCLOSURE_MINIMUMS = {
  recorders: 3,
  sources: 3,
  recorded: 10,
} as const;

/** Why a shared outcome figure printed no number — the hub picks one, the CLI says it. */
export const HINT_OUTCOME_WITHHOLDINGS = [
  /** No moment of the period could record an outcome on this repo. */
  "not_recordable",
  /** Nothing reached anyone in the counted part of the period. */
  "no_interventions",
  "too_few_recorders",
  "too_few_sources",
  "too_few_recorded",
] as const;

export type HintOutcomeWithholding = (typeof HINT_OUTCOME_WITHHOLDINGS)[number];
