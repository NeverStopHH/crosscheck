/**
 * THE LINKS A PRE-ROUND GATE MADE BETWEEN TEAMMATES ON A DRAFT'S STRENGTH
 * (review round 3, MEDIUM-4; services/draft-link-cleanup.ts). The similarity
 * gate no longer auto-links a draft into a teammate's tree, but a hub that ran
 * the older gate kept every such edge — the review's migration probe found
 * Nick's draft still linked into Robin's tree after the upgrade. The start-up
 * cleanup deletes exactly those: auto similarity relates_to edges whose two
 * ends belong to different developers and at least one end is derived.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { claimEdges } from "../src/db/schema.ts";
import { removeCrossDeveloperDraftLinks } from "../src/services/draft-link-cleanup.ts";
import { AUTO_SIMILARITY_NOTE } from "../src/services/similarity-gate.ts";
import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  postRecords,
  recordEnvelope,
  TEST_START_ISO,
  validClaimBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const ROBIN_SESSION_ID = "ses_02";
const derived = { captureMode: "auto", provenance: "derived", confidence: 0.4 } as const;

/** An edge as the older gate wrote it, straight into the table. */
const legacyEdge = (harness: TestHarness, id: string, from: string, to: string, note: string = AUTO_SIMILARITY_NOTE) =>
  harness.db.execute(
    sql`INSERT INTO claim_edges (id, from_claim_id, to_claim_id, kind, author_session_id, note, created_at)
      VALUES (${id}, ${from}, ${to}, 'relates_to', ${VALID_SESSION_BODY.id}, ${note}, ${TEST_START_ISO}::timestamptz)`,
  );

/** Nick's declared claim and draft; Robin's declared claim and draft — four ends to link. */
const seedTwoTrees = async (): Promise<TestHarness> => {
  const { harness, developer: nick } = await createHarnessWithSession();
  await postRecords(harness, nick, {
    records: [
      recordEnvelope("work_context", validWorkContextBody()),
      recordEnvelope("claim", validClaimBody({ id: "clm_nick", body: "Nick's vouched finding" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_nick_draft", kind: "hypothesis", body: "Nick's machine guess", ...derived })),
    ],
  });
  const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: ROBIN_SESSION_ID });
  const asRobin = { sessionId: ROBIN_SESSION_ID };
  await postRecords(harness, robin, {
    records: [
      recordEnvelope("work_context", validWorkContextBody({ id: "wc_robin", sessionId: ROBIN_SESSION_ID }), asRobin),
      recordEnvelope("claim", validClaimBody({ id: "clm_robin", workContextId: "wc_robin", authorSessionId: ROBIN_SESSION_ID, body: "Robin's vouched finding" }), asRobin),
      recordEnvelope(
        "claim",
        validClaimBody({ id: "clm_robin_draft", kind: "hypothesis", workContextId: "wc_robin", authorSessionId: ROBIN_SESSION_ID, body: "Robin's machine guess", ...derived }),
        asRobin,
      ),
    ],
  });
  return harness;
};

const edgeIds = async (harness: TestHarness): Promise<readonly string[]> =>
  (await harness.db.select({ id: claimEdges.id }).from(claimEdges)).map((row) => row.id).sort();

describe("removeCrossDeveloperDraftLinks", () => {
  test("deletes the auto links between teammates that have a derived end, and nothing else", async () => {
    // Arrange
    const harness = await seedTwoTrees();
    await legacyEdge(harness, "edge_draft_into_teammate", "clm_nick_draft", "clm_robin");
    await legacyEdge(harness, "edge_into_teammates_draft", "clm_nick", "clm_robin_draft");
    await legacyEdge(harness, "edge_vouched_pair", "clm_nick", "clm_robin");
    await legacyEdge(harness, "edge_own_draft", "clm_nick_draft", "clm_nick");
    await legacyEdge(harness, "edge_human_note", "clm_nick_draft", "clm_robin_draft", "Robin and I saw the same thing");

    // Act
    const removed = await removeCrossDeveloperDraftLinks(harness.db);

    // Assert
    expect(removed).toBe(2);
    expect(await edgeIds(harness)).toEqual(["edge_human_note", "edge_own_draft", "edge_vouched_pair"]);
  });

  test("is idempotent: a second start removes nothing", async () => {
    const harness = await seedTwoTrees();
    await legacyEdge(harness, "edge_draft_into_teammate", "clm_nick_draft", "clm_robin");
    await removeCrossDeveloperDraftLinks(harness.db);

    expect(await removeCrossDeveloperDraftLinks(harness.db)).toBe(0);
  });
});
