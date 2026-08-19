/**
 * wire/v1.ts — the ACP v1 wire shapes capture needs (design §2.4), parsed
 * TOLERANTLY: unknown fields and unknown methods are ignored by
 * construction, a malformed message classifies to null and captures nothing
 * (§2.3 rule 4 — the wire itself was already forwarded upstream), and the
 * module is pinned to protocol version 1 (§2.5: v2 lands as a NEW module
 * behind a version switch, never edits here).
 */
import { describe, expect, test } from "bun:test";

import {
  ACP_PROTOCOL_VERSION,
  WIRE_METHODS,
  classifyWireMessage,
  parseInitializeResult,
  parseSessionLoadParams,
  parseSessionNewParams,
  parseSessionNewResult,
  parseSessionIdParams,
  parseSessionPromptResult,
  parseSessionUpdateParams,
  parseFsWriteParams,
  parseTerminalCreateParams,
  parseTerminalCreateResult,
  parseTerminalIdParams,
  parseTerminalOutputResult,
  parseTerminalExitResult,
} from "../src/wire/v1.ts";

describe("the version pin", () => {
  test("this module speaks protocol 1 and says so", () => {
    expect(ACP_PROTOCOL_VERSION).toBe(1);
  });
});

describe("classifyWireMessage", () => {
  test("method + id = request", () => {
    const message = classifyWireMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "session/new",
      params: { cwd: "/repo" },
    });

    expect(message).toEqual({
      kind: "request",
      id: 7,
      method: "session/new",
      params: { cwd: "/repo" },
    });
  });

  test("method without id = notification", () => {
    const message = classifyWireMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1" },
    });

    expect(message?.kind).toBe("notification");
  });

  test("id without method = response; error responses are marked", () => {
    const ok = classifyWireMessage({ jsonrpc: "2.0", id: "a", result: { x: 1 } });
    const failed = classifyWireMessage({
      jsonrpc: "2.0",
      id: "a",
      error: { code: -32601, message: "method not found" },
    });

    expect(ok).toEqual({ kind: "response", id: "a", result: { x: 1 }, isError: false });
    expect(failed?.kind).toBe("response");
    expect(failed?.kind === "response" && failed.isError).toBe(true);
  });

  test("string ids classify like numeric ones", () => {
    const message = classifyWireMessage({ jsonrpc: "2.0", id: "req-1", method: "x" });

    expect(message?.kind).toBe("request");
  });

  test("non-objects, arrays and idless/methodless junk classify to null", () => {
    expect(classifyWireMessage("hello")).toBeNull();
    expect(classifyWireMessage(42)).toBeNull();
    expect(classifyWireMessage(null)).toBeNull();
    expect(classifyWireMessage([1, 2])).toBeNull();
    expect(classifyWireMessage({ jsonrpc: "2.0" })).toBeNull();
    // A boolean id is not a JSON-RPC id — tolerated by ignoring, never a throw.
    expect(classifyWireMessage({ jsonrpc: "2.0", id: true, result: {} })).toBeNull();
  });
});

describe("initialize", () => {
  test("agent name, version and protocol come out of a stable-shape result", () => {
    const parsed = parseInitializeResult({
      protocolVersion: 1,
      agentInfo: { name: "Gemini CLI", version: "3.4.5", extra: "ignored" },
      agentCapabilities: { promptCapabilities: {} },
    });

    expect(parsed).toEqual({
      protocolVersion: 1,
      agentName: "Gemini CLI",
      agentVersion: "3.4.5",
    });
  });

  test("a result without agentInfo degrades to nulls, never a throw", () => {
    expect(parseInitializeResult({ protocolVersion: 1 })).toEqual({
      protocolVersion: 1,
      agentName: null,
      agentVersion: null,
    });
    expect(parseInitializeResult("junk")).toEqual({
      protocolVersion: null,
      agentName: null,
      agentVersion: null,
    });
  });
});

describe("session lifecycle shapes", () => {
  test("session/new params carry the cwd; unknown fields ignored", () => {
    expect(
      parseSessionNewParams({ cwd: "/work/repo", mcpServers: [], _meta: { x: 1 } }),
    ).toEqual({ cwd: "/work/repo" });
    expect(parseSessionNewParams({ mcpServers: [] })).toBeNull();
  });

  test("session/new result carries the sessionId", () => {
    expect(parseSessionNewResult({ sessionId: "sess_1", modes: {} })).toEqual({
      sessionId: "sess_1",
    });
    expect(parseSessionNewResult({})).toBeNull();
  });

  test("session/load params carry sessionId + cwd", () => {
    expect(
      parseSessionLoadParams({ sessionId: "sess_1", cwd: "/work/repo", mcpServers: [] }),
    ).toEqual({ sessionId: "sess_1", cwd: "/work/repo" });
    expect(parseSessionLoadParams({ sessionId: "sess_1" })).toBeNull();
  });

  test("sessionId-only params (prompt, close) parse tolerantly", () => {
    expect(
      parseSessionIdParams({ sessionId: "sess_1", prompt: [{ type: "text", text: "hi" }] }),
    ).toEqual({ sessionId: "sess_1" });
    expect(parseSessionIdParams({})).toBeNull();
  });

  test("prompt result stopReason is optional", () => {
    expect(parseSessionPromptResult({ stopReason: "end_turn" })).toEqual({
      stopReason: "end_turn",
    });
    expect(parseSessionPromptResult({})).toEqual({ stopReason: null });
    expect(parseSessionPromptResult(undefined)).toEqual({ stopReason: null });
  });
});

describe("session/update tool calls", () => {
  test("locations and diff-content paths are collected; texts never", () => {
    const parsed = parseSessionUpdateParams({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "Editing limiter",
        kind: "edit",
        status: "in_progress",
        locations: [{ path: "/repo/src/a.ts", line: 4 }, { notAPath: true }],
        content: [
          { type: "diff", path: "/repo/src/b.ts", oldText: "SECRET", newText: "X" },
          { type: "content", content: { type: "text", text: "chatter" } },
        ],
      },
    });

    expect(parsed?.sessionId).toBe("sess_1");
    expect(parsed?.toolCall?.paths).toEqual(["/repo/src/a.ts", "/repo/src/b.ts"]);
    expect(parsed?.toolCall?.toolKind).toBe("edit");
    expect(parsed?.toolCall?.status).toBe("in_progress");
    // The parsed shape carries NO diff text fields at all — paths only.
    expect(JSON.stringify(parsed)).not.toContain("SECRET");
  });

  test("a failed update exposes rawOutput for fingerprinting", () => {
    const parsed = parseSessionUpdateParams({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "failed",
        rawOutput: { stderr: "boom" },
      },
    });

    expect(parsed?.toolCall?.status).toBe("failed");
    expect(parsed?.toolCall?.rawOutput).toEqual({ stderr: "boom" });
  });

  test("non-tool updates (message chunks) carry no tool call", () => {
    const parsed = parseSessionUpdateParams({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "thinking" },
      },
    });

    expect(parsed?.sessionId).toBe("sess_1");
    expect(parsed?.toolCall).toBeNull();
  });
});

describe("fs + terminal shapes", () => {
  test("fs/write_text_file params carry sessionId + path, never content", () => {
    const parsed = parseFsWriteParams({
      sessionId: "sess_1",
      path: "/repo/src/new.ts",
      content: "SECRET BODY",
    });

    expect(parsed).toEqual({ sessionId: "sess_1", path: "/repo/src/new.ts" });
    expect(JSON.stringify(parsed)).not.toContain("SECRET");
  });

  test("terminal create request/response and id-bearing params", () => {
    expect(
      parseTerminalCreateParams({ sessionId: "sess_1", command: "bun", args: ["test"] }),
    ).toEqual({ sessionId: "sess_1" });
    expect(parseTerminalCreateResult({ terminalId: "term_1" })).toEqual({
      terminalId: "term_1",
    });
    expect(
      parseTerminalIdParams({ sessionId: "sess_1", terminalId: "term_1" }),
    ).toEqual({ sessionId: "sess_1", terminalId: "term_1" });
  });

  test("terminal output result: output text + exit code from either spelling", () => {
    expect(
      parseTerminalOutputResult({ output: "fail: x", truncated: false }),
    ).toEqual({ output: "fail: x", exitCode: null });
    expect(
      parseTerminalOutputResult({
        output: "done",
        exitStatus: { exitCode: 2, signal: null },
      }),
    ).toEqual({ output: "done", exitCode: 2 });
  });

  test("wait_for_exit result: exitCode at top level or under exitStatus", () => {
    expect(parseTerminalExitResult({ exitCode: 3 })).toEqual({ exitCode: 3 });
    expect(parseTerminalExitResult({ exitStatus: { exitCode: 0 } })).toEqual({
      exitCode: 0,
    });
    expect(parseTerminalExitResult({ signal: "SIGKILL" })).toEqual({
      exitCode: null,
    });
  });
});

describe("the method table", () => {
  test("names the §2.4 rows exactly once each", () => {
    const values = Object.values(WIRE_METHODS);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toContain("initialize");
    expect(values).toContain("session/new");
    expect(values).toContain("session/load");
    expect(values).toContain("session/prompt");
    expect(values).toContain("session/update");
    expect(values).toContain("fs/write_text_file");
    expect(values).toContain("terminal/create");
    expect(values).toContain("terminal/wait_for_exit");
  });
});
