/**
 * THE GUARD ITSELF (test/network-guard.ts). A real hub listens on
 * 127.0.0.1:7100 on a developer machine; these pin that no test can reach it,
 * or any tailnet host, through either door a test uses — the global `fetch`
 * and the connector's own HTTP client — while an in-process hub on a random
 * port still answers.
 *
 * This file imports the RULES only, never the preload: the first test proves
 * the bunfig wired the guard for this very run, and the requests below are
 * made only when it did, so a run that lost the preload fails here instead of
 * dialling the real hub.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { z } from "zod";

import { hubRequest } from "../src/http/client.ts";
import { makeHome } from "./helpers.ts";
import { BLOCKED_FETCHES_KEY, GUARD_INSTALLED_KEY, isRealHubUrl } from "./network-guard-rules.ts";
import type { GuardMarks } from "./network-guard-rules.ts";

const paths: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const server of servers) {
    server.stop(true);
  }
  servers.length = 0;
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const marks = globalThis as GuardMarks;
const blockedSoFar = (): number => marks[BLOCKED_FETCHES_KEY] ?? 0;

/** Refuses to make the request at all unless the guard is in place. */
const requireGuard = (): void => {
  if (marks[GUARD_INSTALLED_KEY] !== true) {
    throw new Error("the network guard preload is not wired for this run — no request made");
  }
};

describe("which URLs count as a real hub", () => {
  test.each([
    ["http://127.0.0.1:7100/api/health", true],
    ["http://localhost:7100", true],
    ["http://[::1]:7100/api/records", true],
    ["http://0.0.0.0:7100", true],
    ["https://hub.tailnet.ts.net/api/presence", true],
    ["http://HUB.TAILNET.TS.NET:8443", true],
    ["http://127.0.0.1:7199", false],
    ["http://127.0.0.1:1", false],
    ["http://hub.example:7100", false],
    ["http://hub.invalid", false],
  ] as const)("%s → %p", (url, expected) => {
    // Act / Assert
    expect(isRealHubUrl(new URL(url))).toBe(expected);
  });
});

describe("the preload refuses a real hub on every door a test uses", () => {
  test("the preload wired the guard for this very run", () => {
    // Assert
    expect(marks[GUARD_INSTALLED_KEY]).toBe(true);
  });

  test("a bare fetch to 127.0.0.1:7100 rejects before any socket opens", async () => {
    // Arrange
    requireGuard();
    const before = blockedSoFar();

    // Act
    const attempt = fetch("http://127.0.0.1:7100/api/health");

    // Assert
    await expect(attempt).rejects.toThrow("test network guard");
    expect(blockedSoFar()).toBe(before + 1);
  });

  test("a tailnet host rejects too, given as a Request", async () => {
    // Arrange
    requireGuard();

    // Act / Assert
    await expect(fetch(new Request("https://hub.tailnet.ts.net/api/presence"))).rejects.toThrow(
      "test network guard",
    );
  });

  test("the connector's HTTP client reaches the guard and reads it as a network failure", async () => {
    // Arrange
    requireGuard();
    const home = await makeHome("network-guard");
    paths.push(home);
    const before = blockedSoFar();

    // Act
    const result = await hubRequest(
      { hubUrl: "http://127.0.0.1:7100", apiKey: "test-key", timeoutMs: 400, home, repoKey: "guard", now: () => new Date() },
      { method: "GET", path: "/api/health", schema: z.unknown() },
    );

    // Assert
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.kind).toBe("network");
    expect(blockedSoFar()).toBe(before + 1);
  });

  test("an in-process hub on a random port still answers", async () => {
    // Arrange
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true, data: { pong: true } }) });
    servers.push(server);

    // Act
    const response = await fetch(`http://127.0.0.1:${String(server.port)}/ping`);

    // Assert
    expect(await response.json()).toEqual({ ok: true, data: { pong: true } });
  });
});
