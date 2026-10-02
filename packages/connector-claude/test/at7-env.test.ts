import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CHILD_ENV_ALLOWLIST, childEnv } from "../bench/at7/exec.ts";
import type { ProcOptions, ProcResult } from "../bench/at7/exec.ts";
import { assertRepoConfigHub, install } from "../bench/at7/install.ts";
import type { InstallInput } from "../bench/at7/install.ts";

/**
 * A1.5: every child the harness spawns gets an explicit allowlist (PATH, HOME,
 * USER, LANG, TMPDIR, TERM) plus what the caller pins; every other variable of
 * the launching process — every CROSSCHECK_* and CLAUDE_* above all — is
 * dropped. A launcher's CROSSCHECK_HUB_URL would otherwise outrank the run's
 * hub in login/init, and CLAUDE_EFFORT / CLAUDE_CODE_* would change the run.
 */
const LAUNCHER_ENV = {
  PATH: "/usr/bin:/bin",
  HOME: "/Users/someone",
  USER: "someone",
  LANG: "en_US.UTF-8",
  TMPDIR: "/tmp/x/",
  TERM: "xterm-256color",
  CROSSCHECK_HUB_URL: "https://team-hub.example",
  CROSSCHECK_API_KEY: "fake-placeholder-key",
  CROSSCHECK_TRIPWIRE: "ask",
  CLAUDE_EFFORT: "xhigh",
  CLAUDE_CODE_ENTRYPOINT: "claude-vscode",
  CLAUDE_CODE_SESSION_ID: "abc",
  ANTHROPIC_BASE_URL: "https://proxy.example",
  SHELL: "/bin/zsh",
};

describe("childEnv", () => {
  test("keeps exactly the allowlisted launcher variables", () => {
    // Act
    const env = childEnv(LAUNCHER_ENV, {});

    // Assert
    expect(Object.keys(env).sort()).toEqual([...CHILD_ENV_ALLOWLIST].sort());
  });

  test("drops every CROSSCHECK_* and CLAUDE_* of the launcher", () => {
    // Act
    const env = childEnv(LAUNCHER_ENV, {});

    // Assert
    expect(Object.keys(env).filter((k) => k.startsWith("CROSSCHECK_"))).toEqual([]);
    expect(Object.keys(env).filter((k) => k.startsWith("CLAUDE_"))).toEqual([]);
  });

  test("applies the caller's pinned variables over the allowlist", () => {
    // Act
    const env = childEnv(LAUNCHER_ENV, {
      CROSSCHECK_HOME: "/tmp/run/home",
      CROSSCHECK_TRIPWIRE: "notice",
    });

    // Assert
    expect(env["CROSSCHECK_HOME"]).toBe("/tmp/run/home");
    expect(env["CROSSCHECK_TRIPWIRE"]).toBe("notice");
    expect(env["CROSSCHECK_HUB_URL"]).toBeUndefined();
  });

  test("an allowlisted variable missing from the launcher is simply absent", () => {
    // Act
    const env = childEnv({ PATH: "/bin" }, {});

    // Assert
    expect(env).toEqual({ PATH: "/bin" });
  });
});

describe("assertRepoConfigHub", () => {
  test("passes when .crosscheck.json names the run's own hub", () => {
    // Act / Assert
    expect(() =>
      assertRepoConfigHub(
        JSON.stringify({ hubUrl: "http://127.0.0.1:5123", protocol: "0.1" }),
        "http://127.0.0.1:5123",
      ),
    ).not.toThrow();
  });

  test("throws when init wrote a different hub", () => {
    // Act / Assert
    expect(() =>
      assertRepoConfigHub(
        JSON.stringify({ hubUrl: "https://team-hub.example" }),
        "http://127.0.0.1:5123",
      ),
    ).toThrow();
  });

  test("throws when the config is unreadable", () => {
    // Act / Assert
    expect(() => assertRepoConfigHub("not json", "http://127.0.0.1:5123")).toThrow();
  });
});

/**
 * install() itself, with the `crosscheck login/init` processes faked: the
 * repo-config check is CALLED (A1.5 "Wrong hub"), the key goes on stdin, and
 * init gets the caller's command prefix. Temp dirs only; nothing spawned.
 */
describe("install", () => {
  const HUB = "http://127.0.0.1:5123";
  let root: string;
  let calls: { cmd: readonly string[]; options: ProcOptions }[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "install-"));
    await mkdir(join(root, "slugkit"));
    calls = [];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const installInput = (): InstallInput => ({
    home: join(root, "crosscheck-home"),
    runTempDir: root,
    hubUrl: HUB,
    readerKey: "reader-key-placeholder",
    fixtureRoot: join(root, "slugkit"),
    commandPrefix: "/bin/bun /work/crosscheck/packages/cli/src/bin/crosscheck.ts",
  });

  /** A fake runner: login succeeds; init writes the three files, naming `writtenHub`. */
  const fakeRunner =
    (writtenHub: string) =>
    async (cmd: readonly string[], options: ProcOptions = {}): Promise<ProcResult> => {
      calls.push({ cmd, options });
      if (cmd.includes("init")) {
        const fixture = join(root, "slugkit");
        await mkdir(join(fixture, ".claude"), { recursive: true });
        await writeFile(join(fixture, ".claude", "settings.json"), "{}", "utf8");
        await writeFile(join(fixture, ".mcp.json"), "{}", "utf8");
        await writeFile(join(fixture, ".crosscheck.json"), JSON.stringify({ hubUrl: writtenHub }), "utf8");
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };

  test("refuses when init wrote another hub into .crosscheck.json", async () => {
    // Act / Assert
    expect(install(installInput(), fakeRunner("https://team-hub.example"))).rejects.toThrow(
      /names hub https:\/\/team-hub\.example/,
    );
  });

  test("passes when init wrote the run's own hub, with the key on stdin only", async () => {
    // Act
    const result = await install(installInput(), fakeRunner(HUB));
    const login = calls.find((call) => call.cmd.includes("login"));

    // Assert
    expect(result.env["CROSSCHECK_HOME"]).toBe(join(root, "crosscheck-home"));
    expect(login?.options.stdin).toBe("reader-key-placeholder\n");
    expect(login?.cmd.join(" ")).not.toContain("reader-key-placeholder");
  });

  test("hands init the caller's command prefix (A2.4)", async () => {
    // Act
    await install(installInput(), fakeRunner(HUB));
    const init = calls.find((call) => call.cmd.includes("init"));

    // Assert
    const flag = init?.cmd.indexOf("--command-prefix") ?? -1;
    expect(init?.cmd[flag + 1]).toBe("/bin/bun /work/crosscheck/packages/cli/src/bin/crosscheck.ts");
  });
});
