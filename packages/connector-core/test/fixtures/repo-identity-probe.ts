/**
 * Subprocess body for test/repo-ssh-determinism.test.ts: builds a throwaway
 * repo whose remote is the canonical github form, resolves its identity
 * through the DEFAULT resolver — the exact path every hook, statusline render
 * and MCP tool call takes — and prints the repoId as JSON. A child process
 * because executable lookup is fixed at process start: the launching test
 * controls which `ssh` (if any) the default resolver can see purely through
 * the env it spawns this probe with (the ssh-hostname-probe.ts precedent).
 */
import { rm } from "node:fs/promises";

import { resolveRepoIdentity } from "../../src/git/repo-identity.ts";
import { makeRepo } from "../helpers.ts";

const repo = await makeRepo("identity-probe", {
  remote: "git@github.com:acme/api.git",
});
const identity = await resolveRepoIdentity(repo);
console.log(JSON.stringify({ repoId: identity?.repoId ?? null }));
await rm(repo, { recursive: true, force: true });
process.exit(0);
