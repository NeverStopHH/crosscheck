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
 */
import { resolve } from "node:path";

import { selfSpawnCmd, withoutRuntimeInjection } from "@crosscheck/connector-core/config/runtime-isolation.ts";
import { SSH_CANONICALIZE_ENV } from "@crosscheck/connector-core/constants.ts";

import type { Env } from "../../../src/index.ts";

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
  return { ...inherited, ...own };
};

export interface ProcessRun {
  readonly stdout: string;
  /** Wall time of the whole process, boot included. */
  readonly durationMs: number;
}

const runEntry = async (args: readonly string[], stdin: string, env: Env, cwd: string): Promise<ProcessRun> => {
  const startedAt = performance.now();
  const child = Bun.spawn({
    cmd: [...selfSpawnCmd(CLI_ENTRY, args)],
    cwd,
    env: childEnv(env),
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "ignore",
  });
  const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { stdout, durationMs: Math.round(performance.now() - startedAt) };
};

/** `crosscheck hook <name>` with `stdin`, as Claude Code runs it. */
export const runHookProcess = async (name: string, stdin: string, env: Env, cwd: string): Promise<ProcessRun> =>
  runEntry(["hook", name], stdin, env, cwd);

/** `crosscheck statusline` with `stdin`, as Claude Code's status line runs it. */
export const runStatuslineProcess = async (stdin: string, env: Env, cwd: string): Promise<string> =>
  (await runEntry(["statusline"], stdin, env, cwd)).stdout.trimEnd();
