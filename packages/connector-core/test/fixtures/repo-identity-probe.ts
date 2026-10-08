/**
 * Subprocess body for test/repo-ssh-determinism.test.ts: builds a throwaway
 * repo whose remote is the canonical github form, resolves its identity
 * through the DEFAULT resolver — the exact path every hook, statusline render
 * and MCP tool call takes — and prints the repoId as JSON. A child process
 * because executable lookup is fixed at process start: the launching test
 * controls which `ssh` (if any) the default resolver can see purely through
 * the env it spawns this probe with (the ssh-hostname-probe.ts precedent).
 *
 * `--await-ssh` swaps ONE thing: the spawn primitive under the resolver
 * waits for ssh's own exit (fixtures/run-to-exit.ts) instead of racing the
 * hook path's 500 ms deadline, which CPU contention legitimately runs out.
 * The off-switch, the parse and the canonicalization are the same code; the
 * opted-in assertion is about those, not about the deadline.
 */
import { rm } from "node:fs/promises";

import { resolveRepoIdentity } from "../../src/git/repo-identity.ts";
import { createSshHostnameResolver } from "../../src/git/ssh-hostname.ts";
import { makeRepo } from "../helpers.ts";
import { runToExit } from "./run-to-exit.ts";

const AWAIT_SSH_FLAG = "--await-ssh";

const repo = await makeRepo("identity-probe", {
  remote: "git@github.com:acme/api.git",
});
const awaiting = createSshHostnameResolver(runToExit);
const identity = process.argv.includes(AWAIT_SSH_FLAG)
  ? await resolveRepoIdentity(repo, (host) => awaiting(host, repo))
  : await resolveRepoIdentity(repo);
console.log(JSON.stringify({ repoId: identity?.repoId ?? null }));
await rm(repo, { recursive: true, force: true });
process.exit(0);
