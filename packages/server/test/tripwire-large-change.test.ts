/**
 * The TRIPWIRE takes the large-change rule too (release gate, 2026-10-08):
 * "a large surface must never mean not collision-relevant", and never the
 * FIRST relevance either. GET /api/hints/tripwire names the teammate whose
 * live session targeted the file the caller is about to edit, and the
 * connector asks about the first row. Ordered by nothing but the scan, a
 * fresher 300-file sweep through that file led the teammate whose focused
 * plan is in it. Now each row carries `largeChangeFiles` — the files its
 * change touched in the window, by the ghost check's own count
 * (services/ghost-overlap.ts listLargeChanges) — and focused rows lead, then
 * the freshest heartbeat.
 */
import { describe, expect, test } from "bun:test";

import { GHOST_MAX_CONTEXT_TARGETS } from "../src/constants.ts";
import { TRIPWIRE_MAX_SESSIONS as TRIPWIRE_ANSWER_ROWS } from "../src/services/hints.ts";
import {
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  TEST_START_ISO,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
const TARGET_FILE = "src/auth/refresh.ts";
/** Inside the 90 s presence TTL, so both sessions stay active. */
const FRESHER_BY_S = 30;
/** Past GHOST_ACTIVE_WINDOW_DAYS, the window a large change is counted in. */
const TEN_DAYS_S = 10 * 86_400;
const LARGE_FILES = GHOST_MAX_CONTEXT_TARGETS + 10;
/** Records per POST /api/records — the route refuses more (MAX_INGEST_BATCH). */
const INGEST_CHUNK = 100;

interface TripwireRow {
  readonly sessionId: string;
  readonly developerName: string;
  readonly lastHeartbeatAt: string;
  readonly largeChangeFiles?: number | null;
}

const fetchTripwire = async (harness: TestHarness, developer: TestDeveloper): Promise<readonly TripwireRow[]> => {
  const params = new URLSearchParams({ repo: REPO, value: TARGET_FILE });
  const response = await harness.app.request(`/api/hints/tripwire?${params.toString()}`, jsonRequest("GET", developer.apiKey));
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: { sessions: readonly TripwireRow[] } }).data.sessions;
};

const seedContext = async (
  harness: TestHarness,
  developer: TestDeveloper,
  sessionId: string,
  files: readonly string[],
  createdAt: string = TEST_START_ISO,
): Promise<void> => {
  const records = [
    recordEnvelope(
      "work_context",
      validWorkContextBody({ id: `wc_${sessionId}`, sessionId, title: `${sessionId} work`, description: undefined, createdAt }),
      { sessionId },
    ),
    ...files.map((value) => recordEnvelope("target", { workContextId: `wc_${sessionId}`, kind: "file", value }, { sessionId })),
  ];
  for (let start = 0; start < records.length; start += INGEST_CHUNK) {
    const posted = await postRecords(harness, developer, { records: records.slice(start, start + INGEST_CHUNK) });
    if (posted.status !== 200 || (posted.data?.rejected ?? 1) > 0) {
      throw new Error(`seed failed: ${JSON.stringify(posted.data?.results)}`);
    }
  }
};

const otherFiles = (count: number, prefix: string): readonly string[] =>
  Array.from({ length: count }, (_unused, i) => `src/${prefix}/f${String(i)}.ts`);

describe("the tripwire ranks and qualifies a large change", () => {
  test("a fresher large change follows the focused session in the file, and says how large it is", async () => {
    // Arrange: Ken's focused plan holds the file; a minute later Mike's
    // rename does too, with the fresher heartbeat.
    const harness = await createTestHarness();
    const robin = await createTestDeveloper(harness, "Robin", "robin@example.com");
    const ken = await createTestDeveloper(harness, "Ken", "ken@example.com");
    const mike = await createTestDeveloper(harness, "Mike", "mike@example.com");
    await registerTestSession(harness, robin.apiKey, { id: "ses_robin" });
    await registerTestSession(harness, ken.apiKey, { id: "ses_ken" });
    await seedContext(harness, ken, "ses_ken", [TARGET_FILE, "src/auth/session.ts"]);
    harness.clock.advanceSeconds(FRESHER_BY_S);
    await registerTestSession(harness, mike.apiKey, { id: "ses_mike" });
    await seedContext(harness, mike, "ses_mike", [TARGET_FILE, ...otherFiles(LARGE_FILES - 1, "gen")]);

    // Act
    const rows = await fetchTripwire(harness, robin);

    // Assert: heartbeat alone would have led with Mike.
    expect(Date.parse(rows[1]?.lastHeartbeatAt ?? "")).toBeGreaterThan(Date.parse(rows[0]?.lastHeartbeatAt ?? ""));
    expect(rows.map((row) => row.developerName)).toEqual(["Ken", "Mike"]);
    expect(rows.map((row) => row.largeChangeFiles ?? null)).toEqual([null, LARGE_FILES]);
  });

  test("a focused session behind more fresher large changes than the answer holds still leads it", async () => {
    // Arrange: Ken's focused plan first; then more of Mike's renames through
    // the file than one answer names, every one with a fresher heartbeat.
    const harness = await createTestHarness();
    const robin = await createTestDeveloper(harness, "Robin", "robin@example.com");
    const ken = await createTestDeveloper(harness, "Ken", "ken@example.com");
    const mike = await createTestDeveloper(harness, "Mike", "mike@example.com");
    await registerTestSession(harness, ken.apiKey, { id: "ses_ken" });
    await seedContext(harness, ken, "ses_ken", [TARGET_FILE]);
    for (let index = 0; index < TRIPWIRE_ANSWER_ROWS + 1; index += 1) {
      harness.clock.advanceSeconds(1);
      const sessionId = `ses_mike_${String(index)}`;
      await registerTestSession(harness, mike.apiKey, { id: sessionId });
      await seedContext(harness, mike, sessionId, [TARGET_FILE, ...otherFiles(LARGE_FILES - 1, `gen${String(index)}`)]);
    }

    // Act
    const rows = await fetchTripwire(harness, robin);

    // Assert: ranked over every candidate, not over the freshest five.
    expect(rows).toHaveLength(TRIPWIRE_ANSWER_ROWS);
    expect(rows[0]?.developerName).toBe("Ken");
  });

  test("two focused sessions keep the freshest heartbeat first", async () => {
    // Arrange
    const harness = await createTestHarness();
    const robin = await createTestDeveloper(harness, "Robin", "robin@example.com");
    const ken = await createTestDeveloper(harness, "Ken", "ken@example.com");
    const mike = await createTestDeveloper(harness, "Mike", "mike@example.com");
    await registerTestSession(harness, ken.apiKey, { id: "ses_ken" });
    await seedContext(harness, ken, "ses_ken", [TARGET_FILE]);
    harness.clock.advanceSeconds(FRESHER_BY_S);
    await registerTestSession(harness, mike.apiKey, { id: "ses_mike" });
    await seedContext(harness, mike, "ses_mike", [TARGET_FILE]);

    // Act + Assert
    expect((await fetchTripwire(harness, robin)).map((row) => row.developerName)).toEqual(["Mike", "Ken"]);
  });

  test("a long-lived session's old touches do not make it a large change", async () => {
    // Arrange: Ken's context touched sixty files ten days ago and the file today.
    const harness = await createTestHarness();
    const robin = await createTestDeveloper(harness, "Robin", "robin@example.com");
    const ken = await createTestDeveloper(harness, "Ken", "ken@example.com");
    await registerTestSession(harness, ken.apiKey, { id: "ses_ken" });
    await seedContext(harness, ken, "ses_ken", otherFiles(LARGE_FILES, "old"));
    harness.clock.advanceSeconds(TEN_DAYS_S);
    await registerTestSession(harness, ken.apiKey, { id: "ses_ken" });
    await seedContext(harness, ken, "ses_ken", [TARGET_FILE]);

    // Act
    const rows = await fetchTripwire(harness, robin);

    // Assert
    expect(rows.map((row) => row.developerName)).toEqual(["Ken"]);
    expect(rows[0]?.largeChangeFiles ?? null).toBeNull();
  });
});
