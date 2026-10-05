/**
 * The content floor of GET /api/hints/candidates (DESIGN.md §4): a prompt
 * that carries nothing task-bearing matches no teammate work, and when the
 * session has stated what it is doing, the session's intent is matched in
 * its place — in the SAME call, never a second round trip.
 *
 * "Task-bearing" is derived from the team's own work, not from a word list:
 * a prompt word counts when it names a target that work touched (the exact
 * tier), or when it and another word of the same prompt agree on ONE
 * statement of that work — the context's own title, description and intent,
 * or one claim. A word that matches nothing (a typo, chatter in a language
 * the team does not write) and a word that matches only by itself ("limit"
 * in "limit ist zurückgesetzt") is filler. The pilot's own prompts are the
 * cases: 5 of 5 pointers in one session came on "mache weiter" and
 * "macxhe weiter, limit ist zurukgsetz".
 */
import { describe, expect, test } from "bun:test";

import { HINT_MIN_SHARED_TERMS } from "../src/services/hints.ts";
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
const DECISION_ID = "clm_decision";
const DECISION_BODY =
  "Keep the chunked upload for practice videos. The single PUT hits the gateway body limit above 2 GB.";
const SESSION_INTENT = "Make the practice video upload survive the gateway body limit";

interface CandidateView {
  readonly matchedOn?: string;
  readonly workContext: { readonly id: string };
  readonly claims: readonly { readonly id: string; readonly matchedTerms?: number }[];
}

const fetchCandidates = async (
  harness: TestHarness,
  developer: TestDeveloper,
  params: Record<string, string>,
): Promise<readonly CandidateView[]> => {
  const search = new URLSearchParams({ repo: REPO, ...params });
  const response = await harness.app.request(
    `/api/hints/candidates?${search.toString()}`,
    jsonRequest("GET", developer.apiKey),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { candidates: readonly CandidateView[] } };
  return body.data.candidates;
};

/**
 * Nick's practice-upload tree. The words a content-free prompt could brush
 * against — "limit", "continue", "weiter" — each sit in it the way an
 * ordinary word sits in any real tree: once per statement, in DIFFERENT
 * statements, so only a floor that counts per statement keeps them apart.
 */
const setup = async (): Promise<{ harness: TestHarness; robin: TestDeveloper }> => {
  const { harness, developer: nick } = await createHarnessWithSession();
  const seeded = await postRecords(harness, nick, {
    records: [
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          title: "Practice video upload stalls",
          description: "Uploads continue only after a manual retry",
        }),
      ),
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_obs",
          body: "Der Upload läuft danach weiter, aber nur mit Chunks",
        }),
      ),
      recordEnvelope(
        "claim",
        validClaimBody({
          id: DECISION_ID,
          kind: "decision",
          body: DECISION_BODY,
          evidenceRefs: ["clm_obs"],
        }),
      ),
    ],
  });
  expect(seeded.data?.accepted).toBe(3);
  const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", {
    id: "ses_02",
  });
  return { harness, robin };
};

describe("a prompt that carries nothing task-bearing matches no teammate work", () => {
  test.each([
    ["mache weiter"],
    ["weiter"],
    ["continue"],
    ["macxhe weiter, limit ist zurukgsetz"],
    ["limit limits limiting"],
  ])("%p yields no candidates", async (prompt) => {
    // Arrange
    const { harness, robin } = await setup();

    // Act
    const candidates = await fetchCandidates(harness, robin, { query: prompt });

    // Assert — each of these shares at most ONE lexeme with any one
    // statement of Nick's tree ("limits" and "limiting" are the word "limit"
    // again; "weiter" and "limit" sit in two different claims), and one
    // shared word is a coincidence rather than a topic.
    expect(HINT_MIN_SHARED_TERMS).toBe(2);
    expect(candidates).toEqual([]);
  });

  test("the control: two words of the prompt agreeing on the tree still match it", async () => {
    // Arrange
    const { harness, robin } = await setup();

    // Act
    const candidates = await fetchCandidates(harness, robin, {
      query: "why does the practice upload hit the body limit",
    });

    // Assert
    expect(candidates.map((candidate) => candidate.workContext.id)).toEqual([WORK_CONTEXT_ID]);
    expect(candidates[0]?.matchedOn).toBe("prompt");
  });
});

describe("the session's intent stands in for a content-free prompt, in the same call", () => {
  test("a content-free prompt with an intent matches on the intent", async () => {
    // Arrange
    const { harness, robin } = await setup();

    // Act
    const candidates = await fetchCandidates(harness, robin, {
      query: "mache weiter",
      intent: SESSION_INTENT,
    });

    // Assert — matched, and labelled as matched on the intent, so the hint
    // can say what it relates to.
    expect(candidates.map((candidate) => candidate.workContext.id)).toEqual([WORK_CONTEXT_ID]);
    expect(candidates[0]?.matchedOn).toBe("intent");
  });

  test("an absent prompt with an intent matches on the intent — the prompt need not travel", async () => {
    // Arrange
    const { harness, robin } = await setup();

    // Act
    const candidates = await fetchCandidates(harness, robin, { intent: SESSION_INTENT });

    // Assert
    expect(candidates[0]?.matchedOn).toBe("intent");
  });

  test("a prompt that carries content is matched on itself, whatever the intent says", async () => {
    // Arrange
    const { harness, robin } = await setup();

    // Act
    const candidates = await fetchCandidates(harness, robin, {
      query: "why does the practice upload hit the body limit",
      intent: "Rename the billing tables",
    });

    // Assert
    expect(candidates[0]?.matchedOn).toBe("prompt");
  });

  test("an intent that itself carries nothing task-bearing matches nothing either", async () => {
    // Arrange
    const { harness, robin } = await setup();

    // Act
    const candidates = await fetchCandidates(harness, robin, {
      query: "weiter",
      intent: "Rename the billing tables before the limit freeze",
    });

    // Assert — one rule for every query: "limit" alone is still a coincidence
    expect(candidates).toEqual([]);
  });
});

describe("each claim carries how many distinct words of the matched query it shares", () => {
  test("the count is per claim, over lexemes, against the query that matched", async () => {
    // Arrange
    const { harness, robin } = await setup();

    // Act
    const [candidate] = await fetchCandidates(harness, robin, {
      query: "why does the practice upload hit the body limit limits",
    });

    // Assert — practice, upload, hit, body, limit: five distinct lexemes of
    // the decision; "limits" is "limit" again, and why/does/the are stop
    // words the english configuration drops.
    const decision = candidate?.claims.find((claim) => claim.id === DECISION_ID);
    const observation = candidate?.claims.find((claim) => claim.id === "clm_obs");
    expect(decision?.matchedTerms).toBe(5);
    expect(observation?.matchedTerms).toBe(1);
  });

  test("a claim matched through the intent is counted against the intent", async () => {
    // Arrange
    const { harness, robin } = await setup();

    // Act
    const [candidate] = await fetchCandidates(harness, robin, {
      query: "ok",
      intent: SESSION_INTENT,
    });

    // Assert
    const decision = candidate?.claims.find((claim) => claim.id === DECISION_ID);
    expect(decision?.matchedTerms).toBeGreaterThanOrEqual(HINT_MIN_SHARED_TERMS);
  });
});
