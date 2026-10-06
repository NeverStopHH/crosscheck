/**
 * THE LINKS A PRE-ROUND GATE MADE BETWEEN TEAMMATES ON A DRAFT'S STRENGTH
 * (review round 3, MEDIUM-4; services/draft-link-cleanup.ts). The similarity
 * gate no longer auto-links a draft into a teammate's tree, but a hub that ran
 * the older gate kept every such edge — the review's migration probe found
 * Nick's draft still linked into Robin's tree after the upgrade. The start-up
 * cleanup handles exactly those: the gate's relates_to edges whose two ends
 * belong to different developers and at least one end is derived.
 *
 * Round 4 (H3) made it safe on a real hub: nothing it removes is lost (each
 * row is archived in claim_edges_removed by the same statement, with a
 * documented restore), only the gate's own edges match (a structural origin
 * from now on; for older rows the gate's note AND the gate's authorship AND
 * no wire record of the edge), and a link whose draft was since CONFIRMED
 * moves to the confirmed claim instead of being dropped.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { claimEdges } from "../src/db/schema.ts";
import { getDiagnosis } from "../src/services/diagnosis.ts";
import { describeDraftLinkCleanup, removeCrossDeveloperDraftLinks } from "../src/services/draft-link-cleanup.ts";
import { AUTO_SIMILARITY_NOTE } from "../src/services/similarity-gate.ts";
import { createFakeEmbedder } from "./fixtures/fake-embedder.ts";
import { documentedSql } from "./fixtures/operations-doc.ts";
import {
  addTestDeveloperWithSession,
  createTestDeveloper,
  createTestHarness,
  postRecords,
  recordEnvelope,
  registerTestSession,
  TEST_START_ISO,
  validClaimBody,
  validClaimEdgeBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const NICK_SESSION_ID = VALID_SESSION_BODY.id;
const ROBIN_SESSION_ID = "ses_02";
const asRobin = { sessionId: ROBIN_SESSION_ID };
const derived = { captureMode: "auto", provenance: "derived", confidence: 0.4 } as const;

interface LegacyEdgeOptions {
  readonly note?: string | null;
  readonly author?: string;
  readonly kind?: string;
  readonly origin?: string | null;
}

/** An edge as the older gate wrote it, straight into the table. */
const legacyEdge = (harness: TestHarness, id: string, from: string, to: string, options: LegacyEdgeOptions = {}) =>
  harness.db.execute(
    sql`INSERT INTO claim_edges (id, from_claim_id, to_claim_id, kind, author_session_id, note, origin, created_at)
      VALUES (${id}, ${from}, ${to}, ${options.kind ?? "relates_to"}, ${options.author ?? NICK_SESSION_ID},
              ${options.note === undefined ? AUTO_SIMILARITY_NOTE : options.note}, ${options.origin ?? null},
              ${TEST_START_ISO}::timestamptz)`,
  );

interface TwoTrees {
  readonly harness: TestHarness;
  readonly nick: TestDeveloper;
  readonly robin: TestDeveloper;
}

/** Nick's declared claim and draft; Robin's declared claim and draft — four ends to link. */
const seedTwoTrees = async (): Promise<TwoTrees> => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  await registerTestSession(harness, nick.apiKey);
  await postRecords(harness, nick, {
    records: [
      recordEnvelope("work_context", validWorkContextBody()),
      recordEnvelope("claim", validClaimBody({ id: "clm_nick", body: "Nick's vouched finding" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_nick_draft", kind: "hypothesis", body: "Nick's machine guess", ...derived })),
    ],
  });
  const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: ROBIN_SESSION_ID });
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
  return { harness, nick, robin };
};

/** review_draft's append-only mechanics: a new claim plus a supersedes edge at the draft. */
const revise = (
  trees: TwoTrees,
  who: "nick" | "robin",
  draftId: string,
  revisionId: string,
  revision: Record<string, unknown> = {},
) => {
  const isNick = who === "nick";
  const session = isNick ? {} : asRobin;
  const robinClaim = isNick ? {} : { workContextId: "wc_robin", authorSessionId: ROBIN_SESSION_ID };
  const robinEdge = isNick ? {} : { authorSessionId: ROBIN_SESSION_ID };
  return postRecords(trees.harness, isNick ? trees.nick : trees.robin, {
    records: [
      recordEnvelope("claim", validClaimBody({ id: revisionId, kind: "hypothesis", body: "the confirmed words", ...robinClaim, ...revision }), session),
      recordEnvelope(
        "claim_edge",
        validClaimEdgeBody({ id: `edge_${revisionId}`, fromClaimId: revisionId, toClaimId: draftId, kind: "supersedes", ...robinEdge }),
        session,
      ),
    ],
  });
};

const edgeIds = async (harness: TestHarness): Promise<readonly string[]> =>
  (await harness.db.select({ id: claimEdges.id }).from(claimEdges)).map((row) => row.id).sort();

const relatesTo = async (harness: TestHarness) =>
  (
    await harness.db.execute(
      sql`SELECT id, from_claim_id, to_claim_id, author_session_id, origin FROM claim_edges WHERE kind = 'relates_to' ORDER BY id`,
    )
  ).rows;

const archived = async (harness: TestHarness) =>
  (await harness.db.execute(sql`SELECT * FROM claim_edges_removed ORDER BY id`)).rows as ReadonlyArray<Record<string, unknown>>;

describe("removeCrossDeveloperDraftLinks: exactly the gate's links into a teammate's tree", () => {
  test("removes the auto links between teammates that have a derived end, and nothing else", async () => {
    // Arrange
    const { harness } = await seedTwoTrees();
    await legacyEdge(harness, "edge_draft_into_teammate", "clm_nick_draft", "clm_robin");
    await legacyEdge(harness, "edge_into_teammates_draft", "clm_nick", "clm_robin_draft");
    await legacyEdge(harness, "edge_vouched_pair", "clm_nick", "clm_robin");
    await legacyEdge(harness, "edge_own_draft", "clm_nick_draft", "clm_nick");
    await legacyEdge(harness, "edge_human_note", "clm_nick_draft", "clm_robin_draft", { note: "Robin and I saw the same thing" });

    // Act
    const report = await removeCrossDeveloperDraftLinks(harness.db);

    // Assert
    expect([...report.removed].sort()).toEqual(["edge_draft_into_teammate", "edge_into_teammates_draft"]);
    expect(report.repointed).toEqual([]);
    expect(await edgeIds(harness)).toEqual(["edge_human_note", "edge_own_draft", "edge_vouched_pair"]);
  });

  test("is idempotent: a second start removes nothing", async () => {
    const { harness } = await seedTwoTrees();
    await legacyEdge(harness, "edge_draft_into_teammate", "clm_nick_draft", "clm_robin");
    await removeCrossDeveloperDraftLinks(harness.db);

    expect((await removeCrossDeveloperDraftLinks(harness.db)).removed).toEqual([]);
  });

  test("keeps a link between one developer's own claims made in two different sessions", async () => {
    // Arrange: Nick's second session, with a claim of its own
    const { harness, nick } = await seedTwoTrees();
    const second = { sessionId: "ses_03" };
    await registerTestSession(harness, nick.apiKey, { id: "ses_03", branch: "second-branch" });
    await postRecords(harness, nick, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ id: "wc_nick_two", sessionId: "ses_03" }), second),
        recordEnvelope("claim", validClaimBody({ id: "clm_nick_two", workContextId: "wc_nick_two", authorSessionId: "ses_03", body: "Nick, elsewhere" }), second),
      ],
    });
    await legacyEdge(harness, "edge_own_across_sessions", "clm_nick_draft", "clm_nick_two");

    // Act
    const report = await removeCrossDeveloperDraftLinks(harness.db);

    // Assert
    expect(report.removed).toEqual([]);
    expect(await edgeIds(harness)).toEqual(["edge_own_across_sessions"]);
  });

  test("keeps an edge of another kind that carries the gate's note", async () => {
    const { harness } = await seedTwoTrees();
    await legacyEdge(harness, "edge_supports", "clm_nick_draft", "clm_robin", { kind: "supports" });

    expect((await removeCrossDeveloperDraftLinks(harness.db)).removed).toEqual([]);
    expect(await edgeIds(harness)).toEqual(["edge_supports"]);
  });

  test("keeps a noted edge the gate cannot have written: its author is not its from end's author", async () => {
    const { harness } = await seedTwoTrees();
    await legacyEdge(harness, "edge_robin_authored", "clm_nick_draft", "clm_robin", { author: ROBIN_SESSION_ID });

    expect((await removeCrossDeveloperDraftLinks(harness.db)).removed).toEqual([]);
    expect(await edgeIds(harness)).toEqual(["edge_robin_authored"]);
  });

  test("keeps a PERSON's relates_to edge posted on the wire with the gate's note text", async () => {
    // Arrange: Robin, by hand, links her tree to Nick's draft and types the same note
    const { harness, robin } = await seedTwoTrees();
    const posted = await postRecords(harness, robin, {
      records: [
        recordEnvelope(
          "claim_edge",
          validClaimEdgeBody({ id: "edge_by_robin", fromClaimId: "clm_robin", toClaimId: "clm_nick_draft", kind: "relates_to", authorSessionId: ROBIN_SESSION_ID, note: AUTO_SIMILARITY_NOTE }),
          asRobin,
        ),
      ],
    });
    expect(posted.data?.accepted).toBe(1);

    // Act
    const report = await removeCrossDeveloperDraftLinks(harness.db);

    // Assert
    expect(report.removed).toEqual([]);
    expect(await edgeIds(harness)).toEqual(["edge_by_robin"]);
  });

  test("matches a gate edge by its origin, whatever its note says", async () => {
    const { harness } = await seedTwoTrees();
    await legacyEdge(harness, "edge_gate_origin", "clm_nick_draft", "clm_robin", { note: null, origin: "similarity_gate" });

    expect((await removeCrossDeveloperDraftLinks(harness.db)).removed).toEqual(["edge_gate_origin"]);
  });
});

describe("what the cleanup removes is archived, not lost", () => {
  test("each removed row lands in claim_edges_removed under the pass's id, in the same statement", async () => {
    // Arrange
    const { harness } = await seedTwoTrees();
    await legacyEdge(harness, "edge_draft_into_teammate", "clm_nick_draft", "clm_robin");

    // Act
    const report = await removeCrossDeveloperDraftLinks(harness.db);

    // Assert
    expect(report.removed).toEqual(["edge_draft_into_teammate"]);
    const rows = await archived(harness);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "edge_draft_into_teammate",
      from_claim_id: "clm_nick_draft",
      to_claim_id: "clm_robin",
      kind: "relates_to",
      author_session_id: NICK_SESSION_ID,
      note: AUTO_SIMILARITY_NOTE,
      origin: null,
      removed_by_pass: report.passId,
    });
    expect(rows[0]?.removed_at).not.toBeNull();
  });

  test("the start-up log names the pass to restore by and every edge it touched", () => {
    const line = describeDraftLinkCleanup({ passId: "dlc_1", removed: ["edge_a", "edge_b"], repointed: ["edge_c"] });

    expect(line).toBe(
      "2 cross-developer draft link(s) archived in claim_edges_removed and removed (pass dlc_1: edge_a, edge_b), " +
        "1 moved to the confirmed revision (edge_c)",
    );
  });

  test("the restore documented in docs/OPERATIONS.md puts a link back, and later starts leave it", async () => {
    // Arrange
    const { harness } = await seedTwoTrees();
    await legacyEdge(harness, "edge_draft_into_teammate", "clm_nick_draft", "clm_robin");
    const { passId } = await removeCrossDeveloperDraftLinks(harness.db);

    // Act: the operator runs the documented snippet for that pass
    await harness.db.execute(sql.raw((await documentedSql("restore-archived-links")).replace("<pass id>", passId)));
    const nextStart = await removeCrossDeveloperDraftLinks(harness.db);

    // Assert
    expect(await edgeIds(harness)).toEqual(["edge_draft_into_teammate"]);
    expect(nextStart.removed).toEqual([]);
  });
});

describe("a link whose draft was since confirmed moves to the confirmed claim", () => {
  test("Robin's tree keeps the reference, now to Nick's vouched revision", async () => {
    // Arrange: the old gate's link, then Nick confirms the draft on a keyless hub
    const trees = await seedTwoTrees();
    await legacyEdge(trees.harness, "edge_old_gate", "clm_nick_draft", "clm_robin");
    expect((await revise(trees, "nick", "clm_nick_draft", "clm_nick_rev")).status).toBe(200);

    // Act
    const report = await removeCrossDeveloperDraftLinks(trees.harness.db);

    // Assert
    expect(report).toMatchObject({ removed: [], repointed: ["edge_old_gate"] });
    expect(await relatesTo(trees.harness)).toEqual([
      { id: "edge_old_gate", from_claim_id: "clm_nick_rev", to_claim_id: "clm_robin", author_session_id: NICK_SESSION_ID, origin: "similarity_gate" },
    ]);
    const robinsTree = await getDiagnosis(trees.harness.db, new Date(), "wc_robin");
    expect(robinsTree?.externalClaims.map((claim) => [claim.id, claim.provenance])).toEqual([["clm_nick_rev", "declared"]]);
  });

  test("the teammate's end moves too: Robin confirmed the draft Nick's claim was linked to", async () => {
    const trees = await seedTwoTrees();
    await legacyEdge(trees.harness, "edge_into_teammates_draft", "clm_nick", "clm_robin_draft");
    await revise(trees, "robin", "clm_robin_draft", "clm_robin_rev");

    const report = await removeCrossDeveloperDraftLinks(trees.harness.db);

    expect(report.repointed).toEqual(["edge_into_teammates_draft"]);
    expect(await relatesTo(trees.harness)).toEqual([
      { id: "edge_into_teammates_draft", from_claim_id: "clm_nick", to_claim_id: "clm_robin_rev", author_session_id: NICK_SESSION_ID, origin: "similarity_gate" },
    ]);
  });

  test("follows the revision chain to its head", async () => {
    // Arrange: the later revision's id sorts BEFORE the one it supersedes, so
    // only "nothing supersedes it" can pick it
    const trees = await seedTwoTrees();
    await legacyEdge(trees.harness, "edge_old_gate", "clm_nick_draft", "clm_robin");
    await revise(trees, "nick", "clm_nick_draft", "clm_nick_rev");
    await revise(trees, "nick", "clm_nick_rev", "clm_nick_again", { body: "the confirmed words, edited later" });

    // Act
    await removeCrossDeveloperDraftLinks(trees.harness.db);

    // Assert
    expect((await relatesTo(trees.harness)).map((edge) => edge.from_claim_id)).toEqual(["clm_nick_again"]);
  });

  test("a draft confirmed in a later session: the moved link is that session's, as the gate would write it", async () => {
    // Arrange: Nick reviews the draft from his next session
    const trees = await seedTwoTrees();
    await legacyEdge(trees.harness, "edge_old_gate", "clm_nick_draft", "clm_robin");
    await registerTestSession(trees.harness, trees.nick.apiKey, { id: "ses_03", branch: "next-day" });
    const nextSession = { sessionId: "ses_03" };
    await postRecords(trees.harness, trees.nick, {
      records: [
        recordEnvelope("claim", validClaimBody({ id: "clm_nick_rev", kind: "hypothesis", authorSessionId: "ses_03", body: "the confirmed words" }), nextSession),
        recordEnvelope(
          "claim_edge",
          validClaimEdgeBody({ id: "edge_confirm", fromClaimId: "clm_nick_rev", toClaimId: "clm_nick_draft", kind: "supersedes", authorSessionId: "ses_03" }),
          nextSession,
        ),
      ],
    });

    // Act
    await removeCrossDeveloperDraftLinks(trees.harness.db);

    // Assert
    expect(await relatesTo(trees.harness)).toEqual([
      { id: "edge_old_gate", from_claim_id: "clm_nick_rev", to_claim_id: "clm_robin", author_session_id: "ses_03", origin: "similarity_gate" },
    ]);
  });

  test("a discarded draft has no vouched head: its link is archived and removed", async () => {
    const trees = await seedTwoTrees();
    await legacyEdge(trees.harness, "edge_old_gate", "clm_nick_draft", "clm_robin");
    await revise(trees, "nick", "clm_nick_draft", "clm_nick_discard", { status: "rejected", ...derived });

    const report = await removeCrossDeveloperDraftLinks(trees.harness.db);

    expect(report).toMatchObject({ removed: ["edge_old_gate"], repointed: [] });
    expect((await archived(trees.harness)).map((row) => row.id)).toEqual(["edge_old_gate"]);
  });

  test("confirmed with an embedder: the revision's own link stays, the draft's is archived", async () => {
    // Arrange: the gate links the confirmed revision into Robin's tree on its own
    const harness = await createTestHarness({ embedder: createFakeEmbedder() });
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    await registerTestSession(harness, nick.apiKey);
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: ROBIN_SESSION_ID, branch: "x" });
    await postRecords(harness, robin, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ id: "wc_robin", sessionId: ROBIN_SESSION_ID }), asRobin),
        recordEnvelope("claim", validClaimBody({ id: "clm_robin", workContextId: "wc_robin", authorSessionId: ROBIN_SESSION_ID, body: "warm cache misses" }), asRobin),
      ],
    });
    await postRecords(harness, nick, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope("claim", validClaimBody({ id: "clm_nick_draft", body: "the warm cache is cold", ...derived })),
      ],
    });
    await legacyEdge(harness, "edge_old_gate", "clm_nick_draft", "clm_robin");
    await postRecords(harness, nick, {
      records: [
        recordEnvelope("claim", validClaimBody({ id: "clm_nick_rev", body: "the warm cache is cold" })),
        recordEnvelope("claim_edge", validClaimEdgeBody({ id: "edge_confirm", fromClaimId: "clm_nick_rev", toClaimId: "clm_nick_draft", kind: "supersedes" })),
      ],
    });

    // Act
    const report = await removeCrossDeveloperDraftLinks(harness.db);

    // Assert
    expect(report).toMatchObject({ removed: ["edge_old_gate"], repointed: [] });
    const edges = await harness.db.execute(sql`SELECT from_claim_id, to_claim_id, note FROM claim_edges WHERE kind = 'relates_to'`);
    expect(edges.rows).toEqual([{ from_claim_id: "clm_nick_rev", to_claim_id: "clm_robin", note: AUTO_SIMILARITY_NOTE }]);
  });
});
