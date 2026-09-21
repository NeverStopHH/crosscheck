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
import { MAX_INTENT_CHAIN_VERSIONS } from "@crosscheck/schema";

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
    // AND THE HEAD IS STILL VERSION 1'S WIRE. Counting rows is not the
    // invariant: `amends_version` is computed from the head that exists NOW,
    // which on a replay is the very row being replayed, so a recomputed wire
    // says this sentence amended ITSELF. A redelivered spool line — the one
    // thing the id hash exists to survive — would then leave the head carrying
    // a version no ledger row ever held, and every INT-4 assertion above would
    // still pass.
    expect(await headOf(harness)).toEqual(chain[0]?.wire ?? null);
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

describe("two declarations are never one row", () => {
  test("a second declaration adding a non-goal is its own version", async () => {
    // Arrange: a session whose position could not be allocated — two live
    // agents in one worktree, which does not clear until one of them ends.
    // Every call then carries `seq: null`, so the version key can no longer
    // lean on a position to tell two declarations apart.
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );

    const summary = "Rewrite the matcher.";
    await postRecords(
      harness,
      developer,
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          intent: declared(summary, {
            expectedSurface: [{ kind: "file", value: "packages/a.ts" }],
          }),
        }),
      ),
    );

    // Act: the same sentence, now with something it will NOT touch. Same
    // goal, different declaration.
    await postRecords(
      harness,
      developer,
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          intent: declared(summary, {
            reason: "b.ts is off limits after all.",
            expectedSurface: [{ kind: "file", value: "packages/a.ts" }],
            nonGoals: [{ kind: "file", value: "packages/b.ts" }],
          }),
        }),
      ),
    );

    // Assert: two rows, not one. Before the version key covered the scope,
    // this collapsed — the insert hit the primary key, the replay branch
    // handed back the STORED wire, and the caller answered `accepted` while
    // the declared non-goal reached nothing at all. The half that goes
    // missing is the ACCUSING half: an edit to b.ts would then answer from
    // the surviving `expected` row rather than `declared_non_goal_edited`.
    const chain = await chainOf(harness);
    expect(chain.length).toBe(2);
    expect(chain.map((row) => row.version)).toEqual([2, 1]);
    expect(chain[0]?.reason).toBe("b.ts is off limits after all.");
    expect(await headOf(harness)).toEqual(chain[0]?.wire ?? null);
  });

  test("scope alone separates two declarations", async () => {
    // THE CASE ABOVE DOES NOT PROVE THE SCOPE TERM. It differs in the reason
    // as well, so the key still separates the two rows with the scope term
    // removed — measured by mutating the term away and watching that test
    // stay green. Here the scope is the ONLY difference, which is what makes
    // the term individually load-bearing.
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );

    for (const paths of [["packages/a.ts"], ["packages/a.ts", "packages/b.ts"]]) {
      await postRecords(
        harness,
        developer,
        recordEnvelope(
          "work_context",
          validWorkContextBody({
            intent: declared("Rewrite the matcher.", {
              expectedSurface: paths.map((value) => ({ kind: "file", value })),
            }),
          }),
        ),
      );
    }

    // Widening a declared surface is a new declaration, and the widening is
    // exactly what AT-4 asks about: did the session say so before or after.
    expect((await chainOf(harness)).length).toBe(2);
  });

  test("a genuine replay of one declaration is still one row", async () => {
    // The control, and the reason the key may not simply be a counter: the
    // spool replays on any retry, and a replayed line must stay a duplicate.
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );

    const body = validWorkContextBody({
      intent: declared("Rewrite the matcher.", {
        expectedSurface: [
          { kind: "file", value: "packages/b.ts" },
          { kind: "file", value: "packages/a.ts" },
        ],
      }),
    });
    await postRecords(harness, developer, recordEnvelope("work_context", body));
    await postRecords(harness, developer, recordEnvelope("work_context", body));

    expect((await chainOf(harness)).length).toBe(1);
  });

  test("the same paths in a different order are the same declaration", async () => {
    // A connector that emits its scope in another order has declared nothing
    // new, so the key sorts before hashing. Without that, one replay would
    // become two versions and the chain would grow on retries alone.
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );

    for (const paths of [
      ["packages/a.ts", "packages/b.ts"],
      ["packages/b.ts", "packages/a.ts"],
    ]) {
      await postRecords(
        harness,
        developer,
        recordEnvelope(
          "work_context",
          validWorkContextBody({
            intent: declared("Rewrite the matcher.", {
              expectedSurface: paths.map((value) => ({ kind: "file", value })),
            }),
          }),
        ),
      );
    }

    expect((await chainOf(harness)).length).toBe(1);
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


/**
 * THE CAP IS WHAT REPLACES A RETENTION JOB (§10.1, taken on its default).
 *
 * Nothing sweeps this table, so the only thing bounding one work context's
 * history is the cap — which makes the 20th amendment a RETENTION boundary as
 * well as a correctness one, and its behaviour has to be all three of the
 * things decision 10.1 names: append nothing, leave the head where it is, and
 * say `ignored`.
 *
 * IGNORED, NEVER REJECTED. A rejected record is a DESTROYED record: the
 * connector's flush advances its spool cursor on any 2xx, so a batch the hub
 * refused is a batch the spool considers delivered (`services/records.ts`).
 * Rejecting the 21st sentence would lose it AND every record behind it in that
 * batch; ignoring it loses only the sentence, loudly.
 */
describe("the 20th amendment is the last one", () => {
  test("the 21st sentence is ignored and the head stays on version 20", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );

    // Act: one sentence more than the chain may hold.
    const statuses: (string | undefined)[] = [];
    for (let n = 1; n <= MAX_INTENT_CHAIN_VERSIONS + 1; n += 1) {
      const posted = await postRecords(harness, developer, {
        ...recordEnvelope(
          "work_context",
          validWorkContextBody({ intent: declared(`Sentence ${String(n)}.`) }),
        ),
        seq: { epoch: EPOCH, n },
      });
      statuses.push(posted.data?.results[0]?.status);
    }

    // Assert
    const chain = await chainOf(harness);
    expect(chain.length).toBe(MAX_INTENT_CHAIN_VERSIONS);
    expect(chain[0]?.version).toBe(MAX_INTENT_CHAIN_VERSIONS);
    expect(chain[0]?.summary).toBe(
      `Sentence ${String(MAX_INTENT_CHAIN_VERSIONS)}.`,
    );
    // THE HEAD DID NOT MOVE. A head carrying the 21st sentence is worse than
    // an overwrite: it would hold a sentence with no version at all, and
    // `max(version)` would name a different one — the disagreement the whole
    // ledger exists to make impossible.
    expect(await headOf(harness)).toEqual(chain[0]?.wire ?? null);
    expect(statuses[MAX_INTENT_CHAIN_VERSIONS]).toBe("ignored");
    expect(statuses.slice(0, MAX_INTENT_CHAIN_VERSIONS)).toEqual(
      Array.from({ length: MAX_INTENT_CHAIN_VERSIONS }, () => "accepted"),
    );
  });

  test("the cap says so, so the sentence is not silently gone", async () => {
    // Arrange: a chain already at the cap.
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(
      harness,
      developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );
    for (let n = 1; n <= MAX_INTENT_CHAIN_VERSIONS; n += 1) {
      await postRecords(harness, developer, {
        ...recordEnvelope(
          "work_context",
          validWorkContextBody({ intent: declared(`Sentence ${String(n)}.`) }),
        ),
        seq: { epoch: EPOCH, n },
      });
    }

    // Act
    const posted = await postRecords(harness, developer, {
      ...recordEnvelope(
        "work_context",
        validWorkContextBody({ intent: declared("One sentence too many.") }),
      ),
      seq: { epoch: EPOCH, n: MAX_INTENT_CHAIN_VERSIONS + 1 },
    });

    // Assert: an outcome with no issue is a silent drop, which is
    // non-negotiable #4 broken — the author has to be able to read WHY their
    // sentence is not on their own work context.
    const issues = posted.data?.results[0]?.issues ?? [];
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain(String(MAX_INTENT_CHAIN_VERSIONS));
  });
});
