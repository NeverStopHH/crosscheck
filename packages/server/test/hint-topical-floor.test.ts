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
 * statement — a title that shares one word beside a claim that shares
 * another is two weak statements, not one strong one.
 *
 * REVISED IN ROUND 4 (M1): the closed classes decide content-freeness only.
 * In a prompt that IS a task a meta word is topical — "token refresh
 * broken" is about tokens — while a content-free prompt, or one that carries
 * the session on (C1), never reaches the hub at all.
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

describe("meta words: no topic in a prompt that carries the session on, a topic in a task (C1; round 4, M1)", () => {
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

  test("round 4, M1: a task's meta words, agreeing on a claim, qualify its tree", async () => {
    // Arrange
    const { harness, robin } = await seedTree({ title: "Nightly report formatting", description: "Columns" }, [
      { id: "clm_meta", body: "The usage limit resets every session window." },
    ]);

    // Act — a task: "went wrong somehow" is no command to the session
    const candidates = await fetchCandidates(harness, robin, "usage limit reset for the session went wrong somehow");

    // Assert — round 3 (C1) counted the four for nothing
    expect(candidates.map((candidate) => candidate.workContext.id)).toEqual([WORK_CONTEXT_ID]);
  });
});

/**
 * WEAK WORDS ARE NEVER THE TOPICAL ONE (round 4, decision 3): since a task's
 * meta words are topical (M1), the words a floor statement may share and
 * still not be about the task are the weak ones — add, new, users — and a
 * statement that shares only those clears nothing, however many it shares.
 */
describe("weak words: never the topical word a floor statement needs (round 4, decision 3)", () => {
  const WEAK_PROMPT = "add new users to the billing ledger";

  test("a tree's own statement that shares only weak words is no candidate", async () => {
    // Arrange
    const { harness, robin } = await seedTree({ title: "Add new users without invites", description: "Onboarding" }, []);

    // Act
    const candidates = await fetchCandidates(harness, robin, WEAK_PROMPT);

    // Assert
    expect(candidates).toEqual([]);
  });

  test("a claim that shares only weak words is no candidate", async () => {
    // Arrange
    const { harness, robin } = await seedTree({ title: "Nightly report formatting", description: "Columns" }, [
      { id: "clm_weak", body: "Add new users without invites." },
    ]);

    // Act
    const candidates = await fetchCandidates(harness, robin, WEAK_PROMPT);

    // Assert
    expect(candidates).toEqual([]);
  });

  test("the control: a topical word beside them on the same statement is a candidate", async () => {
    // Arrange
    const { harness, robin } = await seedTree({ title: "Add new users to the billing export", description: "Onboarding" }, []);

    // Act
    const candidates = await fetchCandidates(harness, robin, WEAK_PROMPT);

    // Assert
    expect(candidates.map((candidate) => candidate.workContext.id)).toEqual([WORK_CONTEXT_ID]);
  });
});

describe("the topical word stands on the floor statement itself (C1, generalised)", () => {
  test("a title sharing one word beside a claim sharing another is no candidate", async () => {
    // Arrange — title: banner alone; claim: flickers alone
    const { harness, robin } = await seedTree({ title: "Banner notes", description: "Scratch" }, [
      { id: "clm_banner", body: "Something flickers in the colour picker." },
    ]);

    // Act
    const candidates = await fetchCandidates(harness, robin, "the usage banner flickers");

    // Assert
    expect(candidates).toEqual([]);
  });

  test("the control: the same words on one statement are a candidate", async () => {
    // Arrange
    const { harness, robin } = await seedTree({ title: "Banner flickers notes", description: "Scratch" }, []);

    // Act
    const candidates = await fetchCandidates(harness, robin, "the usage banner flickers");

    // Assert
    expect(candidates.map((candidate) => candidate.workContext.id)).toEqual([WORK_CONTEXT_ID]);
  });
});
