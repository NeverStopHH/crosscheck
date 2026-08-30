/**
 * GET /api/search — the hybrid search block (DESIGN.md §6).
 *
 * Three tiers, honestly degraded: exact target match (files, symbols, error
 * fingerprints — highest precision), FTS over the normalized doc and claim
 * bodies, and an OPTIONAL vector tier that exists only when an embedder is
 * configured. RRF fusion with time decay (half-life ~14 days).
 *
 * The keyless install is the default install, so keyless behavior is asserted
 * first-class here, not inferred: every lexical test in this file runs without
 * an embedder, and the vector tests prove both presence (fake embedder) and
 * silent absence (no embedder, failing embedder).
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { searchWorkContexts } from "../src/services/search.ts";
import {
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  TEST_START_ISO,
  validClaimBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";
import {
  createFailingEmbedder,
  createFakeEmbedder,
  createHangingEmbedder,
} from "./fixtures/fake-embedder.ts";

const API_REPO = VALID_SESSION_BODY.repo;
const WEB_REPO = "github.com/acme/web";
const WEB_SESSION_ID = "ses_web";

/** 60 days before TEST_START_ISO — deep into decay territory. */
const OLD_CREATED_ISO = "2026-05-25T09:00:00.000Z";

interface SearchResultView {
  readonly id: string;
  readonly developerName: string;
  readonly title: string;
  readonly status: string;
  readonly tier: string;
  readonly score: number;
}

interface SearchView {
  readonly status: number;
  readonly results: readonly SearchResultView[];
  readonly vectorTierActive: boolean;
}

const search = async (
  harness: TestHarness,
  apiKey: string | null,
  params: Record<string, string>,
): Promise<SearchView> => {
  const query = new URLSearchParams(params).toString();
  const response = await harness.app.request(
    `/api/search?${query}`,
    jsonRequest("GET", apiKey),
  );
  if (response.status !== 200) {
    return { status: response.status, results: [], vectorTierActive: false };
  }
  const body = (await response.json()) as {
    data: {
      results: SearchResultView[];
      vectorTierActive: boolean;
    };
  };
  return {
    status: response.status,
    results: body.data.results,
    vectorTierActive: body.data.vectorTierActive,
  };
};

interface SeedContext {
  readonly id: string;
  readonly title: string;
  readonly createdAt?: string;
  readonly sessionId?: string;
  readonly claimBodies?: readonly string[];
  readonly targetValues?: readonly string[];
}

const seedContext = async (
  harness: TestHarness,
  developer: TestDeveloper,
  seed: SeedContext,
): Promise<void> => {
  const sessionId = seed.sessionId ?? VALID_SESSION_BODY.id;
  const createdAt = seed.createdAt ?? TEST_START_ISO;
  const records = [
    recordEnvelope(
      "work_context",
      validWorkContextBody({
        id: seed.id,
        sessionId,
        title: seed.title,
        description: undefined,
        createdAt,
      }),
      { sessionId },
    ),
    ...(seed.targetValues ?? []).map((value) =>
      recordEnvelope(
        "target",
        { workContextId: seed.id, kind: "file", value },
        { sessionId },
      ),
    ),
    ...(seed.claimBodies ?? []).map((body, index) =>
      recordEnvelope(
        "claim",
        validClaimBody({
          id: `clm_${seed.id}_${String(index)}`,
          workContextId: seed.id,
          authorSessionId: sessionId,
          body,
          createdAt,
        }),
        { sessionId },
      ),
    ),
  ];
  const posted = await postRecords(harness, developer, { records });
  if (posted.status !== 200 || (posted.data?.rejected ?? 1) > 0) {
    throw new Error(`seed failed: ${JSON.stringify(posted.data?.results)}`);
  }
};

interface SeededHarness {
  readonly harness: TestHarness;
  readonly developer: TestDeveloper;
}

const createSearchHarness = async (
  options: {
    readonly embedder?: unknown;
    readonly embedDeadlineMs?: number;
  } = {},
): Promise<SeededHarness> => {
  const harness = await createTestHarness(
    options as Parameters<typeof createTestHarness>[0],
  );
  const developer = await createTestDeveloper(
    harness,
    "Nick",
    "nick@example.com",
  );
  await registerTestSession(harness, developer.apiKey);
  return { harness, developer };
};

describe("GET /api/search", () => {
  test("requires an api key like every other route", async () => {
    // Arrange
    const { harness } = await createSearchHarness();

    // Act
    const result = await search(harness, null, { query: "login" });

    // Assert
    expect(result.status).toBe(401);
  });

  test("finds a context through a word that appears only in a claim body", async () => {
    // Arrange
    const { harness, developer } = await createSearchHarness();
    await seedContext(harness, developer, {
      id: "wc_rotation",
      title: "Token rotation window overrun",
      claimBodies: ["The refresh path reads a rotated signing key"],
    });

    // Act
    const result = await search(harness, developer.apiKey, {
      query: "signing key",
    });

    // Assert: found via the claim summary, labelled as the text tier, scored
    const found = result.results.find((entry) => entry.id === "wc_rotation");
    expect(found).toBeDefined();
    expect(found?.tier).toBe("fts");
    expect(found?.score ?? 0).toBeGreaterThan(0);
    expect(found?.developerName).toBe("Nick");
  });

  test("ranks an exact target match above a same-age full-text match", async () => {
    // Arrange: wc_target owns the FILE; wc_text merely mentions refreshing.
    // Same createdAt, so decay cannot be what separates them.
    const { harness, developer } = await createSearchHarness();
    await seedContext(harness, developer, {
      id: "wc_target",
      title: "Token rotation window overrun",
      targetValues: ["src/auth/refresh.ts"],
    });
    await seedContext(harness, developer, {
      id: "wc_text",
      title: "Refresh flow returns stale key",
    });

    // Act
    const result = await search(harness, developer.apiKey, {
      query: "src/auth/refresh.ts",
    });

    // Assert
    expect(result.results[0]?.id).toBe("wc_target");
    expect(result.results[0]?.tier).toBe("exact");
    const textHit = result.results.find((entry) => entry.id === "wc_text");
    expect(textHit?.tier).toBe("fts");
  });

  test("matches a file target by its basename", async () => {
    // Arrange: an agent asks about "refresh.ts", not about the full path
    const { harness, developer } = await createSearchHarness();
    await seedContext(harness, developer, {
      id: "wc_target",
      title: "Token rotation window overrun",
      targetValues: ["src/auth/refresh.ts"],
    });

    // Act
    const result = await search(harness, developer.apiKey, {
      query: "refresh.ts",
    });

    // Assert
    expect(result.results[0]?.id).toBe("wc_target");
    expect(result.results[0]?.tier).toBe("exact");
  });

  test("an empty query lists recent work, newest first, as tier recency", async () => {
    // Arrange
    const { harness, developer } = await createSearchHarness();
    await seedContext(harness, developer, {
      id: "wc_old",
      title: "Cache stampede on deploy",
      createdAt: OLD_CREATED_ISO,
    });
    await seedContext(harness, developer, {
      id: "wc_new",
      title: "Login 500s on staging",
    });

    // Act
    const result = await search(harness, developer.apiKey, { query: "" });

    // Assert
    expect(result.results.map((entry) => entry.id)).toEqual([
      "wc_new",
      "wc_old",
    ]);
    expect(result.results[0]?.tier).toBe("recency");
  });

  test("repo filters for relevance without being a boundary", async () => {
    // Arrange: same hub, two repos (DESIGN.md §2.1 — the filter orders
    // relevance; it contains nobody, and omitting it searches the whole hub)
    const { harness, developer } = await createSearchHarness();
    await registerTestSession(harness, developer.apiKey, {
      id: WEB_SESSION_ID,
      repo: WEB_REPO,
    });
    await seedContext(harness, developer, {
      id: "wc_api",
      title: "Refresh flow returns stale key",
    });
    await seedContext(harness, developer, {
      id: "wc_web",
      title: "Refresh spinner never stops",
      sessionId: WEB_SESSION_ID,
    });

    // Act
    const filtered = await search(harness, developer.apiKey, {
      query: "refresh",
      repo: API_REPO,
    });
    const unfiltered = await search(harness, developer.apiKey, {
      query: "refresh",
    });

    // Assert
    expect(filtered.results.map((entry) => entry.id)).toEqual(["wc_api"]);
    const allIds = unfiltered.results.map((entry) => entry.id);
    expect(allIds).toContain("wc_api");
    expect(allIds).toContain("wc_web");
  });

  test("time decay ranks the fresher of two equal matches first", async () => {
    // Arrange: identical titles — identical FTS rank — 60 days apart
    const { harness, developer } = await createSearchHarness();
    await seedContext(harness, developer, {
      id: "wc_stale",
      title: "Cache stampede on deploy",
      createdAt: OLD_CREATED_ISO,
    });
    await seedContext(harness, developer, {
      id: "wc_fresh",
      title: "Cache stampede on deploy",
    });

    // Act
    const result = await search(harness, developer.apiKey, {
      query: "stampede",
    });

    // Assert
    expect(result.results.map((entry) => entry.id)).toEqual([
      "wc_fresh",
      "wc_stale",
    ]);
  });

  test("caps the result count and accepts an oversized limit by capping it", async () => {
    // Arrange
    const { harness, developer } = await createSearchHarness();
    for (let index = 0; index < 4; index += 1) {
      await seedContext(harness, developer, {
        id: `wc_${String(index)}`,
        title: `Cache stampede on deploy ${String(index)}`,
      });
    }

    // Act
    const limited = await search(harness, developer.apiKey, {
      query: "stampede",
      limit: "2",
    });
    const oversized = await search(harness, developer.apiKey, {
      query: "stampede",
      limit: "9999",
    });

    // Assert
    expect(limited.status).toBe(200);
    expect(limited.results.length).toBe(2);
    expect(oversized.status).toBe(200);
    expect(oversized.results.length).toBe(4);
  });
});

describe("the vector tier and its honest absence", () => {
  test("keyless: no vector tier, and lexical search still fully works", async () => {
    // Arrange: THE DEFAULT INSTALL. "authentication" shares no lexeme with
    // "Login 500s", so without an embedder this query honestly finds nothing.
    const { harness, developer } = await createSearchHarness();
    await seedContext(harness, developer, {
      id: "wc_login",
      title: "Login 500s on staging",
      claimBodies: ["The refresh path reads a rotated signing key"],
    });

    // Act
    const semantic = await search(harness, developer.apiKey, {
      query: "authentication timeouts",
    });
    const lexical = await search(harness, developer.apiKey, {
      query: "signing key",
    });

    // Assert
    expect(semantic.vectorTierActive).toBe(false);
    expect(semantic.results).toEqual([]);
    expect(lexical.results[0]?.id).toBe("wc_login");
  });

  test("with an embedder, the same query finds the semantic neighbor", async () => {
    // Arrange: the fake embedder puts "authentication" and "Login" on the
    // same topic axis, so this is the cross-vocabulary match of DESIGN.md §1
    // ("login 500s" ≈ "JWT validation regression")
    const { harness, developer } = await createSearchHarness({
      embedder: createFakeEmbedder(),
    });
    await seedContext(harness, developer, {
      id: "wc_login",
      title: "Login 500s on staging",
      claimBodies: ["The refresh path reads a rotated signing key"],
    });

    // Act
    const result = await search(harness, developer.apiKey, {
      query: "authentication timeouts",
    });

    // Assert
    expect(result.vectorTierActive).toBe(true);
    expect(result.results[0]?.id).toBe("wc_login");
    expect(result.results[0]?.tier).toBe("vector");
  });

  test("an embedder that fails degrades to lexical instead of failing search", async () => {
    // Arrange
    const { harness, developer } = await createSearchHarness({
      embedder: createFailingEmbedder(),
    });
    await seedContext(harness, developer, {
      id: "wc_login",
      title: "Login 500s on staging",
      claimBodies: ["The refresh path reads a rotated signing key"],
    });

    // Act
    const result = await search(harness, developer.apiKey, {
      query: "signing key",
    });

    // Assert
    expect(result.status).toBe(200);
    expect(result.results[0]?.id).toBe("wc_login");
    expect(result.vectorTierActive).toBe(false);
  });

  test("a hanging embedder degrades to lexical on the search deadline", async () => {
    // Arrange: an embed call that never settles (cold-loading Ollama, host
    // asleep) exactly when the search asks. Search must answer lexically on
    // its own deadline instead of hanging until the connector's timeout turns
    // it into a hub failure. The deadline is INJECTED small: what is proven
    // is degrade-on-deadline, not the production constant's 2 s of wall
    // wait, which under a loaded full-suite run pushed this test past its
    // own timeout — the one nondeterministic failure the gauntlet had.
    const HANG_DEADLINE_MS = 250;
    const { harness, developer } = await createSearchHarness({
      embedder: createHangingEmbedder("signing key"),
      embedDeadlineMs: HANG_DEADLINE_MS,
    });
    await seedContext(harness, developer, {
      id: "wc_login",
      title: "Login 500s on staging",
      claimBodies: ["The refresh path reads a rotated signing key"],
    });

    // Act
    const result = await search(harness, developer.apiKey, {
      query: "signing key",
    });

    // Assert: lexical results, vector tier honestly reported absent
    expect(result.status).toBe(200);
    expect(result.results[0]?.id).toBe("wc_login");
    expect(result.vectorTierActive).toBe(false);
  });
});

describe("query bounds that keep the hub alive", () => {
  /** Distinct ≥3-char tokens, the shape that killed PGlite unbounded. */
  const hugeQuery = (tokenCount: number): string =>
    Array.from({ length: tokenCount }, (_, index) => `tok${String(index)}xyz`).join(
      " ",
    );

  test("rejects an oversized query with 400 and answers the next search", async () => {
    // Arrange
    const { harness, developer } = await createSearchHarness();
    await seedContext(harness, developer, {
      id: "wc_alive",
      title: "Cache stampede on deploy",
    });

    // Act: ~34 KB of query, then a normal search on the same hub
    const oversized = await search(harness, developer.apiKey, {
      query: hugeQuery(5000),
    });
    const followUp = await search(harness, developer.apiKey, {
      query: "stampede",
    });

    // Assert: boundary rejection, and the embedded database survived it
    expect(oversized.status).toBe(400);
    expect(followUp.status).toBe(200);
    expect(followUp.results[0]?.id).toBe("wc_alive");
  });

  test("a query bypassing the route cannot kill the embedded database", async () => {
    // Arrange: call the service directly — the route cap must not be the only
    // thing standing between a long token list and a dead WASM heap.
    const { harness, developer } = await createSearchHarness();
    await seedContext(harness, developer, {
      id: "wc_alive",
      title: "Cache stampede on deploy",
    });

    // Act
    const result = await searchWorkContexts(
      { db: harness.db, now: harness.clock.now, embedder: null },
      { query: hugeQuery(5000), limit: 10 },
    );

    // Assert: resolved (not crashed), and the database still answers
    expect(Array.isArray(result.results)).toBe(true);
    const probe = await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM work_contexts`,
    );
    expect((probe.rows[0] as { n: number }).n).toBe(1);
  });
});

describe("ranking constants, each pinned by a behavior it alone produces", () => {
  test("an exact match outranks a context leading both text tiers", async () => {
    // Arrange: wc_exact appears ONLY in the exact tier (its path target is a
    // single tsvector file token, so "refresh"/"login" cannot FTS-match it,
    // and its title sits on no fake-embedder topic axis). wc_both is rank 1
    // in BOTH fts and vector. Same age everywhere, so only the exact-tier
    // weight separates 3/(60+1) from 1/(60+1) + 1/(60+1).
    const { harness, developer } = await createSearchHarness({
      embedder: createFakeEmbedder(),
    });
    await seedContext(harness, developer, {
      id: "wc_exact",
      title: "Token rotation window overrun",
      targetValues: ["src/auth/refresh.ts"],
    });
    await seedContext(harness, developer, {
      id: "wc_both",
      title: "Login refresh flow keeps failing",
    });

    // Act
    const result = await search(harness, developer.apiKey, {
      query: "refresh.ts login",
    });

    // Assert: weakest-exact beats strongest-non-exact at equal age
    expect(result.results[0]?.id).toBe("wc_exact");
    expect(result.results[0]?.tier).toBe("exact");
    expect(result.results[1]?.id).toBe("wc_both");
  });

  test("time decay demotes a stale exact match below a fresh text match", async () => {
    // Arrange: the stale context owns the exact file target (weight 3) but is
    // 60 days old; the fresh context merely FTS-matches (weight 1) today.
    // Without decay 3/61 beats 1/61 outright — decay is the ONLY thing that
    // can flip this ordering (0.5^(60/14) ≈ 0.05).
    const { harness, developer } = await createSearchHarness();
    await seedContext(harness, developer, {
      id: "wc_stale_exact",
      title: "Token rotation window overrun",
      targetValues: ["src/auth/refresh.ts"],
      createdAt: OLD_CREATED_ISO,
    });
    await seedContext(harness, developer, {
      id: "wc_fresh_text",
      title: "Refresh flow returns stale key",
    });

    // Act
    const result = await search(harness, developer.apiKey, {
      query: "refresh.ts",
    });

    // Assert: DESIGN.md §5 staleness — fresh text above stale exact
    expect(result.results.map((entry) => entry.id)).toEqual([
      "wc_fresh_text",
      "wc_stale_exact",
    ]);
  });

  test("the vector noise floor keeps orthogonal rows out of the results", async () => {
    // Arrange: cache topic context, authentication topic query — cosine 0,
    // no shared lexeme. Only the MIN_VECTOR_SIMILARITY floor stands between
    // this query and a nonsense "semantic" result.
    const { harness, developer } = await createSearchHarness({
      embedder: createFakeEmbedder(),
    });
    await seedContext(harness, developer, {
      id: "wc_cache",
      title: "Cache stampede on deploy",
    });

    // Act
    const result = await search(harness, developer.apiKey, {
      query: "authentication timeouts",
    });

    // Assert: the vector tier ran and honestly found nothing
    expect(result.vectorTierActive).toBe(true);
    expect(result.results).toEqual([]);
  });
});

describe("intent in search (trial finding #16)", () => {
  test("finds a context through a word that appears only in its intent, and returns the intent", async () => {
    // Arrange: title and targets share nothing with the query; the intent does
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    await registerTestSession(harness, nick.apiKey);
    await seedContext(harness, nick, { id: "wc_quota", title: "Tuesday cleanup" });
    await postRecords(
      harness,
      nick,
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          id: "wc_quota",
          title: "Tuesday cleanup",
          description: undefined,
          intent: {
            summary: "Refactor the tenant quota limiter so bursts stop tripping it",
            provenance: "derived",
            confidence: 0.4,
            capturedAt: TEST_START_ISO,
          },
        }),
      ),
    );

    // Act
    const result = await search(harness, nick.apiKey, { query: "quota limiter", repo: API_REPO });

    // Assert
    expect(result.results.map((row) => row.id)).toEqual(["wc_quota"]);
    expect(result.results[0]?.tier).toBe("fts");
    const intent = (result.results[0] as unknown as { intent: { summary: string } | null }).intent;
    expect(intent?.summary).toContain("tenant quota limiter");
  });
});
