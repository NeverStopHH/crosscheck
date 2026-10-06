/**
 * THE UPGRADE PASS THAT TAKES DRAFTS BACK OUT OF THE DOCS (review round 3,
 * HIGH-1; services/doc-upgrade.ts), exercised the way a real hub meets it: a
 * PERSISTENT data dir whose doc was built under the pre-round rule — every
 * draft's and every discard's words folded in, seeded here through SQL the
 * way the review's migration probe found it — closed, opened again by the
 * current code, and passed over.
 *
 * Before the pass the probe's finding reproduces: a teammate's search finds
 * the DISCARDED word as an ordinary match. After it, the discarded word
 * finds nothing and the unreviewed draft's word is marked draft-only.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";

import { createDb, createServer } from "../src/index.ts";
import type { Db, Embedder } from "../src/index.ts";
import { upgradeNormalizedDocs } from "../src/services/doc-upgrade.ts";
import { NORMALIZED_DOC_VERSION } from "../src/services/normalized-doc.ts";
import { createFakeEmbedder } from "./fixtures/fake-embedder.ts";
import {
  addTestDeveloperWithSession,
  createFakeClock,
  createTestDeveloper,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  TEST_ADMIN_TOKEN,
  TEST_CI_TOKEN,
  TEST_WEBAUTHN_ORIGIN,
  validClaimBody,
  validClaimEdgeBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

/** Generous: this file boots real persistent PGlite instances, ~2s each. */
const UPGRADE_TEST_TIMEOUT_MS = 30_000;

const DRAFT_WORD = "zebrafrobnicator";
const DISCARDED_WORD = "kumquatoverflow";

/**
 * On the fake embedder's warm/cache axis, so the vector tier never lists the
 * tree for the two neutral words below: what is left is the lexical answer.
 */
const TITLE = "Warm boot misses";

/** The doc a pre-round hub built for wc_01: the draft and the discard folded in. */
const PRE_ROUND_DOC = [
  TITLE,
  "analyzing",
  "nothing here",
  `observation: The ${DRAFT_WORD} cache poisons the quuxinator`,
  `hypothesis: ${DISCARDED_WORD} breaks the parser`,
  `hypothesis: ${DISCARDED_WORD} breaks the parser`,
].join("\n");

const tempDirs: string[] = [];

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

interface Hub {
  readonly harness: TestHarness;
  readonly close: () => Promise<void>;
}

const boot = async (dataDir: string, embedder: Embedder): Promise<Hub> => {
  const db: Db = await createDb({ dataDir });
  const clock = createFakeClock();
  const app = createServer({
    db,
    now: clock.now,
    adminToken: TEST_ADMIN_TOKEN,
    ciToken: TEST_CI_TOKEN,
    embedder,
    webauthnOrigins: [TEST_WEBAUTHN_ORIGIN],
    peerAddress: () => "127.0.0.1",
  });
  return {
    harness: { app, clock, db },
    close: () => (db as unknown as { $client: PGlite }).$client.close(),
  };
};

const derived = { captureMode: "auto", provenance: "derived", confidence: 0.4 } as const;

/** Nick's tree: an unreviewed draft and a discarded one; Robin is the searcher. */
const seedPreRoundHub = async (dataDir: string, embedder: Embedder): Promise<{ robin: TestDeveloper }> => {
  const hub = await boot(dataDir, embedder);
  const nick = await createTestDeveloper(hub.harness, "Nick", "nick@example.com");
  await registerTestSession(hub.harness, nick.apiKey);
  await postRecords(hub.harness, nick, {
    records: [
      recordEnvelope("work_context", validWorkContextBody({ title: TITLE, description: "nothing here" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_draft", body: `The ${DRAFT_WORD} cache poisons the quuxinator`, ...derived })),
      recordEnvelope("claim", validClaimBody({ id: "clm_d2", kind: "hypothesis", body: `${DISCARDED_WORD} breaks the parser`, ...derived })),
      recordEnvelope(
        "claim",
        validClaimBody({ id: "clm_d2x", kind: "hypothesis", status: "rejected", body: `${DISCARDED_WORD} breaks the parser`, ...derived }),
      ),
      recordEnvelope("claim_edge", validClaimEdgeBody({ id: "edge_discard", fromClaimId: "clm_d2x", toClaimId: "clm_d2", kind: "supersedes" })),
    ],
  });
  const robin = await addTestDeveloperWithSession(hub.harness, "Robin", "robin@example.com", { id: "ses_02", branch: "x" });
  // THE PRE-ROUND STATE: the doc the old rule built, its vector, no version.
  const [vector] = await embedder.embed([PRE_ROUND_DOC]);
  await hub.harness.db.execute(
    sql`UPDATE work_contexts SET normalized_doc = ${PRE_ROUND_DOC}, doc_version = 0,
        embedding = ${JSON.stringify(vector)}::vector, embedding_model = ${embedder.model}
      WHERE id = ${WORK_CONTEXT_ID}`,
  );
  await hub.close();
  return { robin };
};

interface SearchRow {
  readonly id: string;
  readonly derivedOnly?: boolean;
}

const search = async (harness: TestHarness, developer: TestDeveloper, query: string): Promise<readonly SearchRow[]> => {
  const params = new URLSearchParams({ query, repo: VALID_SESSION_BODY.repo });
  const response = await harness.app.request(`/api/search?${params.toString()}`, jsonRequest("GET", developer.apiKey));
  return ((await response.json()) as { data: { results: SearchRow[] } }).data.results;
};

const docRow = async (harness: TestHarness) =>
  (
    await harness.db.execute(
      sql`SELECT normalized_doc, doc_version, embedding_model, embedding IS NOT NULL AS has_embedding FROM work_contexts WHERE id = ${WORK_CONTEXT_ID}`,
    )
  ).rows[0] as { normalized_doc: string; doc_version: number; embedding_model: string | null; has_embedding: boolean };

describe("a hub upgraded across the declared-only doc rule", () => {
  test(
    "after restart and the start-up pass, the discarded word finds nothing and the draft-only word is marked",
    async () => {
      // Arrange: a pre-round dir, reopened by the current code
      const dataDir = await mkdtemp(join(tmpdir(), "crosscheck-doc-upgrade-"));
      tempDirs.push(dataDir);
      const embedder = createFakeEmbedder();
      const { robin } = await seedPreRoundHub(dataDir, embedder);
      const hub = await boot(dataDir, embedder);
      try {
        // The probe's finding, reproduced on the reopened hub
        const before = await search(hub.harness, robin, DISCARDED_WORD);
        expect(before.find((row) => row.id === WORK_CONTEXT_ID)?.derivedOnly).toBe(false);

        // Act
        const report = await upgradeNormalizedDocs({ db: hub.harness.db, embedder });

        // Assert
        expect(report).toEqual({ contexts: 1, stamped: 0, reembedded: 1 });
        expect(await search(hub.harness, robin, DISCARDED_WORD)).toEqual([]);
        const draftHit = (await search(hub.harness, robin, DRAFT_WORD)).find((row) => row.id === WORK_CONTEXT_ID);
        expect(draftHit?.derivedOnly).toBe(true);
        const row = await docRow(hub.harness);
        expect(row.normalized_doc).not.toContain(DRAFT_WORD);
        expect(row.normalized_doc).not.toContain(DISCARDED_WORD);
        expect(row.doc_version).toBe(NORMALIZED_DOC_VERSION);
        // Re-embedded from the rebuilt doc, not left out of the vector tier
        expect(row.has_embedding).toBe(true);
        expect(row.embedding_model).toBe(embedder.model);
      } finally {
        await hub.close();
      }
    },
    UPGRADE_TEST_TIMEOUT_MS,
  );

  test(
    "the pass records its progress: a second start rebuilds nothing",
    async () => {
      const dataDir = await mkdtemp(join(tmpdir(), "crosscheck-doc-upgrade-"));
      tempDirs.push(dataDir);
      const embedder = createFakeEmbedder();
      await seedPreRoundHub(dataDir, embedder);
      const first = await boot(dataDir, embedder);
      await upgradeNormalizedDocs({ db: first.harness.db, embedder });
      await first.close();

      const second = await boot(dataDir, embedder);
      try {
        expect(await upgradeNormalizedDocs({ db: second.harness.db, embedder })).toEqual({ contexts: 0, stamped: 0, reembedded: 0 });
      } finally {
        await second.close();
      }
    },
    UPGRADE_TEST_TIMEOUT_MS,
  );
});

describe("which contexts the pass rebuilds", () => {
  const inMemory = async (): Promise<{ hub: Hub; nick: TestDeveloper }> => {
    const db: Db = await createDb();
    const clock = createFakeClock();
    const app = createServer({
      db,
      now: clock.now,
      adminToken: TEST_ADMIN_TOKEN,
      ciToken: TEST_CI_TOKEN,
      embedder: null,
      webauthnOrigins: [TEST_WEBAUTHN_ORIGIN],
      peerAddress: () => "127.0.0.1",
    });
    const hub = { harness: { app, clock, db }, close: () => Promise.resolve() };
    const nick = await createTestDeveloper(hub.harness, "Nick", "nick@example.com");
    await registerTestSession(hub.harness, nick.apiKey);
    return { hub, nick };
  };

  const markPreRound = (harness: TestHarness, id: string) =>
    harness.db.execute(sql`UPDATE work_contexts SET doc_version = 0 WHERE id = ${id}`);

  test("pre-round docs that hold a non-declared claim are rebuilt across pages, each once; declared-only ones are stamped", async () => {
    // Arrange: three pre-round contexts with a draft, one with declared claims only
    const { hub, nick } = await inMemory();
    const ids = ["wc_a", "wc_b", "wc_c"];
    await postRecords(hub.harness, nick, {
      records: [
        ...ids.flatMap((id) => [
          recordEnvelope("work_context", validWorkContextBody({ id })),
          recordEnvelope("claim", validClaimBody({ id: `clm_${id}`, workContextId: id, body: `Draft in ${id}`, ...derived })),
        ]),
        recordEnvelope("work_context", validWorkContextBody({ id: "wc_declared" })),
        recordEnvelope("claim", validClaimBody({ id: "clm_declared", workContextId: "wc_declared", body: "A vouched finding" })),
      ],
    });
    for (const id of [...ids, "wc_declared"]) {
      await markPreRound(hub.harness, id);
    }
    const declaredDocBefore = await hub.harness.db.execute(sql`SELECT normalized_doc FROM work_contexts WHERE id = 'wc_declared'`);

    // Act: one context per page
    const report = await upgradeNormalizedDocs({ db: hub.harness.db, embedder: null }, { batch: 1 });

    // Assert: the declared-only doc is the same under both rules, so it is
    // only STAMPED — and no later start scans it again (review round 4, L2)
    expect(report).toEqual({ contexts: ids.length, stamped: 1, reembedded: 0 });
    const versions = await hub.harness.db.execute(sql`SELECT id, doc_version FROM work_contexts ORDER BY id`);
    expect(versions.rows).toEqual([
      { id: "wc_a", doc_version: NORMALIZED_DOC_VERSION },
      { id: "wc_b", doc_version: NORMALIZED_DOC_VERSION },
      { id: "wc_c", doc_version: NORMALIZED_DOC_VERSION },
      { id: "wc_declared", doc_version: NORMALIZED_DOC_VERSION },
    ]);
    const declaredDocAfter = await hub.harness.db.execute(sql`SELECT normalized_doc FROM work_contexts WHERE id = 'wc_declared'`);
    expect(declaredDocAfter.rows).toEqual(declaredDocBefore.rows);
    expect(await upgradeNormalizedDocs({ db: hub.harness.db, embedder: null })).toEqual({ contexts: 0, stamped: 0, reembedded: 0 });
  });

  test("a run interrupted part-way resumes with exactly the contexts it had not reached", async () => {
    const { hub, nick } = await inMemory();
    await postRecords(hub.harness, nick, {
      records: ["wc_a", "wc_b"].flatMap((id) => [
        recordEnvelope("work_context", validWorkContextBody({ id })),
        recordEnvelope("claim", validClaimBody({ id: `clm_${id}`, workContextId: id, body: `Draft in ${id}`, ...derived })),
      ]),
    });
    // wc_a was rebuilt by the run that was cut off; wc_b was not reached
    await markPreRound(hub.harness, "wc_b");

    expect(await upgradeNormalizedDocs({ db: hub.harness.db, embedder: null })).toEqual({ contexts: 1, stamped: 0, reembedded: 0 });
  });
});
