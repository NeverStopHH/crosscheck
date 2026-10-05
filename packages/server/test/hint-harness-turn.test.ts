/**
 * A turn the harness wrote matches nothing (DESIGN.md §4), hub half — the
 * half that protects every connector already installed. Live on 0.10.0:
 * Claude Code delivers a background task's notification as a user turn, the
 * connector sent it as the query, and its words — monitor, event, checks,
 * pass — pointed the session at a teammate's automation tree. The hub strips
 * the same wrappers the connector does (@crosscheck/schema harness-turn.ts)
 * and scores only the human text; a turn that is all harness gets no
 * candidate, not even through the session's intent.
 */
import { describe, expect, test } from "bun:test";

import { SYSTEM_NOTIFICATION_MARKER } from "@crosscheck/schema";

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
const TASK_NOTIFICATION =
  "<task-notification><task-id>bp1v5vsl4</task-id>" +
  '<summary>Monitor event: "PR #74 CI checks for 493ffb4f"</summary>' +
  "<event>Comment claims (macos-latest): pass</event></task-notification>";
const SESSION_INTENT = "Automate the match extraction monitor for every provider";

interface CandidateView {
  readonly workContext: { readonly id: string };
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

/** Ken's automation tree, whose claim shares four of the notification's words. */
const setup = async (): Promise<{ harness: TestHarness; robin: TestDeveloper }> => {
  const { harness, developer: ken } = await createHarnessWithSession();
  const seeded = await postRecords(harness, ken, {
    records: [
      recordEnvelope(
        "work_context",
        validWorkContextBody({ title: "AUTOMATION FLOW FOR MATCH EXTRACTION FROM PROVIDERS" }),
      ),
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_monitor",
          body: "The monitor event fires once the checks pass for each provider's extraction run",
        }),
      ),
    ],
  });
  expect(seeded.data?.accepted).toBe(2);
  const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", {
    id: "ses_02",
  });
  return { harness, robin };
};

describe("a turn that is all harness is no query", () => {
  test.each([
    ["a task notification", TASK_NOTIFICATION],
    ["a turn headed by the system-notification marker", `${SYSTEM_NOTIFICATION_MARKER}\nMonitor event: checks pass`],
    ["another agent's message", '<agent-message from="a781e1e961b68f4c2">monitor event checks pass</agent-message>'],
    ["another session's message", '<cross-session-message from="ken">monitor event checks pass</cross-session-message>'],
  ])("%s matches no tree", async (_, turn) => {
    // Arrange
    const { harness, robin } = await setup();

    // Act
    const candidates = await fetchCandidates(harness, robin, { query: turn });

    // Assert
    expect(candidates).toEqual([]);
  });

  test("and the session's intent does not stand in for it — nobody typed anything", async () => {
    // Arrange — an intent that WOULD match the tree on its own
    const { harness, robin } = await setup();

    // Act
    const candidates = await fetchCandidates(harness, robin, {
      query: TASK_NOTIFICATION,
      intent: SESSION_INTENT,
    });

    // Assert
    expect(candidates).toEqual([]);
  });

  test("the control: the same intent beside a content-free HUMAN prompt still matches", async () => {
    // Arrange
    const { harness, robin } = await setup();

    // Act
    const candidates = await fetchCandidates(harness, robin, { query: "ok", intent: SESSION_INTENT });

    // Assert
    expect(candidates.map((candidate) => candidate.workContext.id)).toEqual([WORK_CONTEXT_ID]);
  });
});

describe("human text around a wrapper is scored, and only it", () => {
  test("the human question matches; the notification's words did not make it", async () => {
    // Arrange
    const { harness, robin } = await setup();

    // Act — the human words share two with the tree's claim on their own
    const candidates = await fetchCandidates(harness, robin, {
      query: `${TASK_NOTIFICATION} why does the extraction monitor stall`,
    });

    // Assert
    expect(candidates.map((candidate) => candidate.workContext.id)).toEqual([WORK_CONTEXT_ID]);
  });

  test("human text that shares one word is still one word, whatever the wrapper beside it shares", async () => {
    // Arrange
    const { harness, robin } = await setup();

    // Act — "monitor" alone is below the floor; the wrapper must not top it up
    const candidates = await fetchCandidates(harness, robin, {
      query: `${TASK_NOTIFICATION} the monitor`,
    });

    // Assert
    expect(candidates).toEqual([]);
  });
});
