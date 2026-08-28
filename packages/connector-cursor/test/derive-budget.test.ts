/**
 * THE DERIVE RUNGS' COST, MEASURED — never asserted.
 *
 * Two of these events existed before this step and got slower: `stop` now
 * reads a bounded transcript tail, runs the gate and may spawn; `postToolUse`
 * now makes one extra state read to see whether a ghost debt is owed. The
 * third, `beforeSubmitPrompt`, is BRAND NEW and synchronous on every prompt
 * the developer sends — which is the one that can actually be FELT, so it is
 * the one measured most carefully.
 *
 * WHAT IS AND IS NOT MEASURED HERE. The hub answers 404 instantly, on
 * purpose: a slow hub is already pinned by budget.test.ts's race cases, and
 * mixing the two would hide this step's own cost inside network latency. What
 * is left is exactly what this step added — a state read, a lock round, a
 * 0600 file write, a bounded file read, a process spawn.
 *
 * Every case PRINTS its samples. A budget number in a comment is a claim; a
 * number a run wrote down is a measurement, and the difference is the whole
 * rule.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  HTTP_TIMEOUT_MS,
  POST_TOOL_USE_BUDGET_RATIO,
  STOP_BUDGET_RATIO,
  USER_PROMPT_SUBMIT_BUDGET_RATIO,
} from "@crosscheck/connector-core/constants.ts";
import { writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";

import { runCursorHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

/** A throwaway hub on this task's own port range — instant 404s. */
const server = Bun.serve({
  port: 7615,
  fetch: () => new Response("not found", { status: 404 }),
});
const HUB_URL = `http://127.0.0.1:${String(server.port)}`;

const CONV = "conv-budget-1";
const HOST_KEY = `cur-${CONV}`;
const SAMPLES = 5;
const paths: string[] = [];

afterEach(async () => {
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

afterAll(() => {
  server.stop(true);
});

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly env: Env;
}

const fixture = async (
  label: string,
  overrides: Record<string, unknown> = {},
): Promise<Fixture> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  await writeSessionState(home, {
    hostSessionKey: HOST_KEY,
    crosscheckSessionId: `cc_${HOST_KEY}`,
    workContextId: `wc_cc_${HOST_KEY}`,
    repoId: "github.com/acme/api",
    repoRoot: repo,
    hubUrl: HUB_URL,
    developerId: "dev_self",
    startedAt: new Date().toISOString(),
    workContextTitle: "main @ api",
    workContextStatus: "analyzing",
    ...overrides,
  });
  return {
    repo,
    home,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: HUB_URL,
      CROSSCHECK_API_KEY: "test-key",
      CURSOR_PROJECT_DIR: repo,
      // A binary that does not exist: the spawn still costs what a spawn
      // costs, and no model can run long enough to distort the reading.
      CROSSCHECK_SUMMARIZER_CMD: "/nonexistent/crosscheck-no-model",
      PATH: process.env["PATH"],
    },
  };
};

const measure = async (
  label: string,
  budgetMs: number,
  run: (index: number) => Promise<unknown>,
): Promise<void> => {
  const samples: number[] = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const startedAt = performance.now();
    await run(index);
    samples.push(Math.round(performance.now() - startedAt));
  }
  const worst = Math.max(...samples);
  process.stdout.write(
    `[derive-budget] ${label}: ${samples.join(", ")} ms (worst ${String(worst)}, budget ${String(budgetMs)})\n`,
  );
  expect(worst).toBeLessThan(budgetMs);
};

describe("the derive triggers stay inside their host's budget", () => {
  test("beforeSubmitPrompt — the NEW synchronous cost on every prompt submit", async () => {
    // Arrange: each iteration gets its own home so the FIRST-prompt path (the
    // expensive one: lock write, 0600 file, spawn) is what is timed every
    // time, never the cheap already-fired read.
    const budgetMs = USER_PROMPT_SUBMIT_BUDGET_RATIO * HTTP_TIMEOUT_MS;

    // Act + Assert
    await measure("beforeSubmitPrompt (first prompt, fires)", budgetMs, async (index) => {
      const fix = await fixture(`budget-prompt-${String(index)}`);
      return runCursorHook(
        "beforeSubmitPrompt",
        JSON.stringify({
          conversation_id: CONV,
          hook_event_name: "beforeSubmitPrompt",
          workspace_roots: [fix.repo],
          prompt: "why does the refresh call 500 after the key rotation",
        }),
        fix.env,
      );
    });
  }, 30_000);

  test("beforeSubmitPrompt — the steady-state cost, once the fire is spent", async () => {
    const fix = await fixture("budget-prompt-steady", { intentFireCount: 1 });
    const budgetMs = USER_PROMPT_SUBMIT_BUDGET_RATIO * HTTP_TIMEOUT_MS;

    await measure("beforeSubmitPrompt (already fired)", budgetMs, () =>
      runCursorHook(
        "beforeSubmitPrompt",
        JSON.stringify({
          conversation_id: CONV,
          hook_event_name: "beforeSubmitPrompt",
          workspace_roots: [fix.repo],
          prompt: "and now please also check the cache invalidation path",
        }),
        fix.env,
      ),
    );
  }, 30_000);

  test("stop — the transcript read, the gate and the spawn", async () => {
    const fix = await fixture("budget-stop");
    const transcript = join(fix.home, "transcript.jsonl");
    // A tail worth reading: ~40 KiB of turn, the shape a real gate sees.
    await writeFile(
      transcript,
      `${Array.from({ length: 200 }, (_, index) =>
        JSON.stringify({
          role: index % 2 === 0 ? "user" : "assistant",
          text: `line ${String(index)} — ${"x".repeat(180)}`,
        }),
      ).join("\n")}\n${JSON.stringify({
        role: "assistant",
        text: "ran bun test src/auth — 3 tests failed with TypeError. Root cause: the refresh path reads the retired key.",
      })}\n`,
      "utf8",
    );
    const budgetMs = STOP_BUDGET_RATIO * HTTP_TIMEOUT_MS;

    await measure("stop (transcript + gate + spawn)", budgetMs, () =>
      runCursorHook(
        "stop",
        JSON.stringify({
          conversation_id: CONV,
          hook_event_name: "stop",
          workspace_roots: [fix.repo],
          status: "completed",
          transcript_path: transcript,
        }),
        fix.env,
      ),
    );
  }, 30_000);

  test("postToolUse — the ghost-debt read added to an event that already ran", async () => {
    const fix = await fixture("budget-ptu", {
      ghostPending: true,
      workContextIntent: "Fix the refresh 500s after the key rotation",
    });
    const budgetMs = POST_TOOL_USE_BUDGET_RATIO * HTTP_TIMEOUT_MS;

    await measure("postToolUse (ghost debt owed)", budgetMs, () =>
      runCursorHook(
        "postToolUse",
        JSON.stringify({
          conversation_id: CONV,
          hook_event_name: "postToolUse",
          workspace_roots: [fix.repo],
          tool_name: "Shell",
          tool_output: JSON.stringify({ exitCode: 0, stdout: "ok" }),
        }),
        fix.env,
      ),
    );
  }, 30_000);
});
