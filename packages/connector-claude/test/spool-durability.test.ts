/**
 * The five ways a record could still go missing, one describe each.
 *
 * Every test here is a reproduction first and a regression guard second: each
 * one failed against the code that shipped before it, and the failure was
 * always the same shape — a record that is neither on disk, nor delivered, nor
 * counted in `.drops`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { open, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import {
  MAX_INGEST_BATCH,
  SPOOL_REAP_GRACE_MS,
  appendRecords,
  flushSpool,
  readDropSummary,
  readSpoolLines,
  readUnclosedSummary,
  reapSpool,
  repoKey,
} from "../src/index.ts";
import {
  PRIVATE_FILE_MODE,
  MS_PER_DAY,
  MS_PER_SECOND,
  MAX_SPOOL_AGE_DAYS,
} from "../src/constants.ts";
import {
  ensureDir,
  removeFile,
  sessionSlug,
  spoolCursorPath,
  spoolDataPath,
  spoolDir,
  spoolDropsPath,
  spoolPendingEndPath,
} from "../src/config/paths.ts";
import { writeCursorOffset } from "../src/spool/cursor.ts";
import { recordDrop } from "../src/spool/drops.ts";
import { readSessionSpool } from "../src/spool/files.ts";
import type { SessionSpool } from "../src/spool/files.ts";
import { rescueTail } from "../src/spool/reap.ts";
import { appendOnce, appendThroughHandle } from "../src/spool/write.ts";
import { writeSessionState } from "../src/state/session-state.ts";
import { makeHome } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
const HUB_URL = "http://127.0.0.1:9";
const NOW = new Date("2026-07-26T12:00:00.000Z");
const KEY = repoKey(HUB_URL, REPO_ID);
const SESSION = "session-a";
const SLUG = sessionSlug(SESSION);

/** No hook hosts these flushes, so nothing bounds them but the batch ceiling. */
const AMPLE_BUDGET_MS = 60_000;

const homes: string[] = [];

const home = async (): Promise<string> => {
  const path = await makeHome("spool-durability");
  homes.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(homes.map((path) => rm(path, { recursive: true, force: true })));
  homes.length = 0;
});

const envelope = (id: string, at: Date = NOW): Record<string, unknown> => ({
  cx: "0.1",
  id,
  ts: at.toISOString(),
  producer: {
    developerId: "unknown",
    agentKind: "claude-code",
    sessionId: "cc_old",
  },
  kind: "target",
  body: { workContextId: "wc_1", kind: "file", value: `src/${id}.ts` },
});

const hubContext = (path: string, hubUrl: string, now: Date = NOW) => ({
  hubUrl,
  apiKey: "key",
  timeoutMs: 5000,
  home: path,
  repoKey: KEY,
  now: () => now,
});

const acceptingHub = (received: string[]) =>
  Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as {
        records: readonly { id: string }[];
      };
      received.push(...body.records.map((record) => record.id));
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

/** Backdates a data file so it reads as an appender that has gone quiet. */
const idleSince = async (path: string, ageMs: number): Promise<void> => {
  const when = new Date(NOW.getTime() - ageMs);
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

describe("reap against an appender that holds a handle", () => {
  test("keeps a data file an appender created but has not written to yet", async () => {
    // Arrange: exactly what appendOnce does first — open(path, "a") CREATES the
    // file at zero length, and the write follows as a separate syscall.
    const path = await home();
    const dataPath = spoolDataPath(path, KEY, SLUG);
    await ensureDir(spoolDir(path, KEY));
    const handle = await open(dataPath, "a", PRIVATE_FILE_MODE);

    // Act: a SessionStart in another process reaps, then our write lands.
    const reaped = await reapSpool(path, KEY, NOW);
    const payload = `${JSON.stringify(envelope("racer"))}\n`;
    const { bytesWritten } = await handle.write(payload);
    await handle.close();

    // Assert: an empty file has nothing to deliver, so it is not reapable
    expect(reaped).toEqual({ delivered: 0, expired: 0, dropped: 0 });
    expect(bytesWritten).toBe(Buffer.byteLength(payload));
    expect(await Bun.file(dataPath).exists()).toBe(true);
    expect(await readSpoolLines(path, KEY)).toHaveLength(1);
    expect((await readDropSummary(path, KEY)).records).toBe(0);
  });

  test("keeps a fully delivered data file while an appender holds a handle", async () => {
    // Arrange: everything written so far reached the hub, so the file is
    // delivered — and an appender is between its open and its write.
    const path = await home();
    const dataPath = spoolDataPath(path, KEY, SLUG);
    const received: string[] = [];
    const server = acceptingHub(received);
    const ctx = hubContext(path, `http://127.0.0.1:${server.port}`);
    await appendRecords(path, KEY, SESSION, [envelope("first")], NOW);
    await flushSpool(ctx, { sessionId: "cc_live", developerId: "dev_1" }, AMPLE_BUDGET_MS);
    const handle = await open(dataPath, "a", PRIVATE_FILE_MODE);

    // Act
    const reaped = await reapSpool(path, KEY, NOW);
    const payload = `${JSON.stringify(envelope("racer"))}\n`;
    await handle.write(payload);
    await handle.close();

    // Assert: the record is on disk, not lost to an unlinked inode
    expect(reaped).toEqual({ delivered: 0, expired: 0, dropped: 0 });
    expect(await Bun.file(dataPath).exists()).toBe(true);
    const pending = await readSpoolLines(path, KEY);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toContain('"id":"racer"');
    expect((await readDropSummary(path, KEY)).records).toBe(0);
    server.stop(true);
  });

  test("recovers a record whose write landed on the inode reap just unlinked", async () => {
    // Arrange: delivered in full, no session state, quiet past the grace — a
    // file reap is willing to remove. An appender opens it before reap runs.
    const path = await home();
    const dataPath = spoolDataPath(path, KEY, SLUG);
    const received: string[] = [];
    const server = acceptingHub(received);
    const ctx = hubContext(path, `http://127.0.0.1:${server.port}`);
    await appendRecords(path, KEY, SESSION, [envelope("first")], NOW);
    await flushSpool(ctx, { sessionId: "cc_live", developerId: "dev_1" }, AMPLE_BUDGET_MS);
    await idleSince(dataPath, SPOOL_REAP_GRACE_MS * 2);
    const handle = await open(dataPath, "a", PRIVATE_FILE_MODE);

    // Act: the unlink lands between this appender's open and its write, which
    // is the whole necessary condition — no idling required.
    const reaped = await reapSpool(path, KEY, NOW);
    const payload = `${JSON.stringify(envelope("racer"))}\n`;
    const outcome = await appendThroughHandle(handle, dataPath, payload);
    await handle.close();

    // Assert: on disk or counted, never neither
    expect(reaped).toEqual({ delivered: 1, expired: 0, dropped: 0 });
    expect(outcome).toBe("written");
    const pending = await readSpoolLines(path, KEY);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toContain('"id":"racer"');
    expect((await readDropSummary(path, KEY)).records).toBe(0);
    server.stop(true);
  });

  test("re-sends the recovered record instead of skipping it on a stale cursor", async () => {
    // Arrange: the same recovery, then the flush a later session would run
    const path = await home();
    const dataPath = spoolDataPath(path, KEY, SLUG);
    const received: string[] = [];
    const server = acceptingHub(received);
    const ctx = hubContext(path, `http://127.0.0.1:${server.port}`);
    await appendRecords(path, KEY, SESSION, [envelope("first")], NOW);
    await flushSpool(ctx, { sessionId: "cc_live", developerId: "dev_1" }, AMPLE_BUDGET_MS);
    await idleSince(dataPath, SPOOL_REAP_GRACE_MS * 2);
    const handle = await open(dataPath, "a", PRIVATE_FILE_MODE);
    await reapSpool(path, KEY, NOW);
    await appendThroughHandle(
      handle,
      dataPath,
      `${JSON.stringify(envelope("racer"))}\n`,
    );
    await handle.close();

    // Act
    await flushSpool(ctx, { sessionId: "cc_live", developerId: "dev_1" }, AMPLE_BUDGET_MS);

    // Assert: exactly once at the hub, and nothing left waiting
    expect(received).toEqual(["first", "racer"]);
    expect(await readSpoolLines(path, KEY)).toHaveLength(0);
    expect((await readDropSummary(path, KEY)).records).toBe(0);
    server.stop(true);
  });

  test("removes a delivered file once its writers have been idle past the grace", async () => {
    // Arrange: delivered, session gone, and untouched for longer than the grace
    const path = await home();
    const dataPath = spoolDataPath(path, KEY, SLUG);
    const received: string[] = [];
    const server = acceptingHub(received);
    const ctx = hubContext(path, `http://127.0.0.1:${server.port}`);
    await appendRecords(path, KEY, SESSION, [envelope("first")], NOW);
    await flushSpool(ctx, { sessionId: "cc_live", developerId: "dev_1" }, AMPLE_BUDGET_MS);
    await idleSince(dataPath, SPOOL_REAP_GRACE_MS * 2);

    // Act
    const reaped = await reapSpool(path, KEY, NOW);

    // Assert: the guard defers reaping, it does not strand files forever
    expect(reaped).toEqual({ delivered: 1, expired: 0, dropped: 0 });
    expect(await Bun.file(dataPath).exists()).toBe(false);
    expect(await Bun.file(spoolCursorPath(path, KEY, SLUG)).exists()).toBe(false);
    server.stop(true);
  });

  test("removes an empty file that has aged out, so nothing accumulates", async () => {
    // Arrange: a zero-length file left by an appender that never wrote
    const path = await home();
    const dataPath = spoolDataPath(path, KEY, SLUG);
    await ensureDir(spoolDir(path, KEY));
    await writeFile(dataPath, "", "utf8");
    await idleSince(dataPath, (MAX_SPOOL_AGE_DAYS + 1) * MS_PER_DAY);

    // Act
    const reaped = await reapSpool(path, KEY, NOW);

    // Assert: removed for age, and it had no records to count
    expect(reaped).toEqual({ delivered: 0, expired: 1, dropped: 0 });
    expect(await Bun.file(dataPath).exists()).toBe(false);
    expect((await readDropSummary(path, KEY)).records).toBe(0);
  });
});

describe("flush order across sessions", () => {
  test("drains a backlog whose slug sorts after the live session's", async () => {
    // Arrange: the backlog is older but its slug sorts LAST, which is the half
    // of the coin flip that used to strand it forever.
    const path = await home();
    const backlog = "zz-backlog";
    const live = "aa-live";
    const older = new Date(NOW.getTime() - 60 * 60 * 1000);
    const received: string[] = [];
    const server = acceptingHub(received);
    const ctx = hubContext(path, `http://127.0.0.1:${server.port}`);
    await appendRecords(
      path,
      KEY,
      backlog,
      [envelope("backlog_1", older), envelope("backlog_2", older)],
      older,
    );

    // Act: a live session runs hooks, each appending its own record then flushing
    for (let hook = 0; hook < 3; hook += 1) {
      await appendRecords(path, KEY, live, [envelope(`live_${hook}`)], NOW);
      await flushSpool(ctx, { sessionId: "cc_live", developerId: "dev_1" }, AMPLE_BUDGET_MS);
    }

    // Assert
    expect(received.filter((id) => id.startsWith("backlog_"))).toEqual([
      "backlog_1",
      "backlog_2",
    ]);
    expect(await readSpoolLines(path, KEY)).toHaveLength(0);
    expect(sessionSlug(backlog) > sessionSlug(live)).toBe(true);
    server.stop(true);
  });

  test("sends the oldest session's records before a newer session's", async () => {
    // Arrange
    const path = await home();
    const older = new Date(NOW.getTime() - 60 * 60 * 1000);
    const received: string[] = [];
    const server = acceptingHub(received);
    const ctx = hubContext(path, `http://127.0.0.1:${server.port}`);
    await appendRecords(path, KEY, "aa-newer", [envelope("newer", NOW)], NOW);
    await appendRecords(path, KEY, "zz-older", [envelope("older", older)], older);

    // Act
    await flushSpool(ctx, { sessionId: "cc_live", developerId: "dev_1" }, AMPLE_BUDGET_MS);

    // Assert
    expect(received).toEqual(["older", "newer"]);
    server.stop(true);
  });

  test("keeps draining batches until the backlog is empty", async () => {
    // Arrange: more than one batch worth of records in one session
    const path = await home();
    const backlogSize = MAX_INGEST_BATCH * 2 + 5;
    const received: string[] = [];
    const server = acceptingHub(received);
    const ctx = hubContext(path, `http://127.0.0.1:${server.port}`);
    await appendRecords(
      path,
      KEY,
      SESSION,
      Array.from({ length: backlogSize }, (_unused, index) =>
        envelope(`b_${index}`),
      ),
      NOW,
    );

    // Act: ONE flush, the way a single hook would call it
    const outcome = await flushSpool(ctx, {
      sessionId: "cc_live",
      developerId: "dev_1",
    }, AMPLE_BUDGET_MS);

    // Assert
    expect(outcome).toEqual({
      outcome: "flushed",
      sent: backlogSize,
      remaining: 0,
    });
    expect(received).toHaveLength(backlogSize);
    expect(await readSpoolLines(path, KEY)).toHaveLength(0);
    server.stop(true);
  });
});

describe("cursor trust", () => {
  test("re-sends a spool whose cursor claims more than the file holds", async () => {
    // Arrange: a corrupt cursor — right inode, offset far past the end
    const path = await home();
    const dataPath = spoolDataPath(path, KEY, SLUG);
    const received: string[] = [];
    const server = acceptingHub(received);
    await appendRecords(
      path,
      KEY,
      SESSION,
      [envelope("keep_1"), envelope("keep_2")],
      NOW,
    );
    const { ino } = await stat(dataPath);
    await writeFile(
      spoolCursorPath(path, KEY, SLUG),
      `${JSON.stringify({ ino, offset: 10_000_000 })}\n`,
      "utf8",
    );
    await idleSince(dataPath, SPOOL_REAP_GRACE_MS * 2);

    // Act: reap first — a corrupt cursor must not authorise deletion
    const reaped = await reapSpool(path, KEY, NOW);
    await flushSpool(hubContext(path, `http://127.0.0.1:${server.port}`), {
      sessionId: "cc_live",
      developerId: "dev_1",
    }, AMPLE_BUDGET_MS);

    // Assert: both records reached the hub instead of being destroyed
    expect(reaped).toEqual({ delivered: 0, expired: 0, dropped: 0 });
    expect(received).toEqual(["keep_1", "keep_2"]);
    expect((await readDropSummary(path, KEY)).records).toBe(0);
    server.stop(true);
  });
});

describe("reap's own unlink window", () => {
  /** Everything reap holds when it unlinks: the spool as read, and a handle on it. */
  const midUnlink = async (
    path: string,
  ): Promise<{ spool: SessionSpool; handle: FileHandle }> => {
    const dataPath = spoolDataPath(path, KEY, SLUG);
    const received: string[] = [];
    const server = acceptingHub(received);
    await appendRecords(path, KEY, SESSION, [envelope("delivered_1")], NOW);
    await flushSpool(
      hubContext(path, `http://127.0.0.1:${server.port}`),
      { sessionId: "cc_live", developerId: "dev_1" },
      AMPLE_BUDGET_MS,
    );
    server.stop(true);
    const spool = await readSessionSpool(path, KEY, SLUG);
    return { spool, handle: await open(dataPath, "r") };
  };

  const unlinkSpool = async (path: string): Promise<void> => {
    await removeFile(spoolCursorPath(path, KEY, SLUG));
    await removeFile(spoolDataPath(path, KEY, SLUG));
  };

  test("puts back records that landed between its last check and the unlink", async () => {
    // Arrange: reap has measured the file and holds it open
    const path = await home();
    const { spool, handle } = await midUnlink(path);

    // Act: two appends land in the window, then the unlink takes the name
    await appendRecords(
      path,
      KEY,
      SESSION,
      [envelope("late_1"), envelope("late_2")],
      NOW,
    );
    await unlinkSpool(path);
    await rescueTail(path, KEY, spool, handle, NOW);
    await handle.close();

    // Assert: back on disk under the recreated file, and nothing counted lost
    const pending = await readSpoolLines(path, KEY);
    expect(pending).toHaveLength(2);
    expect(pending.join("\n")).toContain('"id":"late_1"');
    expect(pending.join("\n")).toContain('"id":"late_2"');
    expect((await readDropSummary(path, KEY)).records).toBe(0);
  });

  test("puts back a record with multi-byte text without inventing a drop", async () => {
    // Arrange: a path only a byte count reads correctly
    const path = await home();
    const { spool, handle } = await midUnlink(path);
    await appendRecords(
      path,
      KEY,
      SESSION,
      [
        {
          ...envelope("late_umlaut"),
          body: { workContextId: "wc_1", kind: "file", value: "src/größe/übung.ts" },
        },
      ],
      NOW,
    );

    // Act
    await unlinkSpool(path);
    await rescueTail(path, KEY, spool, handle, NOW);
    await handle.close();

    // Assert
    const pending = await readSpoolLines(path, KEY);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toContain("übung.ts");
    expect((await readDropSummary(path, KEY)).records).toBe(0);
  });

  test("counts a half-landed record it cannot put back", async () => {
    // Arrange: a write that had not finished when the name went
    const path = await home();
    const { spool, handle } = await midUnlink(path);
    await appendOnce(spoolDataPath(path, KEY, SLUG), '{"cx":"0.1","id":"torn');

    // Act
    await unlinkSpool(path);
    await rescueTail(path, KEY, spool, handle, NOW);
    await handle.close();

    // Assert: not recovered, but not silent either
    expect(await readSpoolLines(path, KEY)).toHaveLength(0);
    expect((await readDropSummary(path, KEY)).records).toBe(1);
  });
});

describe("cursor against a spool that was recreated mid-flush", () => {
  test("refuses to move a cursor onto a file it did not deliver from", async () => {
    // Arrange: a flush has read the spool and sent what it found
    const path = await home();
    const dataPath = spoolDataPath(path, KEY, SLUG);
    const cursorPath = spoolCursorPath(path, KEY, SLUG);
    await appendRecords(path, KEY, SESSION, [envelope("delivered_1")], NOW);
    const asRead = await readSessionSpool(path, KEY, SLUG);

    // Act: reap removes the file, appenders recreate it past the old offset,
    // and only THEN does the in-flight cursor write land.
    await removeFile(cursorPath);
    await removeFile(dataPath);
    await appendRecords(
      path,
      KEY,
      SESSION,
      [envelope("new_1"), envelope("new_2"), envelope("new_3")],
      NOW,
    );
    await writeCursorOffset(dataPath, cursorPath, asRead.size, asRead.ino);

    // Assert: the new file's records are not skipped by the old file's offset
    const pending = await readSpoolLines(path, KEY);
    expect(pending).toHaveLength(3);
    expect(pending.join("\n")).toContain('"id":"new_1"');
    expect((await readDropSummary(path, KEY)).records).toBe(0);
  });
});

describe("the end SessionEnd deferred", () => {
  const deferredEnd = async (
    path: string,
    slug: string,
    at: Date = NOW,
  ): Promise<void> => {
    await ensureDir(spoolDir(path, KEY));
    await writeFile(
      spoolPendingEndPath(path, KEY, slug),
      `${JSON.stringify({
        crosscheckSessionId: `cc_${slug}`,
        at: at.toISOString(),
      })}\n`,
      "utf8",
    );
  };

  /** Records what reap asked to end, and whether the hub played along. */
  const enderThat = (
    succeeds: boolean,
    seen: string[],
  ): ((sessionId: string) => Promise<boolean>) =>
    async (sessionId: string) => {
      seen.push(sessionId);
      return succeeds;
    };

  test("ends the session once its backlog has reached the hub", async () => {
    // Arrange: SessionEnd left a marker, and the spool has since been drained
    const path = await home();
    const ended: string[] = [];
    await deferredEnd(path, SLUG);

    // Act
    await reapSpool(path, KEY, NOW, enderThat(true, ended));

    // Assert: told the hub exactly once, and the marker is spent
    expect(ended).toEqual([`cc_${SLUG}`]);
    expect(await Bun.file(spoolPendingEndPath(path, KEY, SLUG)).exists()).toBe(
      false,
    );
  });

  test("keeps the deferral while records of that session are still waiting", async () => {
    // Arrange: a marker and an undelivered record of the same session
    const path = await home();
    const ended: string[] = [];
    await appendRecords(path, KEY, SESSION, [envelope("waiting")], NOW);
    await deferredEnd(path, SLUG);

    // Act
    await reapSpool(path, KEY, NOW, enderThat(true, ended));

    // Assert: a session is not "done" while its work is on disk
    expect(ended).toEqual([]);
    expect(await Bun.file(spoolPendingEndPath(path, KEY, SLUG)).exists()).toBe(
      true,
    );
  });

  test("keeps the deferral when the hub refuses the end", async () => {
    // Arrange
    const path = await home();
    const ended: string[] = [];
    await deferredEnd(path, SLUG);

    // Act
    await reapSpool(path, KEY, NOW, enderThat(false, ended));

    // Assert: retried by a later SessionStart, never silently dropped
    expect(ended).toEqual([`cc_${SLUG}`]);
    expect(await Bun.file(spoolPendingEndPath(path, KEY, SLUG)).exists()).toBe(
      true,
    );
  });

  test("leaves the deferral alone while that session id is live again", async () => {
    // Arrange: the same session came back, so it will end itself
    const path = await home();
    const ended: string[] = [];
    await liveSession(path, SESSION);
    await deferredEnd(path, SLUG);

    // Act
    await reapSpool(path, KEY, NOW, enderThat(true, ended));

    // Assert
    expect(ended).toEqual([]);
    expect(await Bun.file(spoolPendingEndPath(path, KEY, SLUG)).exists()).toBe(
      true,
    );
  });

  test("retires a marker past MAX_SPOOL_AGE_DAYS and keeps what it stood for", async () => {
    // Arrange: SessionEnd deferred nine days ago against a hub that never came
    // back — every other spool artifact of that age is already gone
    const path = await home();
    const ended: string[] = [];
    const nineDaysAgo = new Date(NOW.getTime() - 9 * MS_PER_DAY);
    await deferredEnd(path, SLUG, nineDaysAgo);

    // Act
    await reapSpool(path, KEY, NOW, enderThat(true, ended));

    // Assert: no marker, no week-late hub call, and the fact still readable
    expect(await Bun.file(spoolPendingEndPath(path, KEY, SLUG)).exists()).toBe(
      false,
    );
    expect(ended).toEqual([]);
    const unclosed = await readUnclosedSummary(path, KEY);
    expect(unclosed.sessions).toBe(1);
    expect(unclosed.oldestAt).toBe(nineDaysAgo.toISOString());
  });

  test("folds several retired markers into one surviving count", async () => {
    // Arrange
    const path = await home();
    const ended: string[] = [];
    await deferredEnd(path, sessionSlug("gone-1"), new Date(NOW.getTime() - 9 * MS_PER_DAY));
    await deferredEnd(path, sessionSlug("gone-2"), new Date(NOW.getTime() - 20 * MS_PER_DAY));

    // Act: two sweeps, so the second folds into what the first already wrote
    await reapSpool(path, KEY, NOW, enderThat(true, ended));
    await reapSpool(path, KEY, NOW, enderThat(true, ended));

    // Assert
    expect((await readUnclosedSummary(path, KEY)).sessions).toBe(2);
    expect(ended).toEqual([]);
  });

  test("keeps a marker that has not aged out yet", async () => {
    // Arrange: one day short of the bound, and a hub still refusing the end
    const path = await home();
    const ended: string[] = [];
    await deferredEnd(
      path,
      SLUG,
      new Date(NOW.getTime() - (MAX_SPOOL_AGE_DAYS - 1) * MS_PER_DAY),
    );

    // Act
    await reapSpool(path, KEY, NOW, enderThat(false, ended));

    // Assert: still retried, and nothing counted as given up on
    expect(ended).toEqual([`cc_${SLUG}`]);
    expect(await Bun.file(spoolPendingEndPath(path, KEY, SLUG)).exists()).toBe(
      true,
    );
    expect((await readUnclosedSummary(path, KEY)).sessions).toBe(0);
  });

  test("ages an unreadable stamp out on the marker file's own mtime", async () => {
    // Arrange: the session id is readable, the timestamp is not, and the file
    // itself has been sitting in the spool for nine days
    const path = await home();
    const ended: string[] = [];
    await ensureDir(spoolDir(path, KEY));
    const markerPath = spoolPendingEndPath(path, KEY, SLUG);
    await writeFile(
      markerPath,
      `${JSON.stringify({ crosscheckSessionId: `cc_${SLUG}`, at: "not-a-date" })}\n`,
      "utf8",
    );
    const nineDaysAgo = new Date(NOW.getTime() - 9 * MS_PER_DAY);
    await utimes(markerPath, nineDaysAgo, nineDaysAgo);

    // Act
    await reapSpool(path, KEY, NOW, enderThat(true, ended));

    // Assert: retired, and aged from the DEFERRAL — the mtime — not from the
    // sweep that retired it, so `doctor` shows nine days and not zero
    expect(await Bun.file(markerPath).exists()).toBe(false);
    expect(ended).toEqual([]);
    const unclosed = await readUnclosedSummary(path, KEY);
    expect(unclosed.sessions).toBe(1);
    expect(
      Math.abs(Date.parse(unclosed.oldestAt ?? "") - nineDaysAgo.getTime()),
    ).toBeLessThan(MS_PER_SECOND);
  });

  test("discards a marker whose session id cannot be read", async () => {
    // Arrange: a torn marker names nobody, so nothing can ever act on it
    const path = await home();
    const ended: string[] = [];
    await ensureDir(spoolDir(path, KEY));
    await writeFile(spoolPendingEndPath(path, KEY, SLUG), '{"cross\n', "utf8");

    // Act
    await reapSpool(path, KEY, NOW, enderThat(true, ended));

    // Assert
    expect(ended).toEqual([]);
    expect(await Bun.file(spoolPendingEndPath(path, KEY, SLUG)).exists()).toBe(
      false,
    );
  });
});

describe("drops ledger retention", () => {
  const agedLedger = async (
    path: string,
    slug: string,
    count: number,
    at: Date,
  ): Promise<void> => {
    await ensureDir(spoolDir(path, KEY));
    await writeFile(
      spoolDropsPath(path, KEY, slug),
      `${JSON.stringify({ at: at.toISOString(), count, reason: "cap" })}\n`,
      "utf8",
    );
  };

  test("keeps the total when it removes a ledger nobody has read yet", async () => {
    // Arrange: 999 records dropped during an outage, newest entry nine days old
    const path = await home();
    const nineDaysAgo = new Date(NOW.getTime() - 9 * MS_PER_DAY);
    await agedLedger(path, sessionSlug("gone-session"), 999, nineDaysAgo);
    const before = await readDropSummary(path, KEY);

    // Act
    await reapSpool(path, KEY, NOW);

    // Assert: the detail may go, the NUMBER may not
    const after = await readDropSummary(path, KEY);
    expect(before.records).toBe(999);
    expect(after.records).toBe(999);
    expect(
      await Bun.file(spoolDropsPath(path, KEY, sessionSlug("gone-session"))).exists(),
    ).toBe(false);
  });

  test("folds several removed ledgers into one surviving total", async () => {
    // Arrange
    const path = await home();
    const nineDaysAgo = new Date(NOW.getTime() - 9 * MS_PER_DAY);
    const twentyDaysAgo = new Date(NOW.getTime() - 20 * MS_PER_DAY);
    await agedLedger(path, sessionSlug("gone-1"), 7, nineDaysAgo);
    await agedLedger(path, sessionSlug("gone-2"), 11, twentyDaysAgo);

    // Act: two sweeps, so the second folds into what the first already wrote
    await reapSpool(path, KEY, NOW);
    await reapSpool(path, KEY, NOW);

    // Assert
    expect((await readDropSummary(path, KEY)).records).toBe(18);
  });

  test("keeps the aged ledger of a session that is still live", async () => {
    // Arrange
    const path = await home();
    const live = "live-session";
    const nineDaysAgo = new Date(NOW.getTime() - 9 * MS_PER_DAY);
    await liveSession(path, live);
    await agedLedger(path, sessionSlug(live), 5, nineDaysAgo);

    // Act
    await reapSpool(path, KEY, NOW);

    // Assert
    expect(
      await Bun.file(spoolDropsPath(path, KEY, sessionSlug(live))).exists(),
    ).toBe(true);
    expect((await readDropSummary(path, KEY)).records).toBe(5);
  });

  test("reports a torn ledger line as malformed rather than under-counting", async () => {
    // Arrange
    const path = await home();
    await ensureDir(spoolDir(path, KEY));
    await writeFile(
      spoolDropsPath(path, KEY, sessionSlug("torn-session")),
      `${JSON.stringify({ at: NOW.toISOString(), count: 4, reason: "cap" })}\n{"at":"2026-0\n`,
      "utf8",
    );

    // Act
    const summary = await readDropSummary(path, KEY);

    // Assert
    expect(summary).toEqual({ records: 4, entries: 1, malformed: 1 });
  });
});

describe("a drop the ledger itself could not record", () => {
  /**
   * A DIRECTORY where the ledger's file belongs, so every `open(path, "a")` on
   * it fails. That is the one shape of ledger failure a test can force without
   * reaching inside the write path, and it stands in for the real ones: a full
   * disk, a mode change, a `.drops` name taken by something else.
   */
  const unwritableLedger = async (path: string, slug: string): Promise<void> => {
    await ensureDir(spoolDropsPath(path, KEY, slug));
  };

  test("keeps a count its ledger append could not take", async () => {
    // Arrange
    const path = await home();
    await unwritableLedger(path, SLUG);

    // Act: the count reap takes off an expired file, with nowhere to put it
    await recordDrop(path, KEY, SLUG, 7, "expired", NOW);

    // Assert: not in the ledger, and not silently gone either
    expect((await readDropSummary(path, KEY)).records).toBe(0);
    const dir = spoolDir(path, KEY);
    const marker = (await readdir(dir)).find((name) =>
      name.endsWith(".dropmarker"),
    );
    expect(marker).toBeDefined();
    expect(
      JSON.parse(await Bun.file(join(dir, marker ?? "")).text()) as unknown,
    ).toMatchObject({ at: NOW.toISOString(), count: 7, reason: "expired" });
  });
});