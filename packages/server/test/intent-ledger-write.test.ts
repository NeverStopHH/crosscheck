/**
 * THE LEDGER IS WRITTEN ON BOTH PATHS, AND THE HEAD IS A PROJECTION OF IT
 * (spec 06 §4).
 *
 * INT-4 — the head cannot disagree with the ledger. After N amendments
 * `work_contexts.intent` equals version N's `wire` and `max(version) = N`; a
 * replayed spool line is a `duplicate` and mints no second version.
 *
 * TWO FIXTURES, BECAUSE THERE ARE TWO PATHS. §4 appends "when
 * `workContextChanges` reports an intent change", and that function runs on
 * the UPDATE path only. The INSERT path writes `intent: body.intent ?? null`
 * straight into the row — and `set_intent` posts DIRECTLY over HTTP while the
 * work-context create travels via the SPOOL, so a `set_intent` issued before
 * the session's first flush reaches the hub FIRST and creates a context
 * already carrying an intent. An UPDATE-only implementation leaves that first
 * version outside the ledger: the head says v1 and `max(version)` says nothing
 * at all.
 *
 * INT-5 — a derived intent still never overwrites a declared one, AND appends
 * nothing. A refused merge is not intent evolution, and recording it would put
 * a model sentence nobody accepted within reach of every renderer.
 */
import { describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";

import { workContextIntents, workContexts } from "../src/db/schema.ts";
import {
  WORK_CONTEXT_ID,
  createHarnessWithSession,
  postRecords,
  recordEnvelope,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const TS = "2026-07-24T09:00:00.000Z";

const declared = (
  summary: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  summary,
  provenance: "declared",
  confidence: 1,
  capturedAt: TS,
  ...extra,
});

const chainOf = async (harness: TestHarness) =>
  harness.db
    .select()
    .from(workContextIntents)
    .where(eq(workContextIntents.workContextId, WORK_CONTEXT_ID))
    .orderBy(desc(workContextIntents.version));

const headOf = async (
  harness: TestHarness,
): Promise<Record<string, unknown> | null> => {
  const rows = await harness.db
    .select({ intent: workContexts.intent })
    .from(workContexts)
    .where(eq(workContexts.id, WORK_CONTEXT_ID));
  return rows[0]?.intent ?? null;
};

describe("INT-4 — the head cannot disagree with the ledger", () => {
  test("three amendments are three rows, and the head is version 3's wire", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );

    // Act
    for (const [index, summary] of [
      "Map entity ids across the two providers.",
      "Map entity ids, and fix the fixture that hid the gap.",
      "Rewrite the matcher; the id map was never the problem.",
    ].entries()) {
      await postRecords(harness, developer, {
        ...recordEnvelope(
          "work_context",
          validWorkContextBody({
            intent: declared(
              summary,
              index === 0 ? {} : { reason: "The provider's id changed." },
            ),
          }),
        ),
        seq: { epoch: EPOCH, n: index + 1 },
      });
    }

    // Assert
    const chain = await chainOf(harness);
    expect(chain.length).toBe(3);
    expect(chain.map((row) => row.version)).toEqual([3, 2, 1]);
    expect(chain[0]?.summary).toBe(
      "Rewrite the matcher; the id map was never the problem.",
    );
    // The head IS the newest row's wire, not a second opinion about it.
    expect(await headOf(harness)).toEqual(chain[0]?.wire ?? null);
  });

  test("an intent that arrives BEFORE the context exists is still version 1", async () => {
    // Arrange: set_intent posts directly over HTTP; the work-context create
    // travels via the spool. This is that order, and it takes the INSERT path.
    const { harness, developer } = await createHarnessWithSession();

    // Act
    await postRecords(harness, developer, {
      ...recordEnvelope(
        "work_context",
        validWorkContextBody({ intent: declared("Map entity ids.") }),
      ),
      seq: { epoch: EPOCH, n: 1 },
    });

    // Assert
    const chain = await chainOf(harness);
    expect(chain.length).toBe(1);
    expect(chain[0]?.version).toBe(1);
    expect(chain[0]?.amendsVersion).toBeNull();
    expect(chain[0]?.seq).toBe(1);
    expect(chain[0]?.seqEpoch).toBe(EPOCH);
    expect(await headOf(harness)).toEqual(chain[0]?.wire ?? null);
  });

  test("a replayed spool line mints no second version", async () => {
    // Arrange: the SAME envelope twice — same id, same seq, same sentence.
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );
    const line = {
      ...recordEnvelope(
        "work_context",
        validWorkContextBody({ intent: declared("Map entity ids.") }),
      ),
      seq: { epoch: EPOCH, n: 1 },
    };

    // Act
    await postRecords(harness, developer, line);
    await postRecords(harness, developer, line);

    // Assert
    const chain = await chainOf(harness);
    expect(chain.length).toBe(1);
    expect(chain[0]?.version).toBe(1);
  });

  test("the hub assigns amends_version; the connector never could", async () => {
    // Arrange: `OwnWorkContext` carries no version and session state carries
    // only the summary, so a connector learning the number needs a hub read —
    // which §6 forbids. The hub already assigns `version`; it assigns this too.
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );

    // Act
    for (const [index, summary] of [
      "First sentence.",
      "Second sentence.",
    ].entries()) {
      await postRecords(harness, developer, {
        ...recordEnvelope(
          "work_context",
          validWorkContextBody({
            intent: declared(
              summary,
              index === 0 ? {} : { reason: "The provider's id changed." },
            ),
          }),
        ),
        seq: { epoch: EPOCH, n: index + 1 },
      });
    }

    // Assert
    const chain = await chainOf(harness);
    expect(chain.map((row) => row.amendsVersion)).toEqual([1, null]);
    expect(chain[0]?.reason).toBe("The provider's id changed.");
  });

  test("a body-carried position is discarded for the one the envelope proves", async () => {
    // Arrange: `provenance` is body-carried and unverifiable, and §1.2 names
    // that as a defect. A body-carried POSITION would be worse — it is the
    // whole answer to AT-4 — so the hub stamps it from the envelope, the one
    // seam a connector cannot forge past, exactly as it derives `seq_kind`.
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );

    // Act
    await postRecords(harness, developer, {
      ...recordEnvelope(
        "work_context",
        validWorkContextBody({
          intent: declared("Map entity ids.", {
            seq: { epoch: EPOCH, n: 9999 },
          }),
        }),
      ),
      seq: { epoch: EPOCH, n: 4 },
    });

    // Assert
    const chain = await chainOf(harness);
    expect(chain[0]?.seq).toBe(4);
    expect((chain[0]?.wire as Record<string, unknown>)["seq"]).toEqual({
      epoch: EPOCH,
      n: 4,
    });
  });
});

describe("INT-5 — a refused derived merge appends nothing", () => {
  test("a derived intent behind a declared one leaves the chain at one row", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );
    await postRecords(harness, developer, {
      ...recordEnvelope(
        "work_context",
        validWorkContextBody({ intent: declared("The session's own goal.") }),
      ),
      seq: { epoch: EPOCH, n: 1 },
    });

    // Act: a late-flushed derived spool record
    await postRecords(harness, developer, {
      ...recordEnvelope(
        "work_context",
        validWorkContextBody({
          intent: {
            summary: "A model's guess at the first prompt.",
            provenance: "derived",
            confidence: 0.4,
            capturedAt: TS,
          },
        }),
      ),
      seq: { epoch: EPOCH, n: 2 },
    });

    // Assert: the head is untouched AND no row records the refusal — a
    // sentence nobody accepted must not be within reach of a renderer.
    const chain = await chainOf(harness);
    expect(chain.length).toBe(1);
    expect(chain[0]?.summary).toBe("The session's own goal.");
    expect((await headOf(harness))?.["summary"]).toBe("The session's own goal.");
  });

  test("a derived intent on a bare context is version 1 and says which lane wrote it", async () => {
    // Arrange: nothing refused it, so it IS the intent evolution so far — and
    // the row has to say which lane wrote it, because §3.5 step 2 drops
    // derived entries before any timing is computed.
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );

    // Act
    await postRecords(harness, developer, {
      ...recordEnvelope(
        "work_context",
        validWorkContextBody({
          intent: {
            summary: "A model's guess at the first prompt.",
            provenance: "derived",
            confidence: 0.4,
            capturedAt: TS,
          },
        }),
      ),
      seq: { epoch: EPOCH, n: 1 },
    });

    // Assert: and its position is `observed`, because a detached worker
    // summarises a slice from EARLIER in the session — the claim lane's rule.
    const chain = await chainOf(harness);
    expect(chain.length).toBe(1);
    expect(chain[0]?.provenance).toBe("derived");
    expect(chain[0]?.seqKind).toBe("observed");
  });
});
