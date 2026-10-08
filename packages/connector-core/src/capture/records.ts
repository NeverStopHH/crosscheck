import { PROTOCOL_VERSION } from "@crosscheck/schema";
import type { Envelope, GeneratedSignal, Intent, LandedStop, WorkContextTitleSource } from "@crosscheck/schema";

import { FOREIGN_SESSION_DELIVERY } from "./seq.ts";
import type { DeliveryChannel, DeliveryMatchedOn, IntentProvenance } from "@crosscheck/schema";

export interface Producer {
  readonly developerId: string;
  readonly agentKind: string;
  readonly sessionId: string;
  readonly [key: string]: unknown;
}

/** Placeholder until the hub has told us who we are; rewritten on flush. */
export const UNKNOWN_DEVELOPER_ID = "unknown";

const envelopeId = (): string => `env_${crypto.randomUUID()}`;

export const buildEnvelope = (
  kind: string,
  body: unknown,
  producer: Producer,
  now: Date,
): Envelope => ({
  cx: PROTOCOL_VERSION,
  id: envelopeId(),
  ts: now.toISOString(),
  producer,
  kind,
  body,
});

export interface WorkContextRecordInput {
  readonly workContextId: string;
  readonly sessionId: string;
  readonly title: string;
  /**
   * How `title` was written (@crosscheck/schema WORK_CONTEXT_TITLE_SOURCES):
   * `fallback` is the session's branch, which the hub withholds from
   * colleagues of a developer who opted out of presence. Omitted only by a
   * writer that does not know (a state file from before the marker) — the
   * hub then keeps the stored marker while the title is unchanged.
   */
  readonly titleSource?: WorkContextTitleSource | undefined;
  readonly status: string;
  /**
   * Present only on an intent UPDATE (the derived-intent worker, `set_intent`):
   * omitted, the record says nothing about the intent and the hub keeps what it
   * has — so a registration or recovery re-send can never wipe one.
   */
  readonly intent?: Intent | undefined;
  /**
   * A TOPIC's branch and the commit HEAD named at the session's first touch
   * of it (flows/topic-contexts.ts). Absent on the session's own context, and
   * on a topic whose commit could not be read — never a guess.
   */
  readonly branch?: string | undefined;
  readonly baseCommit?: string | null | undefined;
  /**
   * The topic's own word about that commit (flows/topic-base-word.ts): was it
   * already on the default branch when the topic opened? Sent only beside
   * the commit it is about; null or absent says nothing.
   */
  readonly baseOnDefault?: boolean | null | undefined;
}

/** A topic's word about its base, as the body carries it: only beside that base. */
const baseWordOf = (input: WorkContextRecordInput): { readonly baseOnDefault?: boolean } =>
  input.baseCommit === undefined || input.baseCommit === null || typeof input.baseOnDefault !== "boolean"
    ? {}
    : { baseOnDefault: input.baseOnDefault };

export const workContextRecord = (
  input: WorkContextRecordInput,
  producer: Producer,
  now: Date,
): Envelope =>
  buildEnvelope(
    "work_context",
    {
      id: input.workContextId,
      sessionId: input.sessionId,
      title: input.title,
      ...(input.titleSource === undefined ? {} : { titleSource: input.titleSource }),
      status: input.status,
      ...(input.intent === undefined ? {} : { intent: input.intent }),
      ...(input.branch === undefined ? {} : { branch: input.branch }),
      ...(input.baseCommit === undefined || input.baseCommit === null ? {} : { baseCommit: input.baseCommit }),
      ...baseWordOf(input),
      createdAt: now.toISOString(),
    },
    producer,
    now,
  );

export type TargetKind = "file" | "symbol" | "component" | "error_fingerprint";

export type HintRefKind = "claim" | "work_context";

/**
 * DETERMINISTIC, from (receiving session, ref) — and derived in
 * `@crosscheck/schema` (delivery-id.ts), because the hub now CHECKS the id it
 * is sent against the same derivation. Re-exported under the names this module
 * has always had, so no importer changes.
 */
export { hintDeliveryId, tripwireDeliveryId } from "@crosscheck/schema";
import { deliveryIdFor } from "@crosscheck/schema";

/**
 * Delivery telemetry (DESIGN.md §4): refs only, never the rendered text.
 *
 * `channel` IS REQUIRED, AND THAT IS THE POINT (07 §3.1). The wire schema
 * defaults it to `unknown` so a connector older than the column still parses
 * — but a default HERE would let the next writer added to this codebase book
 * its deliveries into the bucket that means "nobody can tell", silently, on
 * the one surface whose whole purpose is being counted. Required makes the
 * compiler ask.
 *
 * `matching` is the opposite case, and optional on purpose (review 1006b,
 * M7): what a PROMPT-TIME delivery was matched on — the prompt, or a question
 * this developer asked — and whose intent the session held. A briefing
 * pointer, a failure-time solved hint or a pre-edit notice was matched on
 * none of those, and its channel already says what it answered; inventing a
 * value for it would be the guess the field exists to avoid.
 */
export interface DeliveryMatching {
  readonly matchedOn: DeliveryMatchedOn;
  readonly intentProvenance: IntentProvenance | null;
}

export const hintDeliveryRecord = (
  receiverSessionId: string,
  refKind: HintRefKind,
  refId: string,
  channel: DeliveryChannel,
  producer: Producer,
  now: Date,
  matching?: DeliveryMatching,
): Envelope =>
  buildEnvelope(
    "hint_delivery",
    {
      id: deliveryIdFor(receiverSessionId, refId, channel),
      sessionId: receiverSessionId,
      refKind,
      refId,
      channel,
      ...(matching === undefined
        ? {}
        : { matchedOn: matching.matchedOn, intentProvenance: matching.intentProvenance }),
      deliveredAt: now.toISOString(),
    },
    producer,
    now,
  );

/**
 * A reader's stop at a teammate's landed change (docs/1.0/landed-changes.md,
 * step 4), for the hub to tell the authors the stop NAMED as told. The body
 * is built by the stop itself, which alone knows whom it named.
 */
export const landedStopRecord = (body: LandedStop, producer: Producer, now: Date): Envelope =>
  buildEnvelope("landed_stop", body, producer, now);

/**
 * The author's notices this session showed, by the hub's row ids: the hub
 * marks them told, and only if they are addressed to this developer.
 */
export const landedNoticeDeliveryRecord = (
  sessionId: string,
  noticeIds: readonly string[],
  producer: Producer,
  now: Date,
): Envelope =>
  buildEnvelope(
    "landed_notice_delivery",
    { sessionId, noticeIds, deliveredAt: now.toISOString() },
    producer,
    now,
  );

/**
 * WHICH lane saw a file (regression-guard Stage 1). Omitted means the tool
 * lane, which is what every target minted before Stage 1 was — so an old
 * spool replays as itself instead of as an unlabelled unknown.
 */
export type TargetSource = "tool_edit" | "git_diff" | "git_commit";

export const targetRecord = (
  workContextId: string,
  kind: TargetKind,
  value: string,
  producer: Producer,
  now: Date,
  source: TargetSource = "tool_edit",
  /**
   * The generated-target signal that fired (capture/generated.ts) on a file
   * that is mechanically generated and non-authoritative, or absent for an
   * ordinary target AND for one whose classification could not run — the
   * wire carries only positive evidence, so an unknown stays ordinary.
   */
  generated?: GeneratedSignal,
  /**
   * True for a generated file that is AUTHORITATIVE (declared, or a contract
   * or migration): it stays evidence, and the hub must not label it either.
   */
  authoritative = false,
): Envelope =>
  buildEnvelope(
    "target",
    {
      workContextId,
      kind,
      value,
      source,
      ...(generated === undefined ? {} : { generated }),
      ...(authoritative ? { authoritative: true } : {}),
    },
    producer,
    now,
  );

/**
 * KINDS WHOSE BODY NAMES THE SESSION THAT AUTHORED THEM — directly
 * (`authorSessionId`, `sessionId`) or through a join the hub can make
 * (`target` → `work_contexts.sessionId`). Their POSITION survives delivery by
 * any session, because the hub never has to ask the producer whose order they
 * belong to.
 *
 * Everything else — commit evidence, landed evidence, delivery telemetry,
 * questions — is filed under the producer, and the producer is rewritten one
 * line below. See `withProducer`.
 */
const BODY_NAMES_ITS_SESSION: ReadonlySet<string> = new Set([
  "claim",
  "claim_edge",
  "work_context",
  "target",
]);

/** Whether the hub files this kind's position in the session its BODY names. */
export const bodyNamesItsSession = (kind: unknown): boolean =>
  typeof kind === "string" && BODY_NAMES_ITS_SESSION.has(kind);

/**
 * Flush-time rewrite: ingest rejects records from an ended producer session,
 * so a dead session's spool is only deliverable in a live session's name.
 *
 * THE POSITION IS WITHHELD WHEN THE REWRITE MOVES THE RECORD TO A SESSION THAT
 * CANNOT CLAIM IT. A `seq` belongs to ONE session's counter. For a body that
 * names its own session the hub files it correctly whoever delivered it, so an
 * offline backlog drained by a successor keeps its real order. For a body that
 * names none, the hub can only use the producer — and A's epoch inside B's
 * sequence makes B hold two epochs, which marks B's ENTIRE causal order broken
 * for a reason that is not B's.
 *
 * WITHHELD IS A REFUSAL, NOT A DELETED FIELD. This used to delete `seq`
 * outright, and an absent `seq` is the hub's word for a connector from BEFORE
 * this protocol field — said about a current connector whose position was
 * withheld on purpose. That is the confound `SEQ_REFUSAL_REASONS`' own header
 * forbids, produced by the very code it describes.
 *
 * AND ONLY A REAL POSITION IS REPLACED. An envelope that carried no `seq` at
 * all is left alone — stamping the delivery refusal on it would claim a
 * position existed and was lost — and an envelope that already carries a
 * refusal keeps it, because the emitter's own reason is the true one and names
 * a remedy this one does not have.
 */
const carriesPosition = (seq: unknown): boolean =>
  typeof seq === "object" && seq !== null && "n" in seq;

export const withProducer = (
  envelope: Record<string, unknown>,
  developerId: string | null,
  sessionId: string,
): Record<string, unknown> => {
  const producer = envelope["producer"];
  const base =
    typeof producer === "object" && producer !== null
      ? (producer as Record<string, unknown>)
      : {};
  const kind = envelope["kind"];
  const movedToAnotherSession =
    base["sessionId"] !== sessionId &&
    !BODY_NAMES_ITS_SESSION.has(typeof kind === "string" ? kind : "");
  const losesItsPosition =
    movedToAnotherSession && carriesPosition(envelope["seq"]);
  return {
    ...envelope,
    ...(losesItsPosition ? { seq: FOREIGN_SESSION_DELIVERY } : {}),
    producer: {
      ...base,
      ...(developerId === null ? {} : { developerId }),
      sessionId,
    },
  };
};
