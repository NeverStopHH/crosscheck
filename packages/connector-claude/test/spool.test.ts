import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, rm, utimes, writeFile } from "node:fs/promises";

import {
  MAX_SPOOL_BYTES,
  SPOOL_REAP_GRACE_MS,
  appendRecords,
  flushSpool,
  readDropSummary,
  readSpoolLines,
  reapSpool,
  repoKey,
} from "../src/index.ts";
import {
  ensureDir,
  readTextOrNull,
  sessionSlug,
  spoolCursorPath,
  spoolDataPath,
  spoolDir,
  spoolDropsPath,
} from "../src/config/paths.ts";
import { writeSessionState } from "../src/state/session-state.ts";
import { makeHome } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
const HUB_URL = "http://127.0.0.1:9";
const NOW = new Date("2026-07-26T12:00:00.000Z");
const SESSION = "session-a";
const KEY = repoKey(HUB_URL, REPO_ID);
const SLUG = sessionSlug(SESSION);

/** No hook hosts these flushes, so nothing bounds them but the batch ceiling. */
const AMPLE_BUDGET_MS = 60_000;

const homes: string[] = [];

const home = async (): Promise<string> => {
  const path = await makeHome("spool");
  homes.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(homes.map((path) => rm(path, { recursive: true, force: true })));
  homes.length = 0;
});

const envelope = (index: number): Record<string, unknown> => ({
  cx: "0.1",
  id: `env_${index}`,
  ts: NOW.toISOString(),
  producer: {
    developerId: "unknown",
    agentKind: "claude-code",
    sessionId: "cc_old",
  },
  kind: "target",
  body: { workContextId: "wc_1", kind: "file", value: `src/file-${index}.ts` },
});

const hubContext = (path: string, hubUrl = HUB_URL) => ({
  hubUrl,
  apiKey: "key",
  timeoutMs: 2000,
  home: path,
  repoKey: KEY,
  now: () => NOW,
});

const acceptingHub = (received: unknown[] = []) =>
  Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as { records: readonly unknown[] };
      received.push(...body.records);
      return Response.json({
        ok: true,
        data: {
          accepted: body.records.length,
          duplicates: 0,
          ignored: 0,
          rejected: 0,
        },
      });
    },
  });

/**
 * Fills a session's data file to the byte cap with ONE valid record, so a test
 * about the cap is not secretly also a test about unparsable lines.
 */
const fillToCap = async (path: string): Promise<void> => {
  const skeleton = JSON.stringify({ ...envelope(0), body: { pad: "" } });
  const pad = "p".repeat(MAX_SPOOL_BYTES - skeleton.length);
  await ensureDir(spoolDir(path, KEY));
  await writeFile(
    spoolDataPath(path, KEY, SLUG),
    `${JSON.stringify({ ...envelope(0), body: { pad } })}\n`,
    "utf8",
  );
};

/**
 * Backdates a data file past the reap grace, which is how a test says "the
 * appenders of this session have stopped". Reap refuses to remove a file that
 * was written moments ago, because an appender may be between its open and its
 * write on it.
 */
const idlePastGrace = async (path: string): Promise<void> => {
  const when = new Date(NOW.getTime() - SPOOL_REAP_GRACE_MS * 2);
  await utimes(path, when, when);
};

const liveSession = async (path: string, sessionId: string): Promise<void> => {
  await writeSessionState(path, {
    claudeSessionId: sessionId,
    crosscheckSessionId: `cc_${sessionId}`,
    workContextId: `wc_cc_${sessionId}`,
    repoId: REPO_ID,
    repoRoot: "/tmp/repo",
    hubUrl: HUB_URL,
    developerId: "dev_1",
    startedAt: NOW.toISOString(),
    lastHeartbeatAt: null,
    seenTargets: [],
  });
};

describe("spool append", () => {
  test("writes a batch to the session's own file and reports it persisted", async () => {
    // Arrange
    const path = await home();

    // Act
    const result = await appendRecords(
      path,
      KEY,
      SESSION,
      [envelope(1), envelope(2)],
      NOW,
    );

    // Assert
    expect(result).toEqual({ persisted: true, dropped: 0 });
    expect(await readSpoolLines(path, KEY)).toHaveLength(2);
    expect(await Bun.file(spoolDataPath(path, KEY, SLUG)).exists()).toBe(true);
  });

  test("keeps two sessions in separate files that both read back", async () => {
    // Arrange
    const path = await home();

    // Act
    await appendRecords(path, KEY, "session-a", [envelope(1)], NOW);
    await appendRecords(path, KEY, "session-b", [envelope(2)], NOW);

    // Assert
    expect(await readSpoolLines(path, KEY)).toHaveLength(2);
    expect(
      await Bun.file(spoolDataPath(path, KEY, sessionSlug("session-b"))).exists(),
    ).toBe(true);
  });

  test("refuses a batch at the byte cap and counts it in the drops ledger", async () => {
    // Arrange: the session's file is already at MAX_SPOOL_BYTES
    const path = await home();
    await fillToCap(path);
    const before = await readTextOrNull(spoolDataPath(path, KEY, SLUG));

    // Act
    const result = await appendRecords(
      path,
      KEY,
      SESSION,
      [envelope(1), envelope(2), envelope(3)],
      NOW,
    );

    // Assert: refused, counted, and the file was not touched to make room
    expect(result).toEqual({ persisted: false, dropped: 3 });
    expect(await readTextOrNull(spoolDataPath(path, KEY, SLUG))).toBe(
      before as string,
    );
    expect(await readDropSummary(path, KEY)).toEqual({
      records: 3,
      entries: 1,
      malformed: 0,
    });
  });

  test("survives a lock file left behind by another process", async () => {
    // Arrange: appends take no lock at all, so a held lock must not matter
    const path = await home();
    await ensureDir(spoolDir(path, KEY));
    await writeFile(`${spoolDir(path, KEY)}/flush.lock`, "42:other\n", "utf8");

    // Act
    const result = await appendRecords(path, KEY, SESSION, [envelope(1)], NOW);

    // Assert
    expect(result.persisted).toBe(true);
    expect(await readSpoolLines(path, KEY)).toHaveLength(1);
    expect((await readDropSummary(path, KEY)).records).toBe(0);
  });

  test("treats a half-landed write as a record only once the rest arrives", async () => {
    // Arrange
    const path = await home();
    await appendRecords(path, KEY, SESSION, [envelope(1)], NOW);
    const whole = JSON.stringify(envelope(2));
    const split = whole.length - 12;
    await appendFile(spoolDataPath(path, KEY, SLUG), whole.slice(0, split), "utf8");

    // Act
    const midWrite = await readSpoolLines(path, KEY);
    await appendFile(
      spoolDataPath(path, KEY, SLUG),
      `${whole.slice(split)}\n`,
      "utf8",
    );
    const settled = await readSpoolLines(path, KEY);

    // Assert
    expect(midWrite).toHaveLength(1);
    expect(settled).toHaveLength(2);
    expect(settled[1]).toBe(whole);
  });
});

describe("spool flush", () => {
  test("leaves every byte on disk when the hub is unreachable", async () => {
    // Arrange
    const path = await home();
    await appendRecords(path, KEY, SESSION, [envelope(1), envelope(2)], NOW);
    const before = await readTextOrNull(spoolDataPath(path, KEY, SLUG));

    // Act
    const outcome = await flushSpool(hubContext(path), {
      sessionId: "cc_live",
      developerId: "dev_1",
    }, AMPLE_BUDGET_MS);

    // Assert
    expect(outcome).toEqual({ outcome: "failed", remaining: 2 });
    expect(await readTextOrNull(spoolDataPath(path, KEY, SLUG))).toBe(
      before as string,
    );
    expect(await readSpoolLines(path, KEY)).toHaveLength(2);
  });

  test("advances the cursor instead of rewriting the file", async () => {
    // Arrange
    const path = await home();
    await appendRecords(path, KEY, SESSION, [envelope(1)], NOW);
    const before = await readTextOrNull(spoolDataPath(path, KEY, SLUG));
    const server = acceptingHub();

    // Act
    await flushSpool(hubContext(path, `http://127.0.0.1:${server.port}`), {
      sessionId: "cc_live",
      developerId: "dev_live",
    }, AMPLE_BUDGET_MS);

    // Assert: nothing pending, and not one byte of the data file moved
    expect(await readSpoolLines(path, KEY)).toHaveLength(0);
    expect(await readTextOrNull(spoolDataPath(path, KEY, SLUG))).toBe(
      before as string,
    );
    expect(await Bun.file(spoolCursorPath(path, KEY, SLUG)).exists()).toBe(true);
    server.stop(true);
  });

  test("rewrites the producer to the live session before sending", async () => {
    // Arrange
    const path = await home();
    await appendRecords(path, KEY, SESSION, [envelope(1)], NOW);
    const received: unknown[] = [];
    const server = acceptingHub(received);

    // Act
    const outcome = await flushSpool(
      hubContext(path, `http://127.0.0.1:${server.port}`),
      { sessionId: "cc_live", developerId: "dev_live" },
      AMPLE_BUDGET_MS,
    );

    // Assert
    expect(outcome).toEqual({ outcome: "flushed", sent: 1, remaining: 0 });
    const record = received[0] as { producer: Record<string, string> };
    expect(record.producer).toEqual({
      developerId: "dev_live",
      agentKind: "claude-code",
      sessionId: "cc_live",
    });
    server.stop(true);
  });

  test("counts a complete line that is not JSON instead of losing it", async () => {
    // Arrange: exactly what a torn write plus a later record leaves behind
    const path = await home();
    await appendRecords(path, KEY, SESSION, [envelope(1)], NOW);
    await appendFile(
      spoolDataPath(path, KEY, SLUG),
      '{"id":"env_torn","bo\n',
      "utf8",
    );
    const server = acceptingHub();

    // Act
    await flushSpool(hubContext(path, `http://127.0.0.1:${server.port}`), {
      sessionId: "cc_live",
      developerId: "dev_live",
    }, AMPLE_BUDGET_MS);

    // Assert: the fragment is a counted drop, not a silent hole
    expect(await readSpoolLines(path, KEY)).toHaveLength(0);
    expect(await readDropSummary(path, KEY)).toEqual({
      records: 1,
      entries: 1,
      malformed: 0,
    });
    server.stop(true);
  });

  test("drops a batch the hub accepted even when it rejected records", async () => {
    // Arrange
    const path = await home();
    await appendRecords(path, KEY, SESSION, [envelope(1)], NOW);
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          ok: true,
          data: { accepted: 0, duplicates: 0, ignored: 0, rejected: 1 },
        }),
    });

    // Act
    await flushSpool(hubContext(path, `http://127.0.0.1:${server.port}`), {
      sessionId: "cc_live",
      developerId: "dev_live",
    }, AMPLE_BUDGET_MS);

    // Assert
    expect(await readSpoolLines(path, KEY)).toHaveLength(0);
    server.stop(true);
  });
});

describe("spool reap", () => {
  test("never removes the file of a session that is still live", async () => {
    // Arrange: delivered in full, but its session still exists
    const path = await home();
    await liveSession(path, SESSION);
    await appendRecords(path, KEY, SESSION, [envelope(1)], NOW);
    const server = acceptingHub();
    await flushSpool(hubContext(path, `http://127.0.0.1:${server.port}`), {
      sessionId: "cc_live",
      developerId: "dev_live",
    }, AMPLE_BUDGET_MS);

    // Act
    const result = await reapSpool(path, KEY, NOW);

    // Assert
    expect(result).toEqual({ delivered: 0, expired: 0, dropped: 0 });
    expect(await Bun.file(spoolDataPath(path, KEY, SLUG)).exists()).toBe(true);
    server.stop(true);
  });

  test("removes a dead session's file once everything reached the hub", async () => {
    // Arrange: no session state file — the session is gone — and its file has
    // not been written to since, so no appender can be holding it
    const path = await home();
    await appendRecords(path, KEY, SESSION, [envelope(1)], NOW);
    const server = acceptingHub();
    await flushSpool(hubContext(path, `http://127.0.0.1:${server.port}`), {
      sessionId: "cc_live",
      developerId: "dev_live",
    }, AMPLE_BUDGET_MS);
    await idlePastGrace(spoolDataPath(path, KEY, SLUG));

    // Act
    const result = await reapSpool(path, KEY, NOW);

    // Assert
    expect(result).toEqual({ delivered: 1, expired: 0, dropped: 0 });
    expect(await Bun.file(spoolDataPath(path, KEY, SLUG)).exists()).toBe(false);
    expect(await Bun.file(spoolCursorPath(path, KEY, SLUG)).exists()).toBe(false);
    server.stop(true);
  });

  test("keeps a dead session's undelivered file until a flush has sent it", async () => {
    // Arrange
    const path = await home();
    await appendRecords(path, KEY, SESSION, [envelope(1)], NOW);

    // Act: reap before delivery, then deliver, then reap again
    await idlePastGrace(spoolDataPath(path, KEY, SLUG));
    const early = await reapSpool(path, KEY, NOW);
    const kept = await Bun.file(spoolDataPath(path, KEY, SLUG)).exists();
    const received: unknown[] = [];
    const server = acceptingHub(received);
    await flushSpool(hubContext(path, `http://127.0.0.1:${server.port}`), {
      sessionId: "cc_live",
      developerId: "dev_live",
    }, AMPLE_BUDGET_MS);
    const late = await reapSpool(path, KEY, NOW);

    // Assert
    expect(early).toEqual({ delivered: 0, expired: 0, dropped: 0 });
    expect(kept).toBe(true);
    expect(received).toHaveLength(1);
    expect(late.delivered).toBe(1);
    expect(await Bun.file(spoolDataPath(path, KEY, SLUG)).exists()).toBe(false);
    server.stop(true);
  });

  test("counts the records of an undelivered file it removes for age", async () => {
    // Arrange: a dead session's file, untouched for longer than the age cap
    const path = await home();
    await appendRecords(path, KEY, SESSION, [envelope(1), envelope(2)], NOW);
    const muchLater = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);

    // Act
    const result = await reapSpool(path, KEY, muchLater);

    // Assert: the records are gone from disk AND visible in the ledger
    expect(result).toEqual({ delivered: 0, expired: 1, dropped: 2 });
    expect(await Bun.file(spoolDataPath(path, KEY, SLUG)).exists()).toBe(false);
    expect((await readDropSummary(path, KEY)).records).toBe(2);
  });

  test("keeps the drops ledger after the data file it belongs to is reaped", async () => {
    // Arrange: a cap drop, then the session ends with nothing left pending
    const path = await home();
    await fillToCap(path);
    await appendRecords(path, KEY, SESSION, [envelope(1)], NOW);
    const server = acceptingHub();
    await flushSpool(hubContext(path, `http://127.0.0.1:${server.port}`), {
      sessionId: "cc_live",
      developerId: "dev_live",
    }, AMPLE_BUDGET_MS);

    // Act
    await reapSpool(path, KEY, NOW);

    // Assert: the drop stays surfaceable after the spool file is gone
    expect(await Bun.file(spoolDropsPath(path, KEY, SLUG)).exists()).toBe(true);
    expect((await readDropSummary(path, KEY)).records).toBe(1);
    server.stop(true);
  });

  test("delivers a stray append that recreated a file after it was reaped", async () => {
    // Arrange: reap the file, then let a late hook append to the same session
    const path = await home();
    await appendRecords(path, KEY, SESSION, [envelope(1)], NOW);
    const received: unknown[] = [];
    const server = acceptingHub(received);
    const ctx = hubContext(path, `http://127.0.0.1:${server.port}`);
    await flushSpool(ctx, { sessionId: "cc_live", developerId: "dev_live" }, AMPLE_BUDGET_MS);
    await idlePastGrace(spoolDataPath(path, KEY, SLUG));
    await reapSpool(path, KEY, NOW);
    const reaped = await Bun.file(spoolDataPath(path, KEY, SLUG)).exists();

    // Act
    const stray = await appendRecords(path, KEY, SESSION, [envelope(99)], NOW);
    await flushSpool(ctx, { sessionId: "cc_live", developerId: "dev_live" }, AMPLE_BUDGET_MS);

    // Assert: recreated, delivered, and never read against the old cursor
    expect(reaped).toBe(false);
    expect(stray.persisted).toBe(true);
    expect(received).toHaveLength(2);
    expect(JSON.stringify(received[1])).toContain('"id":"env_99"');
    expect(await readSpoolLines(path, KEY)).toHaveLength(0);
    server.stop(true);
  });
});