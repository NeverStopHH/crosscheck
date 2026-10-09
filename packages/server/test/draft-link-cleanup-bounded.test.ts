/**
 * THE DRAFT-LINK CLEANUP AT PILOT SCALE (batch-2 integration review, H6).
 *
 * The cleanup ran on every start, after serving, and stalled every request
 * for 9–86 s on a hub with legacy similarity edges. Each legacy edge's "no
 * wire record" test was a NOT EXISTS over `events` inside an OR, which the
 * planner cannot turn into an anti-join: it scanned all of `events` once per
 * legacy edge, twice per pass (EXPLAIN: SubPlan → Seq Scan on events,
 * loops=4000, 119 380 rows removed per loop). PGlite holds the event loop for
 * the whole statement, so every request waited it out.
 *
 * Three guards:
 *   - the wire-record lookup reads events_claim_edge_added_edge_idx and never
 *     loops a subplan over `events`;
 *   - the work is paged: a batch smaller than the work ends exactly where one
 *     pass ends, under one pass id;
 *   - the pass takes a turn of the event loop between pages, so a request
 *     waits out one page at most.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { draftLinkPageQuery, removeCrossDeveloperDraftLinks } from "../src/services/draft-link-cleanup.ts";
import { AUTO_SIMILARITY_NOTE } from "../src/services/similarity-gate.ts";
import {
  addTestDeveloperWithSession,
  createTestDeveloper,
  createTestHarness,
  registerTestSession,
  TEST_START_ISO,
  VALID_SESSION_BODY,
} from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const NICK_S = VALID_SESSION_BODY.id;
const ROBIN_S = "ses_02";
const INDEX = "events_claim_edge_added_edge_idx";

const claim = (harness: TestHarness, id: string, session: string, provenance: "declared" | "derived") =>
  harness.db.execute(sql`
    INSERT INTO claims (id, work_context_id, author_session_id, kind, body, status, confidence, capture_mode, provenance, created_at)
    VALUES (${id}, ${session === NICK_S ? "wc_nick" : "wc_robin"}, ${session}, 'observation', ${`body of ${id}`}, 'proposed', 0.5,
            ${provenance === "declared" ? "agent" : "auto"}, ${provenance}, ${TEST_START_ISO}::timestamptz)`);

/** An edge as the older gate wrote it: its note, its from end's author, no origin. */
const legacyEdge = (harness: TestHarness, id: string, from: string, to: string, author: string, kind = "relates_to") =>
  harness.db.execute(sql`
    INSERT INTO claim_edges (id, from_claim_id, to_claim_id, kind, author_session_id, note, origin, created_at)
    VALUES (${id}, ${from}, ${to}, ${kind}, ${author}, ${kind === "relates_to" ? AUTO_SIMILARITY_NOTE : null}, NULL,
            ${TEST_START_ISO}::timestamptz)`);

/**
 * Nick's vouched claim, his draft since confirmed by a vouched revision, and
 * Robin's vouched claim and draft. Legacy links: one from Nick's confirmed
 * draft into Robin's tree (moves to the revision), two into a teammate's
 * unconfirmed draft (archived), one between vouched claims and one inside
 * Nick's tree (both kept), and one that came over the wire (kept).
 */
const seed = async (): Promise<TestHarness> => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  await registerTestSession(harness, nick.apiKey);
  await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: ROBIN_S });
  await harness.db.execute(sql`
    INSERT INTO work_contexts (id, session_id, title, status, created_at)
    VALUES ('wc_nick', ${NICK_S}, 'nick', 'analyzing', now()), ('wc_robin', ${ROBIN_S}, 'robin', 'analyzing', now())`);
  await claim(harness, "clm_n", NICK_S, "declared");
  await claim(harness, "clm_nd", NICK_S, "derived");
  await claim(harness, "clm_nr", NICK_S, "declared");
  await claim(harness, "clm_r", ROBIN_S, "declared");
  await claim(harness, "clm_rd", ROBIN_S, "derived");
  await legacyEdge(harness, "edge_0_revision", "clm_nr", "clm_nd", NICK_S, "supersedes");
  await legacyEdge(harness, "edge_1_confirmed_draft", "clm_nd", "clm_r", NICK_S);
  await legacyEdge(harness, "edge_2_into_draft", "clm_n", "clm_rd", NICK_S);
  await legacyEdge(harness, "edge_3_from_draft", "clm_rd", "clm_n", ROBIN_S);
  await legacyEdge(harness, "edge_4_vouched", "clm_n", "clm_r", NICK_S);
  await legacyEdge(harness, "edge_5_own", "clm_nd", "clm_n", NICK_S);
  await legacyEdge(harness, "edge_6_wire", "clm_nd", "clm_rd", NICK_S);
  await harness.db.execute(sql`
    INSERT INTO events (kind, payload, created_at)
    SELECT 'claim_edge_added', jsonb_build_object('edgeId', 'unrelated_' || g), now() FROM generate_series(1, 50) g
    UNION ALL SELECT 'claim_edge_added', jsonb_build_object('edgeId', 'edge_6_wire'), now()`);
  return harness;
};

const planOf = async (harness: TestHarness): Promise<string> => {
  await harness.db.execute(sql`SET enable_seqscan = off`);
  try {
    const plan = await harness.db.execute<{ "QUERY PLAN": string }>(sql`EXPLAIN (COSTS OFF) ${draftLinkPageQuery("", 100)}`);
    return plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
  } finally {
    await harness.db.execute(sql`RESET enable_seqscan`);
  }
};

const archivedPasses = async (harness: TestHarness): Promise<readonly string[]> =>
  (await harness.db.execute<{ pass: string }>(sql`SELECT DISTINCT removed_by_pass AS pass FROM claim_edges_removed`)).rows.map(
    (row) => row.pass,
  );

const edges = async (harness: TestHarness): Promise<readonly string[]> =>
  (
    await harness.db.execute<{ id: string; from: string; to: string }>(
      sql`SELECT id, from_claim_id AS from, to_claim_id AS to FROM claim_edges ORDER BY id`,
    )
  ).rows.map((row) => `${row.id}:${row.from}->${row.to}`);

describe("the draft-link cleanup reads a legacy edge's wire record by index (H6)", () => {
  test("the page selector uses the wire-record index and never loops a subplan over events", async () => {
    // Arrange
    const harness = await seed();

    // Act
    const plan = await planOf(harness);

    // Assert — the index by its own name, not one that merely starts with it
    expect(plan).toMatch(new RegExp(`\\b${INDEX}\\b`));
    expect(plan).not.toContain("SubPlan");
  });
});

describe("the draft-link cleanup is paged (H6)", () => {
  test("a batch of one ends where one whole pass ends, under one pass id", async () => {
    // Arrange
    const paged = await seed();
    const whole = await seed();

    // Act
    const pagedReport = await removeCrossDeveloperDraftLinks(paged.db, { batch: 1 });
    const wholeReport = await removeCrossDeveloperDraftLinks(whole.db);

    // Assert
    expect([...pagedReport.removed].sort()).toEqual(["edge_2_into_draft", "edge_3_from_draft"]);
    expect([...pagedReport.repointed]).toEqual(["edge_1_confirmed_draft"]);
    expect([...pagedReport.removed].sort()).toEqual([...wholeReport.removed].sort());
    expect(await edges(paged)).toEqual(await edges(whole));
    expect(await edges(paged)).toContain("edge_1_confirmed_draft:clm_nr->clm_r");
    expect(await archivedPasses(paged)).toEqual([pagedReport.passId]);
  });

  test("a second start finds nothing, paged or not", async () => {
    // Arrange
    const harness = await seed();
    await removeCrossDeveloperDraftLinks(harness.db, { batch: 1 });

    // Act
    const again = await removeCrossDeveloperDraftLinks(harness.db, { batch: 1 });

    // Assert
    expect(again.removed).toEqual([]);
    expect(again.repointed).toEqual([]);
  });

  test("the pass takes a turn of the event loop between pages", async () => {
    // Arrange
    const harness = await seed();
    let turned = false;
    setImmediate(() => {
      turned = true;
    });

    // Act
    const turnedBeforeTheEnd = await removeCrossDeveloperDraftLinks(harness.db, { batch: 1 }).then(() => turned);

    // Assert
    expect(turnedBeforeTheEnd).toBe(true);
  });
});
