/**
 * Measures what the hook PROCESS costs when the hub is instant and there is
 * nothing to send: interpreter start-up, module transpile, and the git
 * processes repo identity spawns. That floor is what PROCESS_ALLOWANCE_MS in
 * test/hook-time-budget.test.ts is set from, and a constant justified by a
 * measurement nobody can reproduce is worse than one with no justification at
 * all — so the measurement lives here, runnable, rather than in a comment.
 *
 *   bun run packages/connector-claude/scripts/measure-process-floor.ts [rounds]
 *
 * Reports min / p50 / max over `rounds` (default 10) of the cheapest hook there
 * is: PostToolUse on a Bash call that yields no target and no failure
 * fingerprint, against a zero-latency hub, with an empty spool. Anything above
 * this floor in the budget tests is hub time, not process time.
 *
 * No p90. At the default 10 rounds `Math.floor(10 * 0.9)` indexes the last
 * element of the sorted sample, so p90 WAS max, printed twice under two names —
 * a statistic that looks like corroboration and is arithmetic. Raising the
 * sample count to make it distinct would buy nothing here: the quantity being
 * measured is a floor, and min and max already bracket it. Every raw sample is
 * printed on the `samples` line, so anyone wanting another quantile has the data.
 *
 * It imports the budget test's own fixtures rather than rebuilding them, which
 * is the point: a floor measured against a different repo, home or hub would not
 * be the floor those ceilings sit on top of.
 */
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";
import { SELF_DEVELOPER_ID, startSlowHub } from "../test/fixtures/slow-hub.ts";
import { writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";

const BIN_PATH = resolve(import.meta.dir, "..", "src", "bin", "crosscheck.ts");
const REPO_ID = "github.com/acme/api";
const REPO_REMOTE = "git@github.com:acme/api.git";
const DEFAULT_ROUNDS = 10;
const SESSION_ID = "floor-uuid";
const MS_PER_NS = 1e6;

const median = (sorted: readonly number[]): number =>
  sorted[Math.floor(sorted.length / 2)] ?? 0;

const main = async (): Promise<number> => {
  const rounds = Number(process.argv[2] ?? DEFAULT_ROUNDS);
  const repo = await makeRepo("floor", { remote: REPO_REMOTE });
  const home = await makeHome("floor");
  const hub = startSlowHub({ ingest: 0, end: 0, other: 0 });
  try {
    await writeSessionState(home, {
      claudeSessionId: SESSION_ID,
      crosscheckSessionId: `cc_${SESSION_ID}`,
      workContextId: `wc_cc_${SESSION_ID}`,
      repoId: REPO_ID,
      repoRoot: repo,
      hubUrl: hub.url,
      developerId: SELF_DEVELOPER_ID,
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: null,
      seenTargets: [],
    });
    const payload = JSON.stringify({
      session_id: SESSION_ID,
      cwd: repo,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "bun test" },
      tool_response: { exit_code: 0, stdout: "ok" },
    });
    const elapsed: number[] = [];
    for (let round = 0; round < rounds; round += 1) {
      const startedAt = Bun.nanoseconds();
      const proc = Bun.spawn({
        cmd: [process.execPath, BIN_PATH, "hook", "post-tool-use"],
        env: {
          ...process.env,
          CROSSCHECK_HOME: home,
          CROSSCHECK_HUB_URL: hub.url,
          CROSSCHECK_API_KEY: "test-key",
          CROSSCHECK_DISABLED: "0",
        },
        stdin: new TextEncoder().encode(payload),
        stdout: "pipe",
        stderr: "ignore",
      });
      await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      elapsed.push(Math.round((Bun.nanoseconds() - startedAt) / MS_PER_NS));
    }
    const sorted = [...elapsed].sort((left, right) => left - right);
    process.stdout.write(`platform ${process.platform}/${process.arch}\n`);
    process.stdout.write(`rounds   ${String(rounds)}\n`);
    process.stdout.write(`samples  ${elapsed.join(" ")}\n`);
    process.stdout.write(
      `min ${String(sorted[0])}  p50 ${String(median(sorted))}  max ${String(sorted[sorted.length - 1])}\n`,
    );
    return 0;
  } finally {
    hub.stop();
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  process.exit(await main());
}
