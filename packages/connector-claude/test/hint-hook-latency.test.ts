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
  POST_TOOL_USE_FAILURE_BUDGET_RATIO,
  USER_PROMPT_SUBMIT_BUDGET_RATIO,
} from "@crosscheck/connector-core/constants.ts";
import { writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { repoKey, sessionSlug } from "@crosscheck/connector-core/config/paths.ts";
import { readSessionSpool } from "@crosscheck/connector-core/spool/files.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";
import {
  solvedFingerprintMatch,
  startHintHub,
} from "../../connector-core/test/fixtures/hint-hub.ts";
import type { HintHub } from "../../connector-core/test/fixtures/hint-hub.ts";

const REPO_ID = "github.com/acme/api";
const SESSION_ID = "latency-uuid";
const PROMPT = "why does src/auth/refresh.ts still 500 after the key rotation";
const BUDGET_MS = USER_PROMPT_SUBMIT_BUDGET_RATIO * HTTP_TIMEOUT_MS;
/** The failure hook's own budget — same keystroke grade, own constant. */
const FAILURE_BUDGET_MS = POST_TOOL_USE_FAILURE_BUDGET_RATIO * HTTP_TIMEOUT_MS;
/** A failure text with enough signal that `fingerprint()` accepts it. */
const FAILURE_TEXT =
  "Exit code 1\nerror: expected 3 to be 4\n  at src/limiter.test.ts";
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
  solvedLatencyMs: number = 0,
): Promise<{ repo: string; home: string; env: Env; hub: HintHub }> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  const hub = startHintHub({
    candidates: candidateLatencyMs,
    tripwire: 0,
    solvedMatches: solvedLatencyMs,
  });
  hubs.push(hub);
  await writeSessionState(home, {
    hostSessionKey: SESSION_ID,
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
    home,
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

const failurePayload = (repo: string): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd: repo,
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command: "bun test" },
    error: FAILURE_TEXT,
    is_interrupt: false,
  });

/**
 * The SAME split for PostToolUseFailure, and it needs its own measurement
 * rather than inheriting the prompt hook's: this one runs inside the agent's
 * turn (nobody is typing, so nothing else paces it), it does MORE than the
 * prompt path per fire — a spool append for the fingerprint, the probe, the
 * delivery append, the state write, then a bounded flush — and it is the one
 * hook whose budget constant is new, which is exactly the kind of number
 * that is asserted and never measured.
 */
describe("the PostToolUseFailure budget, measured through runHook", () => {
  test("a responsive hub captures and answers inside the budget on every run", async () => {
    // Arrange
    const { repo, env, hub } = await fixture("failure-happy", 0);
    hub.setSolvedMatches([solvedFingerprintMatch()]);
    const elapsed: number[] = [];

    // Act — the same failing command five times, the retry-loop shape. Run 0
    // delivers; the later runs are the SILENT path and still pay capture,
    // flush and the state read, which is what these four measurements are
    // about. Their silence is the probed-fingerprint set rather than the
    // seen-set now: one fingerprint is asked about once per session, so
    // runs 1-4 stop before the hub (flows/solved-hint.ts).
    const stdout: string[] = [];
    for (let run = 0; run < HAPPY_RUNS; run += 1) {
      const startedAt = performance.now();
      stdout.push(await runHook("post-tool-use-failure", failurePayload(repo), env));
      elapsed.push(Math.round(performance.now() - startedAt));
    }

    // Assert — the WORK first, because a budget is only a measurement of a
    // hook that did it: an unregistered event, a dropped handler or a probe
    // nobody calls all finish in a millisecond and would pass every bound
    // below. Run 0 must carry the solved answer, the later runs must be the
    // seen-set's silence rather than a hook that never spoke.
    expect(stdout[0]).toContain("get_diagnosis");
    expect(stdout.slice(1)).toEqual(["", "", "", ""]);
    // Asked ONCE across the five, not "at least once": the repeats are the
    // whole point of a retry loop, and paying a round trip for each of them
    // is the cost this hook has no way to bound afterwards.
    expect(hub.calls.solvedMatches).toBe(1);

    // …then measured, then bounded
    console.log(
      `[failure-latency] responsive hub, ms per run: ${elapsed.join(", ")} (budget ${String(FAILURE_BUDGET_MS)})`,
    );
    for (const ms of elapsed) {
      expect(ms).toBeLessThan(FAILURE_BUDGET_MS);
    }
  });

  test("a hub that never answers the probe is cut at the budget, in silence", async () => {
    // Arrange
    const { repo, home, env, hub } = await fixture(
      "failure-hung",
      0,
      UNANSWERABLE_MS,
    );
    hub.setSolvedMatches([solvedFingerprintMatch()]);

    // Act
    const startedAt = performance.now();
    const stdout = await runHook(
      "post-tool-use-failure",
      failurePayload(repo),
      env,
    );
    const elapsedMs = Math.round(performance.now() - startedAt);

    // Assert — fail-open AND on time. The CAPTURE is asserted first: the
    // hook's whole ordering promise is that a slow hub costs the hint and
    // never the fingerprint, and without this line an empty stdout after a
    // millisecond would satisfy every bound here.
    const spool = await readSessionSpool(
      home,
      repoKey(hub.url, REPO_ID),
      sessionSlug(SESSION_ID),
    );
    const captured = spool.lines
      .map((line) => JSON.parse(line) as { kind: string; body: Record<string, unknown> })
      .filter(
        (record) =>
          record.kind === "target" && record.body["kind"] === "error_fingerprint",
      );
    expect(captured).toHaveLength(1);
    console.log(
      `[failure-latency] hung hub cut after ${String(elapsedMs)} ms (budget ${String(FAILURE_BUDGET_MS)} + slop ${String(RACE_SLOP_MS)})`,
    );
    expect(stdout).toBe("");
    expect(elapsedMs).toBeLessThanOrEqual(FAILURE_BUDGET_MS + RACE_SLOP_MS);
  });
});
