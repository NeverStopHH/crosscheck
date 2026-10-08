/**
 * A CLOSED-CLASS WORD'S INFLECTION IS NO TOPIC (DESIGN.md §4, hold-out review
 * round 3, L1). The topical-word rule asks whether a word belongs to a closed
 * class as written, but the hub MATCHES in lexemes, after the english
 * configuration's stemming: "stopped" is no class word as written, matches
 * "stops" in a teammate's title as the lexeme of "stop" — a conversation word
 * — and carried "weekly limit reset, pick up where you stopped" to the
 * StatsBomb rate-limit tree. So a term whose lexeme is a closed-class word's
 * lexeme is not topical, on the hub that stems.
 *
 * ONLY AN INFLECTED PROMPT WORD (round 4, M1): in a task a class word as
 * written is topical, and so is a word that is its own lexeme ("refresh");
 * "stopped" and "shows" still lend none. That prompt now carries the session
 * on ("pick up where you stopped", C1) and never reaches the hub.
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

const seedTree = async (title: string, claimBody: string): Promise<{ harness: TestHarness; robin: TestDeveloper }> => {
  const { harness, developer: nick } = await createHarnessWithSession();
  const seeded = await postRecords(harness, nick, {
    records: [
      recordEnvelope("work_context", validWorkContextBody({ title, description: "Bulk" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_stem", body: claimBody })),
    ],
  });
  expect(seeded.data?.accepted).toBe(2);
  const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
  return { harness, robin };
};

const candidateIds = async (harness: TestHarness, robin: TestDeveloper, query: string): Promise<readonly string[]> => {
  const search = new URLSearchParams({ repo: VALID_SESSION_BODY.repo, query });
  const response = await harness.app.request(`/api/hints/candidates?${search.toString()}`, jsonRequest("GET", robin.apiKey));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { candidates: readonly { workContext: { id: string } }[] } };
  return body.data.candidates.map((candidate) => candidate.workContext.id);
};

describe("an inflected closed-class word lends no topic (L1)", () => {
  test("\"stopped\" and \"shows\" are the conversation word \"stop\" and the operation word \"show\" to a hub that stems", async () => {
    // Arrange — the title shares, as lexemes, "stop" and "show", and nothing else
    const { harness, robin } = await seedTree("Bulk extraction stops and shows a blank page", "Bulk extraction halts with HTTP 429 after sixty requests.");

    // Act — a task: "export" is no class word
    const ids = await candidateIds(harness, robin, "the export stopped and shows it twice");

    // Assert
    expect(ids).toEqual([]);
  });

  test("round 4, M1: beside a task's meta word, the inflected one is the second shared word", async () => {
    // Arrange
    const { harness, robin } = await seedTree("Dashboard shows the limit", "The dashboard renders the plan limit in the header.");

    // Act — "limit" is what the task is about; "shows" lends no topic, only a word
    const ids = await candidateIds(harness, robin, "the counter shows the limit again");

    // Assert
    expect(ids).toEqual([WORK_CONTEXT_ID]);
  });

  test("the control: a topical word beside the inflected one still finds the tree", async () => {
    const { harness, robin } = await seedTree("Import worker stops on OOM", "The import worker halts when memory runs out.");
    expect(await candidateIds(harness, robin, "the import worker stopped with an OOM again")).toEqual([WORK_CONTEXT_ID]);
  });
});
