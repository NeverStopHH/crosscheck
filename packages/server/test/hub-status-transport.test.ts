/**
 * GET /api/hub-status reports how the hub is reachable (routes/hub-status.ts,
 * hub hardening): two flags `crosscheck doctor` turns into WARNs with fixes.
 *
 *   - listensOnEveryInterface: the hub kept 0.10's every-interface listen,
 *     because CROSSCHECK_LISTEN is unset on a data dir older than the setting;
 *   - localhostBesideHttps: a localhost passkey origin beside an https one,
 *     which the hub refuses anyway.
 *
 * Flags, never the addresses: a member learns that something must change.
 */
import { describe, expect, test } from "bun:test";

import { TEST_WEBAUTHN_ORIGIN, createTestDeveloper, createTestHarness, jsonRequest } from "./helpers.ts";
import type { TestHarnessOptions } from "./helpers.ts";

const HTTPS_ORIGIN = "https://hub.example.ts.net";

const transportOf = async (options: TestHarnessOptions): Promise<unknown> => {
  const harness = await createTestHarness(options);
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  const response = await harness.app.request("/api/hub-status", jsonRequest("GET", nick.apiKey));
  return ((await response.json()) as { data: { transport: unknown } }).data.transport;
};

describe("the hub status says how the hub is reachable", () => {
  test("a hub that kept the every-interface listen says so", async () => {
    expect(await transportOf({ listen: "legacy_all_interfaces" })).toEqual({
      listensOnEveryInterface: true,
      localhostBesideHttps: false,
    });
  });

  test("a hub on loopback, or on a listen list, does not", async () => {
    expect(await transportOf({ listen: "loopback_default" })).toMatchObject({ listensOnEveryInterface: false });
    expect(await transportOf({ listen: "configured" })).toMatchObject({ listensOnEveryInterface: false });
  });

  test("a localhost passkey origin beside an https one is flagged; either alone is not", async () => {
    expect(await transportOf({ webauthnOrigins: [TEST_WEBAUTHN_ORIGIN, HTTPS_ORIGIN] })).toMatchObject({
      localhostBesideHttps: true,
    });
    expect(await transportOf({ webauthnOrigins: [HTTPS_ORIGIN] })).toMatchObject({ localhostBesideHttps: false });
    expect(await transportOf({ webauthnOrigins: [TEST_WEBAUTHN_ORIGIN] })).toMatchObject({
      localhostBesideHttps: false,
    });
  });
});
