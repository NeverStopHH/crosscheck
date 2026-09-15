import { PROTOCOL_VERSION } from "@crosscheck/schema";
import type { Envelope, Intent } from "@crosscheck/schema";

import { FOREIGN_SESSION_DELIVERY } from "./seq.ts";

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
  readonly status: string;
  /**
   * Present only on an intent UPDATE (the derived-intent worker, `set_intent`):
   * omitted, the record says nothing about the intent and the hub keeps what it
   * has — so a registration or recovery re-send can never wipe one.
   */
  readonly intent?: Intent | undefined;
}

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
      status: input.status,
      ...(input.intent === undefined ? {} : { intent: input.intent }),
      createdAt: now.toISOString(),
    },
    producer,
    now,
  );

export type TargetKind = "file" | "symbol" | "component" | "error_fingerprint";

export type HintRefKind = "claim" | "work_context";

/** 128 bits of SHA-256 — the id stays deterministic AND filename-short. */
const HINT_DELIVERY_ID_HASH_CHARS = 32;

/**
 * DETERMINISTIC, from (receiving session, ref): the seen-set already
 * guarantees one delivery per ref per session, so this pair is unique — and a
 * spool replay of the same envelope re-sends the same primary key, which the
 * hub answers with `duplicate` instead of a second telemetry row.
 */
export const hintDeliveryId = (
  receiverSessionId: string,
  refId: string,
): string =>
  `hd_${new Bun.CryptoHasher("sha256")
    .update(`${receiverSessionId}\n${refId}`)
    .digest("hex")
    .slice(0, HINT_DELIVERY_ID_HASH_CHARS)}`;

/** Delivery telemetry (DESIGN.md §4): refs only, never the rendered text. */
export const hintDeliveryRecord = (
  receiverSessionId: string,
  refKind: HintRefKind,
  refId: string,
  producer: Producer,
  now: Date,
): Envelope =>
  buildEnvelope(
    "hint_delivery",
    {
      id: hintDeliveryId(receiverSessionId, refId),
      sessionId: receiverSessionId,
      refKind,
      refId,
      deliveredAt: now.toISOString(),
    },
    producer,
    now,
  );

/**
 * WHICH lane saw a file (regression-guard Stage 1). Omitted means the tool
 * lane, which is what every target minted before Stage 1 was — so an old
 * spool replays as itself instead of as an unlabelled unknown.
 */
export type TargetSource = "tool_edit" | "git_diff";

export const targetRecord = (
  workContextId: string,
  kind: TargetKind,
  value: string,
  producer: Producer,
  now: Date,
  source: TargetSource = "tool_edit",
): Envelope =>
  buildEnvelope("target", { workContextId, kind, value, source }, producer, now);

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
