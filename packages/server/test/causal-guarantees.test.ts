/**
 * DECLARED CAUSAL GUARANTEES ON THE HUB (1.0 spec 01a §3.6) — the register
 * body's `guarantees` block, its table, and "rows outrank declarations".
 *
 * Every case is a direction in which a weaker rule would let a surface say
 * more than the rows can: a session that declared nothing read as anything
 * but `undeclared`; a value this hub cannot read stored as the state it
 * arrived with; a re-register that strengthens; a contradicting row that is
 * counted somewhere and capped nowhere.
 */
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { GUARANTEE_KINDS } from "@crosscheck/schema";

import { SESSION_REAP_STALE_HOURS } from "../src/constants.ts";
import { sessionCausalGuarantees } from "../src/db/schema.ts";
import { reapStaleSessions } from "../src/services/sessions.ts";
import {
  countContradictedDeclarations,
  readEffectiveGuarantees,
} from "../src/services/causal-guarantees.ts";
import type { EffectiveGuarantee } from "../src/services/causal-guarantees.ts";
import {
  VALID_SESSION_BODY,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validWorkContextBody,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const SESSION = VALID_SESSION_BODY.id;
const EPOCH = "6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const SECONDS_PER_HOUR = 3600;
/** One hour past SESSION_REAP_STALE_HOURS, so the reaper takes the session. */
const REAP_AFTER_SECONDS = (SESSION_REAP_STALE_HOURS + 1) * SECONDS_PER_HOUR;

const BRACKETED_EDIT = {
  kind: "file.modified",
  guarantee: "guaranteed",
  reason: "bracketed_by_pre_tool",
} as const;
const LIFECYCLE_END = { kind: "session.ended", guarantee: "guaranteed", reason: "lifecycle" } as const;

const seed = async (
  guarantees?: unknown,
): Promise<{ harness: TestHarness; developer: TestDeveloper }> => {
  const harness = await createTestHarness();
  const developer = await createTestDeveloper(harness, "Nick", "nick@example.com");
  const origin = { seq: { epoch: EPOCH, n: 0 } };
  const response = await registerTestSession(
    harness,
    developer.apiKey,
    guarantees === undefined ? origin : { ...origin, guarantees },
  );
  expect(response.status).toBeLessThan(300);
  return { harness, developer };
};

const effective = async (
  harness: TestHarness,
): Promise<ReadonlyMap<string, EffectiveGuarantee>> => {
  const bySession = await readEffectiveGuarantees(harness.db, [SESSION]);
  const found = bySession.get(SESSION);
  if (found === undefined) {
    throw new Error("no reading for the session");
  }
  return found;
};

const storedRows = async (harness: TestHarness): Promise<number> =>
  (
    await harness.db
      .select()
      .from(sessionCausalGuarantees)
      .where(eq(sessionCausalGuarantees.sessionId, SESSION))
  ).length;

const postEdit = async (
  harness: TestHarness,
  developer: TestDeveloper,
  n: number,
  after?: number,
): Promise<void> => {
  const target = recordEnvelope("target", {
    workContextId: WORK_CONTEXT_ID,
    kind: "file",
    value: `src/file-${String(n)}.ts`,
  });
  await postRecords(harness, developer, {
    records: [
      recordEnvelope("work_context", validWorkContextBody()),
      { ...target, seq: after === undefined ? { epoch: EPOCH, n } : { epoch: EPOCH, n, after } },
    ],
  });
};

describe("the declaration a session registers with", () => {
  test("a session that sends none stores nothing and reads undeclared for every kind", async () => {
    // Arrange
    const { harness } = await seed();
    // Act
    const reading = await effective(harness);
    // Assert
    expect(await storedRows(harness)).toBe(0);
    for (const kind of GUARANTEE_KINDS) {
      expect(reading.get(kind)).toEqual({ state: "undeclared", reason: "provider_undeclared" });
    }
  });

  test("a declaration is stored as its triples and read back per kind", async () => {
    // Arrange
    const { harness } = await seed([BRACKETED_EDIT, LIFECYCLE_END]);
    // Act
    const reading = await effective(harness);
    // Assert
    expect(await storedRows(harness)).toBe(2);
    expect(reading.get("file.modified")).toEqual({ state: "guaranteed", reason: "bracketed_by_pre_tool" });
    expect(reading.get("claim.created")).toEqual({ state: "undeclared", reason: "provider_undeclared" });
  });

  test("an unknown reason is read as undeclared, never as the state it arrived with", async () => {
    // Arrange
    const { harness } = await seed([
      { kind: "file.modified", guarantee: "guaranteed", reason: "vendor_magic" },
    ]);
    // Act
    const reading = await effective(harness);
    // Assert
    expect(reading.get("file.modified")).toEqual({ state: "undeclared", reason: "provider_undeclared" });
  });

  test("an unreadable block is not refused: the session registers and stores nothing", async () => {
    // Arrange / Act
    const { harness } = await seed("every kind is guaranteed");
    // Assert
    expect(await storedRows(harness)).toBe(0);
  });

  test("a re-register can weaken a declaration and never strengthen it", async () => {
    // Arrange
    const { harness, developer } = await seed([
      { kind: "file.modified", guarantee: "partial", reason: "unbracketed_lane" },
      LIFECYCLE_END,
    ]);
    // Act: the same session re-registers claiming more for one kind and less for the other.
    await registerTestSession(harness, developer.apiKey, {
      guarantees: [
        BRACKETED_EDIT,
        { kind: "session.ended", guarantee: "unavailable", reason: "not_built" },
      ],
    });
    const reading = await effective(harness);
    // Assert
    expect(reading.get("file.modified")).toEqual({ state: "partial", reason: "unbracketed_lane" });
    expect(reading.get("session.ended")).toEqual({ state: "unavailable", reason: "not_built" });
  });

  test("a re-register that sends no block leaves every kind undeclared", async () => {
    // Arrange
    const { harness, developer } = await seed([BRACKETED_EDIT]);
    // Act: an older connector on the same session.
    await registerTestSession(harness, developer.apiKey, {});
    const reading = await effective(harness);
    // Assert
    expect(reading.get("file.modified")).toEqual({ state: "undeclared", reason: "provider_undeclared" });
    expect(await storedRows(harness)).toBe(0);
  });
});

describe("rows outrank declarations", () => {
  test("an unbracketed file.modified from a session that declared it bracketed caps the kind", async () => {
    // Arrange
    const { harness, developer } = await seed([BRACKETED_EDIT]);
    // Act
    await postEdit(harness, developer, 1);
    const reading = await effective(harness);
    // Assert
    expect(reading.get("file.modified")).toEqual({ state: "partial", reason: "declaration_contradicted" });
    expect(await countContradictedDeclarations(harness.db, VALID_SESSION_BODY.repo)).toBe(1);
  });

  test("a bracketed file.modified leaves a bracketed declaration standing", async () => {
    // Arrange
    const { harness, developer } = await seed([BRACKETED_EDIT]);
    // Act
    await postEdit(harness, developer, 2, 1);
    const reading = await effective(harness);
    // Assert
    expect(reading.get("file.modified")).toEqual({ state: "guaranteed", reason: "bracketed_by_pre_tool" });
    expect(await countContradictedDeclarations(harness.db, VALID_SESSION_BODY.repo)).toBe(0);
  });

  test("a declaration that was already partial keeps its own reason", async () => {
    // Arrange
    const { harness, developer } = await seed([
      { kind: "file.modified", guarantee: "partial", reason: "unbracketed_lane" },
    ]);
    // Act
    await postEdit(harness, developer, 1);
    const reading = await effective(harness);
    // Assert
    expect(reading.get("file.modified")).toEqual({ state: "partial", reason: "unbracketed_lane" });
  });

  test("an end whose position was withheld caps a lifecycle declaration for session.ended", async () => {
    // Arrange
    const { harness, developer } = await seed([LIFECYCLE_END]);
    // Act
    await harness.app.request(
      `/api/sessions/${SESSION}/end`,
      jsonRequest("POST", developer.apiKey, { status: "done", seq: { reason: "allocation_failed" } }),
    );
    const reading = await effective(harness);
    // Assert
    expect(reading.get("session.ended")).toEqual({ state: "partial", reason: "declaration_contradicted" });
  });

  test("a derived intent version caps a bracketed intent.declared, though it lives outside session_events", async () => {
    // Arrange: a connector that over-declares the intent kinds.
    const { harness, developer } = await seed([
      { kind: "intent.declared", guarantee: "guaranteed", reason: "bracketed_by_pre_tool" },
    ]);
    // Act: the ledger's first version, written by a worker — stored observed.
    await postRecords(harness, developer, {
      ...recordEnvelope(
        "work_context",
        validWorkContextBody({
          intent: {
            summary: "A model's guess at the first prompt.",
            provenance: "derived",
            confidence: 0.4,
            capturedAt: "2026-07-24T09:00:00.000Z",
          },
        }),
      ),
      seq: { epoch: EPOCH, n: 1 },
    });
    const reading = await effective(harness);
    // Assert
    expect(reading.get("intent.declared")).toEqual({ state: "partial", reason: "declaration_contradicted" });
  });

  test("a reap is the hub's inference, and overrules no lifecycle declaration", async () => {
    // Arrange
    const { harness } = await seed([LIFECYCLE_END]);
    harness.clock.advanceSeconds(REAP_AFTER_SECONDS);
    // Act
    const reaped = await reapStaleSessions({ db: harness.db, now: harness.clock.now });
    const reading = await effective(harness);
    // Assert
    expect(reaped.ended.length).toBe(1);
    expect(reading.get("session.ended")).toEqual({ state: "guaranteed", reason: "lifecycle" });
  });

  test("the cap outlives the row that caused it", async () => {
    // Arrange
    const { harness, developer } = await seed([BRACKETED_EDIT]);
    await postEdit(harness, developer, 1);
    // Act: the skeleton rows go, as a sweep would take them.
    await harness.db.execute(sql`DELETE FROM session_events WHERE session_id = ${SESSION}`);
    const reading = await effective(harness);
    // Assert
    expect(reading.get("file.modified")).toEqual({ state: "partial", reason: "declaration_contradicted" });
  });
});
