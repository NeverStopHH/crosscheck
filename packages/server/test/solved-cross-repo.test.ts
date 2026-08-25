/**
 * GET /api/solved-matches ACROSS REPOS (VISION.md §1 collective memory): the
 * team's memory is one hub, not one repo, and `get_diagnosis` has always been
 * cross-repo readable — a symptom somebody already diagnosed in the web app
 * is the same answer when it reappears in the api.
 *
 * The rule these tests pin is WHICH identity travels: an error fingerprint is
 * derived from the failure TEXT, so it means the same thing in every
 * checkout; a file target is a REPO-RELATIVE PATH, so `src/index.ts` in two
 * repos is two different files and matching on it across repos is the fuzzy
 * similarity the prior art warns about (Stack Overflow duplicate detection's
 * precision decay; Sentry groups by fingerprint or not at all).
 */
import { describe, expect, test } from "bun:test";

import {
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
/** 60 days before TEST_START_ISO — outside any recent-activity window. */
const OLD_ISO = "2026-05-25T09:00:00.000Z";
const SAME_REPO_SESSION = "ses_same_repo";
const OTHER_REPO_SESSION = "ses_other_repo";
const LIVE_SESSION = "ses_live";
const FINGERPRINT = "fp_3f7a1c9e2b8d4056";
const SHARED_PATH = "src/auth/refresh.ts";

interface MatchView {
  readonly workContextId: string;
  readonly title: string;
  readonly repo?: string;
  readonly matchedTargetKind: string;
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

/** A solved tree owned by `sessionId` (and therefore by that session's repo). */
const solvedTreeRecords = (
  contextId: string,
  sessionId: string,
  targets: readonly { kind: string; value: string }[],
): readonly Record<string, unknown>[] => [
  recordEnvelope(
    "work_context",
    validWorkContextBody({
      id: contextId,
      sessionId,
      title: `Refresh 500s after key rotation (${contextId})`,
      description: undefined,
      createdAt: OLD_ISO,
    }),
    { sessionId },
  ),
  ...targets.map((target) =>
    recordEnvelope(
      "target",
      { workContextId: contextId, ...target },
      { sessionId },
    ),
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

const liveContextRecords = (
  targets: readonly { kind: string; value: string }[],
): readonly Record<string, unknown>[] => [
  recordEnvelope(
    "work_context",
    validWorkContextBody({
      id: "wc_live",
      sessionId: LIVE_SESSION,
      title: "Login 500s on staging again",
      description: undefined,
      createdAt: TEST_START_ISO,
    }),
    { sessionId: LIVE_SESSION },
  ),
  ...targets.map((target) =>
    recordEnvelope(
      "target",
      { workContextId: "wc_live", ...target },
      { sessionId: LIVE_SESSION },
    ),
  ),
];

interface Setup {
  readonly harness: TestHarness;
  readonly developer: TestDeveloper;
}

const setup = async (): Promise<Setup> => {
  const { harness, developer } = await createHarnessWithSession({
    id: SAME_REPO_SESSION,
  });
  await registerTestSession(harness, developer.apiKey, { id: LIVE_SESSION });
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

describe("GET /api/solved-matches across repos", () => {
  test("a fingerprint solved in another repo matches; a shared path there does not", async () => {
    // Arrange: BOTH candidates live on the other repo and BOTH share a target
    // with the live context here — one by content identity, one by a string
    // that merely happens to be spelled the same. Seeding them together is
    // what makes this discriminating: a rule that let ANY target travel
    // across repos would surface both.
    const context = await setup();
    await seed(
      context,
      solvedTreeRecords("wc_other_fp", OTHER_REPO_SESSION, [
        { kind: "error_fingerprint", value: FINGERPRINT },
      ]),
    );
    await seed(
      context,
      solvedTreeRecords("wc_other_path", OTHER_REPO_SESSION, [
        { kind: "file", value: SHARED_PATH },
      ]),
    );
    await seed(
      context,
      liveContextRecords([
        { kind: "error_fingerprint", value: FINGERPRINT },
        { kind: "file", value: SHARED_PATH },
      ]),
    );

    // Act
    const matches = await fetchMatches(context.harness, context.developer.apiKey);

    // Assert
    expect(matches.map((match) => match.workContextId)).toEqual(["wc_other_fp"]);
    expect(matches[0]?.matchedTargetKind).toBe("error_fingerprint");
    expect(matches[0]?.repo).toBe(OTHER_REPO);
  });

  test("a file match inside this repo still counts and names this repo", async () => {
    // Arrange: the same path, this time on a solved tree in the SAME repo —
    // where a repo-relative path IS identity. Without this the rule above
    // would read as "file targets never match", which is not the rule.
    const context = await setup();
    await seed(
      context,
      solvedTreeRecords("wc_same_path", SAME_REPO_SESSION, [
        { kind: "file", value: SHARED_PATH },
      ]),
    );
    await seed(
      context,
      liveContextRecords([{ kind: "file", value: SHARED_PATH }]),
    );

    // Act
    const matches = await fetchMatches(context.harness, context.developer.apiKey);

    // Assert
    expect(matches.map((match) => match.workContextId)).toEqual(["wc_same_path"]);
    expect(matches[0]?.matchedTargetKind).toBe("file");
    expect(matches[0]?.repo).toBe(REPO);
  });
});
