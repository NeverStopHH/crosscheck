/**
 * SEQ-11 / SEQ-12 — A POSITION TAKEN AFTER THE EDIT IS NOT A POSITION AT IT.
 *
 * The tool lane's `file.modified` was mapped `emitted` — "the position was
 * taken AT the thing it records" — and that is false for it. The edit happens
 * INSIDE the tool; the position is taken afterwards, in the hook the host runs
 * once the tool has returned. Every emitter that allocates in that window takes
 * a LOWER position than an edit that already happened, and `A.n < B.n` then
 * answers happens-before with full confidence. The bias is one-directional,
 * because the hook is always the slower party: the answer always comes out
 * `predeclared` — the value that exonerates.
 *
 * MEASURED, not argued: with an Edit and an MCP `publish_claim` issued in one
 * parallel tool batch, the claim took the LOWER position in 10 trials out of
 * 10 after the file was already on disk.
 *
 * SO THE LANE CARRIES AN INTERVAL, not a point. `after` is a position handed
 * out BEFORE the tool started; `n` is the one handed out after it returned. The
 * edit is somewhere between them, and:
 *
 *   - anything at or below `after` happened before the tool started, so it
 *     happened before the edit — `predeclared` survives;
 *   - anything above `n` was allocated after the hook, so the edit preceded it
 *     — `post_hoc` survives;
 *   - anything BETWEEN them raced the tool and is not comparable to it, which
 *     is the honest answer and the one this file exists to pin.
 *
 * AN EMITTER THAT CANNOT BRACKET ITS TOOL sends no `after`, and the hub reads
 * that as the upper bound it is: `seq_kind = observed`, a happens-before
 * question refused rather than answered from a coin flip. That is a
 * per-connector fact, printed in the manifest, never a silent absence.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { sessionEvents } from "../src/db/schema.ts";
import {
  compareEvents,
  isOrderable,
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
const SESSION = "cc_window";
const EDITED = "src/auth/refresh.ts";
const EXPLANATION = "clm_window_explanation";

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

/** A tool-lane edit. `after` present = the emitter bracketed its tool. */
const editRecord = (
  value: string,
  n: number,
  after?: number,
): Record<string, unknown> => ({
  ...recordEnvelope(
    "target",
    {
      workContextId: WORK_CONTEXT_ID,
      kind: "file",
      value,
      source: "tool_edit",
    },
    { sessionId: SESSION },
  ),
  seq: after === undefined ? { epoch: EPOCH, n } : { epoch: EPOCH, n, after },
});

/** An explanation an agent published on its own account: a POINT in time. */
const explanationRecord = (n: number): Record<string, unknown> => ({
  ...recordEnvelope(
    "claim",
    validClaimBody({
      id: EXPLANATION,
      authorSessionId: SESSION,
      kind: "root_cause",
      body: "the refresh path drops the retry header, so the token had to change",
      provenance: "declared",
      captureMode: "agent",
    }),
    { sessionId: SESSION },
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
          seqAfter: row.seqAfter,
          seqKind: row.seqKind,
          seqReason: row.seqReason,
          observedAt: row.observedAt,
        },
      ]),
  );
};

describe("SEQ-11 — an unbracketed tool-lane position is an upper bound", () => {
  test("an explanation that raced the edit is not ordered before it", async () => {
    // Arrange: the ground truth is the inverse of the positions. The file was
    // written first; the claim was published while the edit's hook was still
    // starting, so the claim took 23 and the edit 24.
    const { harness, dev } = await started("window@example.com");
    await postRecords(harness, dev, {
      records: [explanationRecord(23), editRecord(EDITED, 24)],
    });

    // Act
    const order = await readSessionCausalOrder(harness.db, SESSION);
    const events = await eventsBy(harness);
    const explanation = events.get(23);
    const edit = events.get(24);

    // Assert: the row says upper bound, and the comparison refuses rather
    // than reporting the reason as predeclared.
    expect(edit?.seqKind).toBe("observed");
    expect(isOrderable(order, explanation!, edit!)).toBe(false);
    expect(compareEvents(order, explanation!, edit!)).toBeNull();
  });
});

describe("SEQ-13 — a bracket that cannot be true is dropped, not trusted", () => {
  test("a window opening above its own position leaves an upper bound", async () => {
    // Arrange: `after` is a position taken BEFORE the work, so it can never
    // sit above the position it brackets. An emitter that says otherwise is
    // broken, and the answer is to drop the BRACKET rather than the record —
    // rejecting would destroy the record, because a connector's flush
    // advances its cursor on any 2xx.
    const { harness, dev } = await started("inverted@example.com");

    // Act
    await postRecords(harness, dev, {
      records: [editRecord(EDITED, 24, 30)],
    });

    // Assert
    const events = await eventsBy(harness);
    expect(events.get(24)?.seqAfter).toBeNull();
    expect(events.get(24)?.seqKind).toBe("observed");
  });
});

describe("SEQ-12 — a bracketed tool-lane position answers both directions", () => {
  test("before the window orders, inside it refuses, after it orders", async () => {
    // Arrange: the tool opened its window at 20 and its hook closed it at 24.
    // Three explanations: one before the window, one inside it, one after.
    const { harness, dev } = await started("bracket@example.com");
    await postRecords(harness, dev, {
      records: [editRecord(EDITED, 24, 20)],
    });
    await postRecords(harness, dev, {
      records: [explanationRecord(19)],
    });
    const { harness: raced, dev: racedDev } = await started("raced@example.com");
    await postRecords(raced, racedDev, {
      records: [editRecord(EDITED, 24, 20), explanationRecord(22)],
    });
    const { harness: later, dev: laterDev } = await started("later@example.com");
    await postRecords(later, laterDev, {
      records: [editRecord(EDITED, 24, 20), explanationRecord(30)],
    });

    // Act
    const order = await readSessionCausalOrder(harness.db, SESSION);
    const events = await eventsBy(harness);
    const racedOrder = await readSessionCausalOrder(raced.db, SESSION);
    const racedEvents = await eventsBy(raced);
    const laterOrder = await readSessionCausalOrder(later.db, SESSION);
    const laterEvents = await eventsBy(later);

    // Assert: a bracketed lane keeps its happens-before in both directions.
    expect(events.get(24)?.seqKind).toBe("emitted");
    expect(events.get(24)?.seqAfter).toBe(20);
    expect(compareEvents(order, events.get(19)!, events.get(24)!)).toBe(-1);
    expect(
      compareEvents(racedOrder, racedEvents.get(22)!, racedEvents.get(24)!),
    ).toBeNull();
    expect(
      compareEvents(laterOrder, laterEvents.get(24)!, laterEvents.get(30)!),
    ).toBe(-1);
  });
});
