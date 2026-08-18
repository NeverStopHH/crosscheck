/**
 * Subprocess body for test/git-timeout.test.ts: calls runGit once against
 * whatever `git` the launching test put first on PATH, and prints how long
 * the call took as JSON. Runs as a child process because executable lookup
 * is fixed at process start — mutating process.env.PATH inside a test does
 * not redirect Bun.spawn's `git` resolution, a fresh process's environment
 * does.
 *
 * Exits explicitly: an abandoned pipe read from a timed-out git must not be
 * allowed to hold this process open, or the elapsed time measured by the
 * parent would include it and the test would measure the wrong thing.
 */
import { runGit } from "../../src/git/git.ts";

const PROBE_TIMEOUT_MS = 250;

const started = performance.now();
const output = await runGit(["status"], process.cwd(), PROBE_TIMEOUT_MS);
const elapsedMs = performance.now() - started;
console.log(JSON.stringify({ output, elapsedMs }));
process.exit(0);
