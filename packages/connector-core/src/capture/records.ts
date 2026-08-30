import { PROTOCOL_VERSION } from "@crosscheck/schema";
import type { Envelope, Intent } from "@crosscheck/schema";

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

export const targetRecord = (
  workContextId: string,
  kind: TargetKind,
  value: string,
  producer: Producer,
  now: Date,
): Envelope =>
  buildEnvelope("target", { workContextId, kind, value }, producer, now);

/** Flush-time rewrite: ingest rejects records from an ended producer session. */
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
  return {
    ...envelope,
    producer: {
      ...base,
      ...(developerId === null ? {} : { developerId }),
      sessionId,
    },
  };
};
