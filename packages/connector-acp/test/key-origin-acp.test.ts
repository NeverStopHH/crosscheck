/**
 * THE ACP PROXY IN A REPO CONNECTED TO ANOTHER HUB (core config/key-binding.ts).
 *
 * The proxy wraps agents anywhere, and resolves each ACP session's repo from
 * the session's own cwd. A repo whose `.crosscheck.json` names a hub the
 * stored key does not belong to must turn capture off for that session —
 * no register, no records, no heartbeat, to either hub — log why, and count
 * it once, so doctor can say what the mismatch cost.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { saveConfig } from "@crosscheck/connector-core/config/config.ts";
import { makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";
import { createAcpCapture } from "../src/capture/engine.ts";
import { REMOTE, stubLogger, toolCallUpdate, wireLine } from "./fixtures/capture-harness.ts";

const STORED_KEY = "d".repeat(64);
const SESSION_ID = "sess_bait";

interface LoggingHub {
  readonly url: string;
  readonly requests: () => number;
}

const stops: (() => void)[] = [];
const cleanups: string[] = [];

afterEach(async () => {
  for (const stop of stops) {
    stop();
  }
  stops.length = 0;
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
  cleanups.length = 0;
});

const startLoggingHub = (): LoggingHub => {
  let count = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      count += 1;
      return Response.json({ ok: true, data: { session: { id: "cc_x", developerId: "dev_x" } } });
    },
  });
  stops.push(() => {
    server.stop(true);
  });
  return { url: `http://127.0.0.1:${String(server.port)}`, requests: () => count };
};

describe("an ACP session in a repo naming another hub than the key's", () => {
  test("capture is off for the session, nothing reaches either hub, and the refusal is counted", async () => {
    // Arrange — logged in to the developer's own hub; the repo names another
    const own = startLoggingHub();
    const attacker = startLoggingHub();
    const home = await makeHome("acp-key-origin");
    const repo = await makeRepo("acp-key-origin", { remote: REMOTE });
    cleanups.push(home, repo);
    await saveConfig(home, { version: 1, hubUrl: own.url, apiKey: STORED_KEY });
    await writeRepoFile(repo, "src/limiter.ts", "export const a = 1;\n");
    await writeFile(join(repo, ".crosscheck.json"), `${JSON.stringify({ hubUrl: attacker.url })}\n`, "utf8");
    const logger = stubLogger();
    const capture = createAcpCapture({
      env: { CROSSCHECK_HOME: home, CROSSCHECK_TIMEOUT_MS: "4000" },
      logger,
      now: () => new Date("2026-08-19T12:00:00.000Z"),
    });

    // Act — the handshake, a new session in the bait repo, then an edit
    capture.offer("c2a", wireLine({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }));
    capture.offer(
      "a2c",
      wireLine({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, agentInfo: { name: "fake-agent", version: "1.0.0" } } }),
    );
    capture.offer("c2a", wireLine({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: repo, mcpServers: [] } }));
    capture.offer("a2c", wireLine({ jsonrpc: "2.0", id: 2, result: { sessionId: SESSION_ID } }));
    await capture.settle();
    capture.offer(
      "a2c",
      toolCallUpdate(SESSION_ID, {
        sessionUpdate: "tool_call",
        toolCallId: "call_bait",
        kind: "edit",
        status: "in_progress",
        locations: [{ path: join(repo, "src/limiter.ts") }],
      }),
    );
    await capture.shutdown(4000);

    // Assert
    expect(attacker.requests()).toBe(0);
    expect(own.requests()).toBe(0);
    expect(logger.lines.some((line) => line.includes("off (key bound to another hub)"))).toBe(true);
    expect(logger.lines.join("\n")).not.toContain(STORED_KEY);
    const ledger = (await readFile(join(home, "state", "foreign-hub.jsonl"), "utf8")).trim().split("\n");
    expect(ledger.map((line) => (JSON.parse(line) as { surface: string }).surface)).toEqual(["acp"]);
    expect(ledger[0]).toContain(attacker.url);
  });
});
