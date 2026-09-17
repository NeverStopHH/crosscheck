/**
 * SEQ-7 — AN OBSERVED POSITION IS AN UPPER BOUND, AND IT HAS TWO PRODUCERS.
 *
 * `file.modified` from the tool lane is EMITTED at the edit. From the Stop-time
 * `git diff` lane it is OBSERVED: the lane sees a working tree at the end of a
 * turn and cannot say when inside that turn `sed -i`, a codemod or a generator
 * touched the file. Under the happens-before rule `A.n < B.n` an observed
 * position would sort the edit AFTER an amendment it may well predate — a
 * confident wrong answer, which is the one outcome this design exists to
 * prevent.
 *
 * A DETACHED WORKER'S CLAIM IS THE SECOND PRODUCER, and it is the half a
 * reader would not guess. The summarizer, ghost and intent workers summarise a
 * slice from EARLIER in the session, so the position a worker allocates records
 * when the row was WRITTEN, not when the fact it describes was seen. Every
 * worker-authored claim is `derived` provenance, and that is the hub-side
 * signal: an agent declaring on its own account is `declared` and emitted.
 *
 * WHAT THE LANE CANNOT SEE AT ALL, and why it travels with `observed`: the git
 * lane reads uncommitted changes only, so work COMMITTED during the turn and
 * UNTRACKED new files are invisible to it. An observed position is an upper
 * bound partly for that reason.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { sessionEvents } from "../src/db/schema.ts";
import {
  causalComparisonOf,
  compareEvents,
} from "../src/services/session-order.ts";
import type {
  OrderedEvent,
  SessionCausalOrder,
} from "../src/services/session-order.ts";
import {
  createTestDeveloper,
  createTestHarness,
  postRecords,
  recordEnvelope,
  registerTestSession,
  TEST_START_ISO,
  validClaimBody,
  validWorkContextBody,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const SESSION = "cc_lane";

const withSeq = (
  envelope: Record<string, unknown>,
  n: number,
  after?: number,
): Record<string, unknown> => ({
  ...envelope,
  seq: after === undefined ? { epoch: EPOCH, n } : { epoch: EPOCH, n, after },
});

const started = async (
  email: string,
): Promise<{ harness: TestHarness; dev: TestDeveloper }> => {
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

/**
 * THE TOOL LANE BRACKETS ITS TOOL and the git lane has nothing to bracket. A
 * hook's position is taken once the tool RETURNED, so the tool lane sends the
 * position it took before starting it; the Stop-time git lane sees a working
 * tree at the end of a turn and has no window at all. An unbracketed tool-lane
 * position is an upper bound too, and refuses — that is SEQ-11's case, pinned
 * in session-order-window.test.ts.
 */
const targetRecord = (
  value: string,
  source: string,
  n: number,
): Record<string, unknown> =>
  withSeq(
    recordEnvelope(
      "target",
      { workContextId: WORK_CONTEXT_ID, kind: "file", value, source },
      { sessionId: SESSION },
    ),
    n,
    ...(source === "tool_edit" ? ([n - 1] as const) : ([] as const)),
  );

describe("SEQ-7 — seq_kind is derived on the hub, never sent", () => {
  test("(a) a git_diff-only file.modified is observed, a tool_edit one is emitted", async () => {
    // Arrange
    const { harness, dev } = await started("lane@example.com");

    // Act
    await postRecords(harness, dev, {
      records: [
        targetRecord("src/hand/edited.ts", "tool_edit", 1),
        targetRecord("src/codemod/rewritten.ts", "git_diff", 2),
      ],
    });

    // Assert
    const rows = await harness.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, SESSION));
    const byPosition = new Map(rows.map((row) => [row.seqN, row.seqKind]));
    expect(byPosition.get(1)).toBe("emitted");
    expect(byPosition.get(2)).toBe("observed");
  });

  test("a git-lane sighting that arrives WITH a bracket is still observed", async () => {
    // Arrange: the bracket says "this position was taken after a window that
    // opened at N". The git lane has no such window — it sees a working tree
    // at the END of a turn — so a bracket on one of its records is a claim it
    // cannot support, and `git_diff` must stay an upper bound whatever the
    // envelope says. Without this case the source map's own guard is
    // unfalsifiable: every git-lane fixture would be observed for the OTHER
    // reason, and a mutation promoting `git_diff` to emitted stays green.
    const { harness, dev } = await started("gitbracket@example.com");

    // Act
    await postRecords(harness, dev, {
      records: [
        withSeq(
          recordEnvelope(
            "target",
            {
              workContextId: WORK_CONTEXT_ID,
              kind: "file",
              value: "src/codemod/bracketed.ts",
              source: "git_diff",
            },
            { sessionId: SESSION },
          ),
          2,
          1,
        ),
      ],
    });

    // Assert
    const rows = await harness.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, SESSION));
    expect(rows.find((row) => row.seqN === 2)?.seqKind).toBe("observed");
  });

  test("a file BOTH lanes saw keeps one position per observation", async () => {
    // Arrange: the target row's primary key collapses the two sightings into
    // ONE row whose label is upgraded to "both". The EVENTS do not collapse,
    // and each keeps the seq_kind of the lane that made it: the tool lane's
    // position is emitted, the git lane's later sighting of the same file is
    // still an upper bound and stays observed. The spec maps `both → emitted`
    // off the stored ROW label; applied per EVENT that would stamp a git-lane
    // observation as emitted and let a happens-before question answer from it.
    const { harness, dev } = await started("both@example.com");

    // Act: the second arrives on ingestTarget's DUPLICATE branch — and it must
    // still produce an event, or `observed` would be a value no real row ever
    // carries and SEQ-7(a) would be testing a path nothing reaches.
    await postRecords(harness, dev, {
      records: [targetRecord("src/seen/twice.ts", "tool_edit", 1)],
    });
    await postRecords(harness, dev, {
      records: [targetRecord("src/seen/twice.ts", "git_diff", 2)],
    });

    // Assert
    // The register's own `session.started` sits beside these; this test is
    // about the two lanes, so it reads the file events only.
    const rows = (
      await harness.db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, SESSION))
    ).filter((row) => row.kind === "file.modified");
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.seqN === 1)?.seqKind).toBe("emitted");
    expect(rows.find((row) => row.seqN === 2)?.seqKind).toBe("observed");
  });

  test("(b) a worker-authored claim is observed; a declared one is emitted", async () => {
    // Arrange
    const { harness, dev } = await started("worker@example.com");

    // Act
    await postRecords(harness, dev, {
      records: [
        withSeq(
          recordEnvelope(
            "claim",
            validClaimBody({
              id: "clm_declared",
              authorSessionId: SESSION,
              provenance: "declared",
              captureMode: "agent",
            }),
            { sessionId: SESSION },
          ),
          1,
        ),
        withSeq(
          recordEnvelope(
            "claim",
            validClaimBody({
              id: "clm_derived",
              authorSessionId: SESSION,
              provenance: "derived",
              captureMode: "auto",
              confidence: 0.3,
              body: "the refresh path drops the retry header",
            }),
            { sessionId: SESSION },
          ),
          2,
        ),
      ],
    });

    // Assert
    const rows = await harness.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, SESSION));
    const byRef = new Map(rows.map((row) => [row.refId, row.seqKind]));
    expect(byRef.get("clm_declared")).toBe("emitted");
    expect(byRef.get("clm_derived")).toBe("observed");
  });

  test("(c) a SessionStart's commit collection is observed, not emitted", async () => {
    // Arrange: THE THIRD PRODUCER, and spec 01's own argument covers it. The
    // position is allocated when SessionStart WRITES the aggregate down, and
    // the aggregate describes commits authored up to
    // COMMIT_EVIDENCE_WINDOW_DAYS = 14 days earlier — "a worker summarises a
    // slice from earlier in the session, so the position it allocates records
    // when the row was written, not when the fact it describes was seen"
    // (01 §3.6). Stamped `emitted`, the position of a fact that is OLDER than
    // it sorts an explanation written today BEFORE commits from last week:
    // `compareEvents` answered -1, which is `predeclared`, the value that
    // clears the agent.
    //
    // MEASURED before the fix, on the hub's own readers: one SessionStart
    // re-fire gives the SAME aggregate two rows, and a claim between them was
    // answered +1 against the first and -1 against the second — two opposite
    // happens-before answers about one set of commits, inside one usable
    // epoch. `observed` is what turns both into the refusal SEQ-7 specifies.
    const { harness, dev } = await started("commits@example.com");

    // Act: the collection lands twice, as a compact makes it.
    for (const n of [1, 3]) {
      await postRecords(harness, dev, {
        records: [
          withSeq(
            recordEnvelope(
              "commit_evidence",
              {
                repo: "github.com/acme/api",
                collectedAt: TEST_START_ISO,
                windowDays: 14,
                authors: [
                  {
                    name: "Robin",
                    email: "robin@example.com",
                    latestCommitAt: new Date(
                      new Date(TEST_START_ISO).getTime() - 3 * 86_400_000,
                    ).toISOString(),
                    commitCount: 5,
                  },
                ],
              },
              { sessionId: SESSION },
            ),
            n,
          ),
        ],
      });
    }

    // Assert: both rows are upper bounds, so the hub refuses rather than
    // answering in either direction about them.
    const rows = (
      await harness.db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, SESSION))
    ).filter((row) => row.kind === "commit.observed");
    expect(rows.length).toBe(2);
    expect(rows.map((row) => row.seqKind)).toEqual(["observed", "observed"]);
    const order: SessionCausalOrder = {
      sessionId: SESSION,
      state: "usable",
      reason: "sequenced",
      epochs: 1,
    };
    const claim: OrderedEvent = {
      sessionId: SESSION,
      seqEpoch: EPOCH,
      seqN: 2,
      seqAfter: null,
      seqKind: "emitted",
      seqReason: "sequenced",
      observedAt: new Date(TEST_START_ISO),
    };
    for (const row of rows) {
      const collection: OrderedEvent = {
        sessionId: SESSION,
        seqEpoch: row.seqEpoch,
        seqN: row.seqN,
        seqAfter: row.seqAfter,
        seqKind: row.seqKind,
        seqReason: row.seqReason,
        observedAt: row.observedAt,
      };
      expect(causalComparisonOf(order, claim, collection)).toEqual({
        outcome: "indeterminate",
        reason: "upper_bound_only",
      });
      expect(compareEvents(order, claim, collection)).toBeNull();
    }
  });
});
