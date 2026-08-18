/**
 * MEASURES the UserPromptSubmit budget instead of only asserting constants —
 * the other half of the split described in test/hint-budget.test.ts.
 *
 * Two measurements through the real `runHook`:
 *   - a responsive hub: the whole delivery path (prepare, hub call, drift git,
 *     render, spool append, state write) must fit the 800 ms budget with room;
 *   - a hub that never answers inside the budget: the race must return
 *     silence AT the budget, not after the hub.
 *
 * Elapsed times are printed so a slow run is a number in the log, not a guess.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import {
  HTTP_TIMEOUT_MS,
  USER_PROMPT_SUBMIT_BUDGET_RATIO,
} from "@crosscheck/connector-core/constants.ts";
import { writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";
import { startHintHub } from "../../connector-core/test/fixtures/hint-hub.ts";
import type { HintHub } from "../../connector-core/test/fixtures/hint-hub.ts";

const REPO_ID = "github.com/acme/api";
const SESSION_ID = "latency-uuid";
const PROMPT = "why does src/auth/refresh.ts still 500 after the key rotation";
const BUDGET_MS = USER_PROMPT_SUBMIT_BUDGET_RATIO * HTTP_TIMEOUT_MS;
/**
 * Scheduling slop over the budget race: the timer fires AT the deadline and
 * the event loop hands control back some milliseconds later. Generous enough
 * for a loaded CI runner, far below the next meaningful threshold.
 */
const RACE_SLOP_MS = 150;
const HAPPY_RUNS = 5;
/** A hub latency no budget can absorb — proves the race, not the hub, ends it. */
const UNANSWERABLE_MS = 10_000;

const paths: string[] = [];
const hubs: HintHub[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
  for (const hub of hubs) {
    hub.stop();
  }
  hubs.length = 0;
});

const fixture = async (
  label: string,
  candidateLatencyMs: number,
): Promise<{ repo: string; env: Env; hub: HintHub }> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  const hub = startHintHub({ candidates: candidateLatencyMs, tripwire: 0 });
  hubs.push(hub);
  await writeSessionState(home, {
    claudeSessionId: SESSION_ID,
    crosscheckSessionId: `cc_${SESSION_ID}`,
    workContextId: `wc_cc_${SESSION_ID}`,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl: hub.url,
    developerId: "dev_self",
    startedAt: new Date().toISOString(),
    lastHeartbeatAt: null,
    seenTargets: [],
    deliveredHintRefs: [],
    deliveredHintHashes: [],
    tripwireAskedFiles: [],
  });
  return {
    repo,
    hub,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: "test-key",
      // The default request timeout, stated: budget = ratio × this = 800 ms.
      CROSSCHECK_TIMEOUT_MS: String(HTTP_TIMEOUT_MS),
    },
  };
};

const payload = (repo: string): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd: repo,
    hook_event_name: "UserPromptSubmit",
    prompt: PROMPT,
  });

describe("the 800 ms sync budget, measured through runHook", () => {
  test("a responsive hub delivers the hint inside the budget on every run", async () => {
    // Arrange
    const { repo, env } = await fixture("happy", 0);
    const elapsed: number[] = [];

    // Act — first run delivers; later runs exercise the (dedup) silent path
    for (let run = 0; run < HAPPY_RUNS; run += 1) {
      const startedAt = performance.now();
      await runHook("user-prompt-submit", payload(repo), env);
      elapsed.push(Math.round(performance.now() - startedAt));
    }

    // Assert — measured, then bounded
    console.log(
      `[hint-latency] responsive hub, ms per run: ${elapsed.join(", ")} (budget ${String(BUDGET_MS)})`,
    );
    for (const ms of elapsed) {
      expect(ms).toBeLessThan(BUDGET_MS);
    }
  });

  test("a hub that never answers is cut at the budget, in silence", async () => {
    // Arrange
    const { repo, env } = await fixture("hung", UNANSWERABLE_MS);

    // Act
    const startedAt = performance.now();
    const stdout = await runHook("user-prompt-submit", payload(repo), env);
    const elapsedMs = Math.round(performance.now() - startedAt);

    // Assert — fail-open AND on time: the budget race ends the wait
    console.log(
      `[hint-latency] hung hub cut after ${String(elapsedMs)} ms (budget ${String(BUDGET_MS)} + slop ${String(RACE_SLOP_MS)})`,
    );
    expect(stdout).toBe("");
    expect(elapsedMs).toBeLessThanOrEqual(BUDGET_MS + RACE_SLOP_MS);
  });
});
