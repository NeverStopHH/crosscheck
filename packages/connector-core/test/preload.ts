/**
 * Runs before every test file (wired by bunfig.toml at the repo root AND in
 * this package, so both `bun test` invocation cwds get it): forces ssh
 * identity canonicalization OFF for the whole suite.
 *
 * Without it, every test that reaches resolveRepoIdentity's DEFAULT resolver
 * evaluates THIS machine's ~/.ssh/config — a config that rewrites github.com
 * turns dozens of `github.com/acme/api` assertions red (green was machine
 * luck), and even a clean run spawns hundreds of real `ssh -G` processes.
 *
 * Tests that exercise the real resolution machinery opt back in by dropping
 * the variable from the env of the subprocess they spawn
 * (test/repo-ssh-determinism.test.ts, test/repo-ssh-alias.test.ts). The
 * wiring itself is pinned by "the preload wired the off-switch for this very
 * run" — a run that lost the preload fails there instead of going
 * nondeterministic silently.
 */
import { SSH_CANONICALIZE_ENV, SSH_CANONICALIZE_OFF } from "../src/constants.ts";

process.env[SSH_CANONICALIZE_ENV] = SSH_CANONICALIZE_OFF;
