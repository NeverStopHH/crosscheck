/**
 * THE STATUSLINE SHOWS AN OVERLAP WHOSE TEAMMATE IS OFFLINE (review of
 * feat/collision-visible, round 2, M1). Probe C3: SessionStart told the person
 * "Mike is working on 3 files you also touched" while Mike was offline — the
 * pilot's case — and the statusline right after showed nothing, because it
 * named only teammates the presence answer listed and dropped the rest. Now
 * it counts them: `⚠ overlap: 1 teammate · 3 files`. Never named: not from an
 * answer without them, not from a stale cache under an unreadable hub
 * (reviewer mutation R3), not from a fresh cache under a rejected key (R2).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runHook, runStatusline } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import { PRESENCE_CACHE_TTL_MS } from "@crosscheck/connector-core/constants.ts";
import { TEAMMATE_DEVELOPER_ID } from "../../connector-core/test/fixtures/hint-hub.ts";
import {
  MIKE_FILES,
  MIKE_GHOST_NOTICE,
  OVERLAP_FILE,
  REPO_ID,
  SECOND_FILE,
  SESSION_ID,
  cleanupCollisionFixtures,
  collisionFixture,
  editPayload,
  ghostFixture,
  kenSession,
  mikeGhostRow,
  parsed,
  presentNow,
  sessionStartPayload,
} from "./fixtures/collision-fixture.ts";

afterEach(cleanupCollisionFixtures);

const HTTP_UNAUTHORIZED = 401;

const statusline = (repo: string, env: Env): Promise<string> =>
  runStatusline(JSON.stringify({ session_id: SESSION_ID, cwd: repo }), env);

describe("an overlap whose teammate presence does not list is counted, never named", () => {
  test("SessionStart tells the person of Mike, offline — the statusline right after counts him (probe C3)", async () => {
    // Arrange: the ghost hub's presence answer lists nobody
    const { repo, env } = await ghostFixture("su-ghost-offline", [mikeGhostRow(MIKE_FILES, 3)]);
    const told = parsed(await runHook("session-start", sessionStartPayload(repo, "startup"), env));

    // Act
    const line = await statusline(repo, env);

    // Assert
    expect(told.systemMessage).toBe(MIKE_GHOST_NOTICE);
    expect(line.startsWith("⚠ overlap: 1 teammate · 3 files · ")).toBe(true);
    expect(line).not.toContain("Mike");
  });

  test("Nick still present and Ken gone: Nick by name, Ken counted after him", async () => {
    // Arrange: both told; a fresh answer lists Nick only
    const fix = await collisionFixture("su-mixed");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env);
    fix.hub.setTripwireSessions([kenSession()]);
    await runHook("pre-tool-use", editPayload(fix.repo, SECOND_FILE), fix.env);
    await presentNow(fix, [TEAMMATE_DEVELOPER_ID]);

    // Act
    const line = await statusline(fix.repo, fix.env);

    // Assert
    expect(line.startsWith("⚠ overlap: Nick · 1 file, +1 teammate · 1 file · ")).toBe(true);
    expect(line).not.toContain("Ken");
  });

  test("a hub the statusline cannot read never names a STALE cache's teammates (reviewer mutation R3)", async () => {
    // Arrange: Nick told; a cache past its TTL still lists him; this hub
    // answers presence with nothing the client can read
    const fix = await collisionFixture("su-stale-unreadable");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env);
    await presentNow(fix, [TEAMMATE_DEVELOPER_ID], { fetchedAt: new Date(Date.now() - PRESENCE_CACHE_TTL_MS - 5_000) });

    // Act
    const line = await statusline(fix.repo, fix.env);

    // Assert
    expect(line.startsWith("⚠ overlap: 1 teammate · 1 file · cx ! ")).toBe(true);
    expect(line).not.toContain("Nick");
  });

  test("a fresh cache under a booked 401 names nobody either (reviewer mutation R2)", async () => {
    // Arrange: a fresh cache that lists Nick, and the 401 the last real call booked
    const fix = await collisionFixture("su-rejected-key");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env);
    await presentNow(fix, [TEAMMATE_DEVELOPER_ID]);
    const key = repoKey(fix.hub.url, REPO_ID);
    await mkdir(join(fix.home, "state"), { recursive: true });
    await writeFile(
      join(fix.home, "state", `${key}.json`),
      `${JSON.stringify({
        lastSyncAt: new Date().toISOString(),
        lastOkAt: null,
        lastCaptureOkAt: null,
        lastError: "unauthorized: unknown api key",
        lastErrorStatus: HTTP_UNAUTHORIZED,
        cursorVersion: null,
      })}\n`,
      "utf8",
    );

    // Act
    const line = await statusline(fix.repo, fix.env);

    // Assert
    expect(line).toContain("key rejected");
    expect(line.startsWith("⚠ overlap: 1 teammate · 1 file · ")).toBe(true);
    expect(line).not.toContain("Nick");
  });
});
