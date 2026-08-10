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

const unitVector = (axis: number): readonly number[] => {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[axis] = 1;
  return vector;
};

const axisFor = (text: string): number => {
  const index = TOPIC_PATTERNS.findIndex((pattern) => pattern.test(text));
  return index === -1 ? NEUTRAL_AXIS : index;
};

export const FAKE_EMBEDDER_MODEL = "fake:topic-axes@768d";

export const createFakeEmbedder = (): Embedder => ({
  model: FAKE_EMBEDDER_MODEL,
  embed: (texts) =>
    Promise.resolve(texts.map((text) => unitVector(axisFor(text)))),
});

/** An embedder whose every call fails — the degraded-mid-flight case. */
export const createFailingEmbedder = (): Embedder => ({
  model: FAKE_EMBEDDER_MODEL,
  embed: () => Promise.reject(new Error("embedder unavailable (test)")),
});
