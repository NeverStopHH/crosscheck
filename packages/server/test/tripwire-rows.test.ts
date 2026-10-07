/**
 * What a tripwire row tells the connector beyond who and where (review of
 * feat/collision-visible): whether the overlapping work context has LANDED,
 * so the person's line can say "changed (merged)" instead of "is working on".
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { workContexts } from "../src/db/schema.ts";
import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  validWorkContextBody,
  VALID_SESSION_BODY,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
const TARGET_FILE = "src/practice/PlayerMappingGrid.tsx";

interface TripwireRow {
  readonly developerName: string;
  readonly workContextId: string;
  readonly landedAt?: string | null;
}

const fetchTripwire = async (harness: TestHarness, developer: TestDeveloper): Promise<readonly TripwireRow[]> => {
  const params = new URLSearchParams({ repo: REPO, value: TARGET_FILE });
  const response = await harness.app.request(`/api/hints/tripwire?${params.toString()}`, jsonRequest("GET", developer.apiKey));
  const body = (await response.json()) as { data: { sessions: readonly TripwireRow[] } };
  return body.data.sessions;
};

/** The harness developer's live context on TARGET_FILE, and a teammate who asks about it. */
const setup = async (): Promise<{ harness: TestHarness; reader: TestDeveloper }> => {
  const { harness, developer } = await createHarnessWithSession();
  await postRecords(harness, developer, {
    records: [
      recordEnvelope("work_context", validWorkContextBody({ title: "Practice mapping grid" })),
      recordEnvelope("target", { workContextId: WORK_CONTEXT_ID, kind: "file", value: TARGET_FILE }),
    ],
  });
  const reader = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", {
    id: "ses_reader",
    branch: "fix/mapping",
  });
  return { harness, reader };
};

describe("every teammate on the file, in a fixed order", () => {
  test("two teammates' live sessions are both answered, the freshest heartbeat first", async () => {
    // Arrange: Nick (the harness developer) registers first; Ken registers
    // ten seconds later, so Ken's heartbeat is the fresher of the two even
    // though his rows were inserted last
    const { harness, reader } = await setup();
    harness.clock.advanceSeconds(10);
    const ken = await addTestDeveloperWithSession(harness, "Ken", "ken@example.com", {
      id: "ses_ken",
      branch: "feat/ken",
    });
    await postRecords(harness, ken, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ id: "wc_ken", sessionId: "ses_ken", title: "Ken's grid" }), {
          sessionId: "ses_ken",
        }),
        recordEnvelope("target", { workContextId: "wc_ken", kind: "file", value: TARGET_FILE }, { sessionId: "ses_ken" }),
      ],
    });

    // Act
    const rows = await fetchTripwire(harness, reader);

    // Assert
    expect(rows.map((row) => row.developerName)).toEqual(["Ken", "Nick"]);
  });
});

describe("a tripwire row says whether its work context landed", () => {
  test("an open context carries landedAt null", async () => {
    // Arrange
    const { harness, reader } = await setup();

    // Act
    const [row] = await fetchTripwire(harness, reader);

    // Assert
    expect(row?.workContextId).toBe(WORK_CONTEXT_ID);
    expect(row?.landedAt).toBeNull();
  });

  test("a landed context carries the instant it landed", async () => {
    // Arrange
    const { harness, reader } = await setup();
    const landed = new Date("2026-10-06T09:00:00.000Z");
    await harness.db.update(workContexts).set({ landedAt: landed }).where(eq(workContexts.id, WORK_CONTEXT_ID));

    // Act
    const [row] = await fetchTripwire(harness, reader);

    // Assert
    expect(row?.landedAt).toBe(landed.toISOString());
  });
});
