/**
 * The INTENT tier of GET /api/solved-matches (VISION.md §1): the current
 * session's symptoms are its error fingerprints, its targets AND its intent
 * — the sentence a session states about what it is doing. At SessionStart a
 * fresh session has captured no targets and hit no failures yet, so without
 * this tier the whole surface is silent exactly when the reader is deciding
 * what to do.
 *
 * Text overlap is not identity, which is why every test here is really about
 * the FLOOR: how much of what I said I am doing has to appear in an old
 * tree's searchable doc before this product says "you have seen this
 * before", and what such a match is allowed to say when it does (a pointer,
 * never the answer).
 */
import { describe, expect, test } from "bun:test";

import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  TEST_START_ISO,
  validClaimBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
const OTHER_REPO = "github.com/acme/web";
const OLD_ISO = "2026-05-25T09:00:00.000Z";
const OLD_SESSION = "ses_old";
const OTHER_REPO_SESSION = "ses_other_repo";
const MINE_SESSION = "ses_mine";
const SOLVED_TITLE = "Webhook signature verification rejects retries";

interface MatchView {
  readonly workContextId: string;
  readonly matchedTargetKind: string;
  readonly rootCause?: string | null;
}

const fetchMatches = async (
  harness: TestHarness,
  apiKey: string,
): Promise<readonly MatchView[]> => {
  const response = await harness.app.request(
    `/api/solved-matches?repo=${encodeURIComponent(REPO)}`,
    jsonRequest("GET", apiKey),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: { matches: readonly MatchView[] };
  };
  return body.data.matches;
};

/**
 * A solved tree whose title carries the words a matching intent will share.
 * No targets at all: this tier must reach a tree the target tiers cannot.
 */
const solvedTreeRecords = (
  contextId: string,
  sessionId: string,
  title: string,
): readonly Record<string, unknown>[] => [
  recordEnvelope(
    "work_context",
    validWorkContextBody({
      id: contextId,
      sessionId,
      title,
      description: undefined,
      createdAt: OLD_ISO,
    }),
    { sessionId },
  ),
  recordEnvelope(
    "claim",
    validClaimBody({
      id: `${contextId}_evidence`,
      workContextId: contextId,
      authorSessionId: sessionId,
      kind: "evidence",
      body: "The trace shows the rotated key id being dropped",
      createdAt: OLD_ISO,
    }),
    { sessionId },
  ),
  recordEnvelope(
    "claim",
    validClaimBody({
      id: `${contextId}_root`,
      workContextId: contextId,
      authorSessionId: sessionId,
      kind: "root_cause",
      status: "likely_root_cause",
      confidence: 0.9,
      evidenceRefs: [`${contextId}_evidence`],
      body: "The ingestion mapping drops the key id on rotation",
      createdAt: OLD_ISO,
    }),
    { sessionId },
  ),
];

/** A live context carrying the intent this tier reads. */
const intentContextRecords = (
  summary: string,
  sessionId: string = MINE_SESSION,
): readonly Record<string, unknown>[] => [
  recordEnvelope(
    "work_context",
    validWorkContextBody({
      id: `wc_${sessionId}`,
      sessionId,
      title: "Working on the checkout flow",
      description: undefined,
      intent: {
        summary,
        provenance: "declared",
        confidence: 0.9,
        capturedAt: TEST_START_ISO,
      },
      createdAt: TEST_START_ISO,
    }),
    { sessionId },
  ),
];

interface Setup {
  readonly harness: TestHarness;
  readonly developer: TestDeveloper;
}

const setup = async (): Promise<Setup> => {
  const { harness, developer } = await createHarnessWithSession({
    id: OLD_SESSION,
  });
  await registerTestSession(harness, developer.apiKey, { id: MINE_SESSION });
  await registerTestSession(harness, developer.apiKey, {
    id: OTHER_REPO_SESSION,
    repo: OTHER_REPO,
  });
  return { harness, developer };
};

const seed = async (
  setupResult: Setup,
  records: readonly Record<string, unknown>[],
): Promise<void> => {
  const posted = await postRecords(setupResult.harness, setupResult.developer, {
    records,
  });
  if (posted.status !== 200 || (posted.data?.rejected ?? 1) > 0) {
    throw new Error(`seed failed: ${JSON.stringify(posted.data?.results)}`);
  }
};

describe("GET /api/solved-matches intent tier", () => {
  test("an intent sharing enough words with a solved tree earns a pointer", async () => {
    // Arrange: no shared target of any kind — the only thing connecting the
    // two is the sentence this session declared about its work.
    const context = await setup();
    await seed(context, solvedTreeRecords("wc_solved", OLD_SESSION, SOLVED_TITLE));
    await seed(
      context,
      intentContextRecords(
        "Debugging why webhook signature checks reject retries",
      ),
    );

    // Act
    const matches = await fetchMatches(context.harness, context.developer.apiKey);

    // Assert: found, named as an intent match, and POINTER ONLY — the tree
    // has an evidenced root cause and still may not assert it here, because
    // shared words are not evidence that the old answer fits this problem.
    expect(matches.map((match) => match.workContextId)).toEqual(["wc_solved"]);
    expect(matches[0]?.matchedTargetKind).toBe("session_intent");
    expect(matches[0]?.rootCause).toBeNull();
  });

  test("two shared words are below the floor; three are above it", async () => {
    // Arrange: ONE solved tree and two intents differing only in how much of
    // it they repeat. Asserting both in one test is what makes the floor
    // real — a tier with no floor passes the second half on its own.
    const thin = await setup();
    await seed(thin, solvedTreeRecords("wc_solved", OLD_SESSION, SOLVED_TITLE));
    await seed(thin, intentContextRecords("Checking webhook retries in the queue"));

    const thick = await setup();
    await seed(thick, solvedTreeRecords("wc_solved", OLD_SESSION, SOLVED_TITLE));
    await seed(
      thick,
      intentContextRecords("Checking webhook signature retries in the queue"),
    );

    // Act
    const below = await fetchMatches(thin.harness, thin.developer.apiKey);
    const above = await fetchMatches(thick.harness, thick.developer.apiKey);

    // Assert
    expect(below).toHaveLength(0);
    expect(above.map((match) => match.workContextId)).toEqual(["wc_solved"]);
  });

  test("a teammate's intent never pulls trees into my briefing", async () => {
    // Arrange: the matching sentence belongs to ANOTHER developer's live
    // session on the same repo. A fingerprint is a fact about a failure and
    // belongs to whoever hits it; an intent is one person's statement about
    // their own work, so it must not put lines in my briefing.
    const context = await setup();
    const teammate = await addTestDeveloperWithSession(
      context.harness,
      "Ken",
      "ken@example.com",
      { id: "ses_ken" },
    );
    await seed(context, solvedTreeRecords("wc_solved", OLD_SESSION, SOLVED_TITLE));
    // Through `postRecords`, which rewrites the envelope's placeholder
    // producer to the AUTHENTICATED developer — posting Ken's records by
    // hand leaves the default id in the envelope, and the hub rejects the
    // batch with "producer.developerId: does not match authenticated
    // developer" while still answering 200. The arrangement is therefore
    // asserted on `accepted`, not on the status: a rejected record makes the
    // silence below true for a reason that has nothing to do with the tier.
    const posted = await postRecords(context.harness, teammate, {
      records: intentContextRecords(
        "Debugging why webhook signature checks reject retries",
        "ses_ken",
      ),
    });
    expect(posted.status).toBe(200);
    expect(posted.data?.accepted).toBe(1);

    // Act
    const theirs = await fetchMatches(context.harness, context.developer.apiKey);

    // Assert: silence — and the CONTRAST, because "no match" is also what a
    // hub with no intent tier at all answers: the identical sentence as MY
    // OWN intent finds the very same tree.
    expect(theirs).toHaveLength(0);
    await seed(
      context,
      intentContextRecords(
        "Debugging why webhook signature checks reject retries",
      ),
    );
    const mine = await fetchMatches(context.harness, context.developer.apiKey);
    expect(mine.map((match) => match.workContextId)).toEqual(["wc_solved"]);
  });

  test("the intent tier stays inside this repo, unlike the fingerprint tier", async () => {
    // Arrange: the same matching tree, this time solved in another repo.
    // Text overlap is not identity, and the searchable doc still carries the
    // repo label and the default branch name (audit row M13) — so prose is
    // not allowed to travel until that is cleaned up.
    const context = await setup();
    await seed(
      context,
      solvedTreeRecords("wc_far", OTHER_REPO_SESSION, SOLVED_TITLE),
    );
    await seed(
      context,
      intentContextRecords(
        "Debugging why webhook signature checks reject retries",
      ),
    );

    // Act
    const far = await fetchMatches(context.harness, context.developer.apiKey);

    // Assert: silence — and the CONTRAST again, because a hub with no intent
    // tier answers the same way: the identical tree solved HERE is a match.
    expect(far).toHaveLength(0);
    await seed(context, solvedTreeRecords("wc_near", OLD_SESSION, SOLVED_TITLE));
    const near = await fetchMatches(context.harness, context.developer.apiKey);
    expect(near.map((match) => match.workContextId)).toEqual(["wc_near"]);
  });
});
