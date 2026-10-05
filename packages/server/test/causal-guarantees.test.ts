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
import { BRACKETABLE_KINDS, GUARANTEE_KINDS } from "@crosscheck/schema";
import type { GuaranteeKind } from "@crosscheck/schema";

import { SESSION_REAP_STALE_HOURS } from "../src/constants.ts";
import { sessionCausalGuarantees } from "../src/db/schema.ts";
import { TARGET_EVENT_KINDS } from "../src/services/record-handlers.ts";
import { reapStaleSessions } from "../src/services/sessions.ts";
import {
  countContradictedDeclarations,
  readEffectiveGuarantees,
  weakenDeclaredGuarantees,
} from "../src/services/causal-guarantees.ts";
import type { EffectiveGuarantee } from "../src/services/causal-guarantees.ts";
import {
  TEST_START_ISO,
  VALID_SESSION_BODY,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validClaimBody,
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
const CAPPED = { state: "partial", reason: "declaration_contradicted" } as const;

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

/**
 * A `guaranteed` row for a kind the wire fold no longer admits (review H2),
 * written straight into the table: the cap is the second guard, and it has to
 * hold for a row that reached the table some other way.
 */
const holdGuaranteed = async (harness: TestHarness, kind: GuaranteeKind): Promise<void> => {
  await harness.db
    .insert(sessionCausalGuarantees)
    .values({ sessionId: SESSION, kind, guarantee: "guaranteed", reason: "bracketed_by_pre_tool" });
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
  path: string = `src/file-${String(n)}.ts`,
): Promise<void> => {
  const target = recordEnvelope("target", {
    workContextId: WORK_CONTEXT_ID,
    kind: "file",
    value: path,
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

  test("a guarantee the kind cannot carry is stored as nothing, and no read folds it to guaranteed", async () => {
    // Arrange: any client can claim a bracket for a commit and a lifecycle for an edit.
    const { harness, developer } = await seed([
      { kind: "commit.observed", guarantee: "guaranteed", reason: "bracketed_by_pre_tool" },
      { kind: "file.modified", guarantee: "guaranteed", reason: "lifecycle" },
      { kind: "claim.created", guarantee: "guaranteed", reason: "lifecycle" },
    ]);
    // Act
    const reading = await effective(harness);
    const response = await harness.app.request(
      `/api/absences?repo=${encodeURIComponent(VALID_SESSION_BODY.repo)}`,
      jsonRequest("GET", developer.apiKey),
    );
    const body = (await response.json()) as { data: { coverage: { order: unknown } } };
    // Assert
    expect(await storedRows(harness)).toBe(0);
    for (const kind of ["commit.observed", "file.modified", "claim.created"] as const) {
      expect(reading.get(kind)).toEqual({ state: "undeclared", reason: "provider_undeclared" });
    }
    expect(body.data.coverage.order).toEqual({ state: "undeclared", reason: "provider_undeclared" });
  });

  test("the schema's bracketable kinds are the kinds a target record projects to", () => {
    expect([...BRACKETABLE_KINDS].sort()).toEqual(Object.values(TARGET_EVENT_KINDS).sort());
  });

  test("a re-register with a weaker reason in the same state lowers the reason (review L1)", async () => {
    // Arrange
    const { harness, developer } = await seed([
      { kind: "claim.created", guarantee: "partial", reason: "ambiguous_session_possible" },
    ]);
    // Act
    await registerTestSession(harness, developer.apiKey, {
      guarantees: [{ kind: "claim.created", guarantee: "partial", reason: "derived_after_the_fact" }],
    });
    // Assert
    expect((await effective(harness)).get("claim.created")).toEqual({
      state: "partial",
      reason: "derived_after_the_fact",
    });
  });

  test("a re-register never lifts a cap to a declared partial reason (review L1)", async () => {
    // Arrange: a bracketed declaration, capped by an unbracketed edit.
    const { harness, developer } = await seed([BRACKETED_EDIT]);
    await postEdit(harness, developer, 1);
    // Act: the same session re-registers with an honest partial reason.
    await registerTestSession(harness, developer.apiKey, {
      guarantees: [{ kind: "file.modified", guarantee: "partial", reason: "unbracketed_lane" }],
    });
    // Assert: the cap is the weakest partial, and stays.
    expect((await effective(harness)).get("file.modified")).toEqual(CAPPED);
  });

  test("two concurrent re-registers leave the weaker of the two, never the later write (review L2)", async () => {
    // Arrange
    const { harness } = await seed([BRACKETED_EDIT]);
    const unavailable = [{ kind: "file.modified", guarantee: "unavailable", reason: "no_emitter" }];
    const partial = [{ kind: "file.modified", guarantee: "partial", reason: "unbracketed_lane" }];
    // Act: both read guaranteed before either writes, when a read decides the write.
    await Promise.all([
      weakenDeclaredGuarantees(harness.db, SESSION, unavailable),
      weakenDeclaredGuarantees(harness.db, SESSION, partial),
    ]);
    // Assert
    expect((await effective(harness)).get("file.modified")).toEqual({
      state: "unavailable",
      reason: "no_emitter",
    });
  });

  test("a stored row is read through its reason, never through its guarantee column (review L4)", async () => {
    // Arrange: one row whose two columns disagree, one whose reason this hub cannot name.
    const { harness } = await seed();
    await harness.db.execute(
      sql`INSERT INTO session_causal_guarantees (session_id, kind, guarantee, reason) VALUES
            (${SESSION}, 'file.modified', 'guaranteed', 'unbracketed_lane'),
            (${SESSION}, 'tool.failed', 'guaranteed', 'vendor_magic')`,
    );
    // Act
    const reading = await effective(harness);
    // Assert
    expect(reading.get("file.modified")).toEqual({ state: "partial", reason: "unbracketed_lane" });
    expect(reading.get("tool.failed")).toEqual({ state: "undeclared", reason: "provider_undeclared" });
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

describe("what lifecycle itself promises (review M1)", () => {
  const OTHER_EPOCH = "11111111-2222-4333-8444-555555555555";

  const endAt = async (
    harness: TestHarness,
    developer: TestDeveloper,
    seq: { readonly epoch: string; readonly n: number },
  ): Promise<void> => {
    const response = await harness.app.request(
      `/api/sessions/${SESSION}/end`,
      jsonRequest("POST", developer.apiKey, { status: "done", seq }),
    );
    expect(response.status).toBeLessThan(300);
  };

  test("an end positioned below a row already stored caps session.ended", async () => {
    // Arrange: something in the session allocated n = 9.
    const { harness, developer } = await seed([LIFECYCLE_END]);
    await postEdit(harness, developer, 9, 8);
    // Act
    await endAt(harness, developer, { epoch: EPOCH, n: 5 });
    // Assert
    expect((await effective(harness)).get("session.ended")).toEqual(CAPPED);
  });

  test("a row positioned above the end, arriving after it, caps session.ended", async () => {
    // Arrange: the session's work context exists, and the session ends at n = 5.
    const { harness, developer } = await seed([LIFECYCLE_END]);
    await postRecords(harness, developer, recordEnvelope("work_context", validWorkContextBody()));
    await endAt(harness, developer, { epoch: EPOCH, n: 5 });
    await registerTestSession(harness, developer.apiKey, { id: "ses_successor" });
    const late = recordEnvelope(
      "target",
      { workContextId: WORK_CONTEXT_ID, kind: "file", value: "src/late.ts" },
      { sessionId: "ses_successor" },
    );
    // Act: a live successor flushes a record the ended session stamped at n = 9
    // — a producer may not write into its own ended session, a successor may.
    await postRecords(harness, developer, { ...late, seq: { epoch: EPOCH, n: 9, after: 8 } });
    // Assert
    expect((await effective(harness)).get("session.ended")).toEqual(CAPPED);
  });

  const postIntentAt = (
    harness: TestHarness,
    developer: TestDeveloper,
    n: number,
    producer: string = SESSION,
  ): Promise<unknown> =>
    postRecords(harness, developer, {
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
        { sessionId: producer },
      ),
      seq: { epoch: EPOCH, n },
    });

  test("an intent version stored past the end caps session.ended when the end arrives", async () => {
    // Arrange: the ledger holds a version of this session's at n = 9.
    const { harness, developer } = await seed([LIFECYCLE_END]);
    await postIntentAt(harness, developer, 9);
    // Act
    await endAt(harness, developer, { epoch: EPOCH, n: 5 });
    // Assert
    expect((await effective(harness)).get("session.ended")).toEqual(CAPPED);
  });

  test("an intent version arriving after the end, positioned past it, caps session.ended", async () => {
    // Arrange
    const { harness, developer } = await seed([LIFECYCLE_END]);
    await endAt(harness, developer, { epoch: EPOCH, n: 5 });
    await registerTestSession(harness, developer.apiKey, { id: "ses_successor" });
    // Act: a successor flushes the ended session's version, stamped n = 9.
    await postIntentAt(harness, developer, 9, "ses_successor");
    // Assert
    expect((await effective(harness)).get("session.ended")).toEqual(CAPPED);
  });

  test("an end in another epoch than the session's start caps session.ended", async () => {
    // Arrange
    const { harness, developer } = await seed([LIFECYCLE_END]);
    // Act
    await endAt(harness, developer, { epoch: OTHER_EPOCH, n: 1 });
    // Assert
    expect((await effective(harness)).get("session.ended")).toEqual(CAPPED);
  });

  test("an end above every row in the session's one epoch keeps its lifecycle declaration", async () => {
    // Arrange
    const { harness, developer } = await seed([LIFECYCLE_END]);
    await postEdit(harness, developer, 3, 2);
    // Act
    await endAt(harness, developer, { epoch: EPOCH, n: 4 });
    // Assert
    expect((await effective(harness)).get("session.ended")).toEqual({ state: "guaranteed", reason: "lifecycle" });
  });

  test("a session.started positioned anywhere but n = 0 caps session.started", async () => {
    // Arrange
    const harness = await createTestHarness();
    const developer = await createTestDeveloper(harness, "Nick", "nick@example.com");
    // Act
    await registerTestSession(harness, developer.apiKey, {
      seq: { epoch: EPOCH, n: 7 },
      guarantees: [{ kind: "session.started", guarantee: "guaranteed", reason: "lifecycle" }],
    });
    // Assert
    expect((await effective(harness)).get("session.started")).toEqual(CAPPED);
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
    expect(await countContradictedDeclarations(harness.db, developer.developerId)).toBe(1);
    expect(await countContradictedDeclarations(harness.db, "dev_somebody_else")).toBe(0);
  });

  test("a bracketed file.modified leaves a bracketed declaration standing", async () => {
    // Arrange
    const { harness, developer } = await seed([BRACKETED_EDIT]);
    // Act
    await postEdit(harness, developer, 2, 1);
    const reading = await effective(harness);
    // Assert
    expect(reading.get("file.modified")).toEqual({ state: "guaranteed", reason: "bracketed_by_pre_tool" });
    expect(await countContradictedDeclarations(harness.db, developer.developerId)).toBe(0);
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
    // Arrange: an over-declared intent kind, stored past the wire fold.
    const { harness, developer } = await seed();
    await holdGuaranteed(harness, "intent.declared");
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

  test("a reap caps a lifecycle end: the session's end was never observed", async () => {
    // Arrange
    const { harness } = await seed([LIFECYCLE_END]);
    harness.clock.advanceSeconds(REAP_AFTER_SECONDS);
    // Act
    const reaped = await reapStaleSessions({ db: harness.db, now: harness.clock.now });
    const reading = await effective(harness);
    // Assert
    expect(reaped.ended.length).toBe(1);
    expect(reading.get("session.ended")).toEqual(CAPPED);
  });

  test("an amending intent version caps intent.amended, not only intent.declared (review M2)", async () => {
    // Arrange: two derived versions of one intent — the second amends the first.
    const { harness, developer } = await seed();
    await holdGuaranteed(harness, "intent.amended");
    const derivedIntent = (summary: string) =>
      validWorkContextBody({
        intent: { summary, provenance: "derived", confidence: 0.4, capturedAt: "2026-07-24T09:00:00.000Z" },
      });
    await postRecords(harness, developer, {
      ...recordEnvelope("work_context", derivedIntent("A model's first guess.")),
      seq: { epoch: EPOCH, n: 1 },
    });
    // Act
    await postRecords(harness, developer, {
      ...recordEnvelope("work_context", derivedIntent("A model's second guess, narrower.")),
      seq: { epoch: EPOCH, n: 2 },
    });
    // Assert
    expect((await effective(harness)).get("intent.amended")).toEqual(CAPPED);
  });

  test("a second event claiming a taken position caps its kind (review M2)", async () => {
    // Arrange: one bracketed edit holds n = 2.
    const { harness, developer } = await seed([BRACKETED_EDIT]);
    await postEdit(harness, developer, 2, 1);
    // Act: a different edit claims the same slot, and is stored epoch_conflict.
    await postEdit(harness, developer, 2, 1, "src/other.ts");
    // Assert
    expect((await effective(harness)).get("file.modified")).toEqual(CAPPED);
  });

  test("a derived claim caps a claim.created guarantee stored past the wire fold (review M2)", async () => {
    // Arrange
    const { harness, developer } = await seed();
    await holdGuaranteed(harness, "claim.created");
    // Act: a summarizer's claim, stored observed.
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        {
          ...recordEnvelope("claim", validClaimBody({ provenance: "derived", confidence: 0.4 })),
          seq: { epoch: EPOCH, n: 3 },
        },
      ],
    });
    // Assert
    expect((await effective(harness)).get("claim.created")).toEqual(CAPPED);
  });

  test("a commit aggregate caps a commit.observed guarantee stored past the wire fold (review M2)", async () => {
    // Arrange
    const { harness, developer } = await seed();
    await holdGuaranteed(harness, "commit.observed");
    // Act: SessionStart's aggregate, positioned, which the hub stores observed.
    await postRecords(harness, developer, {
      ...recordEnvelope("commit_evidence", {
        repo: VALID_SESSION_BODY.repo,
        collectedAt: TEST_START_ISO,
        windowDays: 14,
        authors: [
          { name: "Robin", email: "robin@example.com", latestCommitAt: TEST_START_ISO, commitCount: 5 },
        ],
      }),
      seq: { epoch: EPOCH, n: 4 },
    });
    // Assert
    expect((await effective(harness)).get("commit.observed")).toEqual(CAPPED);
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
