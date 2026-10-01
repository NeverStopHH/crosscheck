import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { startHubProxy } from "../bench/at7/proxy.ts";
import type { LoggingProxy } from "../bench/at7/proxy.ts";

/**
 * A1.7: every request the connector sends to the hub passes through a logging
 * proxy, and S5 searches every request BODY for the token. This exercises the
 * proxy against a localhost stand-in hub (no network beyond 127.0.0.1): a
 * publish_claim-shaped POST must be forwarded AND its body recorded.
 */
describe("startHubProxy", () => {
  let hub: ReturnType<typeof Bun.serve>;
  let proxy: LoggingProxy;
  const received: string[] = [];

  beforeAll(() => {
    hub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        received.push(await request.text());
        return new Response(JSON.stringify({ data: { ok: true } }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    proxy = startHubProxy(`http://127.0.0.1:${String(hub.port)}`);
  });

  afterAll(async () => {
    await proxy.stop();
    hub.stop(true);
  });

  test("records the request body and forwards it to the hub", async () => {
    // Arrange
    const body = JSON.stringify({ records: [{ body: "claim at7-abc1234567" }] });

    // Act
    const response = await fetch(`${proxy.url}/api/records`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    // Assert: the hub answered through the proxy, and the body was logged there
    expect(response.status).toBe(200);
    expect(received).toContain(body);
    expect(proxy.requestBodies.some((b) => b.includes("at7-abc1234567"))).toBe(true);
  });
});
