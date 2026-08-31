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
});

export type Producer = z.infer<typeof ProducerSchema>;
export type Envelope = z.infer<typeof EnvelopeSchema>;

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