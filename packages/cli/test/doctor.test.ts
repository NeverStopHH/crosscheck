import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DOCTOR_FLUSH_LOCK_WARN_MS,
  MS_PER_DAY,
  recordUnclosedSession,
  repoKey,
  runCli,
} from "../src/index.ts";
import {
  ensureDir,
  spoolDir,
  spoolDropsPath,
  spoolFlushLockPath,
} from "@crosscheck/connector-core/config/paths.ts";
import { recordDrop } from "@crosscheck/connector-core/spool/drops.ts";
import { makeHome, makeRepo, spawnZombie } from "../../connector-core/test/helpers.ts";

/** Unreachable on purpose: the spool checks run whether the hub answers or not. */
const HUB_URL = "http://127.0.0.1:9";
const REPO_ID = "github.com/acme/api";

const doctorEnv = (home: string) => ({
  CROSSCHECK_HOME: home,
  HOME: home,
  CROSSCHECK_HUB_URL: HUB_URL,
  CROSSCHECK_API_KEY: "test-key",
});

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const fixture = async (): Promise<{
  readonly repo: string;
  readonly home: string;
}> => {
  const repo = await makeRepo("doctor", {
    remote: "git@github.com:acme/api.git",
  });
  const home = await makeHome("doctor");
  paths.push(repo, home);
  return { repo, home };
};

const DEBUG_BUNFIG = 'logLevel = "debug"\n';

describe("crosscheck doctor bun logging check", () => {
  test("warns and names the file when a repo bunfig enables debug logging", async () => {
    // Arrange
    const { repo, home } = await fixture();
    await writeFile(join(repo, "bunfig.toml"), DEBUG_BUNFIG, "utf8");

    // Act
    const result = await runCli(
      ["doctor"],
      { CROSSCHECK_HOME: home, HOME: home },
      repo,
    );

    // Assert
    expect(result.stdout).toContain("WARN  bun request logging");
    expect(result.stdout).toContain(join(repo, "bunfig.toml"));
    expect(result.stdout).toContain("rotate the key");
  });

  test("warns when the debug logLevel sits in the user's home instead", async () => {
    // Arrange
    const { repo, home } = await fixture();
    await writeFile(join(home, ".bunfig.toml"), DEBUG_BUNFIG, "utf8");

    // Act
    const result = await runCli(
      ["doctor"],
      { CROSSCHECK_HOME: home, HOME: home },
      repo,
    );

    // Assert
    expect(result.stdout).toContain("WARN  bun request logging");
    expect(result.stdout).toContain(join(home, ".bunfig.toml"));
  });

  test("passes when no discoverable bunfig turns logging up", async () => {
    // Arrange
    const { repo, home } = await fixture();
    await writeFile(join(repo, "bunfig.toml"), 'logLevel = "warn"\n', "utf8");

    // Act
    const result = await runCli(
      ["doctor"],
      { CROSSCHECK_HOME: home, HOME: home },
      repo,
    );

    // Assert
    expect(result.stdout).toContain("PASS  bun request logging");
  });
});

describe("crosscheck doctor workspace-root check (trial finding #9)", () => {
  test("warns when run ABOVE a connected repo — sessions starting here are invisible", async () => {
    // Arrange: a plain workspace folder with a connected repo one level down
    const workspace = await mkdtemp(join(tmpdir(), "cx-doctor-workspace-"));
    paths.push(workspace);
    const child = join(workspace, "monorepo");
    await mkdir(child, { recursive: true });
    await writeFile(
      join(child, ".crosscheck.json"),
      `${JSON.stringify({ hubUrl: HUB_URL })}\n`,
      "utf8",
    );
    const home = await makeHome("doctor-workspace");
    paths.push(home);

    // Act
    const result = await runCli(["doctor"], doctorEnv(home), workspace);

    // Assert
    expect(result.stdout).toContain("WARN  workspace root");
    expect(result.stdout).toContain("monorepo");
    expect(result.stdout).toContain("invisible");
  });

  test("stays quiet inside a repo and above folders without configs", async () => {
    // Arrange: a workspace whose subdirs carry no crosscheck config
    const workspace = await mkdtemp(join(tmpdir(), "cx-doctor-plain-"));
    paths.push(workspace);
    await mkdir(join(workspace, "notes"), { recursive: true });
    const home = await makeHome("doctor-plain");
    paths.push(home);

    // Act
    const above = await runCli(["doctor"], doctorEnv(home), workspace);
    const { repo, home: home2 } = await fixture();
    const inside = await runCli(["doctor"], doctorEnv(home2), repo);

    // Assert
    expect(above.stdout).not.toContain("workspace root");
    expect(inside.stdout).not.toContain("WARN  workspace root");
  });
});

describe("crosscheck doctor spool drops check", () => {
  test("says the drop total is a lower bound when a ledger append failed", async () => {
    // Arrange: a directory where the ledger file belongs, so its append fails
    const { repo, home } = await fixture();
    const key = repoKey(HUB_URL, REPO_ID);
    await ensureDir(spoolDropsPath(home, key, "gone-session"));
    await recordDrop(home, key, "gone-session", 7, "expired", new Date());

    // Act
    const result = await runCli(["doctor"], doctorEnv(home), repo);

    // Assert: the count nobody could write down is still visible here
    expect(result.stdout).toContain("WARN  spool drops");
    expect(result.stdout).toContain("lower bound");
  });

  test("status marks the same total as a lower bound, so both commands agree", async () => {
    // Arrange: same unwritable-ledger setup doctor uses
    const { repo, home } = await fixture();
    const key = repoKey(HUB_URL, REPO_ID);
    await ensureDir(spoolDropsPath(home, key, "gone-session"));
    await recordDrop(home, key, "gone-session", 7, "expired", new Date());

    // Act
    const result = await runCli(["status"], doctorEnv(home), repo);

    // Assert: a number status cannot vouch for must not read as exact
    expect(result.stdout).toContain("lower bound");
  });

  test("passes when every drop reached a ledger", async () => {
    // Arrange
    const { repo, home } = await fixture();

    // Act
    const result = await runCli(["doctor"], doctorEnv(home), repo);

    // Assert
    expect(result.stdout).toContain("PASS  spool drops  none");
  });
});

/**
 * The lock refuses to take a claim whose holder process is still running, which
 * is what stops a flush being robbed mid-request. A holder that CRASHED is not
 * running even while the process table still lists it — a zombie is retired by
 * the lock and reported here as gone — so what is left is the narrower state
 * that cannot resolve itself: a crashed holder's pid reused by an unrelated
 * long-lived process, whose claim is never retired and for whose lifetime flush
 * and reap are deferred. Failing open must not mean going silently dead, so it
 * has to be visible here — and the warning must not talk the reader out of the
 * case it exists for.
 */
describe("crosscheck doctor flush lock check", () => {
  test("warns, and names the pid, when a live process has held the lock far too long", async () => {
    // Arrange: a claim aged well past anything a hook could still be doing,
    // whose pid is a process that really is running.
    const { repo, home } = await fixture();
    const key = repoKey(HUB_URL, REPO_ID);
    const held = Bun.spawn({
      cmd: ["sleep", "30"],
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    await ensureDir(spoolDir(home, key));
    const lockPath = spoolFlushLockPath(home, key);
    await writeFile(lockPath, `${held.pid}:wedged\n`, "utf8");
    const longAgo = new Date(Date.now() - 10 * DOCTOR_FLUSH_LOCK_WARN_MS);
    await utimes(lockPath, longAgo, longAgo);

    // Act
    const result = await runCli(["doctor"], doctorEnv(home), repo);
    held.kill();

    // Assert: a developer can see WHICH process to go and look at, and is NOT
    // told to stand down when that pid turns out to be a crosscheck hook —
    // a crashed holder's pid is a crosscheck hook, and that advice sent the
    // operator away from the one case the warning exists for.
    expect(result.stdout).toContain("WARN  flush lock");
    expect(result.stdout).toContain(`pid ${held.pid}`);
    expect(result.stdout).not.toContain("if that pid is not a crosscheck hook");
  });

  test("passes when a stale lock's holder is gone, because the next flush retires it", async () => {
    // Arrange: the same aged claim, but nobody behind it. This one resolves
    // itself on the next acquisition and is not worth a developer's attention.
    const { repo, home } = await fixture();
    const key = repoKey(HUB_URL, REPO_ID);
    const gone = Bun.spawn({
      cmd: ["true"],
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    await gone.exited;
    await ensureDir(spoolDir(home, key));
    const lockPath = spoolFlushLockPath(home, key);
    await writeFile(lockPath, `${gone.pid}:crashed\n`, "utf8");
    const longAgo = new Date(Date.now() - 10 * DOCTOR_FLUSH_LOCK_WARN_MS);
    await utimes(lockPath, longAgo, longAgo);

    // Act
    const result = await runCli(["doctor"], doctorEnv(home), repo);

    // Assert
    expect(result.stdout).toContain("PASS  flush lock");
  });

  test("passes when a stale lock's holder is a zombie, not warns about it", async () => {
    // Arrange: the holder crashed and nobody has reaped it, so its entry is
    // still in the process table. Reported as running, this reads to an
    // operator as a healthy lock while the spool has in fact stopped draining.
    const { repo, home } = await fixture();
    const key = repoKey(HUB_URL, REPO_ID);
    const zombie = await spawnZombie();
    await ensureDir(spoolDir(home, key));
    const lockPath = spoolFlushLockPath(home, key);
    await writeFile(lockPath, `${zombie.pid}:crashed\n`, "utf8");
    const longAgo = new Date(Date.now() - 10 * DOCTOR_FLUSH_LOCK_WARN_MS);
    await utimes(lockPath, longAgo, longAgo);

    // Act
    const result = await runCli(["doctor"], doctorEnv(home), repo);
    zombie.release();

    // Assert: the same answer any other dead holder gets.
    expect(result.stdout).toContain("PASS  flush lock");
    expect(result.stdout).toContain("holder that is gone");
  });

  test("passes when no flush is running", async () => {
    // Arrange
    const { repo, home } = await fixture();

    // Act
    const result = await runCli(["doctor"], doctorEnv(home), repo);

    // Assert
    expect(result.stdout).toContain("PASS  flush lock  free");
  });
});

describe("crosscheck doctor unclosed sessions check", () => {
  test("warns about a session end that expired before it reached the hub", async () => {
    // Arrange: reap retired a week-old `.pending-end` marker
    const { repo, home } = await fixture();
    const nineDaysAgo = new Date(Date.now() - 9 * MS_PER_DAY);
    await recordUnclosedSession(home, repoKey(HUB_URL, REPO_ID), nineDaysAgo);

    // Act
    const result = await runCli(["doctor"], doctorEnv(home), repo);

    // Assert: the count survived the marker, and it names how long ago
    expect(result.stdout).toContain("WARN  unclosed sessions");
    expect(result.stdout).toContain("1 session end");
    expect(result.stdout).toContain("9d ago");
  });

  test("passes when every deferred end was eventually delivered", async () => {
    // Arrange
    const { repo, home } = await fixture();

    // Act
    const result = await runCli(["doctor"], doctorEnv(home), repo);

    // Assert
    expect(result.stdout).toContain("PASS  unclosed sessions  none");
  });
});

/**
 * Rule 6, on the MCP surface: fail-open must never mean silently dead.
 *
 * A hook that cannot run is invisible by design — it exits 0 and says nothing.
 * The MCP tools are the opposite: a failing CALL is visible to the agent, which
 * is better, but a tool that is not REGISTERED is never called at all and so
 * produces no message of any kind. Nothing else on this machine would say so.
 * That is the state these checks exist for.
 */
describe("crosscheck doctor mcp registration", () => {
  const initEnv = (home: string) => ({
    CROSSCHECK_HOME: home,
    HOME: home,
    CROSSCHECK_HUB_URL: HUB_URL,
    CROSSCHECK_API_KEY: "test-key",
  });

  test("fails when .mcp.json does not exist, and names the fix", async () => {
    // Arrange: a repo where the hooks may well be installed and the tools are
    // not — `init` predating this block leaves exactly this state
    const { repo, home } = await fixture();

    // Act
    const result = await runCli(["doctor"], initEnv(home), repo);

    // Assert
    expect(result.stdout).toContain("FAIL  mcp tools registered");
    expect(result.stdout).toContain("crosscheck init");
  });

  test("passes once init has written it", async () => {
    // Arrange
    const { repo, home } = await fixture();
    await runCli(["init"], initEnv(home), repo);

    // Act
    const result = await runCli(["doctor"], initEnv(home), repo);

    // Assert
    expect(result.stdout).toContain("PASS  mcp tools registered");
  });

  test("fails when the crosscheck entry was replaced by something else", async () => {
    // Arrange: the key is present, so a check that only looked for the KEY
    // would call this healthy. It points somewhere else entirely.
    const { repo, home } = await fixture();
    await writeFile(
      join(repo, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          crosscheck: { type: "stdio", command: "npx", args: ["-y", "something-else"] },
        },
      }),
      "utf8",
    );

    // Act
    const result = await runCli(["doctor"], initEnv(home), repo);

    // Assert
    expect(result.stdout).toContain("FAIL  mcp tools registered");
    expect(result.stdout).toContain("not the one crosscheck init writes");
  });

  test("warns rather than failing when .mcp.json is unparseable", async () => {
    // Arrange: distinct from "missing" because the fix is different — a
    // developer has to look at the file rather than re-run init over it
    const { repo, home } = await fixture();
    await writeFile(join(repo, ".mcp.json"), "{ not json", "utf8");

    // Act
    const result = await runCli(["doctor"], initEnv(home), repo);

    // Assert
    expect(result.stdout).toContain("mcp tools registered");
    expect(result.stdout).toContain("not valid json");
  });

  test("says the tools cannot work at all when there is no hub or key", async () => {
    // Arrange: the systematically-unusable case. Registration alone is not
    // enough — a registered server with no credentials answers every call with
    // an error, and the developer needs to know that before an agent finds out.
    const { repo, home } = await fixture();
    await runCli(["init"], initEnv(home), repo);

    // Act: no CROSSCHECK_API_KEY, and a home with no stored config
    const result = await runCli(["doctor"], { CROSSCHECK_HOME: home, HOME: home }, repo);

    // Assert
    expect(result.stdout).toContain("FAIL  mcp tools usable");
    expect(result.stdout).toContain("crosscheck login");
    expect(result.exitCode).toBe(2);
  });
});

/**
 * The launcher check: hooks and .mcp.json can pass every TEXTUAL check above
 * while calling a launcher that does not resolve (written from an npx cache)
 * or resolves to a FOREIGN binary that happens to be named `crosscheck`
 * (npm's crosscheck-cli ships one). Both are silent in the hooks by design,
 * so doctor must resolve and identify the launcher the way a hook would.
 */
describe("crosscheck doctor hook launcher check", () => {
  const launcherEnv = (home: string, pathDir?: string) => ({
    CROSSCHECK_HOME: home,
    HOME: home,
    CROSSCHECK_HUB_URL: HUB_URL,
    CROSSCHECK_API_KEY: "test-key",
    ...(pathDir === undefined ? {} : { PATH: pathDir }),
  });

  const fakeBin = async (script: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "cx-doctor-bin-"));
    paths.push(dir);
    const bin = join(dir, "crosscheck");
    await writeFile(bin, `#!/bin/sh\n${script}\n`, "utf8");
    await chmod(bin, 0o755);
    return dir;
  };

  test("fails when hooks call a bare crosscheck that is not on PATH", async () => {
    // Arrange: exactly what `npx crosscheck-hub init` used to leave behind
    const { repo, home } = await fixture();
    await runCli(
      ["init", "--command-prefix", "crosscheck"],
      launcherEnv(home),
      repo,
    );

    // Act: a PATH without crosscheck — the hooks' world after npx exits
    const result = await runCli(["doctor"], launcherEnv(home), repo);

    // Assert
    expect(result.stdout).toContain("FAIL  hook launcher");
    expect(result.stdout).toContain("nothing by that name is on PATH");
    // The remedy names the npm PACKAGE (crosscheck-hub), not the bin.
    expect(result.stdout).toContain("npm install -g crosscheck-hub");
    expect(result.exitCode).toBe(2);
  });

  test("fails when the crosscheck on PATH is a different tool", async () => {
    // Arrange
    const { repo, home } = await fixture();
    const dir = await fakeBin('echo "othertool 1.2.3"');
    await runCli(
      ["init", "--command-prefix", "crosscheck"],
      launcherEnv(home, dir),
      repo,
    );

    // Act
    const result = await runCli(["doctor"], launcherEnv(home, dir), repo);

    // Assert
    expect(result.stdout).toContain("FAIL  hook launcher");
  });

  test("passes when the launcher resolves and identifies as crosscheck", async () => {
    // Arrange: the healthy global-install state
    const { repo, home } = await fixture();
    const dir = await fakeBin('echo "crosscheck 9.9.9"');
    await runCli(
      ["init", "--command-prefix", "crosscheck"],
      launcherEnv(home, dir),
      repo,
    );

    // Act
    const result = await runCli(["doctor"], launcherEnv(home, dir), repo);

    // Assert
    expect(result.stdout).toContain("PASS  hook launcher");
  });

  test("passes on the absolute-path launcher init writes without a PATH hit", async () => {
    // Arrange: the repo-checkout flow — runtime and entry both exist here
    const { repo, home } = await fixture();
    await runCli(["init"], launcherEnv(home), repo);

    // Act
    const result = await runCli(["doctor"], launcherEnv(home), repo);

    // Assert
    expect(result.stdout).toContain("PASS  hook launcher");
  });
});
