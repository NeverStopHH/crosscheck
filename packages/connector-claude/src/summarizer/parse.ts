/**
 * Tolerant parsing of the summarizer's stdout (DESIGN.md §3 Tier 1): the
 * contract is "schema-validated claim JSON or the literal NONE", and
 * ANYTHING else is discarded silently — a draft is a bonus, never worth an
 * error surface. Models wrap JSON in prose and fences, so the parse hunts
 * for the outermost braces instead of demanding a clean document.
 */
import { z } from "zod";
import { ClaimKindSchema, DERIVED_CONFIDENCE_CAP } from "@crosscheck/schema";

import {
  SUMMARIZER_DEFAULT_CONFIDENCE,
  SUMMARIZER_DRAFT_BODY_MAX_CHARS,
} from "@crosscheck/connector-core/constants.ts";

/** `NONE`, tolerantly: spacing, case, and a stray full stop are all still NONE. */
const NONE_PATTERN = /^none[.!]?$/i;

/**
 * Whether the model EXPLICITLY answered NONE — the telemetry surface needs
 * this apart from "no draft", because unparseable garbage is a runner
 * problem, not a judged-empty turn, and folding the two would flatter the
 * signal-to-noise figure the trial reads.
 */
export const isNoneAnswer = (stdout: string): boolean =>
  NONE_PATTERN.test(stdout.trim());

/**
 * What the model may choose: kind, body, and (optionally) confidence. It may
 * NOT choose status, capture mode, provenance or evidence — the worker forces
 * those (draft semantics are non-negotiable).
 */
const DraftOutputSchema = z.looseObject({
  kind: ClaimKindSchema,
  body: z.string().min(1).max(SUMMARIZER_DRAFT_BODY_MAX_CHARS),
  confidence: z.number().min(0).max(1).optional(),
});

export interface DraftOutput {
  readonly kind: z.infer<typeof ClaimKindSchema>;
  readonly body: string;
  /** Already clamped to DERIVED_CONFIDENCE_CAP — never trust a model's zeal. */
  readonly confidence: number;
}

/**
 * The client-side half of the derived-confidence cap (DESIGN.md §3): the hub
 * refuses derived claims above the cap (ClaimSchema, reused verbatim by the
 * worker's checkClaim pass), and an honest connector never even sends more.
 */
const clampConfidence = (confidence: number | undefined): number =>
  Math.min(
    confidence ?? SUMMARIZER_DEFAULT_CONFIDENCE,
    DERIVED_CONFIDENCE_CAP,
  );

export const parseSummarizerOutput = (stdout: string): DraftOutput | null => {
  const trimmed = stdout.trim();
  if (trimmed.length === 0 || NONE_PATTERN.test(trimmed)) {
    return null;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
  const parsed = DraftOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  return {
    kind: parsed.data.kind,
    body: parsed.data.body,
    confidence: clampConfidence(parsed.data.confidence),
  };
};
