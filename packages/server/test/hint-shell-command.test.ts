/**
 * A BARE SHELL COMMAND MATCHES NOTHING (hold-out review round 5, M3), hub
 * half — the half that protects every connector already installed. "bun
 * test" reached the CI-cache tree on "bun" and "test"; the hub reads the
 * shared verdict (@crosscheck/schema shell-command.ts) and answers no
 * candidate, while the same words beside what broke still reach the tree.
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
}

const candidateIds = async (harness: TestHarness, developer: TestDeveloper, query: string): Promise<readonly string[]> => {
  const search = new URLSearchParams({ repo: REPO, query });
  const response = await harness.app.request(`/api/hints/candidates?${search.toString()}`, jsonRequest("GET", developer.apiKey));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { candidates: readonly CandidateView[] } };
  return body.data.candidates.map((candidate) => candidate.workContext.id);
};

/** Ken's CI tree, which says bun, install, test and the auth path. */
const setup = async (): Promise<{ harness: TestHarness; robin: TestDeveloper }> => {
  const { harness, developer: ken } = await createHarnessWithSession();
  const seeded = await postRecords(harness, ken, {
    records: [
      recordEnvelope("work_context", validWorkContextBody({ title: "Speed up CI by caching bun install and sharding the test suite", description: "CI cache" })),
      recordEnvelope("target", { workContextId: WORK_CONTEXT_ID, kind: "file", value: "packages/api/src/auth/session.ts" }),
      recordEnvelope("claim", validClaimBody({ id: "clm_ci", body: "bun install takes 3 minutes without a cache, and the test suite runs on one runner" })),
    ],
  });
  expect(seeded.data?.accepted).toBe(3);
  const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
  return { harness, robin };
};

describe("a bare shell command is no query (round 5, M3)", () => {
  test.each([["bun test"], ["bun test packages/api/src/auth"], ["bun run build --frozen"], ["!bun test --watch"]])(
    "%p gets no candidate",
    async (prompt) => {
      // Arrange
      const { harness, robin } = await setup();

      // Act
      const ids = await candidateIds(harness, robin, prompt);

      // Assert
      expect(ids).toEqual([]);
    },
  );

  test("the command beside what broke still reaches the tree", async () => {
    // Arrange
    const { harness, robin } = await setup();

    // Act
    const ids = await candidateIds(harness, robin, "bun test takes 3 minutes because bun install has no cache");

    // Assert
    expect(ids).toEqual([WORK_CONTEXT_ID]);
  });
});
