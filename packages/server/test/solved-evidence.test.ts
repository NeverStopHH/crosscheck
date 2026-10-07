/**
 * The solved label counts RESOLVED evidence (hold-out review, H5 + M2), by the
 * one rule the hint's evidenceBacked applies: a root cause citing itself, a
 * draft, a decision that cites it back or a word of nothing used to read
 * SOLVED on a count of refs, and the solved floor ranked it above live work.
 */
import { describe, expect, test } from "bun:test";

import { listSolvedInfo, listSolvedRootCauses } from "../src/services/solved.ts";
import {
  createHarnessWithSession,
  postRecords,
  recordEnvelope,
  TEST_START_ISO,
  validClaimBody,
  validClaimEdgeBody,
  validWorkContextBody,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const OBSERVATION = "The token cache keeps the rotated key for an hour";
/** Records one POST carries, under the hub's MAX_INGEST_BATCH. */
const INGEST_CHUNK = 50;

const cause = (id: string, evidenceRefs: readonly string[]) =>
  recordEnvelope("claim", validClaimBody({ id, kind: "root_cause", status: "likely_root_cause", evidenceRefs, body: `The kid cache is never invalidated (${id})` }));

const seeded = async (records: readonly unknown[]): Promise<{ harness: TestHarness; nick: TestDeveloper }> => {
  const { harness, developer: nick } = await createHarnessWithSession();
  const result = await postRecords(harness, nick, {
    records: [recordEnvelope("work_context", validWorkContextBody({ title: "Refresh 500s after key rotation" })), ...records],
  });
  expect(result.data?.accepted).toBe(records.length + 1);
  return { harness, nick };
};

const isSolved = async (harness: TestHarness): Promise<boolean> =>
  (await listSolvedInfo(harness.db, [WORK_CONTEXT_ID])).has(WORK_CONTEXT_ID);

describe("a tree is solved only by a root cause whose evidence resolves", () => {
  test("the control: a cause citing a standing observation", async () => {
    // Arrange
    const { harness } = await seeded([recordEnvelope("claim", validClaimBody({ id: "clm_obs", body: OBSERVATION })), cause("clm_cause", ["clm_obs"])]);

    // Act + Assert
    expect(await isSolved(harness)).toBe(true);
    expect((await listSolvedRootCauses(harness.db, [WORK_CONTEXT_ID])).get(WORK_CONTEXT_ID)?.claimId).toBe("clm_cause");
  });

  test.each([
    ["itself", [cause("clm_cause", ["clm_cause"])]],
    ["nothing that exists", [cause("clm_cause", ["clm_nowhere"])]],
    ["an unreviewed draft", [recordEnvelope("claim", validClaimBody({ id: "clm_draft", provenance: "derived", captureMode: "auto", confidence: 0.4, body: OBSERVATION })), cause("clm_cause", ["clm_draft"])]],
    ["an observation of one letter", [recordEnvelope("claim", validClaimBody({ id: "clm_x", body: "x" })), cause("clm_cause", ["clm_x"])]],
    [
      "a decision that cites it back",
      [cause("clm_cause", ["clm_decision"]), recordEnvelope("claim", validClaimBody({ id: "clm_decision", kind: "decision", evidenceRefs: ["clm_cause"], body: "Invalidate the kid cache on every rotation" }))],
    ],
  ])("a cause citing %s leaves the tree unsolved", async (_, records) => {
    // Arrange
    const { harness } = await seeded(records);

    // Act + Assert
    expect(await isSolved(harness)).toBe(false);
  });

  test("read time: retracting the cited observation unsolves the tree", async () => {
    // Arrange
    const { harness, nick } = await seeded([recordEnvelope("claim", validClaimBody({ id: "clm_obs", body: OBSERVATION })), cause("clm_cause", ["clm_obs"])]);
    const before = await isSolved(harness);

    // Act
    await postRecords(harness, nick, {
      records: [
        recordEnvelope("claim", validClaimBody({ id: "clm_retract", body: "Retracted: wrong." })),
        recordEnvelope("claim_edge", validClaimEdgeBody({ id: "edge_retract", fromClaimId: "clm_retract", toClaimId: "clm_obs", kind: "supersedes" })),
      ],
    });

    // Assert
    expect(before).toBe(true);
    expect(await isSolved(harness)).toBe(false);
  });
});

describe("a revision written after the cause, or a teammate's contradiction, un-backs it (round 3, M2)", () => {
  const LATER = new Date(Date.parse(TEST_START_ISO) + 60_000).toISOString();
  const RETRACTION = "Retracted: the rotated key was dropped on time, the stale reads came from the CDN.";

  test("a retraction with content of its own, written after the cause, unsolves the tree", async () => {
    // Arrange — the retraction is an observation and says something, so only its time un-backs
    const { harness } = await seeded([
      recordEnvelope("claim", validClaimBody({ id: "clm_obs", body: OBSERVATION })),
      cause("clm_cause", ["clm_obs"]),
      recordEnvelope("claim", validClaimBody({ id: "clm_retract", body: RETRACTION, createdAt: LATER })),
      recordEnvelope("claim_edge", validClaimEdgeBody({ id: "edge_retract", fromClaimId: "clm_retract", toClaimId: "clm_obs", kind: "supersedes", createdAt: LATER })),
    ]);

    // Act + Assert
    expect(await isSolved(harness)).toBe(false);
  });

  test("the control: a revision written before the cause is what it cited, and backs it", async () => {
    // Arrange — the cause, written later, cites the old id of a revised observation
    const { harness } = await seeded([
      recordEnvelope("claim", validClaimBody({ id: "clm_obs", body: OBSERVATION })),
      recordEnvelope("claim", validClaimBody({ id: "clm_obs_v2", body: `${OBSERVATION}, measured twice` })),
      recordEnvelope("claim_edge", validClaimEdgeBody({ id: "edge_revise", fromClaimId: "clm_obs_v2", toClaimId: "clm_obs", kind: "supersedes" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_cause", kind: "root_cause", status: "likely_root_cause", evidenceRefs: ["clm_obs"], body: "The kid cache is never invalidated", createdAt: LATER })),
    ]);

    // Act + Assert
    expect(await isSolved(harness)).toBe(true);
  });

  test("a teammate's contradicts edge on the cited observation unsolves the tree", async () => {
    // Arrange
    const { harness } = await seeded([
      recordEnvelope("claim", validClaimBody({ id: "clm_obs", body: OBSERVATION })),
      cause("clm_cause", ["clm_obs"]),
      recordEnvelope("claim", validClaimBody({ id: "clm_refute", body: "The token cache drops the rotated key within a second." })),
      recordEnvelope("claim_edge", validClaimEdgeBody({ id: "edge_refute", fromClaimId: "clm_refute", toClaimId: "clm_obs", kind: "contradicts" })),
    ]);

    // Act + Assert
    expect(await isSolved(harness)).toBe(false);
  });
});

describe("one tree's noise never hides another tree's solved label (round 3, M3)", () => {
  test("210 newer, self-cited causes in tree X leave tree Y solved", async () => {
    // Arrange — Y holds one backed cause; X a flood of newer causes citing themselves
    const { harness, nick } = await seeded([recordEnvelope("claim", validClaimBody({ id: "clm_obs", body: OBSERVATION })), cause("clm_cause", ["clm_obs"])]);
    const LATER = new Date(Date.parse(TEST_START_ISO) + 60_000).toISOString();
    const flood = Array.from({ length: 210 }, (_, index) =>
      recordEnvelope(
        "claim",
        validClaimBody({ id: `clm_noise_${String(index)}`, workContextId: "wc_noise", kind: "root_cause", status: "likely_root_cause", evidenceRefs: [`clm_noise_${String(index)}`], body: `The noise cause number ${String(index)} cites itself`, createdAt: LATER }),
      ),
    );
    const records = [recordEnvelope("work_context", validWorkContextBody({ id: "wc_noise", title: "Noise" })), ...flood];
    // In batches under the ingest cap (MAX_INGEST_BATCH)
    const accepted = await Promise.all(
      Array.from({ length: Math.ceil(records.length / INGEST_CHUNK) }, (_, chunk) => records.slice(chunk * INGEST_CHUNK, (chunk + 1) * INGEST_CHUNK)).map(
        async (batch) => (await postRecords(harness, nick, { records: batch })).data?.accepted ?? 0,
      ),
    );
    expect(accepted.reduce((sum, count) => sum + count, 0)).toBe(records.length);

    // Act
    const solved = await listSolvedInfo(harness.db, [WORK_CONTEXT_ID, "wc_noise"]);

    // Assert
    expect([...solved.keys()]).toEqual([WORK_CONTEXT_ID]);
  });

  test("sixty backed causes in tree X leave tree Y's recorded cause in the answer too", async () => {
    // Arrange — every one of X's causes is backed, so all of them qualify
    const { harness, nick } = await seeded([recordEnvelope("claim", validClaimBody({ id: "clm_obs", body: OBSERVATION })), cause("clm_cause", ["clm_obs"])]);
    const many = Array.from({ length: 60 }, (_, index) =>
      recordEnvelope(
        "claim",
        validClaimBody({ id: `clm_busy_${String(index)}`, workContextId: "wc_busy", kind: "root_cause", status: "likely_root_cause", evidenceRefs: ["clm_busy_obs"], body: `The busy cause number ${String(index)} is backed` }),
      ),
    );
    const records = [
      recordEnvelope("work_context", validWorkContextBody({ id: "wc_busy", title: "Busy" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_busy_obs", workContextId: "wc_busy", body: "The busy importer drops every second batch on restart" })),
      ...many,
    ];
    const accepted = await Promise.all(
      Array.from({ length: Math.ceil(records.length / INGEST_CHUNK) }, (_, chunk) => records.slice(chunk * INGEST_CHUNK, (chunk + 1) * INGEST_CHUNK)).map(
        async (batch) => (await postRecords(harness, nick, { records: batch })).data?.accepted ?? 0,
      ),
    );
    expect(accepted.reduce((sum, count) => sum + count, 0)).toBe(records.length);

    // Act
    const causes = await listSolvedRootCauses(harness.db, ["wc_busy", WORK_CONTEXT_ID]);

    // Assert
    expect(causes.get(WORK_CONTEXT_ID)?.claimId).toBe("clm_cause");
  });
});

describe("a deadlock needs two causes whose evidence resolves", () => {
  test("two backed causes that contradict each other leave the tree unsolved", async () => {
    // Arrange
    const { harness } = await seeded([
      recordEnvelope("claim", validClaimBody({ id: "clm_obs", body: OBSERVATION })),
      cause("clm_cause_a", ["clm_obs"]),
      cause("clm_cause_b", ["clm_obs"]),
      recordEnvelope("claim_edge", validClaimEdgeBody({ id: "edge_dispute", fromClaimId: "clm_cause_b", toClaimId: "clm_cause_a", kind: "contradicts" })),
    ]);

    // Act + Assert
    expect(await isSolved(harness)).toBe(false);
  });

  test("a rival whose evidence does not resolve cannot unsolve it", async () => {
    // Arrange
    const { harness } = await seeded([
      recordEnvelope("claim", validClaimBody({ id: "clm_obs", body: OBSERVATION })),
      cause("clm_cause_a", ["clm_obs"]),
      cause("clm_cause_b", ["clm_cause_b"]),
      recordEnvelope("claim_edge", validClaimEdgeBody({ id: "edge_dispute", fromClaimId: "clm_cause_b", toClaimId: "clm_cause_a", kind: "contradicts" })),
    ]);

    // Act + Assert
    expect(await isSolved(harness)).toBe(true);
  });
});
