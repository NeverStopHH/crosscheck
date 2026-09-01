/**
 * The Stop hook's SECOND evidence lane (regression-guard Stage 1), wired and
 * MEASURED.
 *
 * The lane exists because `sed -i`, codemods and generators produce no Edit
 * event at all, so `crosscheck suspect` built on the tool lane alone names
 * the session that used Edit while the codemod session leaves no trace. Its
 * cost is a budget question — the Stop hook's whole envelope is
 * STOP_BUDGET_RATIO x HTTP_TIMEOUT_MS — so the wall clock is asserted here
 * rather than reasoned about: hook budgets are measured, never claimed.
 *
 * TWO OUTCOMES ARE CORRECT, and the tests are split along that line, because
 * the first draft of this file was FLAKY for a real reason. On a saturated
 * machine the hook can reach the lane with less than GIT_TOUCHES_TIMEOUT_MS
 * of its envelope left, and it then skips — correctly, and with the skip
 * counted. A test that demands the lane always runs is therefore asserting
 * something the design does not promise: driven 12 times against a machine
 * held busy by eight spinning processes, 11 turns recorded and 1 skipped.
 * (HISTORICAL: that split is a property of the machine it was measured on,
 * so nothing in this tree re-derives it. What IS re-derived, on every run and
 * at any load, is the invariant the budget test below asserts.) So:
 *
 *   - the BEHAVIOUR tests raise CROSSCHECK_TIMEOUT_MS, which widens the Stop
 *     envelope past any plausible starvation, and then assert the lane's
 *     output exactly — including gitLaneSkipped === 0, so a test that passed
 *     only because the lane never ran cannot go green;
 *   - the BUDGET test keeps the DEFAULT envelope, because that is the number
 *     it exists to measure, and asserts the invariant that holds under any
 *     load: the lane either recorded or was COUNTED as skipped, never
 *     silently nothing. That is non-negotiable 4 written as an assertion, and
 *     it is exactly what a git deadline used to violate (a failing
 *     `git diff` returned the same empty list a clean tree does).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSpoolLines, repoKey, runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { readSessionState, writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";
import { git } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const SESSION_ID = "stop-git-session-uuid";
/** Port 1 refuses instantly: an unreachable hub without the wait. */
const DEAD_HUB_URL = "http://127.0.0.1:1";

/**
 * The Stop hook's own envelope is 800 ms (STOP_BUDGET_RATIO x
 * HTTP_TIMEOUT_MS) and its git lane is capped at GIT_TOUCHES_TIMEOUT_MS
 * (250 ms). This ceiling is deliberately generous — process spawn on a
 * loaded CI box is the variance here, not the lane — while still being far
 * under the point where a developer would notice their session pausing.
 */
const STOP_RETURN_CEILING_MS = 3000;

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly env: Env;
  readonly key: string;
  readonly transcript: string;
}

interface SpooledRecord {
  readonly kind: string;
  readonly body: { readonly value?: string; readonly source?: string };
}

const fixture = async (label: string, wide = true): Promise<Fixture> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  const dir = await mkdtemp(join(tmpdir(), "cx-stop-git-"));
  paths.push(repo, home, dir);
  await writeRepoFile(repo, "src/workbench/usePlayback.ts", "export const a = 1;\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "workbench"]);
  const transcript = join(dir, "transcript.jsonl");
  // A quiet turn: nothing for the summarizer gate, so this test measures the
  // lane rather than a model spawn.
  await writeFile(
    transcript,
    `${JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    })}\n`,
    "utf8",
  );
  await writeSessionState(home, {
    hostSessionKey: SESSION_ID,
    crosscheckSessionId: `cc_${SESSION_ID}`,
    workContextId: `wc_cc_${SESSION_ID}`,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl: DEAD_HUB_URL,
    developerId: "dev_self",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  return {
    repo,
    home,
    key: repoKey(DEAD_HUB_URL, REPO_ID),
    transcript,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: DEAD_HUB_URL,
      CROSSCHECK_API_KEY: "test-key",
      PATH: process.env["PATH"],
      // The DEFAULT Stop envelope is STOP_BUDGET_RATIO(2) x
      // HTTP_TIMEOUT_MS(400) = 800 ms, and the lane needs
      // GIT_TOUCHES_TIMEOUT_MS(250) of it still unspent. `wide` buys enough
      // room that a loaded machine cannot turn a behavioural assertion into
      // a budget measurement; the budget test below deliberately does not
      // pass it.
      ...(wide ? { CROSSCHECK_TIMEOUT_MS: "8000" } : {}),
    },
  };
};

const stopPayload = (fix: Fixture): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd: fix.repo,
    hook_event_name: "Stop",
    transcript_path: fix.transcript,
    stop_hook_active: false,
  });

const spooledTargets = async (fix: Fixture): Promise<readonly SpooledRecord[]> =>
  (await readSpoolLines(fix.home, fix.key))
    .map((line) => JSON.parse(line) as SpooledRecord)
    .filter((record) => record.kind === "target");

describe("the Stop hook's git evidence lane", () => {
  test("records a file no Edit tool reported, labelled git_diff", async () => {
    // Arrange: the codemod shape — the file changed, the host saw nothing.
    const fix = await fixture("stop-git-record");
    await writeRepoFile(fix.repo, "src/workbench/usePlayback.ts", "export const a = 2;\n");

    // Act
    const stdout = await runHook("stop", stopPayload(fix), fix.env);

    // Assert: the hook stays silent, and the evidence lands in the spool.
    expect(stdout).toBe("");
    const targets = await spooledTargets(fix);
    expect(targets.map((record) => record.body.value)).toEqual([
      "src/workbench/usePlayback.ts",
    ]);
    expect(targets[0]?.body.source).toBe("git_diff");
    // Folded into the seen-set, so the next Stop of the same session does not
    // record the same file again every turn.
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.seenTargets).toContain("src/workbench/usePlayback.ts");
    // Counted, because a lane that records nothing must be a number somebody
    // can explain rather than a silence (the finding-#14 lesson).
    expect(state?.gitTouchCount).toBe(1);
    expect(state?.gitLaneSkipped).toBe(0);
  });

  test("records nothing for a worktree that was already dirty before the session", async () => {
    // Arrange
    const fix = await fixture("stop-git-stale");
    const stale = join(fix.repo, "src/workbench/usePlayback.ts");
    await writeRepoFile(fix.repo, "src/workbench/usePlayback.ts", "export const a = 3;\n");
    const before = new Date(Date.now() - 3_600_000);
    await utimes(stale, before, before);

    // Act
    await runHook("stop", stopPayload(fix), fix.env);

    // Assert: nothing recorded — and the COUNTER says so, which is the whole
    // difference between a lane that ran and found nothing and a lane that
    // never ran. An empty spool alone is what a missing feature looks like.
    expect(await spooledTargets(fix)).toHaveLength(0);
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.gitTouchCount).toBe(0);
    // The lane RAN and chose to record nothing. Without this the test would
    // also pass on a turn where the lane never ran at all — which is what a
    // missing feature looks like.
    expect(state?.gitLaneSkipped).toBe(0);
  });

  test("stays inside the Stop budget, and is never silently nothing", async () => {
    // Arrange: the DEFAULT envelope — 800 ms — because that is the number
    // this test exists to measure. Budgets are MEASURED: a lane that quietly
    // waited on git would pass every other test here and stall the
    // developer's session.
    const fix = await fixture("stop-git-budget", false);
    await writeRepoFile(fix.repo, "src/workbench/usePlayback.ts", "export const a = 4;\n");

    // Act
    const started = Date.now();
    await runHook("stop", stopPayload(fix), fix.env);
    const elapsedMs = Date.now() - started;

    // Assert: the invariant that holds under ANY load. Exactly one of the two
    // honest outcomes happened — the lane recorded the file, or the turn is
    // counted as a skip — and the third possibility, silently nothing, is
    // what a timed-out `git diff` used to produce and what doctor would then
    // have reported as health.
    const state = await readSessionState(fix.home, SESSION_ID);
    const recorded = state?.gitTouchCount ?? 0;
    const skipped = state?.gitLaneSkipped ?? 0;
    console.log(`[stop-git-lane] recorded=${String(recorded)} skipped=${String(skipped)}`);
    expect(recorded + skipped).toBe(1);
    console.log(`[stop-git-lane] Stop returned in ${String(elapsedMs)} ms (ceiling ${String(STOP_RETURN_CEILING_MS)})`);
    expect(elapsedMs).toBeLessThan(STOP_RETURN_CEILING_MS);
  });
});
