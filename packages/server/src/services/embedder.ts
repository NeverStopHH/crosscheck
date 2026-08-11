/**
 * The pluggable embedder behind the optional vector tier (DESIGN.md §6).
 *
 * NULL IS THE DEFAULT AND A SUPPORTED STATE, not an error: with no embedder
 * the vector tier is silently absent and exact + FTS carry the search block
 * alone. Everything downstream branches on `Embedder | null`, never on env
 * vars, so the degradation decision is made exactly once, here.
 *
 * Explicit misconfiguration is the opposite case and FAILS FAST: an operator
 * who set CROSSCHECK_EMBEDDER=openai without a key meant to have vectors, and
 * a hub that silently dropped them would be broken in the way DESIGN.md §10
 * calls "silent death".
 */
import { z } from "zod";

import { EMBEDDING_DIMENSIONS } from "../db/schema.ts";

export interface Embedder {
  /**
   * Provider, model and dimensionality in one id, stored on every embedded
   * row: vectors are only comparable within one of these, so a model change
   * makes old rows invisible to the vector tier instead of mis-ranked
   * ("model change = re-embed migration", DESIGN.md §6).
   */
  readonly model: string;
  embed(
    texts: readonly string[],
  ): Promise<ReadonlyArray<readonly number[]>>;
}

export const OPENAI_EMBED_MODEL = "text-embedding-3-small";
export const OLLAMA_EMBED_MODEL = "nomic-embed-text";
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

/**
 * Transport-level ceiling on one embedding call. Hooks never wait on this
 * (embedding runs hub-side, outside ingest transactions), but the SEARCH
 * path does — which is why search stops waiting long before this fires:
 * services/search.ts SEARCH_EMBED_DEADLINE_MS (2 s) races the embed and
 * degrades to lexical, while this timeout merely settles the abandoned call
 * in the background. Ingest keeps the full ceiling: a claim that misses its
 * vector loses similarity-dedup for good (append-only rows are never
 * re-embedded), so ingest trades latency for coverage — and pays it only for
 * claims the deterministic gate cannot already classify (record-handlers.ts).
 */
const EMBED_TIMEOUT_MS = 10_000;

const OpenAiResponseSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      index: z.number().int().min(0),
      embedding: z.array(z.number()),
    }),
  ),
});

const OllamaResponseSchema = z.looseObject({
  embeddings: z.array(z.array(z.number())),
});

const checkDimensions = (
  vectors: ReadonlyArray<readonly number[]>,
  model: string,
): ReadonlyArray<readonly number[]> => {
  const wrong = vectors.find(
    (vector) => vector.length !== EMBEDDING_DIMENSIONS,
  );
  if (wrong !== undefined) {
    throw new Error(
      `${model} returned ${String(wrong.length)}-dimensional vectors; ` +
        `crosscheck stores ${String(EMBEDDING_DIMENSIONS)} — is the model name right?`,
    );
  }
  return vectors;
};

const postJson = async (
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<unknown> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`embedding request failed: HTTP ${String(response.status)}`);
  }
  return response.json();
};

export const createOpenAiEmbedder = (apiKey: string): Embedder => {
  const model = `openai:${OPENAI_EMBED_MODEL}@${String(EMBEDDING_DIMENSIONS)}d`;
  return {
    model,
    embed: async (texts) => {
      const raw = await postJson(
        OPENAI_EMBEDDINGS_URL,
        { Authorization: `Bearer ${apiKey}` },
        {
          model: OPENAI_EMBED_MODEL,
          input: texts,
          // HISTORICAL (OpenAI embeddings guide, read 2026-08; not verifiable
          // from this repo): the API truncates and re-normalizes when asked
          // for fewer dimensions than the model's native width. What IS
          // enforced here is the width itself — checkDimensions below rejects
          // any response that is not EMBEDDING_DIMENSIONS wide.
          dimensions: EMBEDDING_DIMENSIONS,
        },
      );
      const parsed = OpenAiResponseSchema.parse(raw);
      const ordered = [...parsed.data].sort((a, b) => a.index - b.index);
      return checkDimensions(
        ordered.map((entry) => entry.embedding),
        model,
      );
    },
  };
};

export const createOllamaEmbedder = (baseUrl: string): Embedder => {
  const model = `ollama:${OLLAMA_EMBED_MODEL}@${String(EMBEDDING_DIMENSIONS)}d`;
  const url = `${baseUrl.replace(/\/+$/, "")}/api/embed`;
  return {
    model,
    embed: async (texts) => {
      const raw = await postJson(url, {}, {
        model: OLLAMA_EMBED_MODEL,
        input: texts,
      });
      return checkDimensions(OllamaResponseSchema.parse(raw).embeddings, model);
    },
  };
};

/**
 * Read keys: CROSSCHECK_EMBEDDER (openai|ollama|none), OPENAI_API_KEY,
 * CROSSCHECK_OLLAMA_URL. An index signature rather than named optionals so
 * `process.env` (Dict<string>) is assignable directly.
 */
export interface EmbedderEnv {
  readonly [key: string]: string | undefined;
}

const embedderByChoice = (
  choice: string,
  env: EmbedderEnv,
): Embedder | null => {
  const apiKey = env["OPENAI_API_KEY"];
  if (choice === "none") {
    return null;
  }
  if (choice === "openai") {
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(
        "CROSSCHECK_EMBEDDER=openai requires OPENAI_API_KEY to be set",
      );
    }
    return createOpenAiEmbedder(apiKey);
  }
  if (choice === "ollama") {
    return createOllamaEmbedder(
      env["CROSSCHECK_OLLAMA_URL"] ?? DEFAULT_OLLAMA_URL,
    );
  }
  throw new Error(
    `unknown CROSSCHECK_EMBEDDER "${choice}": expected openai, ollama or none`,
  );
};

/**
 * Explicit CROSSCHECK_EMBEDDER wins; otherwise presence of exactly the
 * credential each provider needs selects it; otherwise keyless — null.
 */
export const createEmbedderFromEnv = (env: EmbedderEnv): Embedder | null => {
  const choice = env["CROSSCHECK_EMBEDDER"]?.trim().toLowerCase() ?? "";
  if (choice.length > 0) {
    return embedderByChoice(choice, env);
  }
  const apiKey = env["OPENAI_API_KEY"];
  if (apiKey !== undefined && apiKey.length > 0) {
    return createOpenAiEmbedder(apiKey);
  }
  const ollamaUrl = env["CROSSCHECK_OLLAMA_URL"];
  if (ollamaUrl !== undefined && ollamaUrl.length > 0) {
    return createOllamaEmbedder(ollamaUrl);
  }
  return null;
};
