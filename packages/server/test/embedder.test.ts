/**
 * The embedder factory: which embedder a hub gets from its environment.
 *
 * The default answer is NONE — the keyless install is the default install
 * (DESIGN.md §6), and null here is what makes the vector tier silently absent
 * everywhere else. Explicit misconfiguration fails fast at startup instead of
 * degrading silently: a hub told to use OpenAI without a key is broken in a
 * way its operator meant to notice.
 */
import { describe, expect, test } from "bun:test";

import { createEmbedderFromEnv } from "../src/services/embedder.ts";

describe("createEmbedderFromEnv", () => {
  test("no configuration at all yields no embedder — the default install", () => {
    expect(createEmbedderFromEnv({})).toBeNull();
  });

  test("an explicit none yields no embedder even when a key is present", () => {
    expect(
      createEmbedderFromEnv({
        CROSSCHECK_EMBEDDER: "none",
        OPENAI_API_KEY: "sk-test",
      }),
    ).toBeNull();
  });

  test("an OpenAI key alone selects the OpenAI embedder", () => {
    // Arrange + Act
    const embedder = createEmbedderFromEnv({ OPENAI_API_KEY: "sk-test" });

    // Assert: the model id names provider, model and dimensionality, because
    // vectors are only comparable within one of these
    expect(embedder?.model).toBe("openai:text-embedding-3-small@768d");
  });

  test("an Ollama url alone selects the Ollama embedder", () => {
    // Arrange + Act
    const embedder = createEmbedderFromEnv({
      CROSSCHECK_OLLAMA_URL: "http://127.0.0.1:11434",
    });

    // Assert
    expect(embedder?.model).toBe("ollama:nomic-embed-text@768d");
  });

  test("asking for openai without a key fails fast at startup", () => {
    expect(() =>
      createEmbedderFromEnv({ CROSSCHECK_EMBEDDER: "openai" }),
    ).toThrow(/OPENAI_API_KEY/);
  });

  test("an unknown embedder name fails fast rather than silently degrading", () => {
    expect(() =>
      createEmbedderFromEnv({ CROSSCHECK_EMBEDDER: "cohere" }),
    ).toThrow(/cohere/);
  });
});
