/**
 * THE READER THE LADDER CANNOT WORK WITHOUT (spec 06 §3.5).
 *
 * `explanationTimingFor` is asked about an EDIT, and an edit reaches the hub as
 * a `work_context_targets` row whose identity contains the author-written path.
 * Its POSITION lives on a `session_events` row addressed by `targetDigest`, and
 * before this reader nothing in the tree turned that triple back into an
 * `OrderedEvent`: `session-order.ts`'s two readers select `seq_epoch` and
 * `seq_reason` only, and `session-events.ts` exported the writer, the id
 * helpers, prune and counts — nothing that reads one event back.
 *
 * WHAT THESE TESTS ARE REALLY PINNING IS `seq_kind` AND THE CONSERVATIVE PICK.
 * A reader that returned the position and defaulted the kind to `emitted`
 * passes any test that only asks for the number — and an `emitted` edit is one
 * a happens-before question may be ANSWERED against, which is exactly how the
 * Stop-time git lane's upper bound turns into `predeclared`, the exonerating
 * answer, for a change that came first.
 */
import { describe, expect, test } from "bun:test";

import {
  readEditEvent,
  recordSessionEvent,
  targetDigest,
} from "../src/services/session-events.ts";
import { createHarnessWithSession } from "./helpers.ts";

const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const SESSION_ID = "cc_sess_01";
const WORK_CONTEXT = "wc_edit_01";
const PATH = "packages/b.ts";

describe("readEditEvent", () => {
  test("resolves (context, kind, value) to the event that positions it", async () => {
    // Arrange: a bracketing tool-lane edit — the one shape a happens-before
    // question may be answered against. The reader has to compute the digest
    // itself; nothing outside `session-events.ts` should have to know how a
    // target is addressed.
    const { harness } = await createHarnessWithSession({ id: SESSION_ID });
    const deps = { db: harness.db, now: harness.clock.now };
    await recordSessionEvent(deps, {
      sessionId: SESSION_ID,
      kind: "file.modified",
      seq: { epoch: EPOCH, n: 7, after: 6 },
      seqKind: "emitted",
      refKind: "target_digest",
      refId: targetDigest(WORK_CONTEXT, "file", PATH),
    });

    // Act
    const edit = await readEditEvent(harness.db, WORK_CONTEXT, "file", PATH);

    // Assert: the whole OrderedEvent, bracket included — `seqAfter` is what
    // the overlap condition reads, so a reader that dropped it would make
    // every window a point and every concurrent pair answerable.
    expect(edit).not.toBeNull();
    expect(edit?.event.sessionId).toBe(SESSION_ID);
    expect(edit?.event.seqEpoch).toBe(EPOCH);
    expect(edit?.event.seqN).toBe(7);
    expect(edit?.event.seqAfter).toBe(6);
    expect(edit?.event.seqKind).toBe("emitted");
    expect(edit?.event.seqReason).toBe("sequenced");
    expect(edit?.kind).toBe("file");
    expect(edit?.value).toBe(PATH);
  });

  test("a git-lane edit comes back `observed`, never `emitted`", async () => {
    // Arrange: `git_diff` is ALWAYS observed (record-handlers.ts's
    // SEQ_KIND_BY_SOURCE) — the Stop-time lane sees a working tree at the end
    // of a turn and cannot say when inside it a codemod touched the file. A
    // reader that defaults the kind promotes that upper bound to a
    // happens-before, and an intent below it then answers `predeclared`.
    const { harness } = await createHarnessWithSession({ id: SESSION_ID });
    const deps = { db: harness.db, now: harness.clock.now };
    await recordSessionEvent(deps, {
      sessionId: SESSION_ID,
      kind: "file.modified",
      seq: { epoch: EPOCH, n: 7 },
      seqKind: "observed",
      refKind: "target_digest",
      refId: targetDigest(WORK_CONTEXT, "file", PATH),
    });

    // Act
    const edit = await readEditEvent(harness.db, WORK_CONTEXT, "file", PATH);

    // Assert
    expect(edit?.event.seqKind).toBe("observed");
    expect(edit?.event.seqN).toBe(7);
  });

  test("an unpositioned observation outranks a positioned one", async () => {
    // Arrange: TWO observations of one file — the tool lane positioned it at
    // 7, and a second lane could not allocate at all. The unpositioned one is
    // a sighting of the same edit that says nothing about when, so answering
    // from the positioned one alone would report an order the second
    // observation does not support.
    //
    // FAIL CLOSED IS THE ONLY SAFE DIRECTION HERE, and it is not symmetric:
    // an over-refusal costs certainty, which principle 5 permits, while
    // choosing the later positioned sighting produces `predeclared` — the
    // answer nobody in this system reports when it is wrong.
    const { harness } = await createHarnessWithSession({ id: SESSION_ID });
    const deps = { db: harness.db, now: harness.clock.now };
    const refId = targetDigest(WORK_CONTEXT, "file", PATH);
    await recordSessionEvent(deps, {
      sessionId: SESSION_ID,
      kind: "file.modified",
      seq: { epoch: EPOCH, n: 7, after: 6 },
      seqKind: "emitted",
      refKind: "target_digest",
      refId,
    });
    await recordSessionEvent(deps, {
      sessionId: SESSION_ID,
      kind: "file.modified",
      seq: { reason: "allocation_failed" },
      seqKind: "observed",
      refKind: "target_digest",
      refId,
    });

    // Act
    const edit = await readEditEvent(harness.db, WORK_CONTEXT, "file", PATH);

    // Assert
    expect(edit?.event.seqN).toBeNull();
    expect(edit?.event.seqReason).toBe("allocation_failed");
  });

  test("the earliest sighting wins when both carry a position", async () => {
    // Arrange: a file edited at 3 and touched again at 9. "Was the reason
    // written before the change?" is asked of the CHANGE, and the change is
    // the first one — an intent at 5 did not precede the edit at 3.
    const { harness } = await createHarnessWithSession({ id: SESSION_ID });
    const deps = { db: harness.db, now: harness.clock.now };
    const refId = targetDigest(WORK_CONTEXT, "file", PATH);
    for (const n of [9, 3]) {
      await recordSessionEvent(deps, {
        sessionId: SESSION_ID,
        kind: "file.modified",
        seq: { epoch: EPOCH, n, after: n - 1 },
        seqKind: "emitted",
        refKind: "target_digest",
        refId,
      });
    }

    // Act
    const edit = await readEditEvent(harness.db, WORK_CONTEXT, "file", PATH);

    // Assert
    expect(edit?.event.seqN).toBe(3);
  });

  test("a file no event ever positioned reads as null, not as an edit at 0", async () => {
    // Arrange: nothing recorded at all.
    const { harness } = await createHarnessWithSession({ id: SESSION_ID });

    // Act
    const edit = await readEditEvent(harness.db, WORK_CONTEXT, "file", PATH);

    // Assert
    expect(edit).toBeNull();
  });
});
