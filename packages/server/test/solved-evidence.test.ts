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
  validClaimBody,
  validClaimEdgeBody,
  validWorkContextBody,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const OBSERVATION = "The token cache keeps the rotated key for an hour";

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
