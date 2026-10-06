/**
 * What a cited claim must be to count as evidence (hold-out review, H5 +
 * M2): one rule for the hint's evidenceBacked, the hub's solved label and
 * the connector's solved mirror, read at read time over the head of the
 * cited claim's revision chain.
 */
import { describe, expect, test } from "bun:test";

import { isEvidenceFor, revisionHeads } from "../src/evidence-resolution.ts";
import type { CitedHead } from "../src/evidence-resolution.ts";

const OBSERVATION: CitedHead = {
  id: "clm_obs",
  kind: "observation",
  status: "proposed",
  provenance: "declared",
  body: "The refresh token cache keeps the rotated key for an hour.",
};

describe("a cited head counts as evidence", () => {
  test.each([
    ["a declared observation with content", OBSERVATION],
    ["a piece of evidence", { ...OBSERVATION, kind: "evidence" }],
    ["a partially confirmed observation", { ...OBSERVATION, status: "partially_confirmed" }],
  ])("%s", (_, head) => {
    expect(isEvidenceFor("clm_cause", "clm_obs", head)).toBe(true);
  });
});

describe("a cited head that is not evidence backs nothing", () => {
  test.each([
    ["an unreviewed draft", { ...OBSERVATION, provenance: "derived" }],
    ["a refuted observation", { ...OBSERVATION, status: "rejected" }],
    ["a superseded observation", { ...OBSERVATION, status: "superseded" }],
    ["another root cause — a conclusion backs no conclusion", { ...OBSERVATION, kind: "root_cause" }],
    ["a decision", { ...OBSERVATION, kind: "decision" }],
    ["a hypothesis", { ...OBSERVATION, kind: "hypothesis" }],
    ["a rejected approach", { ...OBSERVATION, kind: "rejected_approach" }],
    ["two content words", { ...OBSERVATION, body: "See above." }],
    ["one letter", { ...OBSERVATION, body: "x" }],
  ])("%s", (_, head) => {
    expect(isEvidenceFor("clm_cause", "clm_obs", head)).toBe(false);
  });

  test("the citing claim itself", () => {
    expect(isEvidenceFor("clm_obs", "clm_obs", OBSERVATION)).toBe(false);
  });

  test("a ref whose chain resolves to the citing claim — a revision citing what it retracts", () => {
    expect(isEvidenceFor("clm_obs", "clm_old", OBSERVATION)).toBe(false);
  });
});

describe("a ref resolves to the head of its revision chain", () => {
  /** Supersedes edges as the hub stores them: the newer claim points at the older. */
  const successors = new Map([
    ["clm_v1", ["clm_v2"]],
    ["clm_v2", ["clm_v3"]],
  ]);
  const successorsOf = (id: string): readonly string[] => successors.get(id) ?? [];

  test("an unrevised claim is its own head", () => {
    expect(revisionHeads("clm_x", successorsOf)).toEqual(["clm_x"]);
  });

  test("a twice-revised claim resolves to the newest revision", () => {
    expect(revisionHeads("clm_v1", successorsOf)).toEqual(["clm_v3"]);
  });

  test("a cycle of revisions ends inside the depth bound, with no head", () => {
    const cyclic = new Map([
      ["clm_a", ["clm_b"]],
      ["clm_b", ["clm_a"]],
    ]);
    expect(revisionHeads("clm_a", (id) => cyclic.get(id) ?? [])).toEqual([]);
  });
});
