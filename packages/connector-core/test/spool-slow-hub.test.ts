/**
 * A HUB SLOWER THAN THE REQUEST BOUND (release gate on ubuntu-latest,
 * 2026-10-13). A resumed life re-files its root in one late lane pass, two
 * batches of records, and the hub took 406 ms for the first: the connector
 * abandoned the request at the 400 ms bound although the hub had stored it,
 * the cursor stayed, and the rest waited for a hook that never came. Two
 * answers here (spool/flush.ts):
 *  - a hook nobody waits for (Stop, SubagentStop) gives a records request the
 *    room left in its envelope, not the bound a waiting host needs;
 *  - a request that timed out is sent again in the same drain with half the
 *    lines it carried, down to MIN_FLUSH_BATCH_LINES, and what an earlier walk
 *    wrote down beyond the smaller batch rides the cursor past it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, rm } from "node:fs/promises";

import { MAX_INGEST_BATCH, MIN_FLUSH_BATCH_LINES } from "../src/constants.ts";
import { sessionSlug, spoolCursorPath, spoolDataPath } from "../src/config/paths.ts";
import { lineEnds, writeCountedLines } from "../src/spool/cursor.ts";
import { readDropDetail } from "../src/spool/drops.ts";
import { flushSpool } from "../src/spool/flush.ts";
import { readFileFacts } from "../src/spool/identity.ts";
import { appendRecords, readSpoolLines, repoKey } from "../src/index.ts";
import { loopbackUrl, serveLoopback } from "./fixtures/loopback-serve.ts";
import { makeHome } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
const HUB_URL = "http://127.0.0.1:9";
const NOW = new Date("2026-10-13T12:00:00.000Z");
const SESSION = "session-slow";
const KEY = repoKey(HUB_URL, REPO_ID);
const SLUG = sessionSlug(SESSION);
const PRODUCER = { sessionId: "cc_live", developerId: "dev_1" };

/** The per-request bound these tests give the hub context: the product's 400 ms, scaled down. */
const REQUEST_BOUND_MS = 150;
/** How long the slow hub holds a batch it was sent: past the bound, inside the room. */
const SLOW_ANSWER_MS = 450;
/** The room a drain is given: several slow answers wide. */
const ROOM_MS = 6000;
/** The largest batch the half-speed hub answers in time. */
const FAST_UP_TO = 24;

const cleanups: string[] = [];
const servers: { stop: (force?: boolean) => void }[] = [];

afterEach(async () => {
  for (const server of servers) {
    server.stop(true);
  }
  servers.length = 0;
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
  cleanups.length = 0;
});

const envelope = (index: number): Record<string, unknown> => ({
  cx: "0.1",
  id: `env_${String(index)}`,
  ts: NOW.toISOString(),
  producer: { developerId: "dev_1", agentKind: "claude-code", sessionId: "cc_old" },
  kind: "target",
  body: { workContextId: "wc_1", kind: "file", value: `src/file-${String(index)}.ts`, source: "git_diff" },
});

/** A hub that answers a batch of more than `fastUpTo` records only after `slowMs`, and records every batch size it was sent. */
const slowHub = (sizes: number[], fastUpTo: number, slowMs = SLOW_ANSWER_MS) => {
  const server = serveLoopback({
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as { records: readonly unknown[] };
      sizes.push(body.records.length);
      if (body.records.length > fastUpTo) {
        await Bun.sleep(slowMs);
      }
      return Response.json({
        ok: true,
        data: { accepted: body.records.length, duplicates: 0, ignored: 0, rejected: 0 },
      });
    },
  });
  servers.push(server);
  return server;
};

const spooled = async (count: number): Promise<string> => {
  const home = await makeHome("slow-hub");
  cleanups.push(home);
  await appendRecords(home, KEY, SESSION, Array.from({ length: count }, (_, index) => envelope(index + 1)), NOW);
  return home;
};

const ctxFor = (home: string, server: { readonly port: number | undefined }) => ({
  hubUrl: loopbackUrl(server),
  apiKey: "key",
  keyOrigin: loopbackUrl(server),
  timeoutMs: REQUEST_BOUND_MS,
  home,
  repoKey: KEY,
  now: () => NOW,
});

describe("an answerless hook gives a records request the room left in its envelope", () => {
  test("a batch the hub answers past the request bound is delivered when nobody waits for the hook", async () => {
    // Arrange
    const home = await spooled(30);
    const sizes: number[] = [];
    const server = slowHub(sizes, 0);

    // Act
    const outcome = await flushSpool(ctxFor(home, server), { ...PRODUCER, isAnswerless: true }, ROOM_MS);

    // Assert: one request, waited out
    expect(outcome).toEqual({ outcome: "flushed", sent: 30, remaining: 0 });
    expect(sizes).toEqual([30]);
    expect(await readSpoolLines(home, KEY)).toHaveLength(0);
  });

  test("a hook a host waits for keeps the request bound, and the records stay on disk", async () => {
    // Arrange
    const home = await spooled(30);
    const sizes: number[] = [];
    const server = slowHub(sizes, 0);

    // Act
    const outcome = await flushSpool(ctxFor(home, server), PRODUCER, ROOM_MS);

    // Assert
    expect(outcome).toEqual({ outcome: "failed", remaining: 30 });
    expect(await readSpoolLines(home, KEY)).toHaveLength(30);
  });
});

describe("a records request that timed out is sent again in the same drain with half its lines", () => {
  test("the batch halves until the hub answers in time, and the drain delivers everything at that size", async () => {
    // Arrange: 60 records; the hub is in time for 24 or fewer
    const home = await spooled(60);
    const sizes: number[] = [];
    const server = slowHub(sizes, FAST_UP_TO);

    // Act
    const outcome = await flushSpool(ctxFor(home, server), PRODUCER, ROOM_MS);

    // Assert: 60 and 30 timed out, 15 went, and the drain stayed at 15
    expect(outcome).toEqual({ outcome: "flushed", sent: 60, remaining: 0 });
    expect(sizes).toEqual([60, 30, 15, 15, 15, 15]);
  });

  test("a batch that times out at the floor ends the drain, every record still on disk", async () => {
    // Arrange: a hub in time for nothing
    const home = await spooled(MAX_INGEST_BATCH * 2);
    const sizes: number[] = [];
    const server = slowHub(sizes, 0);

    // Act
    const outcome = await flushSpool(ctxFor(home, server), PRODUCER, ROOM_MS);

    // Assert: halved down to the floor, never below it, and nothing consumed
    expect(outcome).toEqual({ outcome: "failed", remaining: MAX_INGEST_BATCH * 2 });
    expect(sizes).toEqual([MAX_INGEST_BATCH - 1, 49, 24, 12, MIN_FLUSH_BATCH_LINES]);
  });

  test("a hub that refuses is not asked again with a smaller batch", async () => {
    // Arrange
    const home = await spooled(30);
    const sizes: number[] = [];
    const server = serveLoopback({
      port: 0,
      fetch: async (request) => {
        sizes.push(((await request.json()) as { records: readonly unknown[] }).records.length);
        return Response.json({ ok: false, error: { code: "unavailable", message: "down" } }, { status: 503 });
      },
    });
    servers.push(server);

    // Act
    const outcome = await flushSpool(ctxFor(home, server), PRODUCER, ROOM_MS);

    // Assert
    expect(outcome).toEqual({ outcome: "failed", remaining: 30 });
    expect(sizes).toEqual([30]);
  });

  test("a line an earlier walk counted beyond the smaller batch is not counted again when the cursor passes the batch", async () => {
    // Arrange: 59 records with a torn line at position 40, which an earlier
    // walk already counted and wrote down on the cursor at offset 0
    const home = await spooled(39);
    const dataPath = spoolDataPath(home, KEY, SLUG);
    await appendFile(dataPath, "{torn\n", "utf8");
    await appendRecords(home, KEY, SESSION, Array.from({ length: 20 }, (_, index) => envelope(index + 100)), NOW);
    const raw = await Bun.file(dataPath).text();
    const tornEnd = lineEnds(raw, 40, 0)[39] ?? -1;
    const facts = await readFileFacts(dataPath);
    if (facts === null) {
      throw new Error("the spool's data file is missing");
    }
    await writeCountedLines(dataPath, spoolCursorPath(home, KEY, SLUG), 0, new Set([tornEnd]), facts);
    const sizes: number[] = [];
    const server = slowHub(sizes, FAST_UP_TO);

    // Act
    const outcome = await flushSpool(ctxFor(home, server), PRODUCER, ROOM_MS);

    // Assert: every record delivered, the torn line counted by nobody here
    expect(outcome).toEqual({ outcome: "flushed", sent: 59, remaining: 0 });
    expect((await readDropDetail(home, KEY)).byReason["unparsable"]).toBeUndefined();
  });
});
