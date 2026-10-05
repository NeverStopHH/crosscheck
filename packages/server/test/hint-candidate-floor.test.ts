/**
 * The content floor applies to EVERY CANDIDATE, not to the query as a whole
 * (DESIGN.md §4; review of batch 1006, finding 1).
 *
 * A floor that only asked "did this query carry a task" let every tree the
 * search returned ride along once any ONE of them cleared it. With the
 * strong tree already delivered, the next prompt pointed at the tree that
 * shared a single stray word — "limit" in "Rate limit headers missing" for a
 * session whose intent is about an upload's body limit: the pilot's failure,
 * one step later. Each tree a hint may name must itself share
 * HINT_MIN_SHARED_TERMS words on one statement, or a target.
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
const SESSION_INTENT = "Make the practice video upload survive the gateway body limit";
const MIKE_SESSION = "ses_03";
const MIKE_CONTEXT = "wc_mike";

interface CandidateView {
  readonly workContext: { readonly id: string };
  readonly sharedTerms?: number;
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

const ids = (candidates: readonly CandidateView[]): readonly string[] =>
  candidates.map((candidate) => candidate.workContext.id);

/**
 * Probe F of the review: Nick's upload tree, which the intent is about, and
 * Mike's rate-limit tree, which shares exactly one of its words ("limit").
 */
const setup = async (): Promise<{ harness: TestHarness; robin: TestDeveloper }> => {
  const { harness, developer: nick } = await createHarnessWithSession();
  await postRecords(harness, nick, {
    records: [
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          title: "Practice video upload stalls",
          description: "Uploads stall above the gateway body limit",
        }),
      ),
      recordEnvelope(
        "claim",
        validClaimBody({ id: "clm_x", body: "The gateway body limit stops single PUT uploads" }),
      ),
    ],
  });
  const mike = await addTestDeveloperWithSession(harness, "Mike", "mike@example.com", {
    id: MIKE_SESSION,
  });
  const seeded = await postRecords(harness, mike, {
    records: [
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          id: MIKE_CONTEXT,
          sessionId: MIKE_SESSION,
          title: "Rate limit headers missing",
          description: "429 without Retry-After",
        }),
        { sessionId: MIKE_SESSION },
      ),
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_y",
          workContextId: MIKE_CONTEXT,
          authorSessionId: MIKE_SESSION,
          body: "Retry-After header never set on 429",
        }),
        { sessionId: MIKE_SESSION },
      ),
    ],
  });
  expect(seeded.data?.accepted).toBe(2);
  const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", {
    id: "ses_02",
  });
  return { harness, robin };
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
  const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", {
    id: "ses_02",
  });
  return { harness, robin };
};

/** Probe A2 of the review: a German-written decision tree. */
const germanUploadTree = () =>
  seedTree({ title: "Upload der Trainingsvideos", description: "Chunked Upload statt PUT" }, [
    { id: "clm_obs", body: "Der PUT bricht ab 2 GB ab." },
    {
      id: "clm_dec",
      kind: "decision",
      evidenceRefs: ["clm_obs"],
      body: "Wir bleiben beim Chunked Upload, das ist stabiler und die Gateway-Grenze ist nicht verhandelbar.",
    },
  ]);

describe("German and English function words are never task words (finding 2)", () => {
  test.each([
    ["passt, das ist nicht so wichtig, mach weiter"],
    ["ok, mach jetzt weiter und dann die nächsten Schritte"],
    ["ja, und dann?"],
  ])("German filler %p matches no German-written tree", async (prompt) => {
    // Arrange — "das", "ist", "nicht", "und", "die" sit in the decision; the
    // english configuration alone kept every one of them as a term
    const { harness, robin } = await germanUploadTree();

    // Act
    const candidates = await fetchCandidates(harness, robin, { query: prompt });

    // Assert
    expect(candidates).toEqual([]);
  });

  test("the control: a German prompt with two task words still matches the tree", async () => {
    // Arrange
    const { harness, robin } = await germanUploadTree();

    // Act
    const candidates = await fetchCandidates(harness, robin, {
      query: "warum bricht der chunked upload ab",
    });

    // Assert
    expect(ids(candidates)).toEqual([WORK_CONTEXT_ID]);
  });

  test("English filler matches no English-written tree", async () => {
    // Arrange — every word of the prompt is an English function word
    const { harness, robin } = await seedTree(
      { title: "Then the cache was fine", description: "And with that it was done" },
      [{ id: "clm_en", body: "It was then and there that the cache was rebuilt" }],
    );

    // Act
    const candidates = await fetchCandidates(harness, robin, {
      query: "and then what was that with the",
    });

    // Assert
    expect(candidates).toEqual([]);
  });
});

describe("a tree that shares one stray word is never a candidate", () => {
  test("matched on the intent: the upload tree, never the rate-limit tree beside it", async () => {
    // Arrange
    const { harness, robin } = await setup();

    // Act — "ok": nothing task-bearing, so the session's intent stands in
    const candidates = await fetchCandidates(harness, robin, { query: "ok", intent: SESSION_INTENT });

    // Assert
    expect(ids(candidates)).toEqual([WORK_CONTEXT_ID]);
  });

  test("matched on the prompt: the same, one stray word earns nothing", async () => {
    // Arrange
    const { harness, robin } = await setup();

    // Act
    const candidates = await fetchCandidates(harness, robin, {
      query: "why does the practice upload hit the body limit",
    });

    // Assert
    expect(ids(candidates)).toEqual([WORK_CONTEXT_ID]);
  });

  test("each candidate says how many words of the query its best statement shares", async () => {
    // Arrange
    const { harness, robin } = await setup();

    // Act
    const [candidate] = await fetchCandidates(harness, robin, { query: "ok", intent: SESSION_INTENT });

    // Assert — the number the floor was decided on, for the connector's own
    // second look (hints/select.ts)
    expect(candidate?.sharedTerms).toBeGreaterThanOrEqual(2);
  });
});
