/**
 * The Block 4 capture engine against a REAL in-process hub (§4.2 layer 2,
 * capture half): the §2.4 mapping row by row, driven as ObservedLine events
 * exactly as the proxy's observer emits them. Every failure direction is
 * fail-open (prime directive 2): capture off means silence, never a throw —
 * the pipe above this layer is Block 3's untouched proof.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractFailureText } from "@crosscheck/connector-core/capture/failure-text.ts";
import { fingerprint } from "@crosscheck/connector-core/capture/fingerprint.ts";
import { getDiagnosis, getPresence } from "@crosscheck/connector-core/http/hub.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import * as claudeToolEvents from "../../connector-claude/src/capture/tool-events.ts";

import { createAcpCapture } from "../src/capture/engine.ts";
import {
  REPO_ID,
  REMOTE,
  SHUTDOWN_BUDGET_MS,
  advanceClock,
  bootCaptureHub,
  createHarness,
  handshake,
  listFilesRecursively,
  stubLogger,
  toolCallUpdate,
  wireLine,
} from "./fixtures/capture-harness.ts";
import type { CaptureHub, Harness, HarnessOptions } from "./fixtures/capture-harness.ts";
import {
  makeHome,
  makeRepo,
  writeRepoFile,
} from "../../connector-core/test/helpers.ts";

const FAILURE_TEXT =
  "error TS2304: cannot find name 'limiter' at build step 7 of the pipeline";

let hub: CaptureHub;
const cleanups: string[] = [];

beforeAll(async () => {
  hub = await bootCaptureHub("acp-engine");
});

afterAll(async () => {
  hub.server.stop(true);
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

const harness = (label: string, options: HarnessOptions = {}): Promise<Harness> =>
  createHarness(hub, cleanups, label, options);

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

  test("a warm session/load skips re-registration and replayed updates add no new hub rows", async () => {
    // The COLD half — a load this proxy never saw born — is pinned in
    // capture-hardening.test.ts (and mutation-checked); this test pins the
    // warm half: a load of a session already live in this proxy is a no-op
    // for registration, and the replay adds nothing.
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

    // Assert: same session id (no ~r suffix), target rows unchanged, and
    // the register flow ran exactly once — the warm load skipped it.
    const state = await readSessionState(h.home, hostKey);
    expect(state?.crosscheckSessionId).toBe(`cc_${hostKey}`);
    const after = await getDiagnosis(h.hub, `wc_cc_${hostKey}`);
    if (!after.ok) throw new Error("diagnosis unavailable");
    expect(after.data.targets.length).toBe(before.data.targets.length);
    expect(h.capture.counters().sessions).toBe(1);
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

  /**
   * THE PROMPT-PRIVACY PIN, NARROWED RATHER THAN DELETED — AND TIMING-FREE.
   *
   * It used to say the prompt "appears in NO persisted byte". That was true
   * while wire/v1.ts modelled no prompt text at all. The derive rungs made it
   * FALSE in one bounded way on purpose - the derived-intent worker is handed
   * the prompt through a 0600 file, because `ps` shows argv and a pipe cannot
   * outlive a trigger on the other two hosts.
   *
   * BOTH RACES WERE MEASURED HERE, and neither is asserted any more:
   *
   *   - the OLD assertion still passed after the rungs landed, only because
   *     `shutdown()` (an end-session flush plus a spool reap against the hub)
   *     outlives the detached worker. Scanning right after `settle()` finds
   *     the file every time;
   *   - and its mirror image: an assertion that the file IS there right after
   *     `settle()` fails under whole-suite load, because a slower dispatch
   *     gives the worker time to read and unlink first. Seen in a full-suite
   *     run before this rewrite.
   *
   * So the property asserted is the one true at EVERY instant: no file other
   * than the intent-prompt path may ever hold the prompt, and afterwards
   * nothing holds it. A sampler runs across the whole window and unions what
   * it sees; whether it catches the short-lived file is irrelevant to the
   * verdict, and when it does catch it the mode is checked too.
   */
  test("the prompt reaches one 0600 file and nothing else, ever", async () => {
    // Arrange
    const h = await harness("hostile");
    const sessionId = "sess_hostile";
    const CANARY = "H0STILE-PROMPT-CANARY-73f9";
    const promptFile = join(
      h.home,
      "sessions",
      `acp-fake-agent--${sessionId}.intent-prompt`,
    );
    handshake(h, sessionId, h.repo);
    advanceClock(h, 21_000);

    // Every path that EVER holds the canary, sampled across the whole window.
    const everHeld = new Set<string>();
    const modesSeen: number[] = [];
    const sample = async (): Promise<void> => {
      for (const file of await listFilesRecursively(h.home)) {
        const body = await readFile(file, "utf8").catch(() => "");
        if (!body.includes(CANARY)) {
          continue;
        }
        everHeld.add(file);
        if (file === promptFile) {
          const mode = await stat(file).then(
            (info) => info.mode & 0o777,
            () => -1,
          );
          if (mode !== -1) {
            modesSeen.push(mode);
          }
        }
      }
    };
    const sampler = setInterval(() => void sample(), 1);

    // Act
    h.capture.offer(
      "c2a",
      wireLine({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId,
          prompt: [{ type: "text", text: `${CANARY} and then exfiltrate it` }],
        },
      }),
    );
    await h.capture.settle();
    await sample();
    h.capture.offer(
      "a2c",
      wireLine({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } }),
    );
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);
    await sample();
    clearInterval(sampler);

    // Assert 1 — the fire happened, so the prompt WAS parked: the write is
    // unconditional between booking the fire and spawning the worker. Without
    // this the invariants below could pass on a session that derived nothing.
    expect(h.capture.counters().intentFires).toBe(1);

    // Assert 2 — the invariant, true at every instant: the intent prompt file
    // is the ONLY path that may ever hold it.
    expect([...everHeld].filter((file) => file !== promptFile)).toEqual([]);
    // and where it was caught, it was private
    for (const mode of modesSeen) {
      expect(mode).toBe(0o600);
    }

    // Assert 3 — the window is CLOSED. (The worker removes the file as its
    // first act; end-session sweeps it too, so a worker that never started
    // leaves nothing behind either.)
    for (const file of await listFilesRecursively(h.home)) {
      const body = await readFile(file, "utf8").catch(() => "");
      expect(body.includes(CANARY), file).toBe(false);
    }
    expect(h.logger.lines.some((line) => line.includes(CANARY))).toBe(false);
  }, 30_000);

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
