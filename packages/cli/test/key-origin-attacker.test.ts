/**
 * A REPO NAMING AN ATTACKER HUB GETS ZERO KEYED REQUESTS, FROM ANY PATH
 * (core config/key-binding.ts; the Phase 1 security review finding).
 *
 * A repo is shared content: anyone with commit access writes its
 * `.crosscheck.json`, and a cloned or forked repo arrives with one. Before
 * the binding, `crosscheck status` and most of `doctor` sent the developer's
 * stored key to whatever hub that file named. Here a developer logged in to
 * their own hub opens a bait repo naming another, and every surface that
 * could carry the key runs in it: the Claude hooks and statusline, the
 * Cursor hooks, an MCP tool call, and the CLI commands — status, doctor,
 * conference, pin, pilot, presence, trace, revalidate, key rotate. Two
 * logging hubs on loopback record every request; neither may receive one.
 * Then the pilot's own shape: one hub, spelled the same way (or with a slash
 * or capitals) in the login and the repo, keeps reporting with its key.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runHook, runStatusline } from "@crosscheck/connector-claude";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { saveConfig } from "@crosscheck/connector-core/config/config.ts";
import { parseFrame } from "@crosscheck/connector-core/mcp/protocol.ts";
import { handleFrame } from "@crosscheck/connector-core/mcp/server.ts";
import { runCursorHook } from "@crosscheck/connector-cursor";

import { runCli } from "../src/cli/index.ts";
import { makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";
import {
  AFTER_FILE_EDIT_INPUT,
  BEFORE_SUBMIT_PROMPT_INPUT,
  SESSION_START_INPUT,
  STOP_INPUT,
} from "../../connector-cursor/test/fixtures/cursor-contract/payloads.ts";

/** Synthetic, 64 hex like a real key, so a leak would be recognisable in any output. */
const STORED_KEY = "5ec2e7".repeat(10).padEnd(64, "0");
const TIMEOUT_MS = "4000";
const SESSION_ID = "bait-session-uuid";

interface LoggingHub {
  readonly url: string;
  readonly requests: () => readonly { readonly path: string; readonly keyed: boolean }[];
}

const stops: (() => void)[] = [];
const paths: string[] = [];

afterEach(async () => {
  for (const stop of stops) {
    stop();
  }
  stops.length = 0;
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

/** Records every request; answers the one envelope a register needs. */
const startLoggingHub = (): LoggingHub => {
  const seen: { path: string; keyed: boolean }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      seen.push({ path: new URL(request.url).pathname, keyed: request.headers.get("authorization") !== null });
      return Response.json({ ok: true, data: { session: { id: "cc_x", developerId: "dev_x" } } });
    },
  });
  stops.push(() => {
    server.stop(true);
  });
  return { url: `http://127.0.0.1:${String(server.port)}`, requests: () => [...seen] };
};

interface World {
  readonly home: string;
  readonly repo: string;
  readonly env: Env;
}

/** A developer logged in to `loginUrl` (a legacy login, no binding yet), in a repo naming `repoHubUrl`. */
const world = async (label: string, loginUrl: string, repoHubUrl: string, remote: string): Promise<World> => {
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote });
  paths.push(home, repo);
  await saveConfig(home, { version: 1, hubUrl: loginUrl, apiKey: STORED_KEY });
  await writeRepoFile(repo, "src/app.ts", "export const a = 1;\n");
  await writeFile(
    join(repo, ".crosscheck.json"),
    `${JSON.stringify({ hubUrl: repoHubUrl, protocol: "0.1" }, null, 2)}\n`,
    "utf8",
  );
  return {
    home,
    repo,
    env: { CROSSCHECK_HOME: home, HOME: home, CROSSCHECK_TIMEOUT_MS: TIMEOUT_MS },
  };
};

const claudePayload = (repo: string, event: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ session_id: SESSION_ID, cwd: repo, hook_event_name: event, ...extra });

const runClaudeHooks = async (w: World): Promise<string> => {
  const start = await runHook("session-start", claudePayload(w.repo, "SessionStart", { source: "startup" }), w.env);
  await runHook("user-prompt-submit", claudePayload(w.repo, "UserPromptSubmit", { prompt: "fix the limiter" }), w.env);
  const edit = { tool_name: "Edit", tool_input: { file_path: join(w.repo, "src/app.ts") }, tool_response: {} };
  await runHook("pre-tool-use", claudePayload(w.repo, "PreToolUse", edit), w.env);
  await runHook("post-tool-use", claudePayload(w.repo, "PostToolUse", edit), w.env);
  await runHook(
    "post-tool-use-failure",
    claudePayload(w.repo, "PostToolUseFailure", { tool_name: "Bash", tool_input: { command: "bun test" }, error: "1 fail" }),
    w.env,
  );
  await runHook("stop", claudePayload(w.repo, "Stop", { stop_hook_active: false }), w.env);
  await runHook("session-end", claudePayload(w.repo, "SessionEnd", { reason: "other" }), w.env);
  return start;
};

const inCursorRepo = (payload: object, repo: string): string =>
  JSON.stringify({ ...payload, conversation_id: "bait-conv", workspace_roots: [repo] });

const runCursorHooks = async (w: World): Promise<void> => {
  await runCursorHook("sessionStart", inCursorRepo(SESSION_START_INPUT, w.repo), w.env);
  await runCursorHook("beforeSubmitPrompt", inCursorRepo(BEFORE_SUBMIT_PROMPT_INPUT, w.repo), w.env);
  await runCursorHook(
    "afterFileEdit",
    inCursorRepo({ ...AFTER_FILE_EDIT_INPUT, file_path: join(w.repo, "src/app.ts") }, w.repo),
    w.env,
  );
  await runCursorHook("stop", inCursorRepo(STOP_INPUT, w.repo), w.env);
};

const callMcpTool = async (w: World): Promise<string> => {
  const frame = JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "list_open_questions", arguments: {} },
  });
  return JSON.stringify(await handleFrame(parseFrame(frame), w.env, w.repo));
};

const asPerson = { isInteractive: () => true };

const runCommands = async (w: World): Promise<Readonly<Record<string, string>>> => {
  const noSecret = (): Promise<string | null> => Promise.resolve(null);
  const out = async (argv: readonly string[]): Promise<string> =>
    (await runCli(argv, w.env, w.repo, noSecret, asPerson)).stdout;
  return {
    status: await out(["status"]),
    doctor: await out(["doctor"]),
    conference: await out(["conference"]),
    pinList: await out(["pin", "list"]),
    pilot: await out(["pilot"]),
    pilotMine: await out(["pilot", "--mine"]),
    presence: await out(["presence"]),
    trace: await out(["trace", "src/app.ts"]),
    revalidate: await out(["revalidate"]),
  };
};

const entriesOrNone = async (dir: string): Promise<readonly string[]> => readdir(dir).catch(() => []);

describe("a bait repo naming an attacker hub", () => {
  test("no hook, statusline, Cursor hook, MCP call or CLI command sends anything to either hub", async () => {
    // Arrange — the developer's own hub, and the hub the bait repo names
    const own = startLoggingHub();
    const attacker = startLoggingHub();
    const w = await world("bait-every-path", own.url, attacker.url, "git@github.com:evil/bait.git");

    // Act — every surface that could carry the stored key, in the bait repo
    const sessionStart = await runClaudeHooks(w);
    const statusline = await runStatusline(claudePayload(w.repo, "Status"), w.env);
    await runCursorHooks(w);
    const mcp = await callMcpTool(w);
    const commands = await runCommands(w);

    // Assert — zero requests, keyed or not, at either hub
    expect(attacker.requests()).toEqual([]);
    expect(own.requests()).toEqual([]);
    // Nothing captured for the bait repo, so nothing waits to be flushed there.
    expect(await entriesOrNone(join(w.home, "spool"))).toEqual([]);
    expect(await entriesOrNone(join(w.home, "sessions"))).toEqual([]);
    // Not silent: the session, the status bar and the tool call say so.
    expect(sessionStart).toContain("crosscheck is not reporting from here");
    expect(statusline).toContain("key not sent");
    expect(mcp).toContain("crosscheck is not reporting from here");
    // The key appears in no output at all.
    for (const text of [sessionStart, statusline, mcp, ...Object.values(commands)]) {
      expect(text).not.toContain(STORED_KEY);
    }
    // Counted, never silent: one line per refused hook event and tool call.
    const ledger = await readFile(join(w.home, "state", "foreign-hub.jsonl"), "utf8");
    const surfaces = ledger.trim().split("\n").map((line) => (JSON.parse(line) as { surface: string }).surface);
    expect(new Set(surfaces)).toEqual(
      new Set([
        "session-start",
        "user-prompt-submit",
        "pre-tool-use",
        "post-tool-use",
        "post-tool-use-failure",
        "stop",
        "session-end",
        "sessionStart",
        "beforeSubmitPrompt",
        "afterFileEdit",
        "mcp",
      ]),
    );
    expect(ledger).not.toContain(STORED_KEY);
  });

  test("status and doctor WARN, naming both origins and the fix, and count the refusals", async () => {
    // Arrange
    const own = startLoggingHub();
    const attacker = startLoggingHub();
    const w = await world("bait-warn", own.url, attacker.url, "git@github.com:evil/bait.git");
    await runClaudeHooks(w);

    // Act
    const status = await runCli(["status"], w.env, w.repo);
    const doctor = await runCli(["doctor"], w.env, w.repo);

    // Assert
    expect(attacker.requests()).toEqual([]);
    expect(own.requests()).toEqual([]);
    for (const text of [status.stdout, doctor.stdout]) {
      expect(text).toContain(`names ${attacker.url}, but your crosscheck key belongs to ${own.url}`);
      expect(text).toContain(`set "hubUrl" in .crosscheck.json to ${own.url}`);
      expect(text).toContain("refused in the last 7 days");
      expect(text).not.toContain(STORED_KEY);
    }
    expect(status.stdout).toContain("WARN key origin:");
    expect(doctor.stdout).toContain("WARN  key origin  ");
    expect(doctor.stdout).not.toContain("  hub reachable  ");
    expect(status.exitCode).toBe(1);
  });

  test("CROSSCHECK_HUB_URL naming the attacker is refused by status, doctor and key rotate", async () => {
    // Arrange — a repo naming the developer's own hub; the override does not
    const own = startLoggingHub();
    const attacker = startLoggingHub();
    const w = await world("bait-env", own.url, own.url, "git@github.com:acme/api.git");
    const env: Env = { ...w.env, CROSSCHECK_HUB_URL: attacker.url };

    // Act
    const status = await runCli(["status"], env, w.repo);
    const doctor = await runCli(["doctor"], env, w.repo);
    const rotate = await runCli(["key", "rotate"], env, w.repo, undefined, asPerson);
    await runClaudeHooks({ ...w, env });

    // Assert
    expect(attacker.requests()).toEqual([]);
    expect(own.requests()).toEqual([]);
    expect(status.stdout).toContain(`CROSSCHECK_HUB_URL names ${attacker.url}`);
    expect(doctor.stdout).toContain(`unset CROSSCHECK_HUB_URL, or set it to ${own.url}`);
    expect(rotate.stdout).toContain("Rotating here would send that key to another hub");
  });
});

describe("crosscheck login binds the key", () => {
  test("to the hub it was proven against, replacing a previous login's binding", async () => {
    // Arrange — a machine logged in to another hub before, binding recorded
    const own = startLoggingHub();
    const home = await makeHome("login-binds");
    paths.push(home);
    await saveConfig(home, {
      version: 1,
      hubUrl: "http://127.0.0.1:9",
      apiKey: "e".repeat(64),
      keyOrigin: "http://127.0.0.1:9",
    });
    const env: Env = { CROSSCHECK_HOME: home, HOME: home, CROSSCHECK_API_KEY: STORED_KEY };

    // Act
    const login = await runCli(["login", `${own.url}/`], env, home);

    // Assert — the probe carried the key to the hub being logged in to
    expect(login.exitCode).toBe(0);
    expect(own.requests().every((request) => request.keyed)).toBe(true);
    const stored = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as Record<string, unknown>;
    expect(stored["hubUrl"]).toBe(own.url);
    expect(stored["keyOrigin"]).toBe(own.url);
  });
});

describe("the pilot-shaped config keeps working", () => {
  test("one hub, the same spelling in the login and the repo: capture reaches it with the key", async () => {
    // Arrange — the login typed with capitals and a slash, the repo plain
    const own = startLoggingHub();
    const attacker = startLoggingHub();
    const loginSpelling = `${own.url.replace("http://", "HTTP://")}/`;
    const w = await world("pilot-shape", loginSpelling, own.url, "git@github.com:acme/api.git");

    // Act
    await runHook("session-start", claudePayload(w.repo, "SessionStart", { source: "startup" }), w.env);
    const status = await runCli(["status"], w.env, w.repo);
    const doctor = await runCli(["doctor"], w.env, w.repo);

    // Assert — the key went to its own hub, and nobody warns
    expect(own.requests().some((request) => request.path === "/api/sessions" && request.keyed)).toBe(true);
    expect(attacker.requests()).toEqual([]);
    expect(status.stdout).not.toContain("key origin");
    expect(doctor.stdout).not.toContain("key origin");
    expect(doctor.stdout).toContain("PASS  hub reachable  ");
    const stored = JSON.parse(await readFile(join(w.home, "config.json"), "utf8")) as Record<string, unknown>;
    expect(stored["keyOrigin"]).toBe(own.url);
  });
});
