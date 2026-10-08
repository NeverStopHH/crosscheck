/**
 * A LONG PROMPT'S TASK IS FOUND, WHEREVER IT SITS (DESIGN.md §4, hold-out
 * review round 3, M7). The hub counts the floor on SEARCH_MAX_QUERY_TOKENS
 * terms, and they used to be the prompt's first sixteen: a morning's worth of
 * chatter before "the redis cache eviction drops scouting feed entries" filled
 * all of them. Now the terms are the prompt's RANKED ones (task clauses only,
 * topical words first), and of those only words some work context of this
 * repo says at all — a word nobody on the team wrote cannot match, and it
 * must not take the place of one that can. The existence probe is one
 * indexed lookup per term, for at most HINT_MAX_EXAMINED_TERMS of them.
 */
import { describe, expect, test } from "bun:test";

import { knownTermsIn, promptTerms } from "@crosscheck/schema";

import {
  HINT_LONG_PROMPT_KNOWN_TERMS,
  HINT_LONG_PROMPT_MIN_TOPICAL,
  HINT_MAX_COUNTED_TERMS,
  HINT_MAX_EXAMINED_TERMS,
  hubFloorTermsOf,
} from "../src/services/hints.ts";
import { SEARCH_MAX_QUERY_TOKENS } from "../src/services/search.ts";
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

const CHATTER =
  "Hey, so I was out most of the morning and only now got back to the laptop. " +
  "We went through the roadmap for next quarter, talked about hiring, budgets, the offsite in Lisbon, " +
  "the new office chairs, the coffee machine situation, holiday planning, who covers support in December, " +
  "the onboarding buddy rotation, the reading group, the conference talk proposals and the retro format. ";
const TASK = "What I actually need: the redis cache eviction drops scouting feed entries after deploys.";
/** Words a teammate's tree says: one more than a short prompt's known words. */
const VOCABULARY = Array.from({ length: HINT_LONG_PROMPT_KNOWN_TERMS + 1 }, (_, index) => `officeword${String.fromCharCode(97 + index)}`);

const seed = async (): Promise<{ harness: TestHarness; robin: TestDeveloper }> => {
  const { harness, developer: nick } = await createHarnessWithSession();
  const records = [
    recordEnvelope("work_context", validWorkContextBody({ title: "Redis cache eviction drops scouting feed entries", description: "Feed" })),
    recordEnvelope("claim", validClaimBody({ id: "clm_redis", body: "Scouting feed entries disappear after deploys because redis evicts keys." })),
  ];
  const seeded = await postRecords(harness, nick, { records });
  expect(seeded.data?.accepted).toBe(records.length);
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

/**
 * THE KNOWN WORDS ARE THE WORDS A STATEMENT SAYS (round 4, L1): the hub
 * probed the context's normalized document, which also holds its status, its
 * claims' kinds, the parts of its target paths and its drafts — words no
 * statement a floor counts on says, and a connector recounting an old hub
 * never sees. They filled counted slots and made a short prompt long. The
 * probe now reads what the floor reads: a context's own statement and its
 * visible pushable claims, never the reader's own work.
 */
describe("the hub knows only the words a statement says (L1)", () => {
  test("a status, a claim's kind, a target path's parts and a draft are no known words", async () => {
    // Arrange
    const { harness, developer: nick } = await createHarnessWithSession();
    const records = [
      recordEnvelope("work_context", validWorkContextBody({ title: "Nightly export", description: "Reports", status: "analyzing" })),
      recordEnvelope("target", { workContextId: WORK_CONTEXT_ID, kind: "file", value: "src/zebraquux/quokkapath.ts" }),
      recordEnvelope("claim", validClaimBody({ id: "clm_obs", body: "The nightly export stalls on large reports." })),
      recordEnvelope("claim", validClaimBody({ id: "clm_draft", captureMode: "auto", provenance: "derived", confidence: 0.4, body: "The marmotdraft exporter leaks memory." })),
    ];
    const seeded = await postRecords(harness, nick, { records });
    expect(seeded.data?.accepted).toBe(records.length);

    // Act
    const floor = await hubFloorTermsOf(harness.db, VALID_SESSION_BODY.repo, promptTerms("export zebraquux quokkapath marmotdraft analyzing observation"));

    // Assert
    expect(floor.all).toEqual(["export"]);
  });

  test("the hub's known words and the floor's own count agree, word for word, on paths and hosts too", async () => {
    // Arrange — statements a connector sees on the wire, with a path, a host and an address
    const { harness, developer: nick } = await createHarnessWithSession();
    const title = "Renewal cron runs in Europe/Berlin";
    const body = "The scheduler on api.example.com fires twice; see src/billing/renewal.ts or mail ops@example.com.";
    const records = [
      recordEnvelope("work_context", validWorkContextBody({ title, description: "Billing" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_cron", body })),
    ];
    const seeded = await postRecords(harness, nick, { records });
    expect(seeded.data?.accepted).toBe(records.length);
    const terms = promptTerms("the renewal cron in europe berlin fires twice on the scheduler, see billing renewal ops example");

    // Act
    const hub = await hubFloorTermsOf(harness.db, VALID_SESSION_BODY.repo, terms);

    // Assert — the hub's index and the shared lexeme rule know the same words
    expect(hub.all).toEqual(knownTermsIn(terms.ranked, [`${title} Billing`, body]));
    expect(hub.all).not.toContain("europe");
  });

  test("a prompt that names a path whole reaches the tree whose statement says it", async () => {
    // Arrange — "/health" is one word to the database, never "health"
    const { harness, developer: nick } = await createHarnessWithSession();
    const title = "/health returns 404 after the ingress rewrite";
    const seeded = await postRecords(harness, nick, { records: [recordEnvelope("work_context", validWorkContextBody({ title, description: "Ingress" }))] });
    expect(seeded.data?.accepted).toBe(1);
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
    const terms = promptTerms("why is /health 404");

    // Act
    const floor = await hubFloorTermsOf(harness.db, VALID_SESSION_BODY.repo, terms);
    const ids = await candidateIds(harness, robin, "why is /health 404");

    // Assert — the hub's index and the shared lexeme rule agree, and the tree is reached
    expect(floor.all).toEqual(knownTermsIn(terms.ranked, [`${title} Ingress`]));
    expect(floor.all).toEqual(["/health", "404"]);
    expect(ids).toEqual([WORK_CONTEXT_ID]);
  });

  test("the reader's own work lends no known word", async () => {
    // Arrange — the reader's own tree says "ownword"; a teammate's says "export"
    const { harness, developer: nick } = await createHarnessWithSession();
    const seeded = await postRecords(harness, nick, { records: [recordEnvelope("work_context", validWorkContextBody({ title: "Nightly export", description: "Reports" }))] });
    expect(seeded.data?.accepted).toBe(1);
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
    const own = await postRecords(harness, robin, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ id: "wc_robin", sessionId: "ses_02", title: "Ownword dashboard", description: "Mine" }), {
          sessionId: "ses_02",
        }),
      ],
    });
    expect(own.data?.accepted).toBe(1);

    // Act
    const floor = await hubFloorTermsOf(harness.db, VALID_SESSION_BODY.repo, promptTerms("export ownword"), false, robin.developerId);

    // Assert
    expect(floor.all).toEqual(["export"]);
  });
});

describe("the task behind the chatter (M7)", () => {
  test("a task after forty words of chatter still finds its tree", async () => {
    // Arrange
    const { harness, robin } = await seed();

    // Act
    const ids = await candidateIds(harness, robin, `${CHATTER}${TASK}`);

    // Assert
    expect(ids).toEqual([WORK_CONTEXT_ID]);
  });

  test("the control: the chatter alone finds nothing", async () => {
    const { harness, robin } = await seed();
    expect(await candidateIds(harness, robin, CHATTER)).toEqual([]);
  });

  test("words nobody on the team wrote take no counted slot, however many come first", async () => {
    // Arrange — more topical words nobody wrote than the hub counts, then the task
    const { harness, robin } = await seed();
    const unknown = Array.from({ length: HINT_MAX_COUNTED_TERMS + 8 }, (_, index) => `xqtopic${String(index)}`).join(" ");

    // Act
    const ids = await candidateIds(harness, robin, `${unknown}. ${TASK}`);

    // Assert — the task's words are the known ones, and counted
    expect(ids).toEqual([WORK_CONTEXT_ID]);
  });

  /** A target tree, and a tree whose description makes twenty chatter words known. */
  const seedLong = async (): Promise<{ harness: TestHarness; robin: TestDeveloper }> => {
    const { harness, developer: nick } = await createHarnessWithSession();
    const records = [
      recordEnvelope("work_context", validWorkContextBody({ title: "Composition prompt overflow", description: "Agent" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_rows", body: "The composer inlines every player row and column into the prompt." })),
      recordEnvelope("work_context", validWorkContextBody({ id: "wc_vocabulary", title: "Office notes", description: VOCABULARY.join(" ") })),
    ];
    const seeded = await postRecords(harness, nick, { records });
    expect(seeded.data?.accepted).toBe(records.length);
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
    return { harness, robin };
  };

  test("a long message agreeing with a tree on two topical words is chance, not a topic", async () => {
    // Arrange — more known words than a short prompt carries, and "player"
    // and "column" from two different sentences
    const { harness, robin } = await seedLong();
    const prompt = `${VOCABULARY.join(" ")}. The player was late. One column moved.`;

    // Act
    const ids = await candidateIds(harness, robin, prompt);

    // Assert
    expect(ids).not.toContain(WORK_CONTEXT_ID);
  });

  test(`the control: ${String(HINT_LONG_PROMPT_MIN_TOPICAL)} topical words on one statement are a topic, however long the message`, async () => {
    const { harness, robin } = await seedLong();
    const prompt = `${VOCABULARY.join(" ")}. The composer inlines every player row into the prompt.`;
    expect(await candidateIds(harness, robin, prompt)).toContain(WORK_CONTEXT_ID);
  });

  test("a clause that is a command to the session lends no word to the floor", async () => {
    // Arrange — "short" sits only in "keep it short please", a shaping command
    const { harness, developer: nick } = await createHarnessWithSession();
    const seeded = await postRecords(harness, nick, {
      records: [recordEnvelope("work_context", validWorkContextBody({ title: "Short redis keys", description: "Naming" }))],
    });
    expect(seeded.data?.accepted).toBe(1);
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });

    // Act
    const ids = await candidateIds(harness, robin, "keep it short please. the redis cache eviction drops feed entries");

    // Assert — only "redis" is the task's, and one word is not a topic
    expect(ids).toEqual([]);
  });

  test("the examined bound is a bound: a word past it is never looked at", async () => {
    // Arrange — exactly as many distinct topical words as the hub examines, then the task
    const { harness, robin } = await seed();
    const words = Array.from({ length: HINT_MAX_EXAMINED_TERMS }, (_, index) => `zq${String(index)}`).join(" ");
    const query = `${words} redis cache eviction`;

    // Act
    const ids = await candidateIds(harness, robin, query);

    // Assert
    expect(query.length).toBeLessThan(2000);
    expect(HINT_MAX_EXAMINED_TERMS).toBeGreaterThan(SEARCH_MAX_QUERY_TOKENS);
    expect(ids).toEqual([]);
  });
});
