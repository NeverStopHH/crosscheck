/**
 * A deterministic embedder so the vector tier is testable without a key.
 *
 * Real embedders map meaning to direction; this maps a handful of TOPICS to
 * fixed orthogonal axes. Two texts about the same topic get cosine 1.0 (well
 * above the 0.93 ingest-gate threshold), texts about different topics get 0.0,
 * and text matching no topic gets an axis of its own — orthogonal to
 * everything, so it can never be a spurious near-duplicate.
 */
import { EMBEDDING_DIMENSIONS } from "../../src/db/schema.ts";
import type { Embedder } from "../../src/services/embedder.ts";

const TOPIC_PATTERNS: readonly RegExp[] = [
  /login|authentication|signin/i,
  /cache|warm/i,
  /rate.?limit|burst/i,
];

/** First axis past the topic axes; unmatched texts land here. */
const NEUTRAL_AXIS = TOPIC_PATTERNS.length;

/**
 * Axis used as the "away" direction when blending a near-duplicate vector —
 * far from every topic axis so the blend only ever leans toward topic 0.
 */
const BLEND_AXIS = EMBEDDING_DIMENSIONS - 1;

/**
 * Threshold-boundary texts: a body containing `neardup94` embeds at cosine
 * 0.94 to the login axis (just above the 0.93 dedup gate), `neardup92` at
 * 0.92 (just below). Checked BEFORE the topic patterns so a near-dup body may
 * mention the topic it is near.
 */
const NEAR_DUP_COSINES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly cosine: number;
}> = [
  { pattern: /neardup94/i, cosine: 0.94 },
  { pattern: /neardup92/i, cosine: 0.92 },
];

const unitVector = (axis: number): readonly number[] => {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[axis] = 1;
  return vector;
};

/** cos·(topic 0) + sin·(blend axis): unit length, chosen cosine to topic 0. */
const blendedVector = (cosine: number): readonly number[] => {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = cosine;
  vector[BLEND_AXIS] = Math.sqrt(1 - cosine * cosine);
  return vector;
};

const axisFor = (text: string): number => {
  const index = TOPIC_PATTERNS.findIndex((pattern) => pattern.test(text));
  return index === -1 ? NEUTRAL_AXIS : index;
};

const vectorFor = (text: string): readonly number[] => {
  const nearDup = NEAR_DUP_COSINES.find(({ pattern }) => pattern.test(text));
  return nearDup === undefined
    ? unitVector(axisFor(text))
    : blendedVector(nearDup.cosine);
};

export const FAKE_EMBEDDER_MODEL = "fake:topic-axes@768d";

export const createFakeEmbedder = (): Embedder => ({
  model: FAKE_EMBEDDER_MODEL,
  embed: (texts) => Promise.resolve(texts.map(vectorFor)),
});

/** An embedder whose every call fails — the degraded-mid-flight case. */
export const createFailingEmbedder = (): Embedder => ({
  model: FAKE_EMBEDDER_MODEL,
  embed: () => Promise.reject(new Error("embedder unavailable (test)")),
});

/**
 * An embedder that never settles for one exact text and behaves like the fake
 * embedder otherwise — the provider that worked during ingest and hangs when
 * the search asks. The search path must degrade on its own deadline rather
 * than wait for a promise that will not resolve.
 */
export const createHangingEmbedder = (hangOnExact: string): Embedder => {
  const inner = createFakeEmbedder();
  return {
    model: inner.model,
    embed: (texts) =>
      texts.includes(hangOnExact) ? new Promise(() => {}) : inner.embed(texts),
  };
};

export interface RecordingEmbedder extends Embedder {
  /** Every text embedded so far, in call order (batches flattened). */
  readonly embeddedTexts: readonly string[];
}

/** Wraps the fake embedder and records what was embedded — for cost tests. */
export const createRecordingEmbedder = (): RecordingEmbedder => {
  const inner = createFakeEmbedder();
  const embeddedTexts: string[] = [];
  return {
    model: inner.model,
    embeddedTexts,
    embed: (texts) => {
      embeddedTexts.push(...texts);
      return inner.embed(texts);
    },
  };
};
