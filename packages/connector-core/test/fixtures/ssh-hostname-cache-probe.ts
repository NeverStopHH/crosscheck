/**
 * Subprocess body for the memoization pin in
 * test/repo-ssh-determinism.test.ts: resolves the SAME host twice and a
 * second host once through resolveSshHostname, and prints the three answers.
 * The launching test's fake `ssh` appends one line per invocation to
 * CX_SSH_COUNT_FILE, so the line count IS the spawn count: 2 proves that the
 * second resolution of an already-answered host never re-spawns ssh within
 * one process, while a distinct host still gets its own evaluation.
 */
import { resolveSshHostname } from "../../src/git/ssh-hostname.ts";

const first = await resolveSshHostname("alpha.example", process.cwd());
const second = await resolveSshHostname("alpha.example", process.cwd());
const third = await resolveSshHostname("beta.example", process.cwd());
console.log(JSON.stringify({ answers: [first, second, third] }));
process.exit(0);
