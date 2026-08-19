/**
 * The Block 4 capture engine against a REAL in-process hub (§4.2 layer 2,
 * capture half): the §2.4 mapping row by row, driven as ObservedLine events
 * exactly as the proxy's observer emits them. Every failure direction is
 * fail-open (prime directive 2): capture off means silence, never a throw —
 * the pipe above this layer is Block 3's untouched proof.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb, createServer } from "@crosscheck/server";

import { extractFailureText } from "@crosscheck/connector-core/capture/failure-text.ts";
import { fingerprint } from "@crosscheck/connector-core/capture/fingerprint.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { getDiagnosis, getPresence } from "@crosscheck/connector-core/http/hub.ts";
import type { HubContext } from "@crosscheck/connector-core/http/client.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import * as claudeToolEvents from "../../connector-claude/src/capture/tool-events.ts";

import { createAcpCapture } from "../src/capture/engine.ts";
import type { AcpLogger } from "../src/logger.ts";
import type { ObservedLine } from "../src/observer.ts";
import {
  makeHome,
  makeRepo,
  writeRepoFile,
} from "../../connector-core/test/helpers.ts";

const ADMIN_TOKEN = "acp-engine-admin";
const REPO_ID = "github.com/acme/api";
const REMOTE = "git@github.com:acme/api.git";
const TIMEOUT_MS = "4000";
const SHUTDOWN_BUDGET_MS = 4000;
const FAILURE_TEXT =
  "error TS2304: cannot find name 'limiter' at build step 7 of the pipeline";

let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let apiKey: string;
const cleanups: string[] = [];

beforeAll(async () => {
  const db = await createDb();
  const app = createServer({ db, adminToken: ADMIN_TOKEN });
  server = Bun.serve({ port: 0, fetch: app.fetch });
  hubUrl = `http://127.0.0.1:${server.port}`;
  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "Acp Dev", email: "acp-engine@example.com" }),
  });
  const body = (await response.json()) as { data: { apiKey: string } };
  apiKey = body.data.apiKey;
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** In-memory AcpLogger: capture must not need a real log file to be tested. */
interface StubLogger extends AcpLogger {
  readonly lines: readonly string[];
}

const stubLogger = (): StubLogger => {
  const lines: string[] = [];
  return {
    lines,
    path: "/dev/null",
    line: (text: string) => {
      lines.push(text);
    },
    writeFailures: () => 0,
    droppedLines: () => 0,
    flush: () => Promise.resolve(),
  };
};

const wireLine = (value: unknown): ObservedLine => ({
  kind: "line",
  text: JSON.stringify(value),
  parsedOk: true,
  bytes: 0,
  atEof: false,
});

interface Harness {
  readonly home: string;
  readonly repo: string;
  readonly logger: StubLogger;
  readonly hub: HubContext;
  readonly clock: { value: Date };
  readonly capture: ReturnType<typeof createAcpCapture>;
}

const harness = async (
  label: string,
  options: { readonly agentKindFlag?: string } = {},
): Promise<Harness> => {
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: REMOTE });
  cleanups.push(home, repo);
  const env: Env = {
    CROSSCHECK_HOME: home,
    CROSSCHECK_HUB_URL: hubUrl,
    CROSSCHECK_API_KEY: apiKey,
    CROSSCHECK_TIMEOUT_MS: TIMEOUT_MS,
  };
  const logger = stubLogger();
  const clock = { value: new Date("2026-08-19T12:00:00.000Z") };
  const capture = createAcpCapture({
    env,
    logger,
    agentKindFlag: options.agentKindFlag,
    now: () => clock.value,
  });
  return {
    home,
    repo,
    logger,
    clock,
    capture,
    hub: {
      hubUrl,
      apiKey,
      timeoutMs: Number(TIMEOUT_MS),
      home,
      repoKey: repoKey(hubUrl, REPO_ID),
      now: () => new Date(),
    },
  };
};

const advanceClock = (h: Harness, ms: number): void => {
  h.clock.value = new Date(h.clock.value.getTime() + ms);
};

const handshake = (h: Harness, sessionId: string, cwd: string): void => {
  h.capture.offer(
    "c2a",
    wireLine({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }),
  );
  h.capture.offer(
    "a2c",
    wireLine({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "fake-agent", version: "1.0.0" },
      },
    }),
  );
  h.capture.offer(
    "c2a",
    wireLine({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } }),
  );
  h.capture.offer("a2c", wireLine({ jsonrpc: "2.0", id: 2, result: { sessionId } }));
};

const toolCallUpdate = (sessionId: string, update: Record<string, unknown>) =>
  wireLine({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update },
  });

const listFilesRecursively = async (root: string): Promise<readonly string[]> => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(
    () => [],
  );
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
};

describe("the §2.4 mapping against a live hub", () => {
  test("initialize + session/new register with agent_kind acp:<name> and the branch @ repo title", async () => {
    // Arrange
    const h = await harness("register");

    // Act
    handshake(h, "sess_reg", h.repo);
    await h.capture.settle();

    // Assert: state file exists (MCP resolution + reap read it)
    const hostKey = "acp-fake-agent--sess_reg";
    const state = await readSessionState(h.home, hostKey);
    expect(state?.crosscheckSessionId).toBe(`cc_${hostKey}`);

    // Presence carries the session with the derived agent kind
    const presence = await getPresence(h.hub, REPO_ID);
    if (!presence.ok) throw new Error("presence unavailable");
    const own = presence.data.find(
      (entry) => entry.sessionId === `cc_${hostKey}`,
    ) as { agentKind?: string; sessionId: string } | undefined;
    expect(own).toBeDefined();
    expect(own?.agentKind).toBe("acp:fake-agent");
    expect(h.capture.counters().sessions).toBe(1);

    // Work context title is branch @ repo, never prompt-derived
    const diagnosis = await getDiagnosis(h.hub, `wc_cc_${hostKey}`);
    if (!diagnosis.ok) throw new Error("diagnosis unavailable");
    expect(diagnosis.data.workContext.title).toBe("main @ api");
  });

  test("tool_call locations + diff paths + fs/write_text_file become repo-relative targets; failed rawOutput becomes the Claude-identical fingerprint", async () => {
    // Arrange
    const h = await harness("targets");
    await writeRepoFile(h.repo, "src/limiter.ts", "export const a = 1;\n");
    const sessionId = "sess_targets";
    const hostKey = `acp-fake-agent--${sessionId}`;

    // Act
    handshake(h, sessionId, h.repo);
    h.capture.offer(
      "a2c",
      toolCallUpdate(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        kind: "edit",
        status: "in_progress",
        locations: [{ path: join(h.repo, "src/limiter.ts") }],
        content: [
          { type: "diff", path: join(h.repo, "src/other.ts"), oldText: "", newText: "x" },
        ],
      }),
    );
    h.capture.offer(
      "a2c",
      toolCallUpdate(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "failed",
        rawOutput: { stderr: FAILURE_TEXT },
      }),
    );
    // fs/write_text_file is the backstop for agents that report no locations
    h.capture.offer(
      "a2c",
      wireLine({
        jsonrpc: "2.0",
        id: 90,
        method: "fs/write_text_file",
        params: { sessionId, path: join(h.repo, "src/written.ts"), content: "body" },
      }),
    );
    // Denylisted and out-of-repo paths never become targets
    h.capture.offer(
      "a2c",
      toolCallUpdate(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "call_2",
        kind: "edit",
        locations: [{ path: join(h.repo, ".env") }, { path: "/etc/passwd" }],
      }),
    );
    await h.capture.settle();

    // Assert
    const diagnosis = await getDiagnosis(h.hub, `wc_cc_${hostKey}`);
    if (!diagnosis.ok) throw new Error("diagnosis unavailable");
    const files = diagnosis.data.targets
      .filter((target) => target.kind === "file")
      .map((target) => target.value)
      .sort();
    expect(files).toEqual(["src/limiter.ts", "src/other.ts", "src/written.ts"]);

    // Fingerprint parity: the ACP path and the Claude hook path agree on the
    // same bytes — one extractor, one normalizer, one hash.
    const viaClaudePath = fingerprint(
      claudeToolEvents.extractFailureText({ stderr: FAILURE_TEXT }),
    );
    const prints = diagnosis.data.targets
      .filter((target) => target.kind === "error_fingerprint")
      .map((target) => target.value);
    expect(prints).toEqual([viaClaudePath ?? ""]);
    // …and the Claude re-export IS core's implementation, by reference.
    expect(claudeToolEvents.extractFailureText).toBe(extractFailureText);
  });

  test("session/prompt heartbeats under the throttle; the prompt response ticks the turn counter", async () => {
    // Arrange
    const h = await harness("heartbeat");
    const sessionId = "sess_hb";

    // Act: register (which stamps lastHeartbeatAt), then prompt inside the
    // throttle window — no heartbeat; advance past it — one heartbeat; a
    // second prompt at the same instant — throttled again.
    handshake(h, sessionId, h.repo);
    await h.capture.settle();
    h.capture.offer(
      "c2a",
      wireLine({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [] } }),
    );
    await h.capture.settle();
    expect(h.capture.counters().heartbeats).toBe(0);

    advanceClock(h, 21_000);
    h.capture.offer(
      "c2a",
      wireLine({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId, prompt: [] } }),
    );
    h.capture.offer(
      "c2a",
      wireLine({ jsonrpc: "2.0", id: 5, method: "session/prompt", params: { sessionId, prompt: [] } }),
    );
    h.capture.offer("a2c", wireLine({ jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } }));
    await h.capture.settle();

    // Assert
    expect(h.capture.counters().heartbeats).toBe(1);
    expect(h.capture.counters().turns).toBe(1);

    // An edit-kind tool call past the throttle heartbeats with implementing
    advanceClock(h, 21_000);
    h.capture.offer(
      "a2c",
      toolCallUpdate(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "call_hb",
        kind: "edit",
        status: "in_progress",
        locations: [],
      }),
    );
    await h.capture.settle();
    expect(h.capture.counters().heartbeats).toBe(2);
    const presence = await getPresence(h.hub, REPO_ID);
    if (!presence.ok) throw new Error("presence unavailable");
    const own = presence.data.find(
      (entry) => entry.sessionId === `cc_acp-fake-agent--${sessionId}`,
    );
    expect(own?.status).toBe("implementing");
  });

  test("terminal failure: create → output → non-zero wait_for_exit fingerprints the output; the command text is never uploaded", async () => {
    // Arrange
    const h = await harness("terminal");
    const sessionId = "sess_term";
    const hostKey = `acp-fake-agent--${sessionId}`;
    const SECRET_COMMAND = "run-the-build --with-flag";

    // Act: agent-side terminal lifecycle (a2c requests, c2a responses)
    handshake(h, sessionId, h.repo);
    h.capture.offer(
      "a2c",
      wireLine({
        jsonrpc: "2.0",
        id: "t1",
        method: "terminal/create",
        params: { sessionId, command: SECRET_COMMAND, args: [] },
      }),
    );
    h.capture.offer(
      "c2a",
      wireLine({ jsonrpc: "2.0", id: "t1", result: { terminalId: "term_1" } }),
    );
    h.capture.offer(
      "a2c",
      wireLine({
        jsonrpc: "2.0",
        id: "t2",
        method: "terminal/output",
        params: { sessionId, terminalId: "term_1" },
      }),
    );
    h.capture.offer(
      "c2a",
      wireLine({
        jsonrpc: "2.0",
        id: "t2",
        result: { output: FAILURE_TEXT, truncated: false },
      }),
    );
    h.capture.offer(
      "a2c",
      wireLine({
        jsonrpc: "2.0",
        id: "t3",
        method: "terminal/wait_for_exit",
        params: { sessionId, terminalId: "term_1" },
      }),
    );
    h.capture.offer(
      "c2a",
      wireLine({
        jsonrpc: "2.0",
        id: "t3",
        result: { exitStatus: { exitCode: 2, signal: null } },
      }),
    );
    await h.capture.settle();

    // Assert
    const diagnosis = await getDiagnosis(h.hub, `wc_cc_${hostKey}`);
    if (!diagnosis.ok) throw new Error("diagnosis unavailable");
    const prints = diagnosis.data.targets
      .filter((target) => target.kind === "error_fingerprint")
      .map((target) => target.value);
    expect(prints).toEqual([fingerprint(FAILURE_TEXT) ?? ""]);
    // The command never left the machine: not in any spooled/persisted byte.
    for (const file of await listFilesRecursively(h.home)) {
      expect((await readFile(file, "utf8")).includes(SECRET_COMMAND), file).toBe(false);
    }
  });

  test("session/load re-registers idempotently and replayed updates add no new hub rows", async () => {
    // Arrange: a live session with one captured target
    const h = await harness("replay");
    await writeRepoFile(h.repo, "src/limiter.ts", "export const a = 1;\n");
    const sessionId = "sess_replay";
    const hostKey = `acp-fake-agent--${sessionId}`;
    const replayedUpdate = {
      sessionUpdate: "tool_call" as const,
      toolCallId: "call_r",
      kind: "edit",
      status: "completed",
      locations: [{ path: join(h.repo, "src/limiter.ts") }],
    };
    handshake(h, sessionId, h.repo);
    h.capture.offer("a2c", toolCallUpdate(sessionId, replayedUpdate));
    await h.capture.settle();
    const before = await getDiagnosis(h.hub, `wc_cc_${hostKey}`);
    if (!before.ok) throw new Error("diagnosis unavailable");

    // Act: the client loads the same session; history replays as updates
    // BEFORE the load response arrives (the ACP replay shape).
    h.capture.offer(
      "c2a",
      wireLine({
        jsonrpc: "2.0",
        id: 10,
        method: "session/load",
        params: { sessionId, cwd: h.repo, mcpServers: [] },
      }),
    );
    h.capture.offer("a2c", toolCallUpdate(sessionId, replayedUpdate));
    h.capture.offer("a2c", wireLine({ jsonrpc: "2.0", id: 10, result: {} }));
    await h.capture.settle();

    // Assert: same session id (no ~r suffix), target rows unchanged
    const state = await readSessionState(h.home, hostKey);
    expect(state?.crosscheckSessionId).toBe(`cc_${hostKey}`);
    const after = await getDiagnosis(h.hub, `wc_cc_${hostKey}`);
    if (!after.ok) throw new Error("diagnosis unavailable");
    expect(after.data.targets.length).toBe(before.data.targets.length);
  });

  test("--agent-kind overrides the initialize-derived kind; the host key does not change", async () => {
    // Arrange
    const h = await harness("kind-override", { agentKindFlag: "acp:custom" });
    const sessionId = "sess_kind";

    // Act
    handshake(h, sessionId, h.repo);
    await h.capture.settle();

    // Assert
    const presence = await getPresence(h.hub, REPO_ID);
    if (!presence.ok) throw new Error("presence unavailable");
    const own = presence.data.find(
      (entry) => entry.sessionId === `cc_acp-fake-agent--${sessionId}`,
    ) as { agentKind?: string } | undefined;
    expect(own?.agentKind).toBe("acp:custom");
  });

  test("session/close ends the session; shutdown ends the rest and reaps", async () => {
    // Arrange: two sessions in one connection
    const h = await harness("close");
    handshake(h, "sess_close_a", h.repo);
    h.capture.offer(
      "c2a",
      wireLine({
        jsonrpc: "2.0",
        id: 20,
        method: "session/new",
        params: { cwd: h.repo, mcpServers: [] },
      }),
    );
    h.capture.offer(
      "a2c",
      wireLine({ jsonrpc: "2.0", id: 20, result: { sessionId: "sess_close_b" } }),
    );
    await h.capture.settle();

    // Act: close the first explicitly, the second via shutdown
    h.capture.offer(
      "c2a",
      wireLine({
        jsonrpc: "2.0",
        id: 21,
        method: "session/close",
        params: { sessionId: "sess_close_a" },
      }),
    );
    await h.capture.settle();
    const midway = await getPresence(h.hub, REPO_ID);
    if (!midway.ok) throw new Error("presence unavailable");
    expect(
      midway.data.some((entry) => entry.sessionId === "cc_acp-fake-agent--sess_close_a"),
    ).toBe(false);
    expect(
      midway.data.some((entry) => entry.sessionId === "cc_acp-fake-agent--sess_close_b"),
    ).toBe(true);

    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);

    // Assert: both gone, no state files left behind
    const presence = await getPresence(h.hub, REPO_ID);
    if (!presence.ok) throw new Error("presence unavailable");
    expect(
      presence.data.some((entry) => entry.sessionId === "cc_acp-fake-agent--sess_close_b"),
    ).toBe(false);
    expect(await readSessionState(h.home, "acp-fake-agent--sess_close_b")).toBeNull();
  });
});

describe("fail-open and privacy", () => {
  test("no config = capture silently off, nothing written, nothing thrown", async () => {
    // Arrange: an env with no hub and no key — loadConfig resolves null
    const home = await makeHome("no-config");
    const repo = await makeRepo("no-config", { remote: REMOTE });
    cleanups.push(home, repo);
    const logger = stubLogger();
    const capture = createAcpCapture({
      env: { CROSSCHECK_HOME: home },
      logger,
    });

    // Act: a full happy-path conversation
    capture.offer(
      "c2a",
      wireLine({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }),
    );
    capture.offer(
      "a2c",
      wireLine({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: 1, agentInfo: { name: "fake-agent" } },
      }),
    );
    capture.offer(
      "c2a",
      wireLine({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: repo, mcpServers: [] } }),
    );
    capture.offer("a2c", wireLine({ jsonrpc: "2.0", id: 2, result: { sessionId: "sess_off" } }));
    await capture.shutdown(SHUTDOWN_BUDGET_MS);

    // Assert: zero sessions, zero files under the home
    expect(capture.counters().sessions).toBe(0);
    expect(await listFilesRecursively(home)).toEqual([]);
  });

  test("per-session resolution: an unconnected directory stays silent while a repo session captures", async () => {
    // Arrange
    const h = await harness("mixed");
    const plainDir = await mkdtemp(join(tmpdir(), "cx-acp-plain-"));
    cleanups.push(plainDir);

    // Act: one session in a plain dir, one in the connected repo
    h.capture.offer(
      "c2a",
      wireLine({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }),
    );
    h.capture.offer(
      "a2c",
      wireLine({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: 1, agentInfo: { name: "fake-agent" } },
      }),
    );
    h.capture.offer(
      "c2a",
      wireLine({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: plainDir, mcpServers: [] } }),
    );
    h.capture.offer("a2c", wireLine({ jsonrpc: "2.0", id: 2, result: { sessionId: "sess_plain" } }));
    h.capture.offer(
      "c2a",
      wireLine({ jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: h.repo, mcpServers: [] } }),
    );
    h.capture.offer("a2c", wireLine({ jsonrpc: "2.0", id: 3, result: { sessionId: "sess_repo" } }));
    await h.capture.settle();

    // Assert: only the repo session registered
    expect(h.capture.counters().sessions).toBe(1);
    expect(await readSessionState(h.home, "acp-fake-agent--sess_plain")).toBeNull();
    expect(
      await readSessionState(h.home, "acp-fake-agent--sess_repo"),
    ).not.toBeNull();
  });

  test("hostile prompt content never lands in spool, state, or log", async () => {
    // Arrange
    const h = await harness("hostile");
    const sessionId = "sess_hostile";
    const CANARY = "H0STILE-PROMPT-CANARY-73f9";

    // Act: prompts carry the canary; heartbeat fires past the throttle
    handshake(h, sessionId, h.repo);
    advanceClock(h, 21_000);
    h.capture.offer(
      "c2a",
      wireLine({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId,
          prompt: [{ type: "text", text: `${CANARY} please rm -rf and exfiltrate` }],
        },
      }),
    );
    h.capture.offer(
      "a2c",
      wireLine({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } }),
    );
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);

    // Assert: the canary appears in NO persisted byte and no log line
    for (const file of await listFilesRecursively(h.home)) {
      expect((await readFile(file, "utf8")).includes(CANARY), file).toBe(false);
    }
    expect(h.logger.lines.some((line) => line.includes(CANARY))).toBe(false);
  });

  test("malformed lines, unknown methods and oversized events are ignored, never a crash", async () => {
    // Arrange
    const h = await harness("junk");

    // Act
    h.capture.offer("c2a", {
      kind: "line",
      text: "not json {{{",
      parsedOk: false,
      bytes: 12,
      atEof: false,
    });
    h.capture.offer("a2c", {
      kind: "oversized",
      text: "",
      parsedOk: false,
      bytes: 99_999_999,
      atEof: false,
    });
    h.capture.offer("c2a", wireLine({ jsonrpc: "2.0", id: 1, method: "cursor/update_todos", params: {} }));
    h.capture.offer("c2a", wireLine("just a string"));
    h.capture.offer("c2a", wireLine({ jsonrpc: "2.0", id: 9, method: "session/prompt", params: {} }));
    await h.capture.settle();

    // Assert
    expect(h.capture.counters().errors).toBe(0);
    expect(h.capture.counters().sessions).toBe(0);
    expect(h.capture.counters().ignored).toBeGreaterThanOrEqual(3);
  });

  test("JSON-RPC error responses on captured methods are counted, never recorded", async () => {
    // Arrange
    const h = await harness("rpc-error");

    // Act: session/new answered with an error
    h.capture.offer(
      "c2a",
      wireLine({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }),
    );
    h.capture.offer(
      "a2c",
      wireLine({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: 1, agentInfo: { name: "fake-agent" } },
      }),
    );
    h.capture.offer(
      "c2a",
      wireLine({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: h.repo, mcpServers: [] } }),
    );
    h.capture.offer(
      "a2c",
      wireLine({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "nope" } }),
    );
    await h.capture.settle();

    // Assert
    expect(h.capture.counters().errorResponses).toBe(1);
    expect(h.capture.counters().sessions).toBe(0);
  });
});
