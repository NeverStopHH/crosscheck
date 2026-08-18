/**
 * What a hook must still do when a backlog and a slow hub are both against it.
 *
 * The drain used to run on a fixed ratio equal to the whole SessionEnd budget,
 * so it consumed the hook that hosted it: measured through the binary with a
 * 600-record backlog and a 350 ms hub, SessionStart took 1035 ms and returned
 * no briefing, SessionEnd took 831 ms, never sent `end`, and never reached
 * `deleteSessionState`. Both are reproduced here through the real hook entry
 * point, with only the ingest endpoint made slow so the drain is the expensive
 * thing rather than the briefing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";

import { appendRecords, readSpoolLines, repoKey, runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import {
  ensureDir,
  sessionSlug,
  sessionStatePath,
  spoolDir,
  spoolPendingEndPath,
} from "@crosscheck/connector-core/config/paths.ts";
import { writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";
import { SELF_DEVELOPER_ID, startSlowHub } from "./fixtures/slow-hub.ts";
import type { HubCalls, HubLatency } from "./fixtures/slow-hub.ts";

const REPO_ID = "github.com/acme/api";
const DEVELOPER_ID = SELF_DEVELOPER_ID;
/** More batches than any hook budget can pay for at this latency. */
const BACKLOG = 600;
/** Just under the 400 ms default request timeout, as the verifier measured it. */
const INGEST_LATENCY_MS = 350;
/** The documented SessionStart budget: 2.5 × the 400 ms default timeout. */
const SESSION_START_BUDGET_MS = 1000;
/**
 * Slow enough that SessionStart's two mandatory round trips leave less than one
 * request timeout, which is the only state in which the deferred end can spend
 * the reserve; fast enough that the briefing itself is never in doubt.
 */
const SLOW_HUB_MS = 300;
/** An `end` this hub will never answer inside any budget the hook can give it. */
const UNANSWERABLE_MS = 5000;

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const envelope = (index: number, sessionId: string): Record<string, unknown> => ({
  cx: "0.1",
  id: `env_backlog_${index}`,
  ts: new Date().toISOString(),
  producer: {
    developerId: DEVELOPER_ID,
    agentKind: "claude-code",
    sessionId: `cc_${sessionId}`,
  },
  kind: "target",
  body: { workContextId: "wc_1", kind: "file", value: `src/f${index}.ts` },
});

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly hubUrl: string;
  readonly env: Env;
  readonly key: string;
  readonly calls: HubCalls;
  readonly latency: HubLatency;
  readonly stop: () => void;
}

const fixture = async (label: string): Promise<Fixture> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  // Only `/api/records` starts out slow. Everything the briefing needs answers
  // at once, so a missing briefing can only mean the drain took the hook.
  const hub = startSlowHub({ ingest: INGEST_LATENCY_MS, end: 0, other: 0 });
  const hubUrl = hub.url;
  return {
    repo,
    home,
    hubUrl,
    key: repoKey(hubUrl, REPO_ID),
    calls: hub.calls,
    latency: hub.latency,
    stop: hub.stop,
    // No CROSSCHECK_TIMEOUT_MS: the documented 400 ms default, and with it the
    // documented 1000 ms / 800 ms hook budgets.
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: "test-key",
    },
  };
};

const seedBacklog = async (
  home: string,
  key: string,
  sessionId: string,
): Promise<void> => {
  await appendRecords(
    home,
    key,
    sessionId,
    Array.from({ length: BACKLOG }, (_unused, index) =>
      envelope(index, sessionId),
    ),
    new Date(),
  );
};

const liveSession = async (
  fixed: Fixture,
  sessionId: string,
): Promise<void> => {
  await writeSessionState(fixed.home, {
    claudeSessionId: sessionId,
    crosscheckSessionId: `cc_${sessionId}`,
    workContextId: `wc_cc_${sessionId}`,
    repoId: REPO_ID,
    repoRoot: fixed.repo,
    hubUrl: fixed.hubUrl,
    developerId: DEVELOPER_ID,
    startedAt: new Date().toISOString(),
    lastHeartbeatAt: null,
    seenTargets: [],
  });
};

const endPayload = (repo: string, sessionId: string): string =>
  JSON.stringify({
    session_id: sessionId,
    cwd: repo,
    hook_event_name: "SessionEnd",
    reason: "clear",
  });

describe("SessionStart under a backlog", () => {
  test("returns its briefing instead of spending the hook on the drain", async () => {
    // Arrange: 600 records left by an older session, ingest at 350 ms a batch
    const fixed = await fixture("budget-start");
    await seedBacklog(fixed.home, fixed.key, "old-session");

    // Act
    const stdout = await runHook(
      "session-start",
      JSON.stringify({
        session_id: "start-uuid",
        cwd: fixed.repo,
        hook_event_name: "SessionStart",
        source: "startup",
      }),
      fixed.env,
    );

    // Assert: the briefing is what the hook exists for; the backlog is not
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Teammate");
    fixed.stop();
  });
});

describe("SessionStart with a deferred end it cannot make", () => {
  const strandMarker = async (
    fixed: Fixture,
    claudeSessionId: string,
  ): Promise<void> => {
    await ensureDir(spoolDir(fixed.home, fixed.key));
    await writeFile(
      spoolPendingEndPath(fixed.home, fixed.key, sessionSlug(claudeSessionId)),
      `${JSON.stringify({
        crosscheckSessionId: `cc_${claudeSessionId}`,
        at: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
  };

  test("returns its briefing instead of spending the reserve on the end call", async () => {
    // Arrange: a marker left by an earlier SessionEnd, and a hub whose two
    // mandatory round trips leave SessionStart less than one request timeout.
    const fixed = await fixture("budget-start-deferred");
    await strandMarker(fixed, "stranded-uuid");
    fixed.latency.other = SLOW_HUB_MS;
    fixed.latency.end = UNANSWERABLE_MS;

    // Act
    const startedAt = Date.now();
    const stdout = await runHook(
      "session-start",
      JSON.stringify({
        session_id: "start-deferred-uuid",
        cwd: fixed.repo,
        hook_event_name: "SessionStart",
        source: "startup",
      }),
      fixed.env,
    );
    const elapsedMs = Date.now() - startedAt;

    // Assert: the briefing survives, and the hook stays inside its budget —
    // an end call on the remaining budget instead of the spare ran it to the
    // deadline, where the budget race discards the briefing it already had.
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Teammate");
    expect(elapsedMs).toBeLessThan(SESSION_START_BUDGET_MS);
    // Deferred, never dropped: the marker waits for a hook with room to spare.
    expect(fixed.calls.end).toBe(0);
    expect(
      await Bun.file(
        spoolPendingEndPath(fixed.home, fixed.key, sessionSlug("stranded-uuid")),
      ).exists(),
    ).toBe(true);
    fixed.stop();
  });
});

describe("SessionEnd under a backlog", () => {
  test("defers the end while its own records are still on disk", async () => {
    // Arrange: the backlog belongs to the session that is ending
    const fixed = await fixture("budget-end-own");
    const sessionId = "end-uuid";
    await seedBacklog(fixed.home, fixed.key, sessionId);
    await liveSession(fixed, sessionId);

    // Act
    const stdout = await runHook(
      "session-end",
      endPayload(fixed.repo, sessionId),
      fixed.env,
    );

    // Assert: not ended — deliberately, and recorded for reap to finish
    expect(stdout).toBe("");
    expect(fixed.calls.end).toBe(0);
    const marker = (await Bun.file(
      spoolPendingEndPath(fixed.home, fixed.key, sessionSlug(sessionId)),
    ).json()) as { crosscheckSessionId: string };
    expect(marker.crosscheckSessionId).toBe(`cc_${sessionId}`);
    // The state file has to go regardless, or the spool is never reapable.
    expect(await Bun.file(sessionStatePath(fixed.home, sessionId)).exists()).toBe(
      false,
    );
    // Whether the spare budget managed one batch at this latency is a race
    // this test does not pin down — that some of the backlog is still here,
    // and that this is what deferred the end, is the point.
    const stillWaiting = await readSpoolLines(fixed.home, fixed.key);
    expect(stillWaiting.length).toBeGreaterThan(0);
    expect(stillWaiting.length).toBeLessThanOrEqual(BACKLOG);
    fixed.stop();
  });

  test("recovers an end the budget cut off, on the next SessionStart", async () => {
    // Arrange: nothing of this session's own is waiting, so it wants to end —
    // but the hub answers `end` slower than the request timeout allows.
    const fixed = await fixture("budget-end-lost");
    const sessionId = "end-slow-uuid";
    await liveSession(fixed, sessionId);
    fixed.latency.end = 600;

    // Act: the end call cannot land
    await runHook("session-end", endPayload(fixed.repo, sessionId), fixed.env);
    const markerAfterEnd = await Bun.file(
      spoolPendingEndPath(fixed.home, fixed.key, sessionSlug(sessionId)),
    ).exists();

    // Act: a later session starts, and reap finishes what SessionEnd could not
    fixed.latency.end = 0;
    await runHook(
      "session-start",
      JSON.stringify({
        session_id: "next-uuid",
        cwd: fixed.repo,
        hook_event_name: "SessionStart",
        source: "startup",
      }),
      fixed.env,
    );

    // Assert: the intent outlived the failed call, and was spent exactly once
    expect(markerAfterEnd).toBe(true);
    expect(fixed.calls.end).toBe(1);
    expect(
      await Bun.file(
        spoolPendingEndPath(fixed.home, fixed.key, sessionSlug(sessionId)),
      ).exists(),
    ).toBe(false);
    fixed.stop();
  });

  test("ends the session when the backlog on disk is somebody else's", async () => {
    // Arrange: a big backlog, none of it produced by this session
    const fixed = await fixture("budget-end-clean");
    const sessionId = "end-clean-uuid";
    await seedBacklog(fixed.home, fixed.key, "old-session");
    await liveSession(fixed, sessionId);

    // Act
    await runHook("session-end", endPayload(fixed.repo, sessionId), fixed.env);

    // Assert: terminated, with nothing deferred
    expect(fixed.calls.end).toBe(1);
    expect(
      await Bun.file(
        spoolPendingEndPath(fixed.home, fixed.key, sessionSlug(sessionId)),
      ).exists(),
    ).toBe(false);
    expect(await Bun.file(sessionStatePath(fixed.home, sessionId)).exists()).toBe(
      false,
    );
    fixed.stop();
  });
});