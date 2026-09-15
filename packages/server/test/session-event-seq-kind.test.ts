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
  createTestDeveloper,
  createTestHarness,
  postRecords,
  recordEnvelope,
  registerTestSession,
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
): Record<string, unknown> => ({ ...envelope, seq: { epoch: EPOCH, n } });

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
    const rows = await harness.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, SESSION));
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
});
