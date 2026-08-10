/**
 * The wire, which is ours to keep.
 *
 * src/mcp/protocol.ts explains why the official SDK is not used and names the
 * cost: "protocol conformance is ours to keep, so the handshake is pinned by
 * test/mcp-protocol.test.ts rather than by a dependency". This is that file, and
 * it is the whole of what makes that trade honest.
 *
 * THE FRAMING PROPERTY IS THE LOAD-BEARING ONE. Everything rides on one JSON
 * value per line with no embedded raw newline. That comes free from
 * `JSON.stringify`, which escapes U+000A inside strings — but "free" is a
 * property of the current encoder, and a claim body IS attacker-controlled
 * multi-line text, so it is asserted rather than assumed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { MCP_PROTOCOL_VERSIONS, MCP_SERVER_VERSION } from "../src/index.ts";
import {
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  parseFrame,
} from "../src/mcp/protocol.ts";
import { handleFrame } from "../src/mcp/server.ts";
import type { Env } from "../src/index.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const cleanups: string[] = [];

afterAll(async () => {
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

/**
 * A repo with NO hub configured on purpose.
 *
 * Every assertion in this file is about the wire, and the wire has to behave
 * identically whether or not a hub is reachable — a handshake that only works
 * once a hub answers is a handshake that fails on a developer's first run.
 */
const env: Env = { CROSSCHECK_HOME: "/nonexistent-crosscheck-home" };
let cwd: string | undefined;

const setUp = async (): Promise<string> => {
  if (cwd === undefined) {
    const home = await makeHome("mcp-protocol");
    cwd = await makeRepo("mcp-protocol", {
      remote: "git@github.com:acme/api.git",
    });
    cleanups.push(home, cwd);
  }
  return cwd;
};

/** One request in, one line out — the shape the transport actually moves. */
const roundTrip = async (line: string): Promise<string | null> => {
  const response = await handleFrame(parseFrame(line), env, await setUp());
  return response === null ? null : JSON.stringify(response);
};

const parsedRoundTrip = async (
  line: string,
): Promise<Record<string, unknown>> => {
  const raw = await roundTrip(line);
  if (raw === null) {
    throw new Error(`expected a response to ${line}`);
  }
  return JSON.parse(raw) as Record<string, unknown>;
};

const request = (
  id: number | string,
  method: string,
  params?: unknown,
): string =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });

describe("the handshake", () => {
  test("echoes a protocol version this server speaks", async () => {
    // Arrange: the spec's negotiation rule — answer with the client's version
    // when it is one this server knows
    const wanted = MCP_PROTOCOL_VERSIONS[1];

    // Act
    const response = await parsedRoundTrip(
      request(1, "initialize", { protocolVersion: wanted }),
    );

    // Assert
    const result = response["result"] as Record<string, unknown>;
    expect(result["protocolVersion"]).toBe(wanted);
  });

  test("answers an unknown version with the newest it speaks", async () => {
    // Arrange: an older client must keep talking to a newer server rather than
    // failing the handshake
    // Act
    const response = await parsedRoundTrip(
      request(1, "initialize", { protocolVersion: "1999-01-01" }),
    );

    // Assert
    const result = response["result"] as Record<string, unknown>;
    expect(result["protocolVersion"]).toBe(MCP_PROTOCOL_VERSIONS[0]);
  });

  test("declares the tools capability and names itself", async () => {
    // Act
    const response = await parsedRoundTrip(request(1, "initialize", {}));

    // Assert: without the capability a client never calls tools/list
    const result = response["result"] as Record<string, unknown>;
    expect(result["capabilities"]).toHaveProperty("tools");
    const info = result["serverInfo"] as Record<string, unknown>;
    expect(info["name"]).toBe("crosscheck");
    expect(info["version"]).toBe(MCP_SERVER_VERSION);
  });

  test("never answers a notification", async () => {
    // Arrange: `id` ABSENT — not `id: null` — is what makes a frame a
    // notification, and answering one corrupts the client's request matching
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    // Act + Assert
    expect(await roundTrip(line)).toBeNull();
  });
});

describe("tools/list", () => {
  test("lists all five tools with names, descriptions and schemas", async () => {
    // Act
    const response = await parsedRoundTrip(request(2, "tools/list"));

    // Assert
    const result = response["result"] as { tools: Record<string, unknown>[] };
    const names = result.tools.map((tool) => tool["name"]);
    expect(names).toEqual([
      "publish_claim",
      "extend_diagnosis",
      "get_diagnosis",
      "get_referee_brief",
      "search_related_work",
    ]);
    for (const tool of result.tools) {
      expect(typeof tool["description"], String(tool["name"])).toBe("string");
      expect(tool["inputSchema"], String(tool["name"])).toHaveProperty("type");
    }
  });

  test("lists the tools even with no hub configured", async () => {
    // Arrange: this env has no hub and no key. A client that could not even see
    // the tools would give a model no way to learn they exist, and the CALL is
    // what explains the misconfiguration.
    // Act
    const response = await parsedRoundTrip(request(2, "tools/list"));

    // Assert
    expect(response).not.toHaveProperty("error");
  });
});

describe("tools/call", () => {
  test("reports a misconfigured hub as a tool failure, not a protocol error", async () => {
    // Arrange: MCP draws this line deliberately. A JSON-RPC error means "the
    // call was malformed", which a model can do nothing with; `isError` means
    // "the call was fine, here is why it did not work", which it can act on.
    // Act
    const response = await parsedRoundTrip(
      request(3, "tools/call", {
        name: "search_related_work",
        arguments: { query: "login" },
      }),
    );

    // Assert
    expect(response).not.toHaveProperty("error");
    const result = response["result"] as Record<string, unknown>;
    expect(result["isError"]).toBe(true);
    const content = result["content"] as { text: string }[];
    expect(content[0]?.text).toContain("crosscheck login");
  });

  test("names the real tools when asked for one that does not exist", async () => {
    // Act
    const response = await parsedRoundTrip(
      request(3, "tools/call", { name: "delete_everything", arguments: {} }),
    );

    // Assert: a tool failure, so the model reads the list and retries
    const result = response["result"] as Record<string, unknown>;
    expect(result["isError"]).toBe(true);
    const content = result["content"] as { text: string }[];
    expect(content[0]?.text).toContain("publish_claim");
    expect(content[0]?.text).toContain("get_diagnosis");
  });

  test("rejects a call with no tool name as a protocol error", async () => {
    // Arrange: this one really IS malformed — there is no tool to blame
    // Act
    const response = await parsedRoundTrip(
      request(3, "tools/call", { arguments: {} }),
    );

    // Assert
    const error = response["error"] as Record<string, unknown>;
    expect(error["code"]).toBe(RPC_INVALID_PARAMS);
  });
});

describe("framing", () => {
  test("every response is exactly one line", async () => {
    // Arrange: the property the whole transport rests on. It comes free from
    // JSON.stringify escaping U+000A — but "free" is a property of the current
    // encoder, and a future change must not be able to break it quietly.
    const lines = [
      request(1, "initialize", {}),
      request(2, "tools/list"),
      request(3, "tools/call", {
        name: "publish_claim",
        arguments: { kind: "observation", body: "first\nsecond\r\nthird" },
      }),
      request(4, "nonexistent/method"),
      "{ not json at all",
    ];

    // Act + Assert
    for (const line of lines) {
      const raw = await roundTrip(line);
      if (raw === null) {
        continue;
      }
      expect(raw.includes("\n"), line).toBe(false);
      expect(raw.includes("\r"), line).toBe(false);
    }
  });

  test("caller-controlled text carrying newlines cannot split a frame", async () => {
    // Arrange: the transport is newline-delimited and some caller-supplied
    // strings are echoed back inside a response. That is the collision, and it
    // needs a path where the echo really happens.
    //
    // An unknown TOOL NAME is that path, and finding one was this test's first
    // act of work: it was written against a multi-line claim `body`, which this
    // file's deliberately hub-less env never reaches — publish_claim answers
    // "no hub url or api key" long before it looks at the body, so the assertion
    // passed over a response that contained no caller text at all. The tool name
    // is echoed by `unknownToolResult` with no hub involved.
    const name = "evil\nname\r\nwith breaks";

    // Act
    const raw = await roundTrip(
      request(5, "tools/call", { name, arguments: {} }),
    );

    // Assert: one line out. That is the transport property and it is unchanged.
    expect(raw?.includes("\n")).toBe(false);
    expect(raw?.includes("\r")).toBe(false);
    // The response text is itself multi-line now — the quoted-data notice gets
    // its own line — so the escaping this test was written for is still
    // exercised, by the RENDERER's newline rather than by the caller's.
    expect(raw).toContain("\\n");
    // The caller's breaks, though, are no longer escaped: they are GONE. The
    // tool name is a caller-supplied string echoed into an agent's context, so
    // `unknownToolResult` now sanitizes and frames it like any other untrusted
    // text, and the separator characters are spaced and collapsed before
    // anything is encoded. Two defences deep instead of one, and this asserts
    // the stronger of them rather than the weaker one it used to.
    expect(raw).not.toContain("\\r");
    expect(raw).toContain("«evil name with breaks»");
  });

  test("answers a parse error with a null id, as JSON-RPC requires", async () => {
    // Arrange: there is no id to read out of a line that is not JSON, and the
    // spec says the id MUST then be null rather than omitted
    // Act
    const response = await parsedRoundTrip("{ this is not json");

    // Assert
    expect(response["id"]).toBeNull();
    const error = response["error"] as Record<string, unknown>;
    expect(error["code"]).toBe(RPC_PARSE_ERROR);
  });

  test("answers an invalid request addressed to its own id", async () => {
    // Arrange: parseable JSON, but not a request. A client whose call came back
    // with `id: null` could not match the failure to the call it made.
    const line = JSON.stringify({
      jsonrpc: "1.0",
      id: 77,
      method: "initialize",
    });

    // Act
    const response = await parsedRoundTrip(line);

    // Assert
    expect(response["id"]).toBe(77);
    const error = response["error"] as Record<string, unknown>;
    expect(error["code"]).toBe(RPC_INVALID_REQUEST);
  });

  test("answers an unknown method with method-not-found", async () => {
    // Act
    const response = await parsedRoundTrip(request(9, "resources/list"));

    // Assert
    const error = response["error"] as Record<string, unknown>;
    expect(error["code"]).toBe(RPC_METHOD_NOT_FOUND);
  });

  test("answers ping, which clients use as a liveness probe", async () => {
    // Act
    const response = await parsedRoundTrip(request(10, "ping"));

    // Assert
    expect(response).not.toHaveProperty("error");
  });
});
