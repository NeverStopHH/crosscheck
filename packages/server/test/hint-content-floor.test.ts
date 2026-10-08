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

  test("a task beside a continuation signal matches nothing, for a connector that still sends it (round 4, C1)", async () => {
    // Arrange
    const { harness, robin } = await setup();

    // Act — the control below, with the session carried on
    const candidates = await fetchCandidates(harness, robin, {
      query: "why does the practice upload hit the body limit, next",
    });

    // Assert
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
    // "proﬁle", not "ﬁle": "file" is a weak word since round 4 (decision 3), no topic
    ["a ligature the screen folds counts as the word it reads as", "The proﬁle cache keeps the rotated key.", 2],
    ["a redacted span counts for nothing — the reader sees [redacted]", "Disregard cache keys; the rotated key stays.", 1],
  ])("%s (M4: the hub scores exactly the shown text)", async (_, body, expected) => {
    // Arrange
    const { harness, developer: nick } = await createHarnessWithSession();
    await postRecords(harness, nick, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ title: "Profile cache disregard keys", description: "x" })),
        recordEnvelope("claim", validClaimBody({ id: "clm_shown", body })),
      ],
    });
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });

    // Act
    const [candidate] = await fetchCandidates(harness, robin, { query: "disregard the profile cache" });

    // Assert
    expect(candidate?.claims.find((claim) => claim.id === "clm_shown")?.matchedTerms).toBe(expected);
  });
});

/**
 * AN OPTED-OUT TEAMMATE'S WITHHELD TITLE IS NO STATEMENT (the batch merge of
 * this floor with the opt-out). The floor counts query words on the context's
 * own title, description and intent; her fallback title is her branch, which
 * the opt-out keeps off every page and out of the search index. Counted here,
 * a colleague's guess at her branch moved the candidate's `matchedTerms` —
 * and could decide whether the hint fired at all. A slash-free branch, since
 * Postgres splits that one into words (`feat/x` stays one token).
 */
describe("an opted-out teammate's branch title counts toward no floor", () => {
  const BRANCH = "lisbon-relocation";
  const ROBIN_CONTEXT = "wc_robin_lisbon";

  const teamWithRobin = async (optOut: boolean): Promise<{ harness: TestHarness; nick: TestDeveloper }> => {
    const { harness, developer: nick } = await createHarnessWithSession();
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_robin", branch: BRANCH });
    const posted = await postRecords(harness, robin, {
      records: [
        recordEnvelope(
          "work_context",
          validWorkContextBody({
            id: ROBIN_CONTEXT,
            sessionId: "ses_robin",
            title: `${BRANCH} @ api`,
            titleSource: "fallback",
            description: "refresh token rotation window",
          }),
          { sessionId: "ses_robin" },
        ),
      ],
    });
    expect(posted.data?.rejected).toBe(0);
    const settings = await harness.app.request("/api/settings/presence", jsonRequest("PUT", robin.apiKey, { optOut }));
    expect(settings.status).toBe(200);
    return { harness, nick };
  };

  const counted = async (harness: TestHarness, nick: TestDeveloper, query: string) =>
    (await fetchCandidates(harness, nick, { query })).map((candidate) => [candidate.workContext.id, candidate.workContext.matchedTerms]);

  test("a guess at her branch tells a colleague nothing other words in its place would not", async () => {
    // Arrange
    const { harness, nick } = await teamWithRobin(true);

    // Act
    const guessed = await counted(harness, nick, "lisbon relocation token rotation");
    const elsewhere = await counted(harness, nick, "porto migration token rotation");

    // Assert — her work is still pointed at by what it is about
    expect(elsewhere).toEqual([[ROBIN_CONTEXT, 2]]);
    expect(guessed).toEqual(elsewhere);
  });

  test("a teammate who did not opt out is matched on her title as before", async () => {
    // Arrange
    const { harness, nick } = await teamWithRobin(false);

    // Act
    const guessed = await counted(harness, nick, "lisbon relocation token rotation");

    // Assert — lisbon, relocation on the title; token, rotation on the description
    expect(guessed).toEqual([[ROBIN_CONTEXT, 4]]);
  });

  test("her branch's words are not counted on her title even where another teammate's title makes them known", async () => {
    // Arrange: Ken's own title says her branch's words, so the floor knows
    // them — only her withheld title keeps them off her statement
    const { harness, nick } = await teamWithRobin(true);
    const ken = await addTestDeveloperWithSession(harness, "Ken", "ken@example.com", { id: "ses_ken" });
    const posted = await postRecords(harness, ken, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ id: "wc_ken_lisbon", sessionId: "ses_ken", title: "Lisbon relocation checklist" }), {
          sessionId: "ses_ken",
        }),
      ],
    });
    expect(posted.data?.rejected).toBe(0);
    const hers = async (query: string) => (await counted(harness, nick, query)).filter(([id]) => id === ROBIN_CONTEXT);

    // Act
    const guessed = await hers("lisbon relocation token rotation");
    const elsewhere = await hers("porto migration token rotation");

    // Assert — the same count her work earns on what it is about
    expect(elsewhere).toEqual([[ROBIN_CONTEXT, 2]]);
    expect(guessed).toEqual(elsewhere);
  });
});
