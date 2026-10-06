/**
 * THE TOPICAL-WORD RULE (DESIGN.md §4, hold-out review round 3, C1): a
 * candidate's floor statement must share HINT_MIN_SHARED_TERMS of the
 * prompt's words, AND at least one of them must belong to no closed class.
 * Two meta words agreeing — "session" and "limit", "usage" and "reset" — are
 * the session's own machinery, and a teammate's tree that says them is about
 * that machinery at best: the round-3 hold-out pointed ten content-free
 * prompts at an intent-only tree that said nothing else.
 *
 * ON ONE STATEMENT: the topical word and the second word agree on the same
 * statement — a title of two meta words beside a claim that shares one stray
 * topical word is two weak statements, not one strong one.
 */
import { describe, expect, test } from "bun:test";

import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  validClaimBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;

interface CandidateView {
  readonly workContext: { readonly id: string };
  readonly sharedTerms?: number;
}

const fetchCandidates = async (
  harness: TestHarness,
  developer: TestDeveloper,
  query: string,
): Promise<readonly CandidateView[]> => {
  const search = new URLSearchParams({ repo: REPO, query });
  const response = await harness.app.request(`/api/hints/candidates?${search.toString()}`, jsonRequest("GET", developer.apiKey));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { candidates: readonly CandidateView[] } };
  return body.data.candidates;
};

/** One teammate tree with the given statements, and a reader to ask about it. */
const seedTree = async (
  workContext: Record<string, unknown>,
  claimBodies: readonly Record<string, unknown>[],
): Promise<{ harness: TestHarness; robin: TestDeveloper }> => {
  const { harness, developer: nick } = await createHarnessWithSession();
  const seeded = await postRecords(harness, nick, {
    records: [
      recordEnvelope("work_context", validWorkContextBody(workContext)),
      ...claimBodies.map((claim) => recordEnvelope("claim", validClaimBody(claim))),
    ],
  });
  expect(seeded.data?.accepted).toBe(1 + claimBodies.length);
  const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
  return { harness, robin };
};

describe("two meta words are never a topic (C1)", () => {
  test("a prompt that shares only session and limit with an intent-only tree reaches no candidate", async () => {
    // Arrange — the round-3 magnet: an intent made of the session's machinery
    const { harness, robin } = await seedTree(
      {
        title: "Agent continue behaviour",
        description: "Notes",
        intent: { summary: "Make the agent continue after a usage limit reset without losing the session context", provenance: "declared", confidence: 0.9, capturedAt: "2026-09-20T08:00:00.000Z" },
      },
      [],
    );

    // Act
    const candidates = await fetchCandidates(harness, robin, "session limit hit earlier, it's back now, continue");

    // Assert
    expect(candidates).toEqual([]);
  });

  test("the control: one topical word beside a meta word on the same statement is a candidate", async () => {
    // Arrange
    const { harness, robin } = await seedTree({ title: "Session timeout logs users out after 15 minutes", description: "Workbench" }, [
      { id: "clm_st", body: "Users are logged out after 15 minutes while editing." },
    ]);

    // Act
    const candidates = await fetchCandidates(harness, robin, "the session timeout is too short");

    // Assert
    expect(candidates.map((candidate) => candidate.workContext.id)).toEqual([WORK_CONTEXT_ID]);
    expect(candidates[0]?.sharedTerms).toBe(2);
  });

  test("a claim that shares only meta words qualifies no tree", async () => {
    // Arrange
    const { harness, robin } = await seedTree({ title: "Nightly report formatting", description: "Columns" }, [
      { id: "clm_meta", body: "The usage limit resets every session window." },
    ]);

    // Act
    const candidates = await fetchCandidates(harness, robin, "usage limit reset for the session went wrong somehow");

    // Assert
    expect(candidates).toEqual([]);
  });
});

describe("the topical word stands on the floor statement itself (C1, generalised)", () => {
  test("a title of two meta words beside a claim sharing one topical word is no candidate", async () => {
    // Arrange — title: usage, limit; claim: banner alone
    const { harness, robin } = await seedTree({ title: "Usage limit notes", description: "Scratch" }, [
      { id: "clm_banner", body: "The banner colour was changed last sprint." },
    ]);

    // Act
    const candidates = await fetchCandidates(harness, robin, "the usage limit banner flickers");

    // Assert
    expect(candidates).toEqual([]);
  });

  test("the control: the same words on one statement are a candidate", async () => {
    // Arrange
    const { harness, robin } = await seedTree({ title: "Usage limit banner notes", description: "Scratch" }, []);

    // Act
    const candidates = await fetchCandidates(harness, robin, "the usage limit banner flickers");

    // Assert
    expect(candidates.map((candidate) => candidate.workContext.id)).toEqual([WORK_CONTEXT_ID]);
  });
});
