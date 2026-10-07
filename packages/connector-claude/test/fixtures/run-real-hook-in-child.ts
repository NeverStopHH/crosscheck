/**
 * Runs ONE hook through the real runner AND its real handler, in a process of
 * its own, and prints the hook's stdout — for tests that count what a hook
 * SPAWNS: the parent starts this child with a logging `git` first on PATH,
 * which a test cannot do to its own process (fixtures/run-hook-in-child.ts
 * says why: Bun.spawn resolves an executable from the environment a process
 * STARTED with).
 *
 * Argv: <hook name> <stdin payload> <hook env as JSON>.
 */
import { isHookName, runHook } from "../../src/hooks/index.ts";

const [name, stdin, envJson] = process.argv.slice(2);
if (name === undefined || stdin === undefined || envJson === undefined || !isHookName(name)) {
  throw new Error("usage: run-real-hook-in-child.ts <hook> <stdin> <env json>");
}

process.stdout.write(await runHook(name, stdin, JSON.parse(envJson)));
process.exit(0);
