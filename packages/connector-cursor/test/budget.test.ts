/**
 * The fail-open budget (prime directive 1): a cursor hook that cannot reach
 * the hub exits fast and silent — Cursor never waits meaningfully, never
 * breaks. Measured through the REAL runner:
 *
 *   - no login on the machine → silence in far under one request timeout
 *     (the cloud-agent path: project hooks on a machine with no
 *     ~/.crosscheck);
 *   - unreachable hub → bounded by the same ratio family as the Claude
 *     hooks (SESSION_START_BUDGET_RATIO × request timeout);
 *   - a hub SLOWER than every budget → the shared race abandons the work
 *     and answers the no-op within budget + margin (the Claude slow-hub
 *     fixture, reused relatively — same drive-train, new connector).
 *
 * Block 7 extends the same discipline to the INJECTING hooks (prime
 * directive 3): a sessionStart that now assembles the briefing and a
 * postToolUse that now runs the hint fast path must still exit within
 * their budgets against a hung hub — the briefing degrades to silence via
 * per-request timeouts (fail open, its facts surface as later hints), and
 * the hint's one candidates call is bounded the same way. Both are MEASURED
 * below through the real runner; the per-request timeouts are what carry
 * these bounds — the race backstop for non-HTTP wedges has its own
 * deterministic pin in connector-claude/test/hook-budget.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";

import {
  HTTP_TIMEOUT_MS,
  POST_TOOL_USE_BUDGET_RATIO,
  SESSION_START_BUDGET_RATIO,
} from "@crosscheck/connector-core/constants.ts";
import {
  ensureDir,
  repoKey,
  sessionSlug,
  spoolDir,
  spoolPendingEndPath,
} from "@crosscheck/connector-core/config/paths.ts";
import { appendRecords } from "@crosscheck/connector-core/spool/append.ts";
import { writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";

import { runCursorHook } from "../src/index.ts";
import { prepareCursorHook } from "../src/runner.ts";
import { handleCursorPostToolUse } from "../src/handlers/post-tool-use.ts";
import { deliveredAdditionalContext } from "../src/inject/output.ts";
import {
  POST_TOOL_USE_FAILING_COMMAND,
  SESSION_START_INPUT,
} from "./fixtures/cursor-contract/payloads.ts";
import {
  TEAMMATE_NAME,
  startSlowHub,
} from "../../connector-claude/test/fixtures/slow-hub.ts";
import {
  CANDIDATE_BODY,
  rejectedApproachCandidate,
  startHintHub,
} from "../../connector-core/test/fixtures/hint-hub.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REMOTE = "git@github.com:acme/api.git";
const DEAD_HUB_URL = "http://127.0.0.1:1";

/**
 * Scheduler jitter, git spawns and file IO on a loaded CI machine — the
 * margin the Claude latency suites grant on top of the arithmetic budget.
 */
const MARGIN_MS = 500;

const payloadIn = (repo: string, conv: string): string =>
  JSON.stringify({
    ...SESSION_START_INPUT,
    conversation_id: conv,
    session_id: conv,
    workspace_roots: [repo],
  });

describe("fail-open within budget", () => {
  test("no login: silence in well under one request timeout", async () => {
    // Arrange: a repo but NO config of any kind — the cloud-agent machine.
    const repo = await makeRepo("budget-nologin", { remote: REMOTE });
    const home = await makeHome("budget-nologin");

    // Act
    const startedAt = performance.now();
    const out = await runCursorHook(
      "sessionStart",
      payloadIn(repo, "conv-budget-1"),
      { CROSSCHECK_HOME: home },
    );
    const elapsedMs = performance.now() - startedAt;

    // Assert: silent no-op, faster than a single default request timeout
    // plus margin (repo identity's git spawns are the cost floor).
    expect(out).toBe("{}");
    expect(elapsedMs).toBeLessThan(HTTP_TIMEOUT_MS + MARGIN_MS);
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  test("unreachable hub: bounded by the sessionStart ratio at the default timeout", async () => {
    // Arrange
    const repo = await makeRepo("budget-dead", { remote: REMOTE });
    const home = await makeHome("budget-dead");

    // Act
    const startedAt = performance.now();
    const out = await runCursorHook(
      "sessionStart",
      payloadIn(repo, "conv-budget-2"),
      {
        CROSSCHECK_HOME: home,
        CROSSCHECK_HUB_URL: DEAD_HUB_URL,
        CROSSCHECK_API_KEY: "test-key",
      },
    );
    const elapsedMs = performance.now() - startedAt;

    // Assert
    expect(out).toBe("{}");
    expect(elapsedMs).toBeLessThan(
      HTTP_TIMEOUT_MS * SESSION_START_BUDGET_RATIO + MARGIN_MS,
    );
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  test("a hub slower than every budget: the race answers {} within budget + margin — the briefing degrades, never the hook", async () => {
    // Arrange: every endpoint slower than the whole hook budget. Since
    // Block 7 this sessionStart also attempts the briefing (six parallel
    // GETs) — all of them die on the per-request timeout, the briefing
    // collapses to silence, and the hook still answers inside its budget:
    // the briefing prefetch/fallback discipline, measured.
    const hub = startSlowHub({ ingest: 5000, end: 5000, other: 5000 });
    const repo = await makeRepo("budget-slow", { remote: REMOTE });
    const home = await makeHome("budget-slow");
    const timeoutMs = 300;

    try {
      // Act
      const startedAt = performance.now();
      const out = await runCursorHook(
        "sessionStart",
        payloadIn(repo, "conv-budget-3"),
        {
          CROSSCHECK_HOME: home,
          CROSSCHECK_HUB_URL: hub.url,
          CROSSCHECK_API_KEY: "test-key",
          CROSSCHECK_TIMEOUT_MS: String(timeoutMs),
        },
      );
      const elapsedMs = performance.now() - startedAt;

      // Assert: inside the budget — the per-request timeouts carry it (the
      // race, pinned in hook-budget.test.ts, is the backstop if they could
      // not) — never hung on the hub.
      expect(out).toBe("{}");
      expect(elapsedMs).toBeLessThan(
        timeoutMs * SESSION_START_BUDGET_RATIO + MARGIN_MS,
      );
    } finally {
      hub.stop();
      await rm(repo, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test("the emission reserve is never spent on the heartbeat: spareMs 0 → hint delivered, ZERO heartbeat calls", async () => {
    // Arrange: a hub that answers candidates instantly and counts heartbeat
    // hits; a due heartbeat (lastHeartbeatAt null). The fake budget is the
    // state after a slow flush: nothing spare — exactly when an unclamped
    // heartbeat would eat the reserve that carries the hint out of the hook.
    let heartbeats = 0;
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const { pathname } = new URL(request.url);
        if (pathname === "/api/hints/candidates") {
          return Response.json({
            ok: true,
            data: { candidates: [rejectedApproachCandidate()] },
          });
        }
        if (pathname.endsWith("/heartbeat")) {
          heartbeats += 1;
        }
        return Response.json({
          ok: true,
          data: { session: { id: "cc_x", developerId: "dev_self" } },
        });
      },
    });
    const hubUrl = `http://127.0.0.1:${server.port}`;
    const repo = await makeRepo("reserve-skip", { remote: REMOTE });
    const home = await makeHome("reserve-skip");
    const conv = "conv-reserve-skip";
    try {
      await writeSessionState(home, {
        hostSessionKey: `cur-${conv}`,
        crosscheckSessionId: `cc_cur-${conv}`,
        workContextId: `wc_cc_cur-${conv}`,
        repoId: "github.com/acme/api",
        repoRoot: repo,
        hubUrl,
        developerId: "dev_self",
        startedAt: new Date().toISOString(),
        lastHeartbeatAt: null,
        seenTargets: [],
        deliveredHintRefs: [],
        deliveredHintHashes: [],
        tripwireAskedFiles: [],
        briefingSolvedRefs: [],
        foreignRepoDrops: 0,
        briefingPending: false,
        stopTurnCount: 0,
        summarizerFireCount: 0,
        summarizerLastFireTurn: null,
        summarizerEstimatedTokens: 0,
        summarizerNoneCount: 0,
        summarizerDraftCount: 0,
        summarizerFailCount: 0,
        summarizerLastFailure: null,
        workContextTitle: null,
        workContextStatus: null,
        intentFireCount: 0,
        intentNoneCount: 0,
        intentSetCount: 0,
        intentFailCount: 0,
        intentLastFailure: null,
      } satisfies SessionState);
      const ctx = await prepareCursorHook(
        "postToolUse",
        JSON.stringify({
          ...POST_TOOL_USE_FAILING_COMMAND,
          conversation_id: conv,
          workspace_roots: [repo],
        }),
        {
          CROSSCHECK_HOME: home,
          CROSSCHECK_HUB_URL: hubUrl,
          CROSSCHECK_API_KEY: "test-key",
        },
      );
      if (ctx === null) {
        throw new Error("cursor hook context did not resolve");
      }

      // Act
      const out = await handleCursorPostToolUse(ctx, { spareMs: () => 0 });

      // Assert: the hint survived, and the reserve was not spent.
      expect(deliveredAdditionalContext(out)).toContain(CANDIDATE_BODY);
      expect(heartbeats).toBe(0);
    } finally {
      server.stop(true);
      await rm(repo, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a due heartbeat against a HANGING hub is clamped to the spare budget — the hint still leaves promptly", async () => {
    // Arrange: heartbeat hangs far past the per-request timeout; the spare
    // budget is small. Unclamped, the heartbeat runs a full request timeout
    // AFTER the hint is in hand — precisely the reserve. Clamped, it aborts
    // at the room left and the hint is out well inside the detector bound.
    const HEARTBEAT_HANG_MS = 5000;
    const ROOM_MS = 100;
    /** Far above room + overhead, far below the unclamped request timeout. */
    const PROMPT_EXIT_BOUND_MS = 1500;
    const REQUEST_TIMEOUT_MS = "3000";
    let heartbeats = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const { pathname } = new URL(request.url);
        if (pathname === "/api/hints/candidates") {
          return Response.json({
            ok: true,
            data: { candidates: [rejectedApproachCandidate()] },
          });
        }
        if (pathname.endsWith("/heartbeat")) {
          heartbeats += 1;
          await new Promise((done) => {
            setTimeout(done, HEARTBEAT_HANG_MS);
          });
        }
        return Response.json({
          ok: true,
          data: { session: { id: "cc_x", developerId: "dev_self" } },
        });
      },
    });
    const hubUrl = `http://127.0.0.1:${server.port}`;
    const repo = await makeRepo("reserve-clamp", { remote: REMOTE });
    const home = await makeHome("reserve-clamp");
    const conv = "conv-reserve-clamp";
    try {
      await writeSessionState(home, {
        hostSessionKey: `cur-${conv}`,
        crosscheckSessionId: `cc_cur-${conv}`,
        workContextId: `wc_cc_cur-${conv}`,
        repoId: "github.com/acme/api",
        repoRoot: repo,
        hubUrl,
        developerId: "dev_self",
        startedAt: new Date().toISOString(),
        lastHeartbeatAt: null,
        seenTargets: [],
        deliveredHintRefs: [],
        deliveredHintHashes: [],
        tripwireAskedFiles: [],
        briefingSolvedRefs: [],
        foreignRepoDrops: 0,
        briefingPending: false,
        stopTurnCount: 0,
        summarizerFireCount: 0,
        summarizerLastFireTurn: null,
        summarizerEstimatedTokens: 0,
        summarizerNoneCount: 0,
        summarizerDraftCount: 0,
        summarizerFailCount: 0,
        summarizerLastFailure: null,
        workContextTitle: null,
        workContextStatus: null,
        intentFireCount: 0,
        intentNoneCount: 0,
        intentSetCount: 0,
        intentFailCount: 0,
        intentLastFailure: null,
      } satisfies SessionState);
      const ctx = await prepareCursorHook(
        "postToolUse",
        JSON.stringify({
          ...POST_TOOL_USE_FAILING_COMMAND,
          conversation_id: conv,
          workspace_roots: [repo],
        }),
        {
          CROSSCHECK_HOME: home,
          CROSSCHECK_HUB_URL: hubUrl,
          CROSSCHECK_API_KEY: "test-key",
          CROSSCHECK_TIMEOUT_MS: REQUEST_TIMEOUT_MS,
        },
      );
      if (ctx === null) {
        throw new Error("cursor hook context did not resolve");
      }

      // Act
      const startedAt = performance.now();
      const out = await handleCursorPostToolUse(ctx, {
        spareMs: () => ROOM_MS,
      });
      const elapsedMs = performance.now() - startedAt;

      // Assert: heartbeat attempted but clamped; the hint left promptly.
      expect(deliveredAdditionalContext(out)).toContain(CANDIDATE_BODY);
      expect(heartbeats).toBe(1);
      expect(elapsedMs).toBeLessThan(PROMPT_EXIT_BOUND_MS);
    } finally {
      server.stop(true);
      await rm(repo, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a deferred end AND a backlog to drain: one request timeout is held back, so the end lands", async () => {
    // Arrange: the Claude holdback fixture, ported (hook-budget.test.ts —
    // where the livelock argument lives): a stranded end whose own backlog is
    // gone, next to an old session's 600-record backlog, with ingest at
    // 350 ms a batch. Handed the WHOLE spare, the drain runs to its deadline
    // by construction — every batch either costs the full ingest latency or
    // aborts at the clamp — and the ender then reads spareMs() = 0 on every
    // single start: the deferred end starves to its age-out. The holdback in
    // handlers/session-start.ts is the cursor half of that fix, and THIS pin
    // is what makes the cursor call site load-bearing on its own — the
    // adversarial review proved the Claude suite stays green when only the
    // cursor subtraction is dropped. The fixture's latency dial is the whole
    // interleaving; nothing here depends on machine speed.
    const INGEST_LATENCY_MS = 350;
    const BACKLOG = 600;
    const hub = startSlowHub({ ingest: INGEST_LATENCY_MS, end: 0, other: 0 });
    const repo = await makeRepo("budget-holdback", { remote: REMOTE });
    const home = await makeHome("budget-holdback");
    const key = repoKey(hub.url, "github.com/acme/api");
    const markerPath = spoolPendingEndPath(home, key, sessionSlug("stranded-uuid"));
    await ensureDir(spoolDir(home, key));
    await writeFile(
      markerPath,
      `${JSON.stringify({
        crosscheckSessionId: "cc_stranded-uuid",
        at: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    await appendRecords(
      home,
      key,
      "old-session",
      Array.from({ length: BACKLOG }, (_unused, index) => ({
        cx: "0.1",
        id: `env_backlog_${index}`,
        ts: new Date().toISOString(),
        producer: {
          developerId: "dev_self",
          agentKind: "cursor-ide",
          sessionId: "cc_old-session",
        },
        kind: "target",
        body: { workContextId: "wc_1", kind: "file", value: `src/f${index}.ts` },
      })),
      new Date(),
    );

    try {
      // Act — the real runner, at the documented default timeout and budget.
      const startedAt = performance.now();
      const out = await runCursorHook(
        "sessionStart",
        payloadIn(repo, "conv-budget-holdback"),
        {
          CROSSCHECK_HOME: home,
          CROSSCHECK_HUB_URL: hub.url,
          CROSSCHECK_API_KEY: "test-key",
        },
      );
      const elapsedMs = performance.now() - startedAt;

      // Assert: the briefing survives, the budget holds, AND the deferred
      // end landed — the drain was held to spare minus one request timeout,
      // which is exactly what the end call needs and all it may spend.
      expect(deliveredAdditionalContext(out)).toContain(TEAMMATE_NAME);
      expect(elapsedMs).toBeLessThan(
        HTTP_TIMEOUT_MS * SESSION_START_BUDGET_RATIO + MARGIN_MS,
      );
      expect(hub.calls.end).toBe(1);
      expect(await Bun.file(markerPath).exists()).toBe(false);
    } finally {
      hub.stop();
      await rm(repo, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test("hint fast path against candidates slower than every budget: {} within the postToolUse ratio + margin", async () => {
    // Arrange: the canned hint hub with a candidates endpoint slower than
    // the whole hook budget; a registered session so the failing tool
    // output reaches the hint attempt directly.
    const hub = startHintHub({ candidates: 5000, tripwire: 0 });
    const repo = await makeRepo("budget-hint", { remote: REMOTE });
    const home = await makeHome("budget-hint");
    const timeoutMs = 300;
    const conv = "conv-budget-hint";

    try {
      await writeSessionState(home, {
        hostSessionKey: `cur-${conv}`,
        crosscheckSessionId: `cc_cur-${conv}`,
        workContextId: `wc_cc_cur-${conv}`,
        repoId: "github.com/acme/api",
        repoRoot: repo,
        hubUrl: hub.url,
        developerId: "dev_self",
        startedAt: new Date().toISOString(),
        lastHeartbeatAt: null,
        seenTargets: [],
        deliveredHintRefs: [],
        deliveredHintHashes: [],
        tripwireAskedFiles: [],
        briefingSolvedRefs: [],
        foreignRepoDrops: 0,
        briefingPending: false,
        stopTurnCount: 0,
        summarizerFireCount: 0,
        summarizerLastFireTurn: null,
        summarizerEstimatedTokens: 0,
        summarizerNoneCount: 0,
        summarizerDraftCount: 0,
        summarizerFailCount: 0,
        summarizerLastFailure: null,
        workContextTitle: null,
        workContextStatus: null,
        intentFireCount: 0,
        intentNoneCount: 0,
        intentSetCount: 0,
        intentFailCount: 0,
        intentLastFailure: null,
      } satisfies SessionState);

      // Act
      const startedAt = performance.now();
      const out = await runCursorHook(
        "postToolUse",
        JSON.stringify({
          ...POST_TOOL_USE_FAILING_COMMAND,
          conversation_id: conv,
          workspace_roots: [repo],
        }),
        {
          CROSSCHECK_HOME: home,
          CROSSCHECK_HUB_URL: hub.url,
          CROSSCHECK_API_KEY: "test-key",
          CROSSCHECK_TIMEOUT_MS: String(timeoutMs),
        },
      );
      const elapsedMs = performance.now() - startedAt;

      // Assert: the candidates call died on the per-request timeout, the
      // hint became silence, the hook answered inside its own budget — and
      // the attempt really happened (this is the fast path, not a skip).
      expect(out).toBe("{}");
      expect(hub.calls.candidates).toBe(1);
      expect(elapsedMs).toBeLessThan(
        timeoutMs * POST_TOOL_USE_BUDGET_RATIO + MARGIN_MS,
      );
    } finally {
      hub.stop();
      await rm(repo, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
