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
 *
 * `--await-ssh` resolves through a resolver whose spawn waits for ssh's own
 * exit (fixtures/run-to-exit.ts), for the case whose subject is the PARSE of
 * a real dump: through the 500 ms deadline a contended first spawn answered
 * null instead (20 of 36 runs under load). Without the flag this is the
 * process's own resolver, deadline and all — what the hang case measures.
 */
import {
  createSshHostnameResolver,
  resolveSshHostname,
} from "../../src/git/ssh-hostname.ts";
import { runToExit } from "./run-to-exit.ts";

const PROBE_HOST = "github.com-probealias";
const AWAIT_SSH_FLAG = "--await-ssh";

const resolve = process.argv.includes(AWAIT_SSH_FLAG)
  ? createSshHostnameResolver(runToExit)
  : resolveSshHostname;

const started = performance.now();
const hostname = await resolve(PROBE_HOST, process.cwd());
const elapsedMs = performance.now() - started;
console.log(JSON.stringify({ hostname, elapsedMs }));
process.exit(0);
