/**
 * A LONG-LIVED CONTEXT SURVIVES A KEY ROTATION (http/client.ts freshApiKey).
 *
 * A rotation kills the old key at once. Hooks and the MCP server read the
 * config on every call, but the ACP proxy builds one context per agent
 * session, and would send the dead key until the agent restarted — every
 * capture refused, the spool growing, nothing reaching the team. With a
 * `freshApiKey` source, one 401 re-reads the key and retries once; without
 * one, or when the stored key did not change, a 401 stays a single 401.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { hubRequest } from "../src/http/client.ts";
import type { HubContext } from "../src/http/client.ts";

const NEW_KEY = "new-key";
const OLD_KEY = "old-key";

let hub: ReturnType<typeof Bun.serve>;
let home: string;
let seen: string[] = [];

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "cx-key-refresh-"));
  hub = Bun.serve({
    port: 0,
    fetch: (request) => {
      const presented = (request.headers.get("Authorization") ?? "").replace("Bearer ", "");
      seen.push(presented);
      return presented === NEW_KEY
        ? Response.json({ ok: true, data: { ok: true } })
        : Response.json({ ok: false, error: { code: "unauthorized", message: "unknown api key" } }, { status: 401 });
    },
  });
});

afterAll(async () => {
  hub.stop(true);
  await rm(home, { recursive: true, force: true });
});

const ctx = (overrides: Partial<HubContext> = {}): HubContext => ({
  hubUrl: `http://127.0.0.1:${String(hub.port)}`,
  apiKey: OLD_KEY,
  timeoutMs: 2000,
  home,
  repoKey: "hub-repo",
  now: () => new Date(),
  ...overrides,
});

const probe = (context: HubContext) =>
  hubRequest(context, { method: "GET", path: "/probe", schema: z.object({ ok: z.boolean() }) });

describe("a 401 in a context that can read the rotated key", () => {
  test("re-reads the key once and succeeds with it", async () => {
    // Arrange
    seen = [];

    // Act
    const result = await probe(ctx({ freshApiKey: () => Promise.resolve(NEW_KEY) }));

    // Assert
    expect(result.ok).toBe(true);
    expect(seen).toEqual([OLD_KEY, NEW_KEY]);
  });

  test("does not retry when the stored key did not change", async () => {
    // Arrange — the key is unknown to the hub, and rotation is not why
    seen = [];

    // Act
    const result = await probe(ctx({ freshApiKey: () => Promise.resolve(OLD_KEY) }));

    // Assert — one request, one honest 401
    expect(result.ok).toBe(false);
    expect(seen).toEqual([OLD_KEY]);
  });

  test("retries when the key source also updates the context's live key", async () => {
    // Arrange — the ACP proxy's shape: `apiKey` is a getter over a variable
    // that the key source itself replaces before it returns
    seen = [];
    let current = OLD_KEY;
    const live: HubContext = {
      ...ctx(),
      get apiKey() {
        return current;
      },
      freshApiKey: () => {
        current = NEW_KEY;
        return Promise.resolve(NEW_KEY);
      },
    };

    // Act
    const result = await probe(live);

    // Assert — compared with the key the refused request CARRIED, not the
    // one the context reads now, the new key is new and gets its retry
    expect(result.ok).toBe(true);
    expect(seen).toEqual([OLD_KEY, NEW_KEY]);
  });

  test("a context without a key source keeps its single 401", async () => {
    // Arrange
    seen = [];

    // Act
    const result = await probe(ctx());

    // Assert
    expect(result.ok).toBe(false);
    expect(result.ok ? 0 : result.status).toBe(401);
    expect(seen).toEqual([OLD_KEY]);
  });
});
