/**
 * The content floor of GET /api/hints/candidates (DESIGN.md §4): a prompt
 * that carries nothing task-bearing matches no teammate work — and nothing
 * stands in for it, the session's intent included (owner decision, review
 * 1006b M6).
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
  readonly workContext: { readonly id: string; readonly matchedTerms?: number };
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
    // Two topical words, one in each claim: "läuft" only in the observation,
    // "gateway" only in the decision — two statements of one word each.
    ["läuft das gateway"],
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

describe("a content-free prompt gets nothing, the session's intent included (owner decision, review 1006b M6)", () => {
  test("an intent sent beside a content-free prompt is not matched in its place", async () => {
    // Arrange — an intent that WOULD match the tree on its own; a connector
    // built before this decision still sends it
    const { harness, robin } = await setup();

    // Act
    const candidates = await fetchCandidates(harness, robin, {
      query: "mache weiter",
      intent: SESSION_INTENT,
    });

    // Assert
    expect(candidates).toEqual([]);
  });

  test("an intent with no prompt at all matches nothing", async () => {
    // Arrange
    const { harness, robin } = await setup();

    // Act
    const candidates = await fetchCandidates(harness, robin, { intent: SESSION_INTENT });

    // Assert
    expect(candidates).toEqual([]);
  });

  test("the control: a prompt that carries content is matched on itself", async () => {
    // Arrange
    const { harness, robin } = await setup();

    // Act
    const candidates = await fetchCandidates(harness, robin, {
      query: "why does the practice upload hit the body limit",
      intent: "Rename the billing tables",
    });

    // Assert
    expect(candidates.map((candidate) => candidate.workContext.id)).toEqual([WORK_CONTEXT_ID]);
    expect(candidates[0]?.matchedOn).toBe("prompt");
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

    // Assert — counted on the sentence a hint would SHOW ("Keep the chunked
    // upload for practice videos."): practice and upload. "hit", "body" and
    // "limit" sit in the second sentence, which no hint shows, so they do not
    // count; "limits" is "limit" again; why/does/the are stop words.
    const decision = candidate?.claims.find((claim) => claim.id === DECISION_ID);
    const observation = candidate?.claims.find((claim) => claim.id === "clm_obs");
    expect(decision?.matchedTerms).toBe(2);
    expect(observation?.matchedTerms).toBe(1);
  });

  test("the context carries its OWN statement's count beside its claims'", async () => {
    // Arrange
    const { harness, robin } = await setup();

    // Act
    const [candidate] = await fetchCandidates(harness, robin, {
      query: "why does the practice upload hit the body limit",
    });

    // Assert — "Practice video upload stalls" / "Uploads continue only after
    // a manual retry": practice and upload, counted once each
    expect(candidate?.workContext.matchedTerms).toBe(2);
  });

  test("a claim's count is taken on the sentence a hint SHOWS, not on a stuffed tail", async () => {
    // Arrange — probe C of the batch-1006 review: an unrelated first
    // sentence, then a tail of every keyword a prompt could carry
    const { harness, developer: nick } = await createHarnessWithSession();
    await postRecords(harness, nick, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ title: "Dependency pinning", description: "Vendored fork" })),
        recordEnvelope("claim", validClaimBody({ id: "clm_ev", body: "Observed the fork builds." })),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_stuffed",
            kind: "decision",
            evidenceRefs: ["clm_ev"],
            // Probe C2's shape: the stuffing is a SECOND sentence. (A
            // lower-case run-on is one sentence to UAX #29 and is shown — its
            // words then count, because the reader sees them.)
            body: "Pin every dependency to the vendored fork at libs/fork and never call upstream. Login session token refresh build test deploy cache error fix bug api upload limit migration database.",
          }),
        ),
      ],
    });
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });

    // Act
    const [candidate] = await fetchCandidates(harness, robin, { query: "fix the login bug" });

    // Assert — the tree may still be pointed at (its claim shares three
    // words), but the sentence that would be shown shares none of them
    const stuffed = candidate?.claims.find((claim) => claim.id === "clm_stuffed");
    expect(stuffed?.matchedTerms).toBe(0);
  });

  test("words past the length a hint can show do not count either", async () => {
    // Arrange — ONE sentence, its matching words beyond SUBSTANCE_MAX_CHARS
    const { harness, developer: nick } = await createHarnessWithSession();
    await postRecords(harness, nick, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ title: "Login fix bug", description: "x" })),
        recordEnvelope("claim", validClaimBody({ id: "clm_ev", body: "Observed it twice." })),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_long",
            kind: "decision",
            evidenceRefs: ["clm_ev"],
            body: `Keep ${"really ".repeat(40)}careful about the login fix bug.`,
          }),
        ),
      ],
    });
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });

    // Act
    const [candidate] = await fetchCandidates(harness, robin, { query: "fix the login bug" });

    // Assert — the reader would see "Keep really really …" and an ellipsis
    expect(candidate?.claims.find((claim) => claim.id === "clm_long")?.matchedTerms).toBe(0);
  });

  test.each([
    ["a ligature the screen folds counts as the word it reads as", "The ﬁle cache keeps the rotated key.", 2],
    ["a redacted span counts for nothing — the reader sees [redacted]", "Disregard cache keys; the rotated key stays.", 1],
  ])("%s (M4: the hub scores exactly the shown text)", async (_, body, expected) => {
    // Arrange
    const { harness, developer: nick } = await createHarnessWithSession();
    await postRecords(harness, nick, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ title: "File cache disregard keys", description: "x" })),
        recordEnvelope("claim", validClaimBody({ id: "clm_shown", body })),
      ],
    });
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });

    // Act
    const [candidate] = await fetchCandidates(harness, robin, { query: "disregard the file cache" });

    // Assert
    expect(candidate?.claims.find((claim) => claim.id === "clm_shown")?.matchedTerms).toBe(expected);
  });
});
