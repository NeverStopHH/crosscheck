/**
 * A HOOK AS A REAL PROCESS, started the way an installed connector is: the
 * running bun with the runtime-isolation flags (config/runtime-isolation.ts
 * `selfSpawnCmd` — `--no-env-file --config=<crosscheck's empty bunfig>`), the
 * CLI entry, `hook <name>`, the payload on stdin, the session's directory as
 * cwd. The budget's race is the binary's own: when it wins, the process
 * prints what it has and EXITS, and whatever the handler had not written yet
 * is gone — which is the behaviour the production profile exists to see.
 *
 * THE CHILD'S ENVIRONMENT is this run's, minus everything that configures the
 * runtime (`BUN_OPTIONS` and kin — an installed hook has none, and keeping the
 * test preload would only make the entry restart itself, an extra ~50 ms
 * outside the budget), minus every `CROSSCHECK_*` a shell could have exported
 * except the two the test preloads set on purpose (ssh canonicalization off,
 * the guard's mark), plus the developer's own. So the only budget knob a
 * child can see is the one the profile put in the developer's env.
 *
 * NO FETCH GUARD RUNS IN THE CHILD (an installed hook has no test preload),
 * so the env is checked here instead, before any spawn, with the guard's own
 * rules: the hub must be a test hub (loopback, a port of its own, never
 * 7100) and the home must lie under the OS temp directory.
 *
 * A HOOK THAT NEVER EXITS is killed — by its own handle — after
 * HOOK_KILL_AFTER_MS, far past any budget, and its run says so; a hook
 * binary always exits 0 (bin/crosscheck.ts), so any other exit is a crash.
 * Both are what `crashedHooks` (release-gate/gate-checks.ts) reports.
 */
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { selfSpawnCmd, withoutRuntimeInjection } from "@crosscheck/connector-core/config/runtime-isolation.ts";
import { SSH_CANONICALIZE_ENV } from "@crosscheck/connector-core/constants.ts";

import { isTestHubUrl, isUnderDir } from "../../../../connector-core/test/network-guard-rules.ts";
import type { Env } from "../../../src/index.ts";

/** Far past every hook budget (SessionStart's is 1 s): a hook still running then is hung. */
const HOOK_KILL_AFTER_MS = 30_000;

/** The CLI entry an installed `crosscheck` runs. */
export const CLI_ENTRY = resolve(import.meta.dir, "..", "..", "..", "..", "cli", "src", "bin", "crosscheck.ts");

/** Set by connector-core/test/network-guard.ts on the env it hands children. */
const GUARD_MARK = "CROSSCHECK_TEST_NETWORK_GUARD";
const INHERITED_CROSSCHECK_KEYS = new Set([SSH_CANONICALIZE_ENV, GUARD_MARK]);

const childEnv = (env: Env): Record<string, string> => {
  const inherited = Object.fromEntries(
    Object.entries(withoutRuntimeInjection(process.env)).filter(
      ([name]) => !name.startsWith("CROSSCHECK_") || INHERITED_CROSSCHECK_KEYS.has(name),
    ),
  );
  const own = Object.fromEntries(
    Object.entries(env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])),
  );
  const merged = { ...inherited, ...own };
  if (!isTestHubUrl(merged["CROSSCHECK_HUB_URL"]) || !isUnderDir(merged["CROSSCHECK_HOME"], tmpdir())) {
    throw new Error("release gate refuses to start a hook whose hub is not a test hub or whose home is not a temp dir");
  }
  return merged;
};

/** When the host started a hook's process and when it saw it exit (epoch ms), and its pid: what joins a CX_HOOK_TRACE file. */
export interface ProcessTimes {
  readonly pid: number;
  readonly spawnedAt: number;
  readonly exitedAt: number;
}

export interface ProcessRun {
  readonly stdout: string;
  /** Wall time of the whole process, boot included. */
  readonly durationMs: number;
  readonly exitCode: number | null;
  /** True when the process outlived HOOK_KILL_AFTER_MS and was killed. */
  readonly wasKilled: boolean;
  readonly times: ProcessTimes;
}

const runEntry = async (args: readonly string[], stdin: string, env: Env, cwd: string): Promise<ProcessRun> => {
  const startedAt = performance.now();
  const spawnedAt = Date.now();
  const child = Bun.spawn({
    cmd: [...selfSpawnCmd(CLI_ENTRY, args)],
    cwd,
    env: childEnv(env),
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "ignore",
  });
  const killed = { value: false };
  const timer = setTimeout(() => {
    killed.value = true;
    child.kill("SIGKILL");
  }, HOOK_KILL_AFTER_MS);
  try {
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return {
      stdout,
      durationMs: Math.round(performance.now() - startedAt),
      exitCode,
      wasKilled: killed.value,
      times: { pid: child.pid, spawnedAt, exitedAt: Date.now() },
    };
  } finally {
    clearTimeout(timer);
  }
};

/** `crosscheck hook <name>` with `stdin`, as Claude Code runs it. */
export const runHookProcess = async (name: string, stdin: string, env: Env, cwd: string): Promise<ProcessRun> =>
  runEntry(["hook", name], stdin, env, cwd);

/** `crosscheck statusline` with `stdin`, as Claude Code's status line runs it; throws on a crash or a hang. */
export const runStatuslineProcess = async (stdin: string, env: Env, cwd: string): Promise<string> => {
  const run = await runEntry(["statusline"], stdin, env, cwd);
  if (run.exitCode !== 0 || run.wasKilled) {
    throw new Error(`the statusline process ${run.wasKilled ? "hung and was killed" : `exited ${String(run.exitCode)}`}`);
  }
  return run.stdout.trimEnd();
};
