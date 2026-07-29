import { afterEach, describe, expect, test } from "bun:test";
import { rm, utimes, writeFile } from "node:fs/promises";
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
} from "../src/config/paths.ts";
import { recordDrop } from "../src/spool/drops.ts";
import { makeHome, makeRepo, spawnZombie } from "./helpers.ts";

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
