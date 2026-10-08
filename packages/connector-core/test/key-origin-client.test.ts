/**
 * THE SHARED HTTP CLIENT REFUSES A KEY TO ANY ORIGIN BUT ITS OWN
 * (http/client.ts key-origin check), whatever the caller passes.
 *
 * Driven below every surface on purpose: a context built by a caller that
 * paired the developer's key with a repo-named hub — a future surface that
 * forgets config/key-binding.ts, or the spool flusher handed such a context —
 * must still send nothing. Two logging hubs on loopback stand for the
 * attacker's and the developer's own; each records every request it gets.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { z } from "zod";

import { hubRequest, KEY_ORIGIN_MISMATCH } from "../src/http/client.ts";
import type { HubContext } from "../src/http/client.ts";
import { appendRecords, flushSpool, readSpoolLines, repoKey } from "../src/index.ts";
import { hubFailureText } from "../src/mcp/tools/shared.ts";
import { readSyncState } from "../src/state/sync-state.ts";
import { makeHome } from "./helpers.ts";

const KEY = "c".repeat(64);
const REPO_ID = "github.com/acme/api";
const NOW = new Date("2026-07-26T12:00:00.000Z");

interface LoggingHub {
  readonly url: string;
  readonly requests: () => readonly { readonly path: string; readonly keyed: boolean }[];
}

const stops: (() => void)[] = [];
const homes: string[] = [];

afterEach(async () => {
  for (const stop of stops) {
    stop();
  }
  stops.length = 0;
  await Promise.all(homes.map((path) => rm(path, { recursive: true, force: true })));
  homes.length = 0;
});

const startLoggingHub = (): LoggingHub => {
  const seen: { path: string; keyed: boolean }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      seen.push({ path: new URL(request.url).pathname, keyed: request.headers.get("authorization") !== null });
      return Response.json({ ok: true, data: { accepted: 1, rejected: 0, ignored: 0 } });
    },
  });
  stops.push(() => {
    server.stop(true);
  });
  return { url: `http://127.0.0.1:${String(server.port)}`, requests: () => [...seen] };
};

const context = (home: string, hubUrl: string, keyOrigin: string | null): HubContext => ({
  hubUrl,
  apiKey: KEY,
  keyOrigin,
  timeoutMs: 4000,
  home,
  repoKey: repoKey(hubUrl, REPO_ID),
  now: () => NOW,
});

const probe = { method: "GET", path: "/api/presence?repo=x", schema: z.unknown() } as const;

describe("the key-origin check in the HTTP client", () => {
  test("a request for another origin than the key's is refused and never sent", async () => {
    // Arrange — the caller paired the developer's key with the attacker's hub
    const attacker = startLoggingHub();
    const own = startLoggingHub();
    const home = await makeHome("key-origin-refused");
    homes.push(home);

    // Act
    const result = await hubRequest(context(home, attacker.url, own.url), probe);

    // Assert
    expect(attacker.requests()).toEqual([]);
    expect(own.requests()).toEqual([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("refused");
      expect(result.code).toBe(KEY_ORIGIN_MISMATCH);
      expect(result.message).toContain(own.url);
      expect(result.message).toContain(attacker.url);
      expect(result.message).not.toContain(KEY);
    }
  });

  test("a key bound to no hub is sent nowhere", async () => {
    // Arrange
    const own = startLoggingHub();
    const home = await makeHome("key-origin-unbound");
    homes.push(home);

    // Act
    const result = await hubRequest(context(home, own.url, null), probe);

    // Assert
    expect(own.requests()).toEqual([]);
    expect(result.ok ? null : result.kind).toBe("refused");
  });

  test("the key's own origin, spelled with a slash, receives the keyed request", async () => {
    // Arrange
    const own = startLoggingHub();
    const home = await makeHome("key-origin-own");
    homes.push(home);

    // Act
    const result = await hubRequest(context(home, own.url, `${own.url}/`), probe);

    // Assert
    expect(result.ok).toBe(true);
    expect(own.requests()).toEqual([{ path: "/api/presence", keyed: true }]);
  });

  test("the refusal is what the sync record says, never a reachable hub", async () => {
    // Arrange
    const attacker = startLoggingHub();
    const own = startLoggingHub();
    const home = await makeHome("key-origin-sync");
    homes.push(home);
    const ctx = context(home, attacker.url, own.url);

    // Act
    await hubRequest(ctx, probe);

    // Assert
    const sync = await readSyncState(home, ctx.repoKey);
    expect(sync.lastOkAt).toBeNull();
    expect(sync.lastError).toStartWith(`${KEY_ORIGIN_MISMATCH}: not sent`);
  });
});

describe("an MCP tool told of a refusal", () => {
  test("is told nothing was sent, without the foreign url and without a login to it", async () => {
    // Arrange
    const attacker = startLoggingHub();
    const own = startLoggingHub();
    const home = await makeHome("key-origin-mcp-text");
    homes.push(home);
    const refused = await hubRequest(context(home, attacker.url, own.url), probe);
    if (refused.ok) {
      throw new Error("the foreign request was not refused");
    }

    // Act
    const text = hubFailureText(attacker.url, refused);

    // Assert
    expect(text).toContain("crosscheck did not send this request");
    expect(text).not.toContain(attacker.url);
    expect(text).not.toContain("crosscheck login");
  });
});

describe("the spool flusher handed a foreign context", () => {
  test("sends nothing and leaves every record on disk", async () => {
    // Arrange — records spooled under the attacker hub's key, a context
    // pairing the developer's key with that hub
    const attacker = startLoggingHub();
    const own = startLoggingHub();
    const home = await makeHome("key-origin-flush");
    homes.push(home);
    const ctx = context(home, attacker.url, own.url);
    const envelope = (index: number): Record<string, unknown> => ({
      cx: "0.1",
      id: `env_${String(index)}`,
      ts: NOW.toISOString(),
      producer: { developerId: "unknown", agentKind: "claude-code", sessionId: "cc_foreign" },
      kind: "target",
      body: { workContextId: "wc_1", kind: "file", value: `src/file-${String(index)}.ts` },
    });
    await appendRecords(home, ctx.repoKey, "session-foreign", [envelope(1), envelope(2)], NOW);

    // Act
    await flushSpool(ctx, { sessionId: "cc_foreign", developerId: "dev_1" }, 10_000);

    // Assert
    expect(attacker.requests()).toEqual([]);
    expect(own.requests()).toEqual([]);
    expect(await readSpoolLines(home, ctx.repoKey)).toHaveLength(2);
  });
});
