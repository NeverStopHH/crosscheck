/**
 * The floor counts only what a reader could be shown, over the whole pool
 * (review 1006b, M5: the mutations that survived the round before).
 *
 * A retracted claim and a muted author's claim are neither in the window nor
 * on the wire, so their words never qualify a tree. The floor runs over the
 * whole search pool before it is cut to HINT_MAX_CONTEXTS, so trees that
 * rank higher on one repeated word cannot crowd out the one that qualifies.
 * And the hub judges the human text of a turn, never the harness's wrapper
 * around it, for every connector that still sends the wrapper.
 */
import { describe, expect, test } from "bun:test";

import { HINT_MAX_CONTEXTS } from "../src/services/hints.ts";
import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  validClaimBody,
  validClaimEdgeBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
const PROMPT = "why does the zebrafrobnicator cache poison the quuxinator";
const BODY = "The zebrafrobnicator cache poisons the quuxinator on every warm start";
const MIKE_SESSION = "ses_mike";

const fetchIds = async (harness: TestHarness, developer: TestDeveloper, query: string): Promise<readonly string[]> => {
  const search = new URLSearchParams({ repo: REPO, query });
  const response = await harness.app.request(`/api/hints/candidates?${search.toString()}`, jsonRequest("GET", developer.apiKey));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { candidates: readonly { workContext: { id: string } }[] } };
  return body.data.candidates.map((candidate) => candidate.workContext.id);
};

interface World {
  readonly harness: TestHarness;
  readonly nick: TestDeveloper;
  readonly robin: TestDeveloper;
}

/** A quarter ago: old enough that recency decay ranks fresher trees above it. */
const QUARTER_AGO = "2026-05-15T09:00:00.000Z";

/** Nick's tree, its own statement sharing nothing with the prompt unless given a title, last active a quarter ago. */
const world = async (title = "Unrelated title words"): Promise<World> => {
  const { harness, developer: nick } = await createHarnessWithSession();
  const seeded = await postRecords(harness, nick, {
    records: [
      recordEnvelope(
        "work_context",
        validWorkContextBody({ title, description: "x", createdAt: QUARTER_AGO }),
      ),
    ],
  });
  expect(seeded.data?.accepted).toBe(1);
  const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
  return { harness, nick, robin };
};

describe("a word the reader could not be shown never qualifies a tree", () => {
  test("the control: a visible claim's words do", async () => {
    // Arrange
    const { harness, nick, robin } = await world();
    await postRecords(harness, nick, { records: [recordEnvelope("claim", validClaimBody({ id: "clm_seen", body: BODY }))] });

    // Act + Assert
    expect(await fetchIds(harness, robin, PROMPT)).toEqual([WORK_CONTEXT_ID]);
  });

  test("a claim its author retracted", async () => {
    // Arrange — a revision supersedes the matching claim
    const { harness, nick, robin } = await world();
    const seeded = await postRecords(harness, nick, {
      records: [
        recordEnvelope("claim", validClaimBody({ id: "clm_old", body: BODY })),
        recordEnvelope("claim", validClaimBody({ id: "clm_new", body: "Nothing in the warm start path after all." })),
        recordEnvelope("claim_edge", validClaimEdgeBody({ id: "edge_rev", fromClaimId: "clm_new", toClaimId: "clm_old", kind: "supersedes" })),
      ],
    });
    expect(seeded.data?.accepted).toBe(3);

    // Act + Assert
    expect(await fetchIds(harness, robin, PROMPT)).toEqual([]);
  });

  test("a claim by an author the reader muted, inside an unmuted teammate's tree", async () => {
    // Arrange — Mike extends Nick's tree; Robin muted Mike
    const { harness, robin } = await world();
    const mike = await addTestDeveloperWithSession(harness, "Mike", "mike@example.com", { id: MIKE_SESSION });
    const seeded = await postRecords(harness, mike, {
      records: [recordEnvelope("claim", validClaimBody({ id: "clm_mike", authorSessionId: MIKE_SESSION, body: BODY }), { sessionId: MIKE_SESSION })],
    });
    expect(seeded.data?.accepted).toBe(1);
    const muted = await harness.app.request("/api/settings/mutes", jsonRequest("POST", robin.apiKey, { developer: "Mike" }));
    expect(muted.status).toBe(200);

    // Act + Assert
    expect(await fetchIds(harness, robin, PROMPT)).toEqual([]);
  });
});

describe("a tree the pool holds on one word of its own title is not lifted over the floor by words the reader could not be shown", () => {
  /** In the pool on "zebrafrobnicator" alone: one shared word, short of the floor. */
  const ONE_WORD_TITLE = "Zebrafrobnicator migration notes";

  test("the control: a visible claim's words lift it", async () => {
    const { harness, nick, robin } = await world(ONE_WORD_TITLE);
    await postRecords(harness, nick, { records: [recordEnvelope("claim", validClaimBody({ id: "clm_seen", body: BODY }))] });

    expect(await fetchIds(harness, robin, PROMPT)).toEqual([WORK_CONTEXT_ID]);
  });

  test("a retracted claim's words do not", async () => {
    // Arrange
    const { harness, nick, robin } = await world(ONE_WORD_TITLE);
    const seeded = await postRecords(harness, nick, {
      records: [
        recordEnvelope("claim", validClaimBody({ id: "clm_old", body: BODY })),
        recordEnvelope("claim", validClaimBody({ id: "clm_new", body: "Nothing in the warm start path after all." })),
        recordEnvelope("claim_edge", validClaimEdgeBody({ id: "edge_rev", fromClaimId: "clm_new", toClaimId: "clm_old", kind: "supersedes" })),
      ],
    });
    expect(seeded.data?.accepted).toBe(3);

    // Act + Assert
    expect(await fetchIds(harness, robin, PROMPT)).toEqual([]);
  });

  test("a muted author's words do not", async () => {
    // Arrange
    const { harness, robin } = await world(ONE_WORD_TITLE);
    const mike = await addTestDeveloperWithSession(harness, "Mike", "mike@example.com", { id: MIKE_SESSION });
    const seeded = await postRecords(harness, mike, {
      records: [recordEnvelope("claim", validClaimBody({ id: "clm_mike", authorSessionId: MIKE_SESSION, body: BODY }), { sessionId: MIKE_SESSION })],
    });
    expect(seeded.data?.accepted).toBe(1);
    const muted = await harness.app.request("/api/settings/mutes", jsonRequest("POST", robin.apiKey, { developer: "Mike" }));
    expect(muted.status).toBe(200);

    // Act + Assert
    expect(await fetchIds(harness, robin, PROMPT)).toEqual([]);
  });
});

describe("the floor runs over the whole pool before the bound", () => {
  test("trees that rank higher on one repeated word cannot crowd out the tree that qualifies", async () => {
    // Arrange — more noise trees than HINT_MAX_CONTEXTS, each saying one
    // prompt word over and over; the target shares three words, once each
    const { harness, nick, robin } = await world();
    const noise = Array.from({ length: HINT_MAX_CONTEXTS + 2 }, (_, index) => [
      recordEnvelope(
        "work_context",
        validWorkContextBody({ id: `wc_noise_${String(index)}`, title: "Zebrafrobnicator zebrafrobnicator zebrafrobnicator", description: "zebrafrobnicator" }),
      ),
      recordEnvelope(
        "claim",
        validClaimBody({ id: `clm_noise_${String(index)}`, workContextId: `wc_noise_${String(index)}`, body: "Zebrafrobnicator zebrafrobnicator zebrafrobnicator zebrafrobnicator." }),
      ),
    ]).flat();
    const seeded = await postRecords(harness, nick, {
      records: [...noise, recordEnvelope("claim", validClaimBody({ id: "clm_target", body: "The cache poisons the quuxinator." }))],
    });
    expect(seeded.data?.accepted).toBe(noise.length + 1);

    // Act
    const ids = await fetchIds(harness, robin, PROMPT);

    // Assert — only the qualifying tree, however the pool ranked it
    expect(ids).toEqual([WORK_CONTEXT_ID]);
  });
});

describe("the hub judges the human text, never the wrapper an older connector still sends", () => {
  test("an IDE file context around \"ok weiter\" matches no tree its boilerplate shares words with", async () => {
    // Arrange — the tree says current, task and user, as the IDE wrapper does
    const { harness, nick, robin } = await world();
    await postRecords(harness, nick, {
      records: [recordEnvelope("claim", validClaimBody({ id: "clm_ide", body: "The current user is joined twice when a task has two assignees." }))],
    });

    // Act
    const ids = await fetchIds(
      harness,
      robin,
      "<ide_opened_file>The user opened the file /repo/README.md in the IDE. This may or may not be related to the current task.</ide_opened_file>\nok weiter",
    );

    // Assert
    expect(ids).toEqual([]);
  });
});
