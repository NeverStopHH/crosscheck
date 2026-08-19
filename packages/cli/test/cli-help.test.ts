/**
 * Every subcommand answers --help/-h with usage and does NOTHING else, and an
 * unknown flag is an error, never silently ignored. The incident (2026-08-18
 * trial onboarding): `crosscheck init --help` RAN a full init in the wrong
 * repo — the flag fell through an indexOf-based parser and the command's only
 * reading of "--help" was "not one of my flags, carry on".
 *
 * Table-driven across all user-facing subcommands, with a COUNTING hub so
 * "does nothing else" is proven for the network too, and a real git repo so
 * it is proven for the filesystem (init's writes are the incident).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { runCli } from "../src/cli/index.ts";
import { EXIT_OK, EXIT_USAGE } from "@crosscheck/connector-core/constants.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const HELP_FLAGS = ["--help", "-h"] as const;

/** Every user-facing subcommand and a word its usage text must contain. */
const SUBCOMMANDS: readonly (readonly [string, string])[] = [
  ["login", "login"],
  ["init", "init"],
  ["status", "status"],
  ["doctor", "doctor"],
  ["presence", "presence"],
  ["mute", "mute"],
  ["unmute", "unmute"],
];

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

interface Fixture {
  readonly repo: string;
  readonly env: Record<string, string>;
  readonly hubCalls: () => number;
  readonly stop: () => void;
}

/**
 * A fully configured environment in front of a hub that COUNTS every request:
 * help and flag errors must leave the counter at zero — a subcommand that
 * "helpfully" phones home on --help is doing something else.
 */
const fixture = async (label: string): Promise<Fixture> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      calls += 1;
      return Response.json({ ok: true, data: { sessions: [] } });
    },
  });
  return {
    repo,
    env: {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: `http://127.0.0.1:${server.port}`,
      CROSSCHECK_API_KEY: "test-key",
    },
    hubCalls: () => calls,
    stop: () => server.stop(true),
  };
};

/** The three files a real init writes — none may exist after help/error. */
const initArtifacts = (repo: string): readonly string[] => [
  join(repo, ".claude", "settings.json"),
  join(repo, ".mcp.json"),
  join(repo, ".crosscheck.json"),
];

describe("--help and -h answer with usage and do nothing else", () => {
  test("every subcommand, both spellings, exit 0, zero hub calls", async () => {
    // Arrange
    const { repo, env, hubCalls, stop } = await fixture("help-table");

    // Act + Assert: the table
    for (const [command, mustContain] of SUBCOMMANDS) {
      for (const flag of HELP_FLAGS) {
        const result = await runCli([command, flag], env, repo);
        expect(result.exitCode, `${command} ${flag}`).toBe(EXIT_OK);
        expect(result.stdout, `${command} ${flag}`).toContain("usage:");
        expect(result.stdout, `${command} ${flag}`).toContain(mustContain);
      }
    }
    stop();

    // Assert: nothing phoned home
    expect(hubCalls()).toBe(0);
  });

  test("init --help creates not a single file — the incident's exact shape", async () => {
    // Arrange
    const { repo, env, stop } = await fixture("help-init");

    // Act
    const result = await runCli(["init", "--help"], env, repo);
    stop();

    // Assert
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("usage:");
    expect(result.stdout).not.toContain("wrote");
    for (const artifact of initArtifacts(repo)) {
      expect(await Bun.file(artifact).exists(), artifact).toBe(false);
    }
  });
});

describe("unknown flags error with usage instead of being ignored", () => {
  test("every subcommand rejects --hepl with exit 64, zero hub calls", async () => {
    // Arrange
    const { repo, env, hubCalls, stop } = await fixture("hepl-table");

    // Act + Assert: the table
    for (const [command] of SUBCOMMANDS) {
      const result = await runCli([command, "--hepl"], env, repo);
      expect(result.exitCode, command).toBe(EXIT_USAGE);
      expect(result.stdout, command).toContain("unknown flag");
      expect(result.stdout, command).toContain("--hepl");
      expect(result.stdout, command).toContain("usage:");
    }
    stop();

    // Assert
    expect(hubCalls()).toBe(0);
  });

  test("init --hepl must not init either", async () => {
    // Arrange
    const { repo, env, stop } = await fixture("hepl-init");

    // Act
    const result = await runCli(["init", "--hepl"], env, repo);
    stop();

    // Assert
    expect(result.exitCode).toBe(EXIT_USAGE);
    for (const artifact of initArtifacts(repo)) {
      expect(await Bun.file(artifact).exists(), artifact).toBe(false);
    }
  });

  test("known init flags still pass through to the command itself", async () => {
    // Arrange: --hub with an invalid value must reach init's OWN validation —
    // the intercept consumes the flag's value without inspecting it.
    const { repo, env, stop } = await fixture("known-flags");

    // Act
    const result = await runCli(["init", "--hub", "ftp://hub.example.com"], env, repo);
    stop();

    // Assert: init answered, not the flag gate
    expect(result.stdout).toContain("invalid hub url");
    expect(result.stdout).not.toContain("unknown flag");
  });
});

/**
 * Help is EAGER — a --help anywhere in argv wins, even after a value-flag.
 *
 * The gap (found reviewing F4 as the Asia teammate): the value-flag skip ran
 * BEFORE the help check, so `init --command-prefix --help` consumed `--help`
 * as the prefix VALUE and ran a full init — writing hooks whose launcher is
 * literally `--help hook session-start` (every hook then dies silently) and an
 * mcp entry `sh -c "--help mcp"`. That is the exact incident F4 fixed, moved
 * one token to the right: a human typing --help got init instead of usage, and
 * a BROKEN install committed into the repo.
 */
describe("help is eager: a value flag must not swallow --help", () => {
  test("init --command-prefix --help prints usage and writes nothing", async () => {
    // Arrange: --command-prefix is a value flag; --help is its "value"
    const { repo, env, stop } = await fixture("eager-prefix");

    // Act
    const result = await runCli(["init", "--command-prefix", "--help"], env, repo);
    stop();

    // Assert: help won, and not one init artifact exists
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("usage:");
    expect(result.stdout).not.toContain("wrote");
    for (const artifact of initArtifacts(repo)) {
      expect(await Bun.file(artifact).exists(), artifact).toBe(false);
    }
  });

  test("init --command-prefix -h is help too, not a prefix named -h", async () => {
    // Arrange
    const { repo, env, stop } = await fixture("eager-prefix-h");

    // Act
    const result = await runCli(["init", "--command-prefix", "-h"], env, repo);
    stop();

    // Assert
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("usage:");
    for (const artifact of initArtifacts(repo)) {
      expect(await Bun.file(artifact).exists(), artifact).toBe(false);
    }
  });

  test("a real prefix value is still consumed, help still eager after it", async () => {
    // Arrange: --command-prefix takes 'mytool', THEN --help — usage wins and
    // the real value is not mistaken for the flag.
    const { repo, env, stop } = await fixture("eager-prefix-real");

    // Act
    const result = await runCli(
      ["init", "--command-prefix", "mytool", "--help"],
      env,
      repo,
    );
    stop();

    // Assert
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("usage:");
    for (const artifact of initArtifacts(repo)) {
      expect(await Bun.file(artifact).exists(), artifact).toBe(false);
    }
  });
});

describe("crosscheck serve answers --help without booting the hub", () => {
  const BIN_PATH = join(import.meta.dir, "..", "src", "bin", "crosscheck.ts");

  const runServe = async (
    flag: string,
  ): Promise<{ readonly stdout: string; readonly exitCode: number }> => {
    const proc = Bun.spawn({
      cmd: [process.execPath, BIN_PATH, "serve", flag],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env },
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return { stdout, exitCode };
  };

  test("serve --help prints usage and exits 0 — no server, no data dir", async () => {
    // Act: without the intercept this would BOOT the hub and never exit
    const result = await runServe("--help");

    // Assert
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("usage:");
    expect(result.stdout).toContain("serve");
  });

  test("serve rejects an unknown flag with usage", async () => {
    // Act
    const result = await runServe("--hepl");

    // Assert
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stdout).toContain("unknown flag");
  });
});
