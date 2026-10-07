/**
 * X-FORWARDED-* COUNTS ONLY FROM A TRUSTED PEER (http/forwarded.ts, review M7).
 *
 * 0.10 believed `X-Forwarded-Proto: https` from any peer, so a LAN peer
 * talking to `:7100` directly passed as https. Now the header is read only
 * from loopback (`tailscale serve`, a local proxy) or from a peer listed in
 * CROSSCHECK_TRUSTED_PROXIES (the Docker kit's Caddy, on a bridge IP).
 */
import { describe, expect, test } from "bun:test";

import { parseTrustedProxies } from "../src/http/forwarded.ts";
import { createTestDeveloper, createTestHarness } from "./helpers.ts";
import type { TestHarnessOptions } from "./helpers.ts";
import { sessionCookieFrom } from "./ui-helpers.ts";

const LAN_PEER = "192.168.1.20";
const CADDY_PEER = "172.18.0.5";

/** POST /ui/login with a valid key and an `X-Forwarded-Proto: https`, as `options` sees the peer. */
const loginCookieVia = async (options: TestHarnessOptions): Promise<string | null> => {
  const harness = await createTestHarness(options);
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  const response = await harness.app.request("/ui/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Forwarded-Proto": "https",
    },
    body: new URLSearchParams({ apiKey: nick.apiKey }).toString(),
  });
  return sessionCookieFrom(response);
};

describe("CROSSCHECK_TRUSTED_PROXIES", () => {
  test("addresses and CIDRs, IPv4 and IPv6, match their peers and nothing else", () => {
    // Arrange
    const trusted = parseTrustedProxies(" 172.18.0.0/16, 100.101.4.7 ,[fd7a:115c:a1e0::]/48");

    // Act + Assert
    expect(trusted.includes("172.18.3.4")).toBe(true);
    expect(trusted.includes("::ffff:172.18.3.4")).toBe(true);
    expect(trusted.includes("100.101.4.7")).toBe(true);
    expect(trusted.includes("fd7a:115c:a1e0::5")).toBe(true);
    expect(trusted.includes("172.19.0.1")).toBe(false);
    expect(trusted.includes("100.101.4.8")).toBe(false);
    expect(trusted.includes("fd7a:115c:a1e1::5")).toBe(false);
    expect(trusted.includes("not-an-address")).toBe(false);
  });

  test("unset or empty trusts no proxy beyond loopback", () => {
    expect(parseTrustedProxies(undefined).includes("172.18.0.5")).toBe(false);
    expect(parseTrustedProxies(" ").includes("172.18.0.5")).toBe(false);
  });

  test("a hostname, a bad prefix or a malformed CIDR stops the hub at startup", () => {
    expect(() => parseTrustedProxies("caddy")).toThrow(/CROSSCHECK_TRUSTED_PROXIES: "caddy" is not an IP address or CIDR/);
    expect(() => parseTrustedProxies("10.0.0.0/33")).toThrow(/has a prefix outside 0-32/);
    expect(() => parseTrustedProxies("10.0.0.0/x")).toThrow(/has a prefix outside 0-32/);
    expect(() => parseTrustedProxies("10.0.0.0/8/8")).toThrow(/is not an IP address or CIDR/);
  });
});

describe("the login cookie's Secure flag believes X-Forwarded-Proto only from a trusted peer", () => {
  test("from a LAN peer that talks to the hub directly, the header is ignored", async () => {
    expect(await loginCookieVia({ peerAddress: LAN_PEER })).not.toContain("; Secure");
  });

  test("from an unknown peer, the header is ignored", async () => {
    expect(await loginCookieVia({ peerAddress: null })).not.toContain("; Secure");
  });

  test("from loopback, where tailscale serve connects, the header counts", async () => {
    expect(await loginCookieVia({ peerAddress: "127.0.0.1" })).toContain("; Secure");
  });

  test("from a listed proxy, the Docker kit's Caddy, the header counts", async () => {
    expect(await loginCookieVia({ peerAddress: CADDY_PEER, trustedProxies: "172.18.0.0/16" })).toContain("; Secure");
  });
});
