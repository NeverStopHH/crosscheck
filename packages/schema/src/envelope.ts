import { z } from "zod";

import { ClaimEdgeSchema, ClaimSchema } from "./claim.ts";
import { CommitEvidenceSchema } from "./commit-evidence.ts";
import { HintDeliverySchema, HintSchema } from "./hint.ts";
import { LandedEvidenceSchema } from "./landed-evidence.ts";
import { QuestionAnswerSchema, QuestionSchema } from "./question.ts";
import {
  AgentSessionSchema,
  TargetSchema,
  WorkContextSchema,
} from "./session.ts";
import { describeUnstorableText, unstorableTextPath } from "./storable-text.ts";

export const PROTOCOL_VERSION = "0.1";

const VERSION_PATTERN = /^\d+\.\d+$/;

export const ProducerSchema = z.looseObject({
  developerId: z.string().min(1),
  agentKind: z.string().min(1),
  sessionId: z.string().min(1),
});

/**
 * THE POSITION A RECORD HOLDS IN ITS OWN SESSION (spec 01 §3.1) — one optional
 * wire field, not nine new record kinds. The nine dotted names
 * (`session.started`, `intent.amended`, `file.modified`, …) are a PROJECTION
 * of records that already travel; a parallel set of event envelopes would
 * double every record on the wire and build a second pipeline beside the one
 * that works.
 *
 * `epoch` is regex-pinned to a UUID BECAUSE A CONNECTOR IS UNTRUSTED: an
 * opaque id cannot carry prose into a rendered surface, so this field adds no
 * untrusted slot anywhere and no case to the injection corpus. `n` is the
 * per-session monotonic counter — happens-before is `A.n < B.n` inside one
 * `(session, epoch)` and nowhere else, never a wall clock.
 */
export const SEQ_EPOCH_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const SeqStampSchema = z.object({
  epoch: z.string().regex(SEQ_EPOCH_PATTERN),
  n: z.number().int().min(0),
});

/**
 * WHY THERE IS NO POSITION, when the emitter is new enough to have tried.
 *
 * An ABSENT `seq` and a REFUSED one are different facts and the hub must not
 * confound them: absent is a connector from before this protocol field
 * (`pre_seq_connector`), refused is a seq-capable emitter that could not
 * allocate one — a busy state lock, a deleted state file, or the ambiguous
 * MCP session of §10 D1, where stamping the picker's guess would let AT-4
 * answer confidently from a coin flip. The record still lands; only its
 * POSITION is withheld.
 *
 * An ENUM from our own source, never prose — the same discipline the hub's
 * CAUSAL_ORDER_REASONS follows, and for the same reason: a reason a renderer
 * prints must not be a slot a producer can write into.
 */
export const SEQ_REFUSAL_REASONS = ["allocation_failed"] as const;

export const SeqRefusalSchema = z.object({
  reason: z.enum(SEQ_REFUSAL_REASONS),
});

export const SeqFieldSchema = z.union([SeqStampSchema, SeqRefusalSchema]);

/**
 * Wire envelope for every crosscheck record (DESIGN.md §5).
 * Consumers MUST ignore unknown fields and unknown kinds — forward compatibility
 * is a protocol rule, not a convenience.
 */
export const EnvelopeSchema = z.looseObject({
  cx: z.string().regex(VERSION_PATTERN),
  id: z.string().min(1),
  ts: z.iso.datetime(),
  producer: ProducerSchema,
  kind: z.string().min(1),
  body: z.unknown(),
  /**
   * OPTIONAL FOREVER. An envelope with no `seq` stays legal — the forward
   * compatibility rule above is what keeps a pre-`seq` connector working
   * against a new hub, and a new connector's `seq` is simply ignored by an
   * older one (this is a loose object).
   */
  seq: SeqFieldSchema.optional(),
});

export type Producer = z.infer<typeof ProducerSchema>;
export type SeqStamp = z.infer<typeof SeqStampSchema>;
export type SeqRefusal = z.infer<typeof SeqRefusalSchema>;
export type SeqField = z.infer<typeof SeqFieldSchema>;
export type SeqRefusalReason = (typeof SEQ_REFUSAL_REASONS)[number];
export type Envelope = z.infer<typeof EnvelopeSchema>;

/** True for a `seq` that names a position rather than refusing one. */
export const isSeqStamp = (seq: SeqField | undefined): seq is SeqStamp =>
  seq !== undefined && "n" in seq;

const RECORD_BODY_SCHEMAS = {
  claim: ClaimSchema,
  claim_edge: ClaimEdgeSchema,
  commit_evidence: CommitEvidenceSchema,
  landed_evidence: LandedEvidenceSchema,
  session: AgentSessionSchema,
  work_context: WorkContextSchema,
  target: TargetSchema,
  hint: HintSchema,
  hint_delivery: HintDeliverySchema,
  question: QuestionSchema,
  question_answer: QuestionAnswerSchema,
} as const;

export type KnownRecordKind = keyof typeof RECORD_BODY_SCHEMAS;

export const KNOWN_RECORD_KINDS = Object.keys(
  RECORD_BODY_SCHEMAS,
) as readonly KnownRecordKind[];

export type ParseRecordResult =
  | { ok: true; envelope: Envelope; body: unknown; unknownKind: boolean }
  | { ok: false; issues: readonly string[] };

const formatIssues = (error: z.ZodError): readonly string[] =>
  error.issues.map(
    (issue) => `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`,
  );

const isKnownKind = (kind: string): kind is KnownRecordKind =>
  kind in RECORD_BODY_SCHEMAS;

/** True when `version` shares the major version of this package's protocol. */
export const isCompatibleVersion = (version: string): boolean => {
  if (!VERSION_PATTERN.test(version)) {
    return false;
  }
  const major = version.split(".")[0];
  return major === PROTOCOL_VERSION.split(".")[0];
};

/**
 * Validates an incoming wire record. Unknown kinds parse successfully with
 * `unknownKind: true` and an untouched body, so old consumers never choke on
 * records from newer producers.
 */
export const parseRecord = (input: unknown): ParseRecordResult => {
  const envelopeResult = EnvelopeSchema.safeParse(input);
  if (!envelopeResult.success) {
    return { ok: false, issues: formatIssues(envelopeResult.error) };
  }

  const envelope = envelopeResult.data;
  if (!isCompatibleVersion(envelope.cx)) {
    return {
      ok: false,
      issues: [`cx: version ${envelope.cx} is incompatible with ${PROTOCOL_VERSION}`],
    };
  }

  if (!isKnownKind(envelope.kind)) {
    return { ok: true, envelope, body: envelope.body, unknownKind: true };
  }

  const bodyResult = RECORD_BODY_SCHEMAS[envelope.kind].safeParse(envelope.body);
  if (!bodyResult.success) {
    return { ok: false, issues: formatIssues(bodyResult.error) };
  }

  // AFTER the kind check, never before: an UNKNOWN kind is stored by nobody
  // (services/records.ts ignores it), and rejecting one here would turn the
  // forward-compatibility rule — "unknown kinds are never an error" — into a
  // version-skew outage the moment a newer producer sends a field we cannot
  // read. A KNOWN kind is about to become an INSERT, so this is the last
  // place its text can be refused instead of crashing the whole batch.
  const unstorable = unstorableTextPath(envelope);
  if (unstorable !== null) {
    return { ok: false, issues: [describeUnstorableText(unstorable)] };
  }

  return { ok: true, envelope, body: bodyResult.data, unknownKind: false };
};