/**
 * The detached worker's environment (trial finding #14). The Stop hook used
 * to hand the worker an ALLOWLIST — PATH, HOME and the CROSSCHECK_* knobs —
 * and on a Mac logged in through the keychain every nested `claude -p`
 * answered "Not logged in · Please run /login", because the keychain lookup
 * keys on $USER and the allowlist had dropped it. Measured 2026-08-21: 17 of
 * 17 fires of the trial lost that way. Pinned here: the hook's WHOLE
 * environment passes through minus the parent session's own markers, with
 * the crosscheck home and the child marker always set — and the neutral
 * directory the nested claude runs from.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { HOME_DIR_MODE } from "@crosscheck/connector-core/constants.ts";
import {
  PARENT_SESSION_MARKER_PATTERN,
  ensureSummarizerCwd,
  summarizerWorkerEnv,
} from "@crosscheck/connector-core/model/worker-env.ts";
import { makeHome } from "../../connector-core/test/helpers.ts";

const HOME = "/tmp/cx-home-worker-env-fixture";
/** The marker's spelling is operator-visible (the env of a stuck process), so it is spelled out. */
const CHILD_MARKER = "CROSSCHECK_SUMMARIZER_CHILD";

/**
 * What a nested claude NEEDS, by login shape — the 2026-08-21 bisect's USER,
 * and every variable the auth survey named for API-key, Bedrock/Vertex,
 * corp-proxy and alternate-config-dir setups. Values are placeholders.
 */
const LOGIN_SHAPED: Readonly<Record<string, string>> = {
  USER: "nick",
  LOGNAME: "nick",
  TMPDIR: "/var/folders/xy/T",
  LANG: "en_US.UTF-8",
  SHELL: "/bin/zsh",
  ANTHROPIC_API_KEY: "set-by-the-developer",
  ANTHROPIC_AUTH_TOKEN: "set-by-the-proxy",
  ANTHROPIC_BASE_URL: "https://llm-proxy.example.internal",
  CLAUDE_CODE_USE_BEDROCK: "1",
  CLAUDE_CODE_USE_VERTEX: "1",
  CLAUDE_CODE_OAUTH_TOKEN: "set-by-login",
  CLAUDE_CONFIG_DIR: "/home/nick/.claude-work",
  AWS_PROFILE: "dev",
  AWS_REGION: "eu-central-1",
  GOOGLE_APPLICATION_CREDENTIALS: "/home/nick/gcp.json",
  HTTP_PROXY: "http://proxy.example:3128",
  HTTPS_PROXY: "http://proxy.example:3128",
  NO_PROXY: "localhost",
  NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
  SSL_CERT_FILE: "/etc/ssl/corp.pem",
};

/**
 * The PARENT Claude Code session's markers — what must NOT reach the child.
 * The first nine are the spec's list; the rest are the session-scoped names
 * a real 2.1.237 hook/agent env carried past them (CLAUDE_PID,
 * CLAUDE_CODE_CHILD_SESSION) or that the binary reads for session binding
 * (task list, SSE port, remote/bridge session, resume, session access token)
 * — `strings claude.exe | grep -oE 'CLAUDE(_CODE)?_[A-Z0-9_]+'` lists them.
 */
const PARENT_MARKERS: Readonly<Record<string, string>> = {
  CLAUDECODE: "1",
  CLAUDE_CODE_SESSION_ID: "parent-session-uuid",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/parent.sock",
  CLAUDE_CODE_MESSAGING_TOKEN: "parent-token",
  CLAUDE_PLUGIN_ROOT: "/home/nick/.claude/plugins/x",
  CLAUDE_PLUGIN_DATA: "/home/nick/.claude/plugins/x/data",
  CLAUDE_PROJECT_DIR: "/home/nick/repo",
  CLAUDE_AGENT_SDK_VERSION: "0.1.0",
  CLAUDE_PID: "4242",
  CLAUDE_CODE_CHILD_SESSION: "1",
  CLAUDE_CODE_SESSION_ACCESS_TOKEN: "parent-session-access",
  CLAUDE_CODE_TASK_LIST_ID: "parent-task-list",
  CLAUDE_CODE_SSE_PORT: "51234",
  CLAUDE_CODE_REMOTE_SESSION_ID: "remote-session-uuid",
  CLAUDE_CODE_RESUME_FROM_SESSION: "parent-session-uuid",
  CLAUDE_CODE_BRIDGE_SESSION_ID: "bridge-session-uuid",
};

/**
 * CLAUDE_* names a real parent env ALSO carries that are NOT session binding
 * — the executable's own path and feature knobs — and pass through: a
 * denylist that swept CLAUDE_ wholesale would take the auth names with them.
 */
const PARENT_PASS_THROUGH: Readonly<Record<string, string>> = {
  CLAUDE_CODE_EXECPATH: "/usr/local/bin/claude",
  CLAUDE_EFFORT: "medium",
  CLAUDE_CODE_ENABLE_TASKS: "1",
};

const HOOK_ENV: Readonly<Record<string, string>> = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/home/nick",
  CROSSCHECK_AGENT_KIND: "claude-code",
  CROSSCHECK_SUMMARIZER_CMD: "/tmp/fake-summarizer.sh",
  CROSSCHECK_SUMMARIZER_TIMEOUT_MS: "5000",
  ...LOGIN_SHAPED,
  ...PARENT_PASS_THROUGH,
  ...PARENT_MARKERS,
};

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

describe("summarizerWorkerEnv (pass-through minus the parent's markers)", () => {
  test("forwards USER and every login-shaped variable — the allowlist lost all of them", () => {
    // Act
    const env = summarizerWorkerEnv(HOOK_ENV, HOME);

    // Assert: the bisect's one variable first, then the whole survey
    expect(env["USER"]).toBe("nick");
    for (const [name, value] of Object.entries(LOGIN_SHAPED)) {
      expect(env[name]).toBe(value);
    }
    // …and the knobs the old allowlist did carry still arrive
    expect(env["PATH"]).toBe(HOOK_ENV["PATH"]);
    expect(env["HOME"]).toBe(HOOK_ENV["HOME"]);
    expect(env["CROSSCHECK_SUMMARIZER_CMD"]).toBe(HOOK_ENV["CROSSCHECK_SUMMARIZER_CMD"]);
    expect(env["CROSSCHECK_SUMMARIZER_TIMEOUT_MS"]).toBe("5000");
    expect(env["CROSSCHECK_AGENT_KIND"]).toBe("claude-code");
  });

  test("strips every parent-session marker and nothing else", () => {
    const env = summarizerWorkerEnv(HOOK_ENV, HOME);

    for (const name of Object.keys(PARENT_MARKERS)) {
      expect(env).not.toHaveProperty(name);
      expect(PARENT_SESSION_MARKER_PATTERN.test(name)).toBe(true);
    }
    // The auth-shaped CLAUDE_* variables are NOT markers — a denylist that
    // swept CLAUDE_ wholesale would recreate the finding for OAuth/Bedrock —
    // and neither are the executable path and feature knobs a parent carries.
    for (const name of [...Object.keys(LOGIN_SHAPED), ...Object.keys(PARENT_PASS_THROUGH)]) {
      expect(PARENT_SESSION_MARKER_PATTERN.test(name)).toBe(false);
      expect(env[name]).toBe(HOOK_ENV[name] ?? "");
    }
    // Exactly the named markers left the environment — no silent extras.
    const forwarded = Object.keys(env).filter((name) => name in HOOK_ENV);
    expect(forwarded).toHaveLength(
      Object.keys(HOOK_ENV).length - Object.keys(PARENT_MARKERS).length,
    );
  });

  test("always sets the crosscheck home and the child marker, even from an empty env", () => {
    expect(summarizerWorkerEnv({}, HOME)).toEqual({
      CROSSCHECK_HOME: HOME,
      [CHILD_MARKER]: "1",
    });
    // The hook's OWN home is what the worker must use, never an inherited one.
    expect(summarizerWorkerEnv({ CROSSCHECK_HOME: "/elsewhere" }, HOME)["CROSSCHECK_HOME"]).toBe(HOME);
    expect(summarizerWorkerEnv(HOOK_ENV, HOME)[CHILD_MARKER]).toBe("1");
  });

  test("drops undefined values so the result is spawnable as-is", () => {
    const env = summarizerWorkerEnv({ USER: "nick", UNSET: undefined }, HOME);
    expect(env).not.toHaveProperty("UNSET");
    expect(Object.values(env).every((value) => typeof value === "string")).toBe(true);
  });
});

describe("ensureSummarizerCwd (the neutral directory the nested claude runs from)", () => {
  test("creates <home>/summarizer-cwd with the home's private mode and returns it", async () => {
    // Arrange
    const home = await makeHome("summarizer-cwd");
    paths.push(home);

    // Act
    const cwd = await ensureSummarizerCwd(home);

    // Assert
    expect(cwd).toBe(join(home, "summarizer-cwd"));
    const info = await stat(cwd ?? "");
    expect(info.isDirectory()).toBe(true);
    expect(info.mode & 0o777).toBe(HOME_DIR_MODE);
    // Idempotent: the second fire finds it, does not fail on it.
    expect(await ensureSummarizerCwd(home)).toBe(cwd);
  });
});
