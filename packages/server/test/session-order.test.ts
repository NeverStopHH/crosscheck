/**
 * AT-4 — "DECLARED-BEFORE IS DISTINGUISHABLE FROM DECLARED-AFTER", executable.
 *
 * *Fails if the answer depends on wall-clock timestamps from two processes
 * rather than a monotonic per-session sequence.*
 *
 * WHAT STANDS IN FOR THE AMENDMENT, and why it is not a cheat. `set_intent`
 * posts a work_context UPDATE that REPLACES the intent in place, so an
 * amendment has no row of its own yet — the versioned intent ledger is the
 * next spec, and until it lands the two intent kinds are deliberately not
 * projected (a projection off the mutable row would give the declaration and
 * every amendment ONE referent). The shape AT-4 asks about is "was the
 * EXPLANATION written before or after the change it excuses", and a
 * `claim.created` root cause is an explanation with a position, from the same
 * session, through the same allocator. The ledger swaps its row in at step 6
 * of `explanationTimingFor` and nothing here changes.
 *
 * SEQ-2 IS THE ONE THAT MATTERS. Same events, same positions, every clock the
 * hub has INVERTED — the explanation recorded an hour of hub time BEFORE the
 * edit it followed, and its envelope `ts` inverted too. If any code path in
 * the comparison reached for a clock, the answer flips. It must not.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { sessionEvents } from "../src/db/schema.ts";
import {
  compareEvents,
  isOrderable,
  causalOrderOf,
  readSessionCausalOrder,
} from "../src/services/session-order.ts";
import type { OrderedEvent } from "../src/services/session-order.ts";
import {
  WORK_CONTEXT_ID,
  createTestDeveloper,
  createTestHarness,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validClaimBody,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const OTHER_EPOCH = "11111111-2222-4333-8444-555555555555";
const SESSION = "cc_at4";
const EARLY_EDIT = "src/auth/refresh.ts";
const LATE_EDIT = "src/auth/token.ts";
const EXPLANATION = "clm_explanation";
const HOUR_SECONDS = 3600;

interface Fixture {
  readonly harness: TestHarness;
  readonly dev: TestDeveloper;
}

const started = async (email: string): Promise<Fixture> => {
  const harness = await createTestHarness();
  const dev = await createTestDeveloper(harness, "Nick", email);
  await registerTestSession(harness, dev.apiKey, { id: SESSION });
  await postRecords(harness, dev, {
    records: [
      recordEnvelope(
        "work_context",
        validWorkContextBody({ sessionId: SESSION }),
        { sessionId: SESSION },
      ),
    ],
  });
  return { harness, dev };
};

const editRecord = (value: string, n: number, ts: string) => ({
  ...recordEnvelope(
    "target",
    {
      workContextId: WORK_CONTEXT_ID,
      kind: "file",
      value,
      source: "tool_edit",
    },
    { sessionId: SESSION, ts },
  ),
  seq: { epoch: EPOCH, n },
});

const explanationRecord = (n: number, ts: string) => ({
  ...recordEnvelope(
    "claim",
    validClaimBody({
      id: EXPLANATION,
      authorSessionId: SESSION,
      kind: "root_cause",
      body: "the refresh path drops the retry header, so token.ts had to change too",
      provenance: "declared",
      captureMode: "agent",
    }),
    { sessionId: SESSION, ts },
  ),
  seq: { epoch: EPOCH, n },
});

const eventsBy = async (
  harness: TestHarness,
): Promise<Map<number, OrderedEvent>> => {
  const rows = await harness.db
    .select()
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, SESSION));
  return new Map(
    rows
      .filter((row) => row.seqN !== null)
      .map((row) => [
        row.seqN as number,
        {
          sessionId: row.sessionId,
          seqEpoch: row.seqEpoch,
          seqN: row.seqN,
          seqKind: row.seqKind,
          observedAt: row.observedAt,
        },
      ]),
  );
};

describe("SEQ-1 — the positive case", () => {
  test("the explanation is post_hoc for the earlier edit and predeclared for the later one", async () => {
    // Arrange: edit at 1, the explanation at 2, a second edit at 3 — with the
    // clock running FORWARD alongside the positions, so this test is the happy
    // path a wall-clock implementation also passes. SEQ-2 below is the one it
    // cannot pass, which is exactly why both exist.
    const { harness, dev } = await started("at4@example.com");
    await postRecords(harness, dev, {
      records: [editRecord(EARLY_EDIT, 1, "2026-07-24T10:00:00.000Z")],
    });
    harness.clock.advanceSeconds(HOUR_SECONDS);
    await postRecords(harness, dev, {
      records: [explanationRecord(2, "2026-07-24T10:05:00.000Z")],
    });
    harness.clock.advanceSeconds(HOUR_SECONDS);
    await postRecords(harness, dev, {
      records: [editRecord(LATE_EDIT, 3, "2026-07-24T10:10:00.000Z")],
    });

    // Act
    const order = await readSessionCausalOrder(harness.db, SESSION);
    const events = await eventsBy(harness);
    const early = events.get(1);
    const explanation = events.get(2);
    const late = events.get(3);

    // Assert
    expect(order.state).toBe("usable");
    expect(order.reason).toBe("sequenced");
    // The explanation came AFTER the edit it excuses: post_hoc.
    expect(compareEvents(order, explanation!, early!)).toBe(1);
    // ...and BEFORE the later one: predeclared.
    expect(compareEvents(order, explanation!, late!)).toBe(-1);
  });
});

describe("SEQ-2 — the 'fails if', executable", () => {
  test("every clock inverted, positions untouched, the answer is unchanged", async () => {
    // Arrange: the SAME three events, delivered so the HUB clock runs
    // backwards across them and every envelope ts is inverted with it. The
    // explanation is stamped an hour before the edit it actually followed.
    const { harness, dev } = await started("skew@example.com");
    harness.clock.advanceSeconds(2 * HOUR_SECONDS);
    await postRecords(harness, dev, {
      records: [explanationRecord(2, "2026-07-24T09:00:00.000Z")],
    });
    harness.clock.advanceSeconds(-HOUR_SECONDS);
    await postRecords(harness, dev, {
      records: [editRecord(EARLY_EDIT, 1, "2026-07-24T11:00:00.000Z")],
    });
    harness.clock.advanceSeconds(-HOUR_SECONDS);
    await postRecords(harness, dev, {
      records: [editRecord(LATE_EDIT, 3, "2026-07-24T12:00:00.000Z")],
    });

    // Act
    const order = await readSessionCausalOrder(harness.db, SESSION);
    const events = await eventsBy(harness);
    const early = events.get(1);
    const explanation = events.get(2);
    const late = events.get(3);

    // Assert: the clocks really are inverted — this is what makes the test a
    // test rather than a restatement of SEQ-1.
    expect(explanation!.observedAt.getTime()).toBeGreaterThan(
      early!.observedAt.getTime(),
    );
    expect(early!.observedAt.getTime()).toBeGreaterThan(
      late!.observedAt.getTime(),
    );
    // ...and the answer is SEQ-1's, to the letter.
    expect(compareEvents(order, explanation!, early!)).toBe(1);
    expect(compareEvents(order, explanation!, late!)).toBe(-1);
  });

  test("equal clocks answer just as well — two events inside one millisecond", async () => {
    // Arrange: the fake clock does not move at all, so both events carry the
    // identical hub timestamp. A tie-break on a clock has nothing to work
    // with here; a counter does.
    const { harness, dev } = await started("tie@example.com");
    await postRecords(harness, dev, {
      records: [
        editRecord(EARLY_EDIT, 1, "2026-07-24T10:00:00.000Z"),
        explanationRecord(2, "2026-07-24T10:00:00.000Z"),
      ],
    });

    // Act
    const order = await readSessionCausalOrder(harness.db, SESSION);
    const events = await eventsBy(harness);

    // Assert
    expect(events.get(1)!.observedAt.getTime()).toBe(
      events.get(2)!.observedAt.getTime(),
    );
    expect(compareEvents(order, events.get(2)!, events.get(1)!)).toBe(1);
  });
});

describe("SEQ-5 — an epoch split refuses, and never lies", () => {
  test("two epochs in one session make every comparison not comparable", async () => {
    // Arrange: a compact whose carry lost the counter, a second home sharing
    // one host session id, a busy lock on the re-fire — three measured ways to
    // get here, all of them ending in two counters under one session.
    const { harness, dev } = await started("split@example.com");
    await postRecords(harness, dev, {
      records: [editRecord(EARLY_EDIT, 1, "2026-07-24T10:00:00.000Z")],
    });
    await postRecords(harness, dev, {
      records: [
        {
          ...editRecord(LATE_EDIT, 1, "2026-07-24T10:05:00.000Z"),
          seq: { epoch: OTHER_EPOCH, n: 1 },
        },
      ],
    });

    // Act
    const order = await readSessionCausalOrder(harness.db, SESSION);
    const rows = await harness.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, SESSION));
    const [a, b] = rows.map((row) => ({
      sessionId: row.sessionId,
      seqEpoch: row.seqEpoch,
      seqN: row.seqN,
      seqKind: row.seqKind,
      observedAt: row.observedAt,
    }));

    // Assert
    expect(order.state).toBe("broken");
    expect(order.reason).toBe("epoch_split");
    expect(order.epochs).toBe(2);
    expect(isOrderable(order, a!, b!)).toBe(false);
    expect(compareEvents(order, a!, b!)).toBeNull();
  });

  test("a conflicted position breaks the session even though its epoch is gone", async () => {
    // Arrange: the conflicted row's position was nulled when it was stored, so
    // it adds nothing to the epoch count — the reason on the row is the only
    // thing left that knows.
    const order = causalOrderOf(SESSION, [
      { seqEpoch: EPOCH, seqReason: "sequenced" },
      { seqEpoch: null, seqReason: "epoch_conflict" },
    ]);

    // Assert
    expect(order.state).toBe("broken");
    expect(order.reason).toBe("epoch_conflict");
  });
});

describe("SEQ-8 — a pre-seq connector is reported, never silenced", () => {
  test("a session with no positions is unsequenced and says which absence it is", async () => {
    // Arrange
    const { harness, dev } = await started("preseq@example.com");
    await postRecords(harness, dev, {
      records: [
        recordEnvelope(
          "target",
          {
            workContextId: WORK_CONTEXT_ID,
            kind: "file",
            value: EARLY_EDIT,
            source: "tool_edit",
          },
          { sessionId: SESSION },
        ),
      ],
    });

    // Act
    const order = await readSessionCausalOrder(harness.db, SESSION);

    // Assert: accepted, projected, and the reason is on the answer — never a
    // silent null, and never a rejection.
    expect(order.state).toBe("unsequenced");
    expect(order.reason).toBe("pre_seq_connector");
    expect(order.epochs).toBe(0);
  });

  test("a refused allocation outranks a pre-seq absence in the reported reason", () => {
    // Arrange: `allocation_failed` is the one a reader can act on — a busy
    // lock, a deleted state file, an ambiguous MCP session.
    const order = causalOrderOf(SESSION, [
      { seqEpoch: null, seqReason: "pre_seq_connector" },
      { seqEpoch: null, seqReason: "allocation_failed" },
    ]);

    // Assert
    expect(order.state).toBe("unsequenced");
    expect(order.reason).toBe("allocation_failed");
  });

  test("an observed position refuses a happens-before question", () => {
    // Arrange: SEQ-7's consumer half. The git lane's sighting and a detached
    // worker's claim are upper bounds, and a question that would answer from
    // one is refused rather than answered wrongly.
    const order = causalOrderOf(SESSION, [
      { seqEpoch: EPOCH, seqReason: "sequenced" },
    ]);
    const base = {
      sessionId: SESSION,
      seqEpoch: EPOCH,
      observedAt: new Date("2026-07-24T10:00:00.000Z"),
    };

    // Assert
    expect(
      compareEvents(
        order,
        { ...base, seqN: 1, seqKind: "emitted" },
        { ...base, seqN: 2, seqKind: "observed" },
      ),
    ).toBeNull();
    expect(
      compareEvents(
        order,
        { ...base, seqN: 1, seqKind: "emitted" },
        {
          ...base,
          seqN: 2,
          seqKind: "emitted",
          observedAt: new Date("2026-07-24T11:00:00.000Z"),
        },
      ),
    ).toBe(-1);
  });

  test("a position from another epoch is refused even when the session looks usable", () => {
    // Arrange: THE CASE THE SESSION-LEVEL STATE CANNOT SEE. The intent ledger
    // keeps its versions in its own table, so a row it hands this function was
    // never counted among `session_events`' epochs — the order can read
    // `usable` from one epoch while the row carries another. Without the
    // per-pair epoch term, a bare integer from a DIFFERENT counter is compared
    // against this session's and answers confidently.
    const order = causalOrderOf(SESSION, [
      { seqEpoch: EPOCH, seqReason: "sequenced" },
    ]);
    const edit = {
      sessionId: SESSION,
      seqEpoch: EPOCH,
      seqN: 5,
      seqKind: "emitted" as const,
      observedAt: new Date("2026-07-24T10:00:00.000Z"),
    };
    const ledgerRow = { ...edit, seqEpoch: OTHER_EPOCH, seqN: 2 };

    // Assert
    expect(order.state).toBe("usable");
    expect(isOrderable(order, ledgerRow, edit)).toBe(false);
    expect(compareEvents(order, ledgerRow, edit)).toBeNull();
  });

  test("two sessions are not comparable by construction", () => {
    // Arrange: there is no cross-session order and no best effort.
    const order = causalOrderOf(SESSION, [
      { seqEpoch: EPOCH, seqReason: "sequenced" },
    ]);
    const here = {
      sessionId: SESSION,
      seqEpoch: EPOCH,
      seqN: 1,
      seqKind: "emitted" as const,
      observedAt: new Date("2026-07-24T10:00:00.000Z"),
    };

    // Assert
    expect(
      compareEvents(order, here, { ...here, sessionId: "cc_elsewhere", seqN: 2 }),
    ).toBeNull();
  });
});
