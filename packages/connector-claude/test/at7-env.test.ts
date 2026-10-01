import { describe, expect, test } from "bun:test";

import { CHILD_ENV_ALLOWLIST, childEnv } from "../bench/at7/exec.ts";
import { assertRepoConfigHub } from "../bench/at7/install.ts";

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
