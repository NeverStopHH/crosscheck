/**
 * Runs ONE hook through the real runner with a handler that never settles,
 * in a process of its own — for tests that need git slower than the hook's
 * budget on every machine.
 *
 * WHY A CHILD PROCESS: Bun.spawn resolves an executable from the environment
 * the process STARTED with, not from `process.env` as mutated later (measured
 * on bun 1.4: a slow `git` put first on `process.env.PATH` at runtime was
 * never the one spawned). So a test cannot slow the hook's git from inside its
 * own process; this child starts with the slow `git` already on PATH.
 *
 * Argv: <hook name> <stdin payload> <hook env as JSON> [real]. Prints exactly
 * what the hook answered on stdout — nothing for a silent hook — and the
 * caller reads the rest from what the hook wrote under the env's
 * CROSSCHECK_HOME. With `real`, the hook's OWN handler runs (runHook) rather
 * than one that never settles: the landed-change stop against a git that is
 * slow in a way the test chose (landed-probe-cut-hook.test.ts).
 */
import { runHook } from "../../src/hooks/index.ts";
import { runHookWith } from "../../src/hooks/runner.ts";
import type { HookName } from "../../src/hooks/runner.ts";

const [name, stdin, envJson, mode] = process.argv.slice(2);
if (name === undefined || stdin === undefined || envJson === undefined) {
  throw new Error("usage: run-hook-in-child.ts <hook> <stdin> <env json> [real]");
}

const neverSettles = (): Promise<string> => new Promise<string>(() => {});

const env = JSON.parse(envJson);
process.stdout.write(
  mode === "real"
    ? await runHook(name as HookName, stdin, env)
    : await runHookWith(name as HookName, neverSettles, stdin, env),
);
// The abandoned handler (and the slow git under it) would keep this process
// alive; the hook has answered and booked its loss, which is all the test reads.
process.exit(0);
