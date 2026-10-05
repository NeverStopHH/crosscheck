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
 * Argv: <hook name> <stdin payload> <hook env as JSON>. Prints nothing; the
 * caller reads what the hook wrote under the env's CROSSCHECK_HOME.
 */
import { runHookWith } from "../../src/hooks/runner.ts";
import type { HookName } from "../../src/hooks/runner.ts";

const [name, stdin, envJson] = process.argv.slice(2);
if (name === undefined || stdin === undefined || envJson === undefined) {
  throw new Error("usage: run-hook-in-child.ts <hook> <stdin> <env json>");
}

const neverSettles = (): Promise<string> => new Promise<string>(() => {});

await runHookWith(name as HookName, neverSettles, stdin, JSON.parse(envJson));
// The abandoned handler (and the slow git under it) would keep this process
// alive; the hook has answered and booked its loss, which is all the test reads.
process.exit(0);
