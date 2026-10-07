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

import { HINT_MAX_COUNTED_TERMS, HINT_WINDOW_QUERY_MIN_CHARS } from "../src/services/hints.ts";
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
  readonly matchedOn?: string;
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

  test("German function words never stand beside one task word: \"das ist nicht die Grenze\" matches nothing", async () => {
    // Arrange — round 4: the filler prompts above carry the session on (C1)
    // and stop before the floor; this one is a task, and only its function
    // words would agree with the decision beside "Grenze"
    const { harness, robin } = await germanUploadTree();

    // Act
    const candidates = await fetchCandidates(harness, robin, { query: "das ist nicht die Grenze" });

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

describe("a prompt of session-steering words only matches nothing, typos or not (live pilot, 0.10.0)", () => {
  /** A German tree whose claim shares mach, limit and bitt with the live prompt. */
  const germanLimitTree = () =>
    seedTree({ title: "Upload-Limit der Trainingsvideos", description: "Chunked Upload statt PUT" }, [
      { id: "clm_de_limit", body: "Mache das Limit-Handling im Upload robuster, bitte nach dem Reset wiederaufnehmen." },
    ]);
  /** An English tree whose claim shares please, continue, limit and reset. */
  const englishLimitTree = () =>
    seedTree({ title: "Import pauses at the provider quota", description: "Nightly provider import" }, [
      { id: "clm_en_limit", body: "Please continue the import once the limit reset has gone through." },
    ]);

  test.each([
    ["mache weiter, limit zuruckgesetzt. bitte alles wiederuafnhemen"],
    ["mache weiter, limit zurückgesetzt, bitte"],
    ["macxhe weiter, limit ist zurukgsetz"],
  ])("German %p points at no tree that shares those words", async (prompt) => {
    // Arrange
    const { harness, robin } = await germanLimitTree();

    // Act
    const candidates = await fetchCandidates(harness, robin, { query: prompt });

    // Assert
    expect(candidates).toEqual([]);
  });

  test("English \"please continue, the limit was reset\" points at no tree that shares those words", async () => {
    // Arrange
    const { harness, robin } = await englishLimitTree();

    // Act
    const candidates = await fetchCandidates(harness, robin, { query: "please continue, the limit was reset" });

    // Assert
    expect(candidates).toEqual([]);
  });

  test("and the session's intent does not stand in for such a prompt (M6)", async () => {
    // Arrange
    const { harness, robin } = await germanLimitTree();

    // Act
    const candidates = await fetchCandidates(harness, robin, {
      query: "mache weiter, limit zuruckgesetzt. bitte alles wiederuafnhemen",
      intent: "Das Limit-Handling im Upload robuster machen",
    });

    // Assert
    expect(candidates).toEqual([]);
  });

  test.each([
    ["mache weiter mit den Tests, limit zurückgesetzt, bitte"],
    ["mache bitte weiter, das Limit ist zurückgesetzt, danach die Tests"],
  ])("H1: %p — one other word never lets the steering words count again", async (prompt) => {
    // Arrange — the German limit tree holds mache, Limit and bitte
    const { harness, robin } = await germanLimitTree();

    // Act
    const candidates = await fetchCandidates(harness, robin, { query: prompt });

    // Assert
    expect(candidates).toEqual([]);
  });

  test("H1: \"mache bitte weiter mit dem Upload\" — beside a task word, the steering words still never count", async () => {
    // Arrange — the German limit tree says Upload, and Mache and bitte beside it
    const { harness, robin } = await germanLimitTree();

    // Act — one shared task word is not two
    const candidates = await fetchCandidates(harness, robin, { query: "mache bitte weiter mit dem Upload" });

    // Assert
    expect(candidates).toEqual([]);
  });

  test.each([["why does the usage limit reset"], ["reset the limits please"], ["when does the limit reset?"]])(
    "round 4, M1: %p is a task, and its meta words reach the tree that says them",
    async (prompt) => {
      // Arrange — the tree's claim says limit and reset
      const { harness, robin } = await englishLimitTree();

      // Act
      const candidates = await fetchCandidates(harness, robin, { query: prompt });

      // Assert — round 3 (C1) counted two meta words for nothing; the closed
      // classes decide content-freeness only, and a task about the limit's
      // reset is about the limit's reset
      expect(ids(candidates)).toEqual([WORK_CONTEXT_ID]);
    },
  );

  test.each([
    ["add pagination to the users admin table", "Add users to enterprise tenants with SAML"],
    ["add an endpoint GET /v1/me that returns the current user", "Thumbnail worker gets stuck on user uploads"],
  ])("round 4, decision 3: %p shares only weak words with the tree titled %p, and reaches none", async (prompt, title) => {
    // Arrange
    const { harness, robin } = await seedTree({ title, description: "Platform" }, [
      { id: "clm_weak", body: "The batch endpoint was left out of the middleware." },
    ]);

    // Act
    const candidates = await fetchCandidates(harness, robin, { query: prompt });

    // Assert
    expect(candidates).toEqual([]);
  });

  test.each([
    ["token refresh broken", "JWT token refresh fails after signing key rotation"],
    ["rate limit not enforced", "Rate limit for the public API"],
  ])("round 4, M1: %p reaches the tree titled %p", async (prompt, title) => {
    // Arrange
    const { harness, robin } = await seedTree({ title, description: "Platform" }, [
      { id: "clm_m1", body: "The batch endpoint was left out of the middleware." },
    ]);

    // Act
    const candidates = await fetchCandidates(harness, robin, { query: prompt });

    // Assert
    expect(ids(candidates)).toEqual([WORK_CONTEXT_ID]);
  });

  test("C1, the control: one topical word beside the meta words finds the tree about it", async () => {
    // Arrange
    const { harness, robin } = await englishLimitTree();

    // Act
    const candidates = await fetchCandidates(harness, robin, { query: "why does the import limit reset" });

    // Assert
    expect(ids(candidates)).toEqual([WORK_CONTEXT_ID]);
  });

  test("the control: one task word beside them makes it a prompt that matches", async () => {
    // Arrange
    const { harness, robin } = await germanLimitTree();

    // Act
    const candidates = await fetchCandidates(harness, robin, {
      query: "bitte das Limit-Handling im Upload robuster machen",
    });

    // Assert
    expect(ids(candidates)).toEqual([WORK_CONTEXT_ID]);
    expect(candidates[0]?.matchedOn).toBe("prompt");
  });
});

describe("a slash command is scored on its arguments only (hold-out review, H1 d)", () => {
  /** A tree whose title says the command's name. */
  const reviewTree = () =>
    seedTree({ title: "Code review checklist", description: "Before merge" }, [
      { id: "clm_review", body: "Every PR needs a code review before the merge checklist is signed." },
    ]);

  test("a bare \"/code-review\" — sent as it is by a connector that predates the rule — matches nothing", async () => {
    // Arrange
    const { harness, robin } = await reviewTree();

    // Act
    const candidates = await fetchCandidates(harness, robin, { query: "/code-review" });

    // Assert
    expect(candidates).toEqual([]);
  });

  test("its arguments still find the tree they share two words with", async () => {
    // Arrange
    const { harness, robin } = await reviewTree();

    // Act
    const candidates = await fetchCandidates(harness, robin, { query: "/code-review the merge checklist" });

    // Assert
    expect(ids(candidates)).toEqual([WORK_CONTEXT_ID]);
  });
});

describe("the hub's own bounds before any search (hold-out review, L2)", () => {
  test("a content-free prompt never reaches the exact tier, even on a target that says its word", async () => {
    // Arrange — a teammate's tree touched a symbol named "weiter"
    const { harness, developer: nick } = await createHarnessWithSession();
    const seeded = await postRecords(harness, nick, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ title: "Wizard step handler" })),
        recordEnvelope("target", { workContextId: WORK_CONTEXT_ID, kind: "symbol", value: "weiter" }),
        recordEnvelope("claim", validClaimBody({ id: "clm_wizard", body: "The weiter handler skips validation on the last wizard step" })),
      ],
    });
    expect(seeded.data?.accepted).toBe(3);
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });

    // Act + Assert
    expect(await fetchCandidates(harness, robin, { query: "weiter" })).toEqual([]);
  });

  /** A tree two late words of a long prompt share. */
  const lateWordTree = () =>
    seedTree({ title: "Unrelated title words", description: "x" }, [
      { id: "clm_late", body: "The zebrafrobnicator cache poisons the quuxinator on every warm start" },
    ]);

  test("the control: two shared words find the tree", async () => {
    const { harness, robin } = await lateWordTree();
    expect(ids(await fetchCandidates(harness, robin, { query: "zebrafrobnicator quuxinator" }))).toEqual([WORK_CONTEXT_ID]);
  });

  test("round 4, H1: a query that fills the route's cap is a window of something longer, held to the long-prompt floor", async () => {
    // Arrange — words nobody on the team wrote, so only two are known: a
    // query this long is a window, and its known words are a keyhole
    const { harness, robin } = await lateWordTree();
    const unknown = Array.from({ length: 200 }, (_, index) => `qqword${String(index)}`).join(" ");
    const query = `${unknown} zebrafrobnicator quuxinator`.slice(-HINT_WINDOW_QUERY_MIN_CHARS);
    expect(query.length).toBe(HINT_WINDOW_QUERY_MIN_CHARS);

    // Act
    const candidates = await fetchCandidates(harness, robin, { query });

    // Assert — two topical words; a long prompt needs three
    expect(candidates).toEqual([]);
  });

  test(`only the first ${String(HINT_MAX_COUNTED_TERMS)} KNOWN terms are counted — words past them are not searched (M7)`, async () => {
    // Arrange — the bound keeps SQL and the PGlite heap bounded; the verdict
    // still reads every word (prompt-terms.ts), the search does not. The
    // fillers are words a teammate's tree says, so they are known and each
    // takes a counted slot (round 3, M7: an unknown word takes none).
    const fillers = Array.from({ length: HINT_MAX_COUNTED_TERMS }, (_, index) => `filler${String(index).padStart(4, "0")}`);
    const { harness, developer: nick } = await createHarnessWithSession();
    const seeded = await postRecords(harness, nick, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ title: "Unrelated title words", description: "x" })),
        recordEnvelope("claim", validClaimBody({ id: "clm_late", body: "The zebrafrobnicator cache poisons the quuxinator on every warm start" })),
        recordEnvelope("work_context", validWorkContextBody({ id: "wc_fillers", title: "Filler words", description: fillers.join(" ") })),
      ],
    });
    expect(seeded.data?.accepted).toBe(3);
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });

    // Act — three late words the late tree says, enough for a long prompt's floor
    const candidates = await fetchCandidates(harness, robin, { query: `${fillers.join(" ")} zebrafrobnicator quuxinator warm` });

    // Assert
    expect(ids(candidates)).not.toContain(WORK_CONTEXT_ID);
  });
});

describe("a tree that shares one stray word is never a candidate", () => {
  test("probe F: \"ok\" beside the session's intent points at neither tree (M6)", async () => {
    // Arrange
    const { harness, robin } = await setup();

    // Act — "ok" carries nothing, and nothing stands in for it
    const candidates = await fetchCandidates(harness, robin, { query: "ok", intent: SESSION_INTENT });

    // Assert
    expect(candidates).toEqual([]);
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
    const [candidate] = await fetchCandidates(harness, robin, {
      query: "why does the practice upload hit the body limit",
    });

    // Assert — the number the floor was decided on, for the connector's own
    // second look (hints/select.ts)
    expect(candidate?.sharedTerms).toBeGreaterThanOrEqual(2);
  });
});
