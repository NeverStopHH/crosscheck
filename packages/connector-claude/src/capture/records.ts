import { PROTOCOL_VERSION } from "@crosscheck/schema";
import type { Envelope } from "@crosscheck/schema";

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
      createdAt: now.toISOString(),
    },
    producer,
    now,
  );

export type TargetKind = "file" | "symbol" | "component" | "error_fingerprint";

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
