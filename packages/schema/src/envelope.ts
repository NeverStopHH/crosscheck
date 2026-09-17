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
  /**
   * THE POSITION THIS EVENT IS KNOWN TO FOLLOW — an INTERVAL, not a point, and
   * the difference is the whole of AT-4 on a lane whose position is taken
   * after the fact.
   *
   * A hook runs once its tool has returned, so the edit happened BEFORE the
   * position the hook allocates for it. Any emitter that allocated inside that
   * window holds a LOWER position than an edit that already happened, and
   * `A.n < B.n` then reports the explanation as predeclared — the exonerating
   * answer — for a change that came first. Measured, not argued: an Edit and
   * an MCP publish in one parallel tool batch inverted 10 times out of 10.
   *
   * So a bracketing emitter allocates one position BEFORE it starts the tool
   * and sends it here. The event lies somewhere in `(after, n]`: anything at
   * or below `after` precedes it, anything above `n` follows it, and anything
   * BETWEEN raced it and is not comparable — which is the honest answer.
   *
   * ABSENT MEANS UNBRACKETED, never "a point". An emitter that cannot say when
   * its tool started sends no `after`, and the hub reads the position as the
   * upper bound it is (`seq_kind = observed`) rather than promoting a guess.
   * Point emitters — an MCP publish, a session register — are points by lane,
   * not by this field.
   */
  after: z.number().int().min(0).optional(),
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
 * TWO REFUSALS, NOT ONE WORD, because the two remedies are opposites:
 *
 *   allocation_failed            — this machine tried and could not. A busy
 *                                  state lock, a deleted state file, a state
 *                                  file from before this field. It CLEARS ON
 *                                  ITS OWN and the remedy is to do nothing.
 *   ambiguous_session_assignment — the MCP picker could not tell which of two
 *                                  live sessions is calling, so no lock was
 *                                  taken at all (§10 D1). Nothing clears until
 *                                  one of the two sessions ends, and the remedy
 *                                  is a person closing one of them.
 *   foreign_session_delivery     — the emitter HAD a position and it could not
 *                                  survive delivery. A flush rewrites a dead
 *                                  session's backlog into the flushing
 *                                  session's name, and a position belongs to
 *                                  ONE session's counter: carrying A's epoch
 *                                  into B's sequence would mark B's entire
 *                                  causal order broken for a reason that is
 *                                  not B's. Nobody's bug, and no remedy.
 *
 * One word for both would send the reader of a permanently ambiguous worktree
 * to wait for a lock that was never contended — and the ambiguous case is the
 * one AT-4 hangs on, because `set_intent` is the call it asks about.
 *
 * An ENUM from our own source, never prose — the same discipline the hub's
 * CAUSAL_ORDER_REASONS follows, and for the same reason: a reason a renderer
 * prints must not be a slot a producer can write into.
 */
export const SEQ_REFUSAL_REASONS = [
  "allocation_failed",
  "ambiguous_session_assignment",
  "foreign_session_delivery",
] as const;

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