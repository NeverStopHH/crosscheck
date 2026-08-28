/**
 * GET /api/work-contexts — the SessionStart briefing's own listing, bounded.
 *
 * It had no LIMIT at all: on a repo with ten thousand contexts it answered
 * with ten thousand rows, inside the 1000 ms SessionStart budget, for a
 * section that renders five lines. These tests pin the three things that
 * makes it: the window the reader asks for, the hard row bound behind it, and
 * the per-context counts the briefing needs to tell a real investigation from
 * a session that started and did nothing (audit row M15-rest).
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { WORK_CONTEXT_LIST_LIMIT } from "../src/services/diagnosis.ts";
import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  validClaimBody,
  validWorkContextBody,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { HarnessWithSession } from "./helpers.ts";

const REPO_QUERY = "/api/work-contexts?repo=github.com%2Facme%2Fapi";

interface ListEntry {
  readonly id: string;
  readonly developerId: string;
  readonly claimCount: number;
  readonly targetCount: number;
}

const list = async (
  setup: HarnessWithSession,
  query: string = REPO_QUERY,
): Promise<readonly ListEntry[]> => {
  const response = await setup.harness.app.request(
    query,
    jsonRequest("GET", setup.developer.apiKey),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: { workContexts: ListEntry[] };
  };
  return body.data.workContexts;
};

describe("GET /api/work-contexts is bounded", () => {
  test("a session that captured files but published nothing reports its targets", async () => {
    // Arrange: one context, one captured file, no claim — the shape the
    // briefing must be able to tell apart from an empty shell.
    const setup = await createHarnessWithSession();
    await postRecords(
      setup.harness,
      setup.developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );
    await postRecords(
      setup.harness,
      setup.developer,
      recordEnvelope("target", {
        workContextId: WORK_CONTEXT_ID,
        kind: "file",
        value: "src/auth/refresh.ts",
      }),
    );

    // Act
    const rows = await list(setup);

    // Assert
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetCount).toBe(1);
    expect(rows[0]?.claimCount).toBe(0);
  });

  test("claims and targets are counted apart, not multiplied together", async () => {
    // The old query LEFT JOINed claims and grouped, so a second count could
    // only have come from a second join — and two joins multiply. Two claims
    // and three targets on one context must read as 2 and 3, never as 6.
    const setup = await createHarnessWithSession();
    await postRecords(
      setup.harness,
      setup.developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );
    // Distinct bodies: the hub dedups on the normalised body, so two copies
    // of the same sentence are one claim and this test would have been
    // asserting the dedup rather than the count.
    for (const [id, body] of [
      ["clm_01", "JWT validation fails after token refresh"],
      ["clm_02", "The refresh path reuses the expired key id"],
    ] as const) {
      await postRecords(
        setup.harness,
        setup.developer,
        recordEnvelope("claim", validClaimBody({ id, body })),
      );
    }
    for (const value of ["src/a.ts", "src/b.ts", "src/c.ts"]) {
      await postRecords(
        setup.harness,
        setup.developer,
        recordEnvelope("target", {
          workContextId: WORK_CONTEXT_ID,
          kind: "file",
          value,
        }),
      );
    }

    const rows = await list(setup);

    expect(rows[0]?.claimCount).toBe(2);
    expect(rows[0]?.targetCount).toBe(3);
  });

  test("the window the reader asks for is applied by the hub, not after it", async () => {
    // Arrange: one context inside the briefing's 14-day window, one well
    // outside it. Both belong to this repo and this reader.
    const setup = await createHarnessWithSession();
    await postRecords(
      setup.harness,
      setup.developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );
    await setup.harness.db.execute(sql`
      INSERT INTO work_contexts (id, session_id, title, status, created_at, updated_at)
      SELECT 'wc_ancient', session_id, 'Ancient investigation', 'analyzing',
             created_at - interval '90 days', NULL
      FROM work_contexts WHERE id = ${WORK_CONTEXT_ID}
    `);

    // Act
    const windowed = await list(setup, `${REPO_QUERY}&since=14d`);
    const everything = await list(setup);

    // Assert: the window drops it, and the control — without the window the
    // same row is still there, so this is a filter and not a missing record.
    expect(windowed.map((row) => row.id)).toEqual([WORK_CONTEXT_ID]);
    expect([...everything.map((row) => row.id)].sort()).toEqual([
      WORK_CONTEXT_ID,
      "wc_ancient",
    ]);
  });

  test("an unreadable window still answers — it is not a filter the caller chose", async () => {
    // /api/search refuses a bad `since` loudly, because there it is the
    // question. Here it is the reader's own render window, and refusing would
    // cost the briefing its whole related-work section over a typo.
    const setup = await createHarnessWithSession();
    await postRecords(
      setup.harness,
      setup.developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );

    const rows = await list(setup, `${REPO_QUERY}&since=fortnight`);

    expect(rows.map((row) => row.id)).toEqual([WORK_CONTEXT_ID]);
  });

  test("more contexts than the bound are answered freshest first, and bounded", async () => {
    // Arrange: WORK_CONTEXT_LIST_LIMIT + 5 contexts, each one minute older
    // than the last, all inside the window.
    const setup = await createHarnessWithSession();
    await postRecords(
      setup.harness,
      setup.developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );
    const extra = WORK_CONTEXT_LIST_LIMIT + 5;
    await setup.harness.db.execute(sql`
      INSERT INTO work_contexts (id, session_id, title, status, created_at, updated_at)
      SELECT 'wc_bulk_' || lpad(g::text, 4, '0'),
             (SELECT session_id FROM work_contexts WHERE id = ${WORK_CONTEXT_ID}),
             'Bulk investigation ' || g,
             'analyzing',
             (SELECT created_at FROM work_contexts WHERE id = ${WORK_CONTEXT_ID}) - make_interval(days => 1),
             (SELECT created_at FROM work_contexts WHERE id = ${WORK_CONTEXT_ID}) - make_interval(mins => g::int)
      FROM generate_series(1, ${extra}) g
    `);

    // Act
    const rows = await list(setup, `${REPO_QUERY}&since=14d`);

    // Assert: bounded, and the rows kept are the FRESHEST ones — a bound that
    // kept the oldest would hide exactly the work the section exists to show.
    expect(rows).toHaveLength(WORK_CONTEXT_LIST_LIMIT);
    expect(rows[0]?.id).toBe(WORK_CONTEXT_ID);
    expect(rows[1]?.id).toBe("wc_bulk_0001");
    expect(rows.map((row) => row.id)).not.toContain(
      `wc_bulk_${String(extra).padStart(4, "0")}`,
    );
  });

  test("one busy teammate cannot push another out of the answer entirely", async () => {
    // The bound is per-DEVELOPER before it is global, because the reader of
    // this listing groups per developer and shows one line each. A flat
    // freshest-200 cut hands back one person's 200 worktrees and drops the
    // teammate whose single live investigation is the whole reason to read
    // the section — and nothing downstream can say so, because a person who
    // never arrived cannot be counted as folded away.
    const setup = await createHarnessWithSession();
    await postRecords(
      setup.harness,
      setup.developer,
      recordEnvelope("work_context", validWorkContextBody()),
    );
    await setup.harness.db.execute(sql`
      UPDATE work_contexts
         SET created_at = now() - make_interval(hours => 5),
             updated_at = now() - make_interval(hours => 5)
       WHERE id = ${WORK_CONTEXT_ID}
    `);
    const quiet = await addTestDeveloperWithSession(
      setup.harness,
      "Mike",
      "mike@example.com",
      { id: "cc_22222222-3333-4444-8555-666666666666" },
    );
    // Mike: ONE context, ten hours old — inside the 14-day window and older
    // than every one of Nick's, so a flat cut is guaranteed to lose it.
    await postRecords(
      setup.harness,
      quiet,
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          id: "wc_mike_only",
          sessionId: "cc_22222222-3333-4444-8555-666666666666",
          title: "Mike is halfway through the importer retry",
        }),
        { sessionId: "cc_22222222-3333-4444-8555-666666666666" },
      ),
    );
    await setup.harness.db.execute(sql`
      UPDATE work_contexts
         SET created_at = now() - make_interval(hours => 10),
             updated_at = now() - make_interval(hours => 10)
       WHERE id = 'wc_mike_only'
    `);
    // Nick: WORK_CONTEXT_LIST_LIMIT + 5 contexts, every one fresher than that.
    const extra = WORK_CONTEXT_LIST_LIMIT + 5;
    await setup.harness.db.execute(sql`
      INSERT INTO work_contexts (id, session_id, title, status, created_at, updated_at)
      SELECT 'wc_busy_' || lpad(g::text, 4, '0'),
             (SELECT session_id FROM work_contexts WHERE id = ${WORK_CONTEXT_ID}),
             'Worktree ' || g,
             'analyzing',
             now() - make_interval(mins => g::int),
             now() - make_interval(mins => g::int)
      FROM generate_series(1, ${extra}) g
    `);

    // Act: exactly what the connector sends.
    const rows = await list(setup, `${REPO_QUERY}&since=14d`);

    // Assert: still bounded, and both people are in the answer.
    expect(rows).toHaveLength(WORK_CONTEXT_LIST_LIMIT);
    expect(rows.map((row) => row.id)).toContain("wc_mike_only");
    expect(new Set(rows.map((row) => row.developerId)).size).toBe(2);
    // …and breadth comes first: the freshest context of each person leads the
    // answer, so the reader's grouping still meets people newest-first.
    expect(rows[0]?.id).toBe("wc_busy_0001");
    expect(rows[1]?.id).toBe("wc_mike_only");
  });
});
