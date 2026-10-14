/**
 * A FLUSH'S TARGETS ARE ONE RUN (services/target-run.ts; release gate on
 * ubuntu-latest, 2026-10-13). One target at a time cost about fifteen
 * statements each, and a 99-record batch took longer than the connector's
 * 400 ms request bound: the connector abandoned a batch the hub then stored,
 * and the rest never came. A run is now a few statements whatever its
 * length, and still answers each target as it was alone; a re-sent envelope
 * the hub holds is answered `duplicate` without being stored again.
 *
 * THE COST IS COUNTED, NOT TIMED: statements per flush are a property of the
 * code, the same on a loaded laptop and an idle runner.
 */
import { describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";

import { workContexts, workContextTargets } from "../src/db/schema.ts";
import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  postRecords,
  recordEnvelope,
  validWorkContextBody,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const BIG_RUN = 99;
const SMALL_RUN = 10;
const SECONDS_LATER = 3600;

const targetOf = (value: string, source = "git_diff", workContextId = WORK_CONTEXT_ID): Record<string, unknown> =>
  recordEnvelope("target", { workContextId, kind: "file", value, source });

const files = (count: number, from = 0): readonly Record<string, unknown>[] =>
  Array.from({ length: count }, (_, index) => targetOf(`src/file-${String(from + index).padStart(4, "0")}.ts`));

/** How many statements the hub's database ran while `act` did. */
const statementsDuring = async (harness: TestHarness, act: () => Promise<unknown>): Promise<number> => {
  const client = (harness.db as unknown as { readonly $client: PGlite }).$client;
  const original = client.query.bind(client);
  let count = 0;
  client.query = (async (...args: Parameters<PGlite["query"]>) => {
    count += 1;
    return original(...args);
  }) as PGlite["query"];
  try {
    await act();
  } finally {
    client.query = original;
  }
  return count;
};

const withContext = async (): Promise<{ readonly harness: TestHarness; readonly developer: TestDeveloper }> => {
  const { harness, developer } = await createHarnessWithSession();
  await postRecords(harness, developer, { records: [recordEnvelope("work_context", validWorkContextBody())] });
  return { harness, developer };
};

describe("a flush's targets are stored as one run", () => {
  test("a run of 99 targets costs the statements a run of 10 does", async () => {
    // Arrange: two contexts, so neither run meets the other's rows
    const { harness, developer } = await withContext();
    await postRecords(harness, developer, { records: [recordEnvelope("work_context", validWorkContextBody({ id: "wc_02" }))] });
    const small = files(SMALL_RUN).map((record) => ({ ...record, body: { ...(record["body"] as object), workContextId: "wc_02" } }));

    // Act
    const forSmall = await statementsDuring(harness, () => postRecords(harness, developer, { records: small }));
    const forBig = await statementsDuring(harness, () => postRecords(harness, developer, { records: files(BIG_RUN) }));

    // Assert: the count does not grow with the run
    expect(forBig).toBe(forSmall);
  });

  test("each target is answered as it was alone: the second sighting of a file in one flush is a duplicate that labels it both", async () => {
    // Arrange
    const { harness, developer } = await withContext();

    // Act
    const answer = await postRecords(harness, developer, {
      records: [targetOf("src/a.ts", "tool_edit"), targetOf("src/b.ts"), targetOf("src/a.ts", "git_diff")],
    });

    // Assert
    expect(answer.data?.results.map((result) => result.status)).toEqual(["accepted", "accepted", "duplicate"]);
    const row = (
      await harness.db
        .select()
        .from(workContextTargets)
        .where(and(eq(workContextTargets.workContextId, WORK_CONTEXT_ID), eq(workContextTargets.value, "src/a.ts")))
    )[0];
    expect(row?.source).toBe("both");
    expect(row?.lastSeenAt?.toISOString()).toBe(harness.clock.now().toISOString());
  });

  test("a target of a context that is not there, or not the sender's, is refused alone and the rest of the run is stored", async () => {
    // Arrange: Kim's context, which Nick may not file into
    const { harness, developer } = await withContext();
    const kim = await addTestDeveloperWithSession(harness, "Kim", "kim@example.com", { id: "ses_kim" });
    await postRecords(harness, kim, {
      records: [recordEnvelope("work_context", validWorkContextBody({ id: "wc_kim", sessionId: "ses_kim" }), { sessionId: "ses_kim" })],
    });

    // Act
    const answer = await postRecords(harness, developer, {
      records: [targetOf("src/a.ts"), targetOf("src/x.ts", "git_diff", "wc_none"), targetOf("src/y.ts", "git_diff", "wc_kim"), targetOf("src/b.ts")],
    });

    // Assert
    expect(answer.data?.results.map((result) => result.status)).toEqual(["accepted", "rejected", "rejected", "accepted"]);
    expect(answer.data?.results[1]?.issues).toEqual(['workContextId: work context "wc_none" not found']);
    expect(answer.data?.results[2]?.issues).toEqual(["workContextId: work context belongs to another developer"]);
  });

  test("the search doc of a context a run grew names every file the run added", async () => {
    // Arrange
    const { harness, developer } = await withContext();

    // Act
    await postRecords(harness, developer, { records: files(BIG_RUN) });

    // Assert
    const doc = (await harness.db.select().from(workContexts).where(eq(workContexts.id, WORK_CONTEXT_ID)))[0]?.normalizedDoc ?? "";
    expect(files(BIG_RUN).every((record) => doc.includes(String((record["body"] as { value: string }).value)))).toBe(true);
  });
});

describe("a re-sent envelope the hub holds is not stored again", () => {
  test("its answer is duplicate, and the file's last sighting does not move to the re-send", async () => {
    // Arrange: a batch the hub stored whose answer the connector never heard
    const { harness, developer } = await withContext();
    const batch = files(SMALL_RUN);
    await postRecords(harness, developer, { records: batch });
    harness.clock.advanceSeconds(SECONDS_LATER);

    // Act: the same envelopes, an hour later
    const again = await postRecords(harness, developer, { records: batch });

    // Assert: answered as held, not re-touched
    expect(again.data?.duplicates).toBe(SMALL_RUN);
    const rows = await harness.db.select().from(workContextTargets).where(eq(workContextTargets.workContextId, WORK_CONTEXT_ID));
    expect(rows.map((row) => row.lastSeenAt)).toEqual(rows.map(() => null));
  });

  test("a NEW envelope for a file already on the hub is a re-touch all the same", async () => {
    // Arrange
    const { harness, developer } = await withContext();
    await postRecords(harness, developer, { records: [targetOf("src/a.ts")] });
    harness.clock.advanceSeconds(SECONDS_LATER);

    // Act: another sighting of the file, with an envelope of its own
    await postRecords(harness, developer, { records: [targetOf("src/a.ts")] });

    // Assert
    const row = (await harness.db.select().from(workContextTargets).where(eq(workContextTargets.value, "src/a.ts")))[0];
    expect(row?.lastSeenAt?.toISOString()).toBe(harness.clock.now().toISOString());
  });
});
