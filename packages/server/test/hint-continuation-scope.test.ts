/**
 * A CONTINUATION IS SCOPED TO ITS CLAUSE (hold-out review round 5, C1), hub
 * half — the half every installed connector still sends the whole prompt to.
 * The hub reads the connector's own rule (@crosscheck/schema prompt-task.ts):
 * a continuation that only leads is matched on what follows it; one that
 * trails, one that is the whole prompt, and a rest that only reports a
 * status match nothing.
 */
import { describe, expect, test } from "bun:test";

import { promptTaskOf } from "@crosscheck/schema";

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

/** Ken's rate-limit tree, which says upload, endpoint, rate and limiting. */
const setup = async (): Promise<{ harness: TestHarness; robin: TestDeveloper }> => {
  const { harness, developer: ken } = await createHarnessWithSession();
  const seeded = await postRecords(harness, ken, {
    records: [
      recordEnvelope("work_context", validWorkContextBody({ title: "Rate limiting for the upload endpoint", description: "Token bucket per API key" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_rate", body: "The upload endpoint has no rate limiting; a token bucket per API key fixes the abuse" })),
    ],
  });
  expect(seeded.data?.accepted).toBe(2);
  const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
  return { harness, robin };
};

describe("a continuation that only leads is matched on what follows it (round 5, C1)", () => {
  test.each([["next: add rate limiting to the upload endpoint"], ["ok weiter, und dann rate limiting für den upload endpoint"], ["proceed, then the upload endpoint needs rate limiting"]])(
    "%p reaches the tree",
    async (prompt) => {
      // Arrange
      const { harness, robin } = await setup();

      // Act
      const ids = await candidateIds(harness, robin, prompt);

      // Assert
      expect(ids).toEqual([WORK_CONTEXT_ID]);
    },
  );
});

describe("what the leading continuation names is never matched", () => {
  test("a file the continuation clause names does not pull its tree in", async () => {
    // Arrange — Mia's gateway tree touched the file the leading clause names
    const { harness, robin } = await setup();
    const mia = await addTestDeveloperWithSession(harness, "Mia", "mia@example.com", { id: "ses_03" });
    const seeded = await postRecords(harness, mia, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ id: "wc_gateway", sessionId: "ses_03", title: "Gateway bucket refill", description: "Gateway" }), { sessionId: "ses_03" }),
        recordEnvelope("target", { workContextId: "wc_gateway", kind: "file", value: "packages/gateway/bucket.ts" }, { sessionId: "ses_03" }),
      ],
    });
    expect(seeded.data?.accepted).toBe(2);

    // Act
    const ids = await candidateIds(harness, robin, "continue with packages/gateway/bucket.ts, then add rate limiting to the upload endpoint");

    // Assert — only the task's tree
    expect(ids).toEqual([WORK_CONTEXT_ID]);
  });
});

describe("a continuation that trails, is the whole prompt, or hands back a status matches nothing", () => {
  test.each([
    ["cool, upload endpoint rate limiting is merged, next"],
    ["the upload endpoint rate limiting works on staging now, carry on"],
    ["continue the rate limiting work on the upload endpoint"],
    ["continue: the upload endpoint rate limiting is deployed"],
    ["weiter, das rate limiting für den upload endpoint läuft"],
  ])("%p gets no candidate", async (prompt) => {
    // Arrange
    const { harness, robin } = await setup();

    // Act
    const ids = await candidateIds(harness, robin, prompt);

    // Assert — and the rule says why: there is nothing to ask about
    expect(ids).toEqual([]);
    expect(promptTaskOf(prompt)).toBeNull();
  });
});
