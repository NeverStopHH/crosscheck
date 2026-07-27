import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { MS_PER_DAY, recordUnclosedSession, repoKey, runCli } from "../src/index.ts";
import { ensureDir, spoolDropsPath } from "../src/config/paths.ts";
import { recordDrop } from "../src/spool/drops.ts";
import { makeHome, makeRepo } from "./helpers.ts";

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
