/**
 * Subprocess body for the memoization pin in
 * test/repo-ssh-determinism.test.ts: resolves the SAME host twice and a
 * second host once through one resolver, and prints the three answers.
 * The launching test's fake `ssh` appends one line per invocation to
 * CX_SSH_COUNT_FILE, so the line count IS the spawn count: 2 proves that the
 * second resolution of an already-answered host never re-spawns ssh within
 * one process, while a distinct host still gets its own evaluation.
 *
 * The resolver awaits ssh's own exit (fixtures/run-to-exit.ts): the subject
 * is the memo of an ANSWER, and through the hook path's 500 ms deadline a
 * contended first spawn answered null instead (28 of 36 runs under load) —
 * which the old memo then served for the repeat. The deadline's own memo
 * policy is pinned in-process by ssh-hostname-deadline.test.ts.
 */
import { createSshHostnameResolver } from "../../src/git/ssh-hostname.ts";
import { runToExit } from "./run-to-exit.ts";

const resolveSshHostname = createSshHostnameResolver(runToExit);

const first = await resolveSshHostname("alpha.example", process.cwd());
const second = await resolveSshHostname("alpha.example", process.cwd());
const third = await resolveSshHostname("beta.example", process.cwd());
console.log(JSON.stringify({ answers: [first, second, third] }));
process.exit(0);
