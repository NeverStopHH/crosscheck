/**
 * `GET /api/work-contexts` gets a window (trial finding M8).
 *
 * The listing had no LIMIT, no `since` and no cap: 127 rows / 56 928 bytes on
 * the trial hub after three days, growing ~40 a day, fetched by six parallel
 * GETs at every SessionStart under a 400 ms budget — 2000 ms for the teammate
 * reaching it over tailscale.
 *
 * The compatibility half is the subtle one and it is pinned here: the SERVER
 * still defaults to "everything", capped and newest-first, because a
 * server-side default window would silently truncate every 0.7.2 connector,
 * which sends no parameters at all.
 */
import { describe, expect, test } from "bun:test";

import { WORK_CONTEXT_LIST_MAX } from "../src/constants.ts";
import {
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  validWorkContextBody,
} from "./helpers.ts";
import type { HarnessWithSession } from "./helpers.ts";

const REPO = "github.com/acme/api";
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = new Date("2026-07-24T09:00:00.000Z").getTime();

interface ListRow {
  readonly id: string;
  readonly createdAt: string;
  readonly claimCount: number;
  readonly targetCount: number;
}

const listWith = async (
  seeded: HarnessWithSession,
  query: string,
): Promise<readonly ListRow[]> => {
  const response = await seeded.harness.app.request(
    `/api/work-contexts?repo=${encodeURIComponent(REPO)}${query}`,
    jsonRequest("GET", seeded.developer.apiKey),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { workContexts: ListRow[] } };
  return body.data.workContexts;
};

/** `count` contexts, one per day going backwards from NOW_MS. */
const seedContexts = async (
  seeded: HarnessWithSession,
  count: number,
): Promise<void> => {
  const records = Array.from({ length: count }, (_unused, index) =>
    recordEnvelope(
      "work_context",
      validWorkContextBody({
        id: `wc_${String(index).padStart(3, "0")}`,
        title: `context ${String(index)}`,
        createdAt: new Date(NOW_MS - index * DAY_MS).toISOString(),
      }),
    ),
  );
  // Batched: the ingest route caps one POST at MAX_INGEST_BATCH.
  for (let start = 0; start < records.length; start += 50) {
    const batch = records.slice(start, start + 50);
    const result = await postRecords(seeded.harness, seeded.developer, {
      records: batch,
    });
    expect(result.data?.accepted).toBe(batch.length);
  }
};

describe("work-context listing window", () => {
  test("?since= returns only the contexts inside it", async () => {
    // Arrange: five contexts — three of them older than 14 days
    const seeded = await createHarnessWithSession();
    await seedContexts(seeded, 2);
    await postRecords(seeded.harness, seeded.developer, {
      records: [15, 20, 30].map((daysAgo) =>
        recordEnvelope(
          "work_context",
          validWorkContextBody({
            id: `wc_old_${String(daysAgo)}`,
            title: `old ${String(daysAgo)}`,
            createdAt: new Date(NOW_MS - daysAgo * DAY_MS).toISOString(),
          }),
        ),
      ),
    });
    const since = new Date(NOW_MS - 14 * DAY_MS).toISOString();

    // Act
    const windowed = await listWith(seeded, `&since=${encodeURIComponent(since)}`);
    const all = await listWith(seeded, "");

    // Assert
    expect(windowed).toHaveLength(2);
    expect(all).toHaveLength(5);
  });

  test("?limit= bounds the page, newest first", async () => {
    // Arrange
    const seeded = await createHarnessWithSession();
    await seedContexts(seeded, 5);

    // Act
    const one = await listWith(seeded, "&limit=1");

    // Assert: the NEWEST survives a truncation, never an arbitrary row
    expect(one).toHaveLength(1);
    expect(one[0]?.id).toBe("wc_000");
  });

  test("an OLD connector sending no parameters still gets rows, capped", async () => {
    // Arrange: more contexts than the cap
    const seeded = await createHarnessWithSession();
    await seedContexts(seeded, WORK_CONTEXT_LIST_MAX + 20);

    // Act: exactly what a 0.7.2 connector sends
    const rows = await listWith(seeded, "");

    // Assert: the cap, not a server-chosen window — and the newest end of it
    expect(rows).toHaveLength(WORK_CONTEXT_LIST_MAX);
    expect(rows[0]?.id).toBe("wc_000");
  });

  test("an over-large limit is capped rather than rejected", async () => {
    // Arrange
    const seeded = await createHarnessWithSession();
    await seedContexts(seeded, 3);

    // Act
    const rows = await listWith(seeded, "&limit=100000");

    // Assert: a hook path must get an answer, never a 400
    expect(rows).toHaveLength(3);
  });

  test("an unparseable since is ignored, not a 400", async () => {
    // Arrange
    const seeded = await createHarnessWithSession();
    await seedContexts(seeded, 3);

    // Act
    const rows = await listWith(seeded, "&since=not-a-date");

    // Assert
    expect(rows).toHaveLength(3);
  });
});
