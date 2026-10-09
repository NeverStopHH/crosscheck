/**
 * EVERY HUB REQUEST NAMES THIS CLIENT'S RELEASE (human provenance §10, round
 * 2). A hub started with CROSSCHECK_REFUSE_PRE_011_DRAFTS refuses its drafting
 * doors to a request that names none, so a 0.11 client that forgot it on one
 * path would be refused like a 0.10 one. CLI, connectors and the MCP server
 * all reach the hub through `hubRequest`; this pins the header there.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CLIENT_RELEASE, CLIENT_RELEASE_HEADER } from "@crosscheck/schema";

import { hubRequest } from "../src/http/client.ts";
import type { HubContext } from "../src/http/client.ts";

let hub: ReturnType<typeof Bun.serve>;
let home: string;
const seen: (string | null)[] = [];

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "cx-client-release-"));
  hub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      seen.push(request.headers.get(CLIENT_RELEASE_HEADER));
      return Response.json({ ok: true, data: { ok: true } });
    },
  });
});

afterAll(async () => {
  hub.stop(true);
  await rm(home, { recursive: true, force: true });
});

const ctx = (): HubContext => ({
  hubUrl: `http://127.0.0.1:${String(hub.port)}`,
  keyOrigin: `http://127.0.0.1:${String(hub.port)}`,
  apiKey: "release-key",
  timeoutMs: 2000,
  home,
  repoKey: "client-release",
  now: () => new Date(),
});

describe("the client's release header", () => {
  test("a read and a write both carry it", async () => {
    // Arrange
    const schema = z.object({ ok: z.boolean() });

    // Act
    const read = await hubRequest(ctx(), { method: "GET", path: "/api/settings", schema });
    const write = await hubRequest(ctx(), { method: "POST", path: "/api/pilot-marks", schema, body: { repo: "r" } });

    // Assert
    expect(read.ok && write.ok).toBe(true);
    expect(seen).toEqual([CLIENT_RELEASE, CLIENT_RELEASE]);
  });
});
