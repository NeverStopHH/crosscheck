/**
 * Subprocess body for test/repo-ssh-alias.test.ts: calls resolveSshHostname
 * once against whatever `ssh` the launching test put first on PATH, and
 * prints the answer plus elapsed time as JSON. Runs as a child process
 * because executable lookup is fixed at process start — mutating
 * process.env.PATH inside a test does not redirect Bun.spawn's `ssh`
 * resolution, a fresh process's environment does (the
 * rungit-timeout-probe.ts precedent).
 *
 * Exits explicitly: an abandoned pipe read from a timed-out ssh must not
 * hold this process open, or the parent would measure the wrong elapsed.
 */
import { resolveSshHostname } from "../../src/git/ssh-hostname.ts";

const PROBE_HOST = "github.com-probealias";

const started = performance.now();
const hostname = await resolveSshHostname(PROBE_HOST, process.cwd());
const elapsedMs = performance.now() - started;
console.log(JSON.stringify({ hostname, elapsedMs }));
process.exit(0);
