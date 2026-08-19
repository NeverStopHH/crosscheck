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
 * the hint's one candidates call is bounded the same way, with the shared
 * race as backstop. Both are MEASURED below through the real runner.
 */
import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import {
  HTTP_TIMEOUT_MS,
  POST_TOOL_USE_BUDGET_RATIO,
  SESSION_START_BUDGET_RATIO,
} from "@crosscheck/connector-core/constants.ts";
import { writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";

import { runCursorHook } from "../src/index.ts";
import {
  POST_TOOL_USE_FAILING_COMMAND,
  SESSION_START_INPUT,
} from "./fixtures/cursor-contract/payloads.ts";
import { startSlowHub } from "../../connector-claude/test/fixtures/slow-hub.ts";
import { startHintHub } from "../../connector-core/test/fixtures/hint-hub.ts";
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

      // Assert: abandoned by the shared race, never hung on the hub.
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
        stopTurnCount: 0,
        summarizerFireCount: 0,
        summarizerLastFireTurn: null,
        summarizerEstimatedTokens: 0,
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
