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
 */
import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import {
  HTTP_TIMEOUT_MS,
  SESSION_START_BUDGET_RATIO,
} from "@crosscheck/connector-core/constants.ts";

import { runCursorHook } from "../src/index.ts";
import { SESSION_START_INPUT } from "./fixtures/cursor-contract/payloads.ts";
import { startSlowHub } from "../../connector-claude/test/fixtures/slow-hub.ts";
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

  test("a hub slower than every budget: the race answers {} within budget + margin", async () => {
    // Arrange: every endpoint slower than the whole hook budget.
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
});
