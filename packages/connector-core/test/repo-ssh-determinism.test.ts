/**
 * The suite must NEVER answer to this machine's ~/.ssh/config — and one
 * process must never evaluate the same host twice.
 *
 * The finding (adversarial review of the F5 ssh-alias fix): the DEFAULT
 * resolver reaches `ssh -G` on every identity resolution, and dozens of test
 * files assert `github.com/acme/api` through exactly that path. On a machine
 * whose ssh config rewrites github.com to an unrelated host (a corporate
 * `Host *` HostName proxy) those assertions go red; on every machine the run
 * spawns hundreds of real ssh processes. Today's green was machine luck.
 *
 * The fix, both halves:
 *
 *   - CROSSCHECK_SSH_CANONICALIZE=off makes the default resolver answer null
 *     without spawning anything — fail-open, the literal host is kept. The
 *     suite preload (test/preload.ts, wired by bunfig.toml at the repo root
 *     AND in this package so both `bun test` cwds get it) sets it for every
 *     test run; it is equally the documented escape hatch for a developer
 *     whose config genuinely rewrites forge hosts. Tests that exercise the
 *     REAL resolution machinery opt back in by dropping the variable from the
 *     env of the subprocess they spawn — as done here and in
 *     repo-ssh-alias.test.ts.
 *
 *   - resolveSshHostname memoizes per host per process: `ssh -G` is pure
 *     config evaluation, so within one process the answer cannot change, and
 *     the long-lived MCP server was paying one spawn per tool call (worst
 *     case SSH_RESOLVE_TIMEOUT_MS each under a pathological config).
 *
 * Deterministic throughout: every subprocess sees only the fake `ssh` the
 * test put first on PATH — never this machine's config.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SSH_CANONICALIZE_ENV,
  SSH_CANONICALIZE_OFF,
} from "../src/constants.ts";
import { resolveSshHostname } from "../src/git/ssh-hostname.ts";

/** What every plain teammate's checkout reports — the id the hub must see. */
const CANONICAL_ID = "github.com/acme/api";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const makeFakeSshDir = async (script: string): Promise<string> => {
  const binDir = await mkdtemp(join(tmpdir(), "cx-fake-ssh-"));
  paths.push(binDir);
  const fake = join(binDir, "ssh");
  await writeFile(fake, script, "utf8");
  await chmod(fake, 0o755);
  return binDir;
};

/** The suite's own env, with the preload's off-switch dropped: opted back IN. */
const envOptedIn = (): Record<string, string | undefined> => {
  const { [SSH_CANONICALIZE_ENV]: _omitted, ...rest } = process.env;
  return rest;
};

const runFixture = async (
  fixture: string,
  env: Record<string, string | undefined>,
): Promise<string> => {
  const probe = join(import.meta.dir, "fixtures", fixture);
  const proc = Bun.spawn({
    cmd: [process.execPath, probe],
    cwd: import.meta.dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`probe exited ${String(exitCode)}: ${stderr}`);
  }
  return stdout;
};

describe("the suite never consults this machine's ssh config", () => {
  test("the preload wired the off-switch for this very run", () => {
    // Assert: catches a bunfig/preload wiring gap under ANY invocation cwd —
    // a run without it silently degrades to green-by-machine-luck.
    expect(process.env[SSH_CANONICALIZE_ENV]).toBe(SSH_CANONICALIZE_OFF);
  });

  test("a hostile machine config cannot reach a suite subprocess's identity", async () => {
    // Arrange: the corporate `Host *` proxy, as the ONLY ssh a subprocess can
    // find — spawned with the suite's own env, as every suite subprocess is.
    const binDir = await makeFakeSshDir(
      '#!/bin/sh\necho "hostname unrelated-proxy.example"\nexit 0\n',
    );

    // Act
    const stdout = await runFixture("repo-identity-probe.ts", {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    // Assert: the id every plain teammate has, not the proxy's
    expect(JSON.parse(stdout)).toEqual({ repoId: CANONICAL_ID });
  });

  test("opted back in, the default resolver still consults ssh config", async () => {
    // Arrange: same hostile config, but the off-switch dropped — the guard
    // that the switch did not quietly disable canonicalization for real users.
    const binDir = await makeFakeSshDir(
      '#!/bin/sh\necho "hostname corp-proxy.example"\nexit 0\n',
    );

    // Act
    const stdout = await runFixture("repo-identity-probe.ts", {
      ...envOptedIn(),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    // Assert: an unrelated resolved host is a genuine alias and canonicalizes
    expect(JSON.parse(stdout)).toEqual({ repoId: "corp-proxy.example/acme/api" });
  });

  test("off answers null in-process, before any spawn", async () => {
    // Arrange: the preload already set the switch for this process.

    // Act + Assert: null means the caller keeps the literal host — fail-open,
    // identical to ssh being absent.
    expect(await resolveSshHostname("github.com-anyalias", import.meta.dir)).toBeNull();
  });
});

describe("one process evaluates each host at most once", () => {
  test("a re-resolved host answers from memory; a new host still spawns", async () => {
    // Arrange: a counting fake ssh — one line per spawn, then the -G answer
    const binDir = await makeFakeSshDir(
      '#!/bin/sh\necho "$2" >> "$CX_SSH_COUNT_FILE"\necho "hostname resolved-$2"\nexit 0\n',
    );
    const countFile = join(binDir, "spawns.log");

    // Act: alpha, alpha again, beta — inside ONE probe process
    const stdout = await runFixture("ssh-hostname-cache-probe.ts", {
      ...envOptedIn(),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      CX_SSH_COUNT_FILE: countFile,
    });

    // Assert: three answers, two spawns — the repeat never re-ran ssh
    expect(JSON.parse(stdout)).toEqual({
      answers: ["resolved-alpha.example", "resolved-alpha.example", "resolved-beta.example"],
    });
    const spawned = (await readFile(countFile, "utf8")).trim().split("\n");
    expect(spawned).toEqual(["alpha.example", "beta.example"]);
  });
});
