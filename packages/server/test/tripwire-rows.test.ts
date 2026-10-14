/**
 * What a tripwire row tells the connector beyond who and where (review of
 * feat/collision-visible): whether the overlapping work context has LANDED,
 * so the person's line can say "changed (merged)" instead of "is working on".
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { GHOST_HOT_TARGET_MAX_CONTEXTS } from "../src/constants.ts";
import { workContexts } from "../src/db/schema.ts";
import { TRIPWIRE_MAX_SESSIONS } from "../src/services/hints.ts";
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

/** Twenty-one teammates seeded one by one: past bun's 5 s default on a loaded machine. */
const TRIPWIRE_BOUND_CASE_TIMEOUT_MS = 30_000;

interface TripwireRow {
  readonly developerName: string;
  readonly workContextId: string;
  readonly branch?: string | null;
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

  test(
    `past the ${String(GHOST_HOT_TARGET_MAX_CONTEXTS)} candidates read before the ranking, the freshest teammates are still the ones named`,
    async () => {
      // Arrange: Nick plus one teammate per candidate slot — one more than
      // the hub reads — each registering a second after the last, so the
      // freshest heartbeat belongs to the row stored LAST
      const { harness, reader } = await setup();
      const names = Array.from({ length: GHOST_HOT_TARGET_MAX_CONTEXTS }, (_, index) => `Mate ${String(index + 1).padStart(2, "0")}`);
      for (const [index, name] of names.entries()) {
        harness.clock.advanceSeconds(1);
        const sessionId = `ses_mate_${String(index)}`;
        const contextId = `wc_mate_${String(index)}`;
        const mate = await addTestDeveloperWithSession(harness, name, `mate${String(index)}@example.com`, {
          id: sessionId,
          branch: `feat/mate-${String(index)}`,
        });
        await postRecords(harness, mate, {
          records: [
            recordEnvelope("work_context", validWorkContextBody({ id: contextId, sessionId, title: `${name}'s grid` }), { sessionId }),
            recordEnvelope("target", { workContextId: contextId, kind: "file", value: TARGET_FILE }, { sessionId }),
          ],
        });
      }

      // Act
      const rows = await fetchTripwire(harness, reader);

      // Assert: the five freshest, freshest first — never the five the scan met first
      expect(rows.map((row) => row.developerName)).toEqual(names.slice(-TRIPWIRE_MAX_SESSIONS).reverse());
    },
    TRIPWIRE_BOUND_CASE_TIMEOUT_MS,
  );
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

/**
 * A TRIPWIRE ROW SAYS WHERE THE WORK ON THE FILE LIVES (release gate, 1b):
 * the topic's own branch, its session's only when the context has none. A
 * long detached session's branch is the checkout it started in, so the
 * person read "Nick is working on mappingSchema.ts" with no topic at all.
 */
describe("a tripwire row names the branch its work context is on", () => {
  test("a topic's row names the topic's branch, and a plain context its session's", async () => {
    // Arrange: Ken's session sits on feat/ken; his context on this file is a topic on its own branch
    const { harness, reader } = await setup();
    const ken = await addTestDeveloperWithSession(harness, "Ken", "ken@example.com", { id: "ses_ken", branch: "feat/ken" });
    await postRecords(harness, ken, {
      records: [
        recordEnvelope(
          "work_context",
          validWorkContextBody({ id: "wc_ken_topic", sessionId: "ses_ken", title: "Practices", branch: "feat/numlabs-practices" }),
          { sessionId: "ses_ken" },
        ),
        recordEnvelope("target", { workContextId: "wc_ken_topic", kind: "file", value: TARGET_FILE }, { sessionId: "ses_ken" }),
      ],
    });

    // Act
    const rows = await fetchTripwire(harness, reader);

    // Assert
    const branchOf = (id: string): string | null | undefined => rows.find((row) => row.workContextId === id)?.branch;
    expect(branchOf("wc_ken_topic")).toBe("feat/numlabs-practices");
    expect(branchOf(WORK_CONTEXT_ID)).toBe(VALID_SESSION_BODY.branch);
  });
});
