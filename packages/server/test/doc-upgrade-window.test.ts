/**
 * THE WINDOW BEFORE THE DOC UPGRADE REACHES A CONTEXT (review round 4, M2).
 *
 * An upgraded hub serves before its doc upgrade has run (services/
 * doc-upgrade.ts runs in the background), and until the pass reaches a
 * context its doc — and the vector minted from it — still folds in every
 * draft's and every discard's words. The review's hint-window probe pushed a
 * teammate's tree into a prompt on a DISCARDED draft's word through exactly
 * that doc. So while a doc predates NORMALIZED_DOC_VERSION and its context
 * holds a non-declared claim, neither the doc pass nor the vector tier
 * answers for it: it is found by its claims (each marked as it is) and its
 * targets only. A context with declared claims only built the same doc under
 * both rules, and stays findable by it.
 *
 * The hub also says how many docs are still waiting (GET /api/hub-status,
 * which `crosscheck doctor` reads), and the pass logs its start and progress.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { countPendingDocs } from "../src/services/stale-docs.ts";
import { upgradeNormalizedDocs } from "../src/services/doc-upgrade.ts";
import { listHintCandidates } from "../src/services/hints.ts";
import { searchWorkContexts } from "../src/services/search.ts";
import type { Embedder } from "../src/services/embedder.ts";
import { createFakeEmbedder } from "./fixtures/fake-embedder.ts";
import { inMemoryUpgradeHub, seedPreRoundContexts } from "./fixtures/upgrade-hub.ts";
import {
  addTestDeveloperWithSession,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validClaimBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const derived = { captureMode: "auto", provenance: "derived", confidence: 0.4 } as const;
const SEARCH_LIMIT = 10;

interface WindowHub {
  readonly harness: TestHarness;
  readonly nick: TestDeveloper;
  readonly robin: TestDeveloper;
}

/**
 * Nick's tree with a draft, and a doc an older hub built: it still carries
 * the word of a draft Nick since DISCARDED ("kumquatoverflow").
 */
const preRoundTree = async (
  embedder: Embedder | null = null,
  claims: readonly Record<string, unknown>[] = [],
): Promise<WindowHub> => {
  const harness = await createTestHarness({ embedder });
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  await registerTestSession(harness, nick.apiKey);
  await postRecords(harness, nick, {
    records: [
      recordEnvelope("work_context", validWorkContextBody({ title: "Warm boot misses", description: "nothing here" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_draft", body: "zebrafrobnicator poisons the parser", ...derived })),
      ...claims.map((claim) => recordEnvelope("claim", validClaimBody(claim))),
    ],
  });
  await harness.db.execute(
    sql`UPDATE work_contexts SET doc_version = 0, normalized_doc = normalized_doc || E'\nhypothesis: kumquatoverflow breaks it' WHERE id = 'wc_01'`,
  );
  const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02", branch: "x" });
  return { harness, nick, robin };
};

const search = (hub: WindowHub, query: string, embedder: Embedder | null = null) =>
  searchWorkContexts(
    { db: hub.harness.db, now: hub.harness.clock.now, embedder },
    { query, repo: VALID_SESSION_BODY.repo, limit: SEARCH_LIMIT },
  );

const hint = (hub: WindowHub, query: string) =>
  listHintCandidates({ db: hub.harness.db, now: hub.harness.clock.now, embedder: null } as never, hub.robin.developerId, {
    query,
    repo: VALID_SESSION_BODY.repo,
  });

describe("before the doc upgrade reaches a context that holds a draft", () => {
  test("a hint never pushes a teammate's tree on a word only its stale doc carries", async () => {
    // Arrange
    const hub = await preRoundTree();

    // Act
    const inTheWindow = await hint(hub, "kumquatoverflow");
    await upgradeNormalizedDocs({ db: hub.harness.db, embedder: null });
    const afterThePass = await hint(hub, "kumquatoverflow");

    // Assert
    expect(inTheWindow).toEqual([]);
    expect(afterThePass).toEqual([]);
  });

  test("search does not find the tree by its stale doc either", async () => {
    const hub = await preRoundTree();

    expect((await search(hub, "kumquatoverflow")).results).toEqual([]);
  });

  test("the tree is still found by a vouched claim, as vouched", async () => {
    // Arrange
    const hub = await preRoundTree(null, [{ id: "clm_vouched", body: "quixotic retry storm in the scheduler" }]);

    // Act
    const { results } = await search(hub, "quixotic");

    // Assert
    expect(results.map((row) => [row.id, row.tier, row.derivedOnly])).toEqual([["wc_01", "fts", false]]);
  });

  test("its old vector — minted from the doc that folds drafts in — does not surface it", async () => {
    // Arrange: the old vector sits on the cache topic; no word of the query is in the doc
    const fake = createFakeEmbedder();
    const hub = await preRoundTree(fake);
    const [oldVector] = await fake.embed(["warm cache"]);
    await hub.harness.db.execute(
      sql`UPDATE work_contexts SET embedding = ${JSON.stringify(oldVector)}::vector, embedding_model = ${fake.model} WHERE id = 'wc_01'`,
    );

    // Act
    const { results } = await search(hub, "cache", fake);

    // Assert
    expect(results).toEqual([]);
  });

  test("a stale doc of a context with declared claims only is the same under both rules, and still answers", async () => {
    // Arrange: an older hub's doc, never stamped, no draft in the context
    const { harness } = await inMemoryUpgradeHub();
    await seedPreRoundContexts(harness.db, 1, { withDraft: false });

    // Act
    const { results } = await searchWorkContexts(
      { db: harness.db, now: harness.clock.now, embedder: null },
      { query: "zebrafrobnicator", repo: VALID_SESSION_BODY.repo, limit: SEARCH_LIMIT },
    );

    // Assert
    expect(results.map((row) => row.id)).toEqual(["wc_000001"]);
  });
});

describe("the hub says how many search docs are still waiting", () => {
  test("GET /api/hub-status counts the docs the upgrade has yet to rebuild", async () => {
    // Arrange
    const hub = await preRoundTree();
    const status = async () =>
      (await (await hub.harness.app.request("/api/hub-status", jsonRequest("GET", hub.robin.apiKey))).json()) as {
        data: { searchDocsPending: number };
      };

    // Act
    const before = await status();
    await upgradeNormalizedDocs({ db: hub.harness.db, embedder: null });
    const after = await status();

    // Assert
    expect(before.data.searchDocsPending).toBe(1);
    expect(after.data.searchDocsPending).toBe(0);
  });

  test("GET /api/hub-status needs a developer's key", async () => {
    const hub = await preRoundTree();

    expect((await hub.harness.app.request("/api/hub-status", jsonRequest("GET", null))).status).toBe(401);
  });

  test("a declared-only context is not counted as waiting", async () => {
    const { harness } = await inMemoryUpgradeHub();
    await seedPreRoundContexts(harness.db, 2, { withDraft: false });
    await seedPreRoundContexts(harness.db, 3, { prefix: "wd_" });

    expect(await countPendingDocs(harness.db)).toBe(3);
  });
});

describe("the doc upgrade says what it is doing", () => {
  test("it logs its start with the pending count, then its progress every few pages", async () => {
    // Arrange
    const { harness } = await inMemoryUpgradeHub();
    await seedPreRoundContexts(harness.db, 5);
    const lines: string[] = [];

    // Act
    await upgradeNormalizedDocs(
      { db: harness.db, embedder: null },
      { batch: 1, progressEveryPages: 2, progress: (line) => lines.push(line) },
    );

    // Assert
    expect(lines).toEqual([
      "starting: 5 work context doc(s) still fold drafts in; until each is rebuilt it is found by its claims only",
      "2 of 5 rebuilt",
      "4 of 5 rebuilt",
    ]);
  });

  test("a hub with nothing to rebuild logs no start", async () => {
    const { harness } = await inMemoryUpgradeHub();
    const lines: string[] = [];

    await upgradeNormalizedDocs({ db: harness.db, embedder: null }, { progress: (line) => lines.push(line) });

    expect(lines).toEqual([]);
  });
});
