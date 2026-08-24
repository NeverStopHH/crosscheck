/**
 * Doctor's agent-restart check (trial finding #8): an agent process that was
 * already running when `crosscheck init` wrote the settings file never loads
 * the hooks — hooks load at process start and fail open, so nothing else
 * says so. The check is deterministic here: the process list and per-pid cwd
 * come from an injected probe, only the settings file (and its mtime) is
 * real. The single most important pin is the FALSE-POSITIVE one: an agent
 * running in a DIFFERENT repo is untouched by this repo's hooks and must not
 * produce a warning — that noise is how doctors get ignored.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  checkAgentRestart,
  parseLsofCwds,
  parsePsEtime,
  runDoctor,
} from "../src/cli/doctor.ts";
import type { AgentProcessProbe } from "../src/cli/doctor.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const HOUR_SECONDS = 3600;

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

/** A repo with a settings file whose mtime is `ageSeconds` in the past. */
const fixture = async (
  settingsAgeSeconds: number,
): Promise<{ repo: string; settingsPath: string }> => {
  const repo = await makeRepo("agent-restart", {
    remote: "git@github.com:acme/api.git",
  });
  paths.push(repo);
  const settingsDir = join(repo, ".claude");
  await mkdir(settingsDir, { recursive: true });
  const settingsPath = join(settingsDir, "settings.json");
  await writeFile(settingsPath, "{}\n", "utf8");
  const mtime = new Date(Date.now() - settingsAgeSeconds * 1000);
  await utimes(settingsPath, mtime, mtime);
  return { repo, settingsPath };
};

const probeOf = (
  psOutput: string | null,
  cwdByPid: Readonly<Record<number, string | null>>,
): AgentProcessProbe => ({
  listProcesses: async () => psOutput,
  // One call for the whole batch — a pid missing from the map is one whose
  // cwd could not be resolved.
  resolveCwds: async (pids) =>
    new Map(
      pids.flatMap((pid) => {
        const cwd = cwdByPid[pid];
        return cwd === undefined || cwd === null ? [] : [[pid, cwd] as const];
      }),
    ),
});

describe("parsePsEtime", () => {
  test("parses the three documented shapes and refuses garbage", () => {
    // Arrange + Act + Assert: [[dd-]hh:]mm:ss
    expect(parsePsEtime("05:03")).toBe(5 * 60 + 3);
    expect(parsePsEtime("02:03:04")).toBe(2 * 3600 + 3 * 60 + 4);
    expect(parsePsEtime("1-02:03:04")).toBe(86_400 + 2 * 3600 + 3 * 60 + 4);
    expect(parsePsEtime("garbage")).toBeNull();
    expect(parsePsEtime("")).toBeNull();
    expect(parsePsEtime("99:99")).toBeNull();
  });
});

describe("checkAgentRestart", () => {
  test("WARNs for an agent in THIS repo that predates the settings file", async () => {
    // Arrange: settings written a minute ago; claude running for ten hours
    const { repo, settingsPath } = await fixture(60);
    const probe = probeOf(`  4242 10:00:00 claude\n`, { 4242: repo });

    // Act
    const check = await checkAgentRestart(repo, [settingsPath], probe, Date.now());

    // Assert
    expect(check.level).toBe("WARN");
    expect(check.detail).toContain("predates your hooks");
    expect(check.detail).toContain("restart");
    expect(check.detail).toContain("4242");
  });

  test("an agent in a DIFFERENT repo is not an offender", async () => {
    // Arrange
    const { repo, settingsPath } = await fixture(60);
    const elsewhere = await makeHome("elsewhere");
    paths.push(elsewhere);
    const probe = probeOf(`  4242 10:00:00 claude\n`, { 4242: elsewhere });

    // Act
    const check = await checkAgentRestart(repo, [settingsPath], probe, Date.now());

    // Assert: the false-positive pin
    expect(check.level).toBe("PASS");
  });

  test("an agent started AFTER the settings were written passes", async () => {
    // Arrange: settings written an hour ago; claude running five minutes
    const { repo, settingsPath } = await fixture(HOUR_SECONDS);
    const probe = probeOf(`  4242 05:00 claude\n`, { 4242: repo });

    // Act
    const check = await checkAgentRestart(repo, [settingsPath], probe, Date.now());

    // Assert
    expect(check.level).toBe("PASS");
  });

  test("an unresolvable cwd is not an offender (fail-open)", async () => {
    // Arrange
    const { repo, settingsPath } = await fixture(60);
    const probe = probeOf(`  4242 10:00:00 claude\n`, { 4242: null });

    // Act
    const check = await checkAgentRestart(repo, [settingsPath], probe, Date.now());

    // Assert
    expect(check.level).toBe("PASS");
  });

  test("non-agent processes and garbage lines never warn or crash", async () => {
    // Arrange
    const { repo, settingsPath } = await fixture(60);
    const probe = probeOf(
      [
        "  1 10:00:00 /sbin/launchd",
        "  77 10:00:00 node",
        "garbage line without numbers",
        "  88 not-a-time claude",
        "",
      ].join("\n"),
      { 1: repo, 77: repo, 88: repo },
    );

    // Act
    const check = await checkAgentRestart(repo, [settingsPath], probe, Date.now());

    // Assert
    expect(check.level).toBe("PASS");
  });

  test("no ps output (unsupported platform) is 'not measured', a PASS", async () => {
    // Arrange
    const { repo, settingsPath } = await fixture(60);

    // Act
    const check = await checkAgentRestart(
      repo,
      [settingsPath],
      probeOf(null, {}),
      Date.now(),
    );

    // Assert
    expect(check.level).toBe("PASS");
    expect(check.detail).toContain("not measured");
  });

  test("a missing settings file is 'not measured', and a throwing probe never crashes", async () => {
    // Arrange
    const { repo } = await fixture(60);
    const throwing: AgentProcessProbe = {
      listProcesses: async () => {
        throw new Error("ps exploded");
      },
      resolveCwds: async () => {
        throw new Error("lsof exploded");
      },
    };

    // Act + Assert: missing file
    const missing = await checkAgentRestart(
      repo,
      [join(repo, ".claude", "no-such-settings.json")],
      probeOf("  4242 10:00:00 claude\n", { 4242: repo }),
      Date.now(),
    );
    expect(missing.level).toBe("PASS");
    expect(missing.detail).toContain("not measured");

    // Act + Assert: throwing probe
    const { repo: repo2, settingsPath } = await fixture(60);
    const survived = await checkAgentRestart(
      repo2,
      [settingsPath],
      throwing,
      Date.now(),
    );
    expect(survived.level).toBe("PASS");
  });
});

describe("the H6 blind spots", () => {
  test("the GLOBAL settings file is measured when the project has none", async () => {
    // Arrange: the worktree shape — no project settings at all, the hooks
    // live in ~/.claude/settings.json, written a minute ago, and an agent has
    // been running in this repo for ten hours.
    const repo = await makeRepo("agent-restart-global", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("agent-restart-global");
    paths.push(repo, home);
    const globalSettings = join(home, ".claude", "settings.json");
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(globalSettings, "{}\n", "utf8");
    const minuteAgo = new Date(Date.now() - 60 * 1000);
    await utimes(globalSettings, minuteAgo, minuteAgo);
    const probe = probeOf(`  4242 10:00:00 claude\n`, { 4242: repo });

    // Act: only the global path exists — on the pre-fix tree the project
    // path was the ONLY candidate and this read "not measured".
    const check = await checkAgentRestart(
      repo,
      [join(repo, ".claude", "settings.json"), globalSettings],
      probe,
      Date.now(),
    );

    // Assert
    expect(check.level).toBe("WARN");
    expect(check.detail).toContain(globalSettings);
  });

  test("the NEWEST of two wired files decides, and is named", async () => {
    // Arrange: a project stub from an hour ago beside a global file written a
    // minute ago — the double-wiring shape. The agent started ten minutes ago:
    // after the stub, before the global write.
    const { repo, settingsPath } = await fixture(HOUR_SECONDS);
    const home = await makeHome("agent-restart-newest");
    paths.push(home);
    const globalSettings = join(home, ".claude", "settings.json");
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(globalSettings, "{}\n", "utf8");
    const minuteAgo = new Date(Date.now() - 60 * 1000);
    await utimes(globalSettings, minuteAgo, minuteAgo);
    const probe = probeOf(`  4242 10:00 claude\n`, { 4242: repo });

    // Act
    const check = await checkAgentRestart(
      repo,
      [settingsPath, globalSettings],
      probe,
      Date.now(),
    );

    // Assert: measured against the newer file, and it says which one
    expect(check.level).toBe("WARN");
    expect(check.detail).toContain(globalSettings);
    expect(check.detail).not.toContain(settingsPath);
  });

  test("Claude.app helpers never eat the candidate budget", async () => {
    // Arrange: 24 desktop-app helpers ahead of one real agent — the measured
    // shape on the author's Mac (23 `claude` processes, 12+ of them helpers).
    const { repo, settingsPath } = await fixture(60);
    const helpers = Array.from(
      { length: 24 },
      (_unused, index) =>
        `  ${String(1000 + index)} 10:00:00 /Applications/Claude.app/Contents/Frameworks/Claude Helper/claude`,
    );
    const cwdByPid: Record<number, string> = { 4242: repo };
    for (let index = 0; index < 24; index += 1) {
      cwdByPid[1000 + index] = "/";
    }
    const probe = probeOf(
      [...helpers, "  4242 09:00:00 /usr/local/bin/claude", ""].join("\n"),
      cwdByPid,
    );

    // Act
    const check = await checkAgentRestart(repo, [settingsPath], probe, Date.now());

    // Assert: the offender at position 25 is found, and the helpers are
    // reported as skipped rather than silently dropped.
    expect(check.level).toBe("WARN");
    expect(check.detail).toContain("4242");
    expect(check.detail).toContain("1 agent checked, 24 skipped");
  });

  test("a clean PASS still says how much was examined", async () => {
    // Arrange
    const { repo, settingsPath } = await fixture(60);
    const elsewhere = await makeHome("agent-restart-elsewhere");
    paths.push(elsewhere);
    const probe = probeOf(`  4242 10:00:00 claude\n`, { 4242: elsewhere });

    // Act
    const check = await checkAgentRestart(repo, [settingsPath], probe, Date.now());

    // Assert
    expect(check.level).toBe("PASS");
    expect(check.detail).toContain("1 agent checked, 0 skipped");
    expect(check.detail).toContain(settingsPath);
  });
});

describe("parseLsofCwds", () => {
  test("carries the current pid across the repeating p/f/n field groups", () => {
    // Arrange: the shape `lsof -a -p <csv> -d cwd -Fn` prints
    const output = ["p101", "fcwd", "n/repo/one", "p202", "fcwd", "n/repo/two", ""].join(
      "\n",
    );

    // Act
    const cwds = parseLsofCwds(output);

    // Assert
    expect(cwds.get(101)).toBe("/repo/one");
    expect(cwds.get(202)).toBe("/repo/two");
    expect(cwds.size).toBe(2);
  });

  test("a pid with no n line is simply absent, and garbage never throws", () => {
    // Arrange + Act
    const cwds = parseLsofCwds(["p303", "fcwd", "pnot-a-pid", "n/orphan", ""].join("\n"));

    // Assert: the orphan path belongs to nobody, so nobody gets it
    expect(cwds.size).toBe(0);
  });
});

describe("runDoctor carries the check", () => {
  test("the injected probe's offender shows up as a WARN line", async () => {
    // Arrange: an unreachable hub (the spool/settings checks run regardless)
    const { repo } = await fixture(60);
    const home = await makeHome("agent-restart");
    paths.push(home);
    const env = {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: "http://127.0.0.1:9",
      CROSSCHECK_API_KEY: "test-key",
    };

    // Act
    const result = await runDoctor(
      env,
      repo,
      async () => null,
      probeOf(`  4242 10:00:00 claude\n`, { 4242: repo }),
    );

    // Assert
    expect(result.stdout).toContain("WARN  agent restart");
    expect(result.stdout).toContain("predates your hooks");
  });
});
