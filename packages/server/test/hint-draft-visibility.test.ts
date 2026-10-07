/**
 * Unreviewed drafts never push a hint (draft-nudge review; review 1006b, L6).
 *
 * A derived draft is a model's guess nobody has vouched for, and a discarded
 * one is a guess its own author threw away. Neither may qualify a tree for a
 * hint pushed at a teammate, count as one of its claims, or lend a word to
 * the floor. Reproduced before the fix: a tree whose title shared nothing
 * with the prompt reached the reader as "a teammate has notes … It carries 1
 * claim" through the words of a draft alone — before discard and after.
 * Once the author confirms the draft (a declared claim takes its place), the
 * same words may.
 */
import { describe, expect, test } from "bun:test";

import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  validClaimBody,
  validClaimEdgeBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
const DRAFT_BODY = "The zebrafrobnicator cache poisons the quuxinator on every warm start";
const PROMPT = "why does the zebrafrobnicator cache poison the quuxinator";

interface CandidateView {
  readonly workContext: { readonly id: string };
  readonly claims: readonly { readonly id: string }[];
}

const fetchCandidates = async (harness: TestHarness, developer: TestDeveloper): Promise<readonly CandidateView[]> => {
  const search = new URLSearchParams({ repo: REPO, query: PROMPT });
  const response = await harness.app.request(`/api/hints/candidates?${search.toString()}`, jsonRequest("GET", developer.apiKey));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { candidates: readonly CandidateView[] } };
  return body.data.candidates;
};

const draft = (overrides: Record<string, unknown> = {}) =>
  recordEnvelope(
    "claim",
    validClaimBody({ id: "clm_draft", captureMode: "auto", provenance: "derived", confidence: 0.4, body: DRAFT_BODY, ...overrides }),
  );

/** Nick's tree, its title sharing nothing with the prompt unless given one, plus the records given. */
const treeWith = async (
  records: readonly unknown[],
  title = "Unrelated title words",
): Promise<{ harness: TestHarness; robin: TestDeveloper }> => {
  const { harness, developer: nick } = await createHarnessWithSession();
  const all = [recordEnvelope("work_context", validWorkContextBody({ title })), ...records];
  const seeded = await postRecords(harness, nick, { records: all });
  expect(seeded.data?.accepted).toBe(all.length);
  const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
  return { harness, robin };
};

describe("a tree whose only match is a draft gets no hint", () => {
  test("an unreviewed derived draft", async () => {
    // Arrange
    const { harness, robin } = await treeWith([draft()]);

    // Act
    const candidates = await fetchCandidates(harness, robin);

    // Assert
    expect(candidates).toEqual([]);
  });

  test("the same draft after its author discarded it", async () => {
    // Arrange — discard writes a rejected claim superseding the draft
    const { harness, robin } = await treeWith([
      draft(),
      draft({ id: "clm_discard", status: "rejected" }),
      recordEnvelope("claim_edge", validClaimEdgeBody({ id: "edge_discard", fromClaimId: "clm_discard", toClaimId: "clm_draft", kind: "supersedes" })),
    ]);

    // Act
    const candidates = await fetchCandidates(harness, robin);

    // Assert
    expect(candidates).toEqual([]);
  });

  test("a tree in the pool on one word of its own title is not lifted over the floor by a draft's words", async () => {
    // Arrange — the title shares one word, so the tree is ranked into the pool; only the draft says the rest
    const { harness, robin } = await treeWith([draft()], "Zebrafrobnicator migration notes");

    // Act
    const candidates = await fetchCandidates(harness, robin);

    // Assert
    expect(candidates).toEqual([]);
  });

  test("nor when another tree makes the draft's words known words (round 4, L1)", async () => {
    // Arrange — the hub knows only words a visible statement says, so the
    // draft's words are unknown above and could not count anyway; a second
    // tree whose own title says "cache" and "quuxinator" makes them known
    const { harness, robin } = await treeWith(
      [draft(), recordEnvelope("work_context", validWorkContextBody({ id: "wc_known", title: "Quuxinator cache on warm start" }))],
      "Zebrafrobnicator migration notes",
    );

    // Act
    const candidates = await fetchCandidates(harness, robin);

    // Assert — the tree that says the words, never the one whose draft did
    expect(candidates.map((candidate) => candidate.workContext.id)).toEqual(["wc_known"]);
  });

  test("a refuted declared hypothesis lends no word either", async () => {
    // Arrange
    const { harness, robin } = await treeWith([
      recordEnvelope("claim", validClaimBody({ id: "clm_refuted", kind: "hypothesis", status: "rejected", body: DRAFT_BODY })),
    ]);

    // Act
    const candidates = await fetchCandidates(harness, robin);

    // Assert
    expect(candidates).toEqual([]);
  });

  test("once the author confirms it, the declared claim may", async () => {
    // Arrange — confirmation publishes a declared claim in the draft's place
    const { harness, robin } = await treeWith([
      draft(),
      recordEnvelope("claim", validClaimBody({ id: "clm_confirmed", body: DRAFT_BODY })),
      recordEnvelope("claim_edge", validClaimEdgeBody({ id: "edge_confirm", fromClaimId: "clm_confirmed", toClaimId: "clm_draft", kind: "supersedes" })),
    ]);

    // Act
    const candidates = await fetchCandidates(harness, robin);

    // Assert — the tree, carrying the confirmed claim and never the draft
    expect(candidates.map((candidate) => candidate.workContext.id)).toEqual([WORK_CONTEXT_ID]);
    expect(candidates[0]?.claims.map((claim) => claim.id)).toEqual(["clm_confirmed"]);
  });

  test("a draft beside a declared claim is not shipped as one of the tree's claims", async () => {
    // Arrange
    const { harness, robin } = await treeWith([draft(), recordEnvelope("claim", validClaimBody({ id: "clm_declared", body: DRAFT_BODY }))]);

    // Act
    const [candidate] = await fetchCandidates(harness, robin);

    // Assert
    expect(candidate?.claims.map((claim) => claim.id)).toEqual(["clm_declared"]);
  });
});
