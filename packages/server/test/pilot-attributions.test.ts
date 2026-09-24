/**
 * THE SUSPECT ANSWER, KEPT AS IT WAS GIVEN (1.0 spec 07 §3.3).
 *
 * `services/suspect.ts` persists nothing and its window ends *now*, so the
 * same question asked next week is answered from a different fourteen days.
 * Proof 3 asks whether an attribution was RIGHT — which means comparing what
 * was said to what was later repaired — and neither half survives unless the
 * first one is stored at the moment it is made.
 *
 * THE CASE THAT MATTERS MOST IS THE ONE WHERE NOTHING IS WRITTEN. A hub
 * running for a team that never enrolled stores no row at all: not a row
 * marked "not enrolled", nothing. That is the difference between a flag and
 * consent, and it is the assertion somebody removing a condition would break
 * without any other test in this repository noticing.
 */
import { describe, expect, test } from "bun:test";

import { PIN_PRESENCE_TERMINAL } from "@crosscheck/schema";

import { pilotAttributions } from "../src/db/schema.ts";
import { recordAttribution } from "../src/services/pilot.ts";
import { COVERAGE_SOURCES } from "../src/services/coverage.ts";
import type { CoverageRecord } from "../src/services/coverage.ts";
import type { SuspectView } from "../src/services/suspect.ts";
import {
  TEST_ADMIN_TOKEN,
  TEST_START_ISO,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  registerTestSession,
  postRecords,
  recordEnvelope,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";
const PIN = "pin_playback";
const PINNED = "src/workbench/usePlayback.ts";
const SESSION = "cc_11111111-2222-4333-8444-555555555555";

const setup = async (
  options: { readonly enrolled: boolean } = { enrolled: true },
): Promise<{ harness: TestHarness; developer: TestDeveloper }> => {
  const harness = await createTestHarness();
  const developer = await createTestDeveloper(
    harness,
    "Nick",
    "nick-pilot@example.com",
  );
  await harness.app.request(
    "/api/pins",
    jsonRequest("POST", developer.apiKey, {
      id: PIN,
      repo: REPO,
      surface: "Play button plays/pauses",
      files: [PINNED],
      check: "open /workbench, press Play",
      presence: PIN_PRESENCE_TERMINAL,
      verifiedAtCommit: "abc1234",
    }),
  );
  if (options.enrolled) {
    await harness.app.request(
      "/api/team-settings",
      jsonRequest("PUT", TEST_ADMIN_TOKEN, {
        repo: REPO,
        pilotEnrolled: true,
      }),
    );
  }
  return { harness, developer };
};

const seedTouch = async (
  harness: TestHarness,
  developer: TestDeveloper,
): Promise<void> => {
  await registerTestSession(harness, developer.apiKey, {
    id: SESSION,
    repo: REPO,
  });
  const contextId = `wc_${SESSION}`;
  await postRecords(harness, developer, {
    records: [
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          id: contextId,
          sessionId: SESSION,
          title: "rework the playback controls",
          description: undefined,
          createdAt: TEST_START_ISO,
        }),
        { sessionId: SESSION },
      ),
      recordEnvelope(
        "target",
        { workContextId: contextId, kind: "file", value: PINNED },
        { sessionId: SESSION },
      ),
    ],
  });
};

/** A second session touching the same one file — identical score, no separation. */
const seedSecondTouch = async (
  harness: TestHarness,
  developer: TestDeveloper,
): Promise<void> => {
  const sessionId = "cc_22222222-2222-4333-8444-555555555555";
  await registerTestSession(harness, developer.apiKey, {
    id: sessionId,
    repo: REPO,
  });
  const contextId = `wc_${sessionId}`;
  await postRecords(harness, developer, {
    records: [
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          id: contextId,
          sessionId,
          title: "also reworking the playback controls",
          description: undefined,
          createdAt: TEST_START_ISO,
        }),
        { sessionId },
      ),
      recordEnvelope(
        "target",
        { workContextId: contextId, kind: "file", value: PINNED },
        { sessionId },
      ),
    ],
  });
};

/** The falsifier gate: without a recorded break, `suspect` withholds rows. */
const breakPin = async (
  harness: TestHarness,
  developer: TestDeveloper,
): Promise<void> => {
  const response = await harness.app.request(
    `/api/pins/${PIN}/broke`,
    jsonRequest("POST", developer.apiKey, {
      repo: REPO,
      presence: PIN_PRESENCE_TERMINAL,
    }),
  );
  expect(response.status).toBe(200);
};

const ask = async (
  harness: TestHarness,
  developer: TestDeveloper,
  query: string,
): Promise<number> => {
  const response = await harness.app.request(
    `/api/suspect?repo=${encodeURIComponent(REPO)}&${query}`,
    jsonRequest("GET", developer.apiKey),
  );
  return response.status;
};

const rows = (harness: TestHarness) =>
  harness.db.select().from(pilotAttributions);

describe("an answer is kept as it was given", () => {
  test("an enrolled repo stores the answer the route just gave", async () => {
    // Arrange
    const { harness, developer } = await setup();
    await seedTouch(harness, developer);

    // Act
    expect(await ask(harness, developer, `pin=${PIN}`)).toBe(200);

    // Assert
    const stored = await rows(harness);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.pinId).toBe(PIN);
    expect(stored[0]?.repo).toBe(REPO);
    // The falsifier is the SUSPECT'S, verbatim — not a parallel vocabulary.
    expect(stored[0]?.falsifier).toBe("not_recorded_broken");
  });

  test("a repo that never enrolled stores NOTHING — not a row saying so", async () => {
    // Arrange — the assertion somebody removing the gate would break, and
    // which no other test in this repository would notice.
    const { harness, developer } = await setup({ enrolled: false });
    await seedTouch(harness, developer);

    // Act
    expect(await ask(harness, developer, `pin=${PIN}`)).toBe(200);

    // Assert
    expect(await rows(harness)).toHaveLength(0);
  });

  test("a reader-named scope stores nothing — there is nothing to be right about", async () => {
    // Arrange — no pin means no invariant and no repair that could ever
    // confirm or refute the answer. Storing these would grow proof 3's
    // denominator with cases that can never resolve.
    const { harness, developer } = await setup();
    await seedTouch(harness, developer);

    // Act
    expect(
      await ask(harness, developer, `path=${encodeURIComponent(PINNED)}`),
    ).toBe(200);

    // Assert
    expect(await rows(harness)).toHaveLength(0);
  });

  test("judgeability is RECORDED, not used to withhold the row", async () => {
    // Arrange — refusing to store an unjudgeable answer would hide exactly
    // the cases principle 1 exists for: the report has to say how many
    // answers it EXCLUDED, and it cannot count what was never written.
    const { harness, developer } = await setup();
    await seedTouch(harness, developer);

    // Act
    await ask(harness, developer, `pin=${PIN}`);

    // Assert
    const stored = await rows(harness);
    expect(stored).toHaveLength(1);
    expect(typeof stored[0]?.coverageJudgeable).toBe("boolean");
  });

  test("an answer that names nobody records nobody", async () => {
    // Arrange — no touches at all, so the outcome is `no_touch`. A stored
    // top session here would be an attribution the product declined to make.
    const { harness, developer } = await setup();

    // Act
    await ask(harness, developer, `pin=${PIN}`);

    // Assert
    const stored = await rows(harness);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.topSessionId).toBeNull();
    expect(stored[0]?.topLift).toBeNull();
    expect(stored[0]?.candidates).toBe(0);
  });

  test("rows printed WITHOUT a separated top record no top session", async () => {
    // Arrange — two sessions, one pinned file each, identical scores. The
    // product prints both rows and names NOBODY, which is the whole point of
    // `no_separation`. Recording the first row as "the top session" would
    // manufacture an attribution the product declined to make, and proof 3
    // would then score this product against answers it never gave.
    const { harness, developer } = await setup();
    await seedTouch(harness, developer);
    await seedSecondTouch(harness, developer);
    // Without a recorded break the falsifier gate withholds every row, and
    // `withheld` carries no candidates — so the case would look correct for
    // the wrong reason.
    await breakPin(harness, developer);

    // Act
    await ask(harness, developer, `pin=${PIN}`);

    // Assert
    const stored = await rows(harness);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.outcome).toBe("no_separation");
    // Rows were printed…
    expect(stored[0]?.candidates).toBeGreaterThan(0);
    // …and nobody was named.
    expect(stored[0]?.topSessionId).toBeNull();
    expect(stored[0]?.topLift).toBeNull();
  });

  test("the reader-named refusal is a REFUSAL, not a swallowed error", async () => {
    // Arrange — the route wraps this call in a try/catch so instrumentation
    // can never cost a reader their answer, which means a route-level test
    // cannot tell "gated out" from "threw and was swallowed". Both leave
    // zero rows. So the service is called directly: with the gate removed,
    // the insert violates the NOT NULL foreign key and this REJECTS.
    const { harness } = await setup();
    const now = new Date(TEST_START_ISO);
    const coverage: CoverageRecord = {
      repo: REPO,
      computedAt: now.toISOString(),
      scope: { sinceIso: now.toISOString() },
      sources: COVERAGE_SOURCES.map((source) => ({
        source,
        state: "unknown" as const,
        reason: "hub_did_not_report" as const,
        gapSince: null,
        observedAt: null,
      })),
    };
    const view = {
      outcome: "no_touch",
      falsifier: { kind: "reader_named_files", at: null, check: null },
      scope: {
        kind: "paths",
        pinId: null,
        pinVersion: null,
        surface: null,
        files: [PINNED],
        missingFiles: [],
        rewrittenPaths: 0,
        rewrittenAt: null,
      },
      candidates: [],
    } as unknown as SuspectView;

    // Act & Assert — it resolves, and it writes nothing.
    await recordAttribution(
      { db: harness.db, now: () => now },
      { repo: REPO, pinId: null, view, coverage },
    );
    expect(await rows(harness)).toHaveLength(0);
  });

  test("asking twice appends twice — an answer is a thing that happened", async () => {
    // Arrange — append-only. Rewriting an answer because the world moved
    // would be rewriting the measurement to match the outcome.
    const { harness, developer } = await setup();
    await seedTouch(harness, developer);

    // Act
    await ask(harness, developer, `pin=${PIN}`);
    await ask(harness, developer, `pin=${PIN}`);

    // Assert
    expect(await rows(harness)).toHaveLength(2);
  });
});
