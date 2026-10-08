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

/** POST /ui/login with a valid key and `forwarded` headers (an `X-Forwarded-Proto: https` unless given), as `options` sees the peer. */
const loginCookieVia = async (
  options: TestHarnessOptions,
  forwarded: Readonly<Record<string, string>> = { "X-Forwarded-Proto": "https" },
): Promise<string | null> => {
  const harness = await createTestHarness(options);
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  const response = await harness.app.request("/ui/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...forwarded,
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

  test("a CIDR that trusts every peer, or every IPv4 peer, stops the hub at startup (review L3)", () => {
    for (const entry of ["0.0.0.0/0", "::/0", "::ffff:0:0/96", "::ffff:0.0.0.0/96", "::ffff:0:0/80"]) {
      expect(() => parseTrustedProxies(entry)).toThrow(/trusts every peer \(or every IPv4 peer\)/);
    }
    // A mapped block narrower than every IPv4 is a network like any other.
    expect(parseTrustedProxies("::ffff:172.18.0.0/112").includes("172.18.0.5")).toBe(true);
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

  test("from loopback as a dual-stack socket spells it, ::ffff:127.0.0.1, the header counts (review X3)", async () => {
    expect(await loginCookieVia({ peerAddress: "::ffff:127.0.0.1" })).toContain("; Secure");
  });
});

describe("an RFC 7239-only proxy's Forwarded: proto= counts the same way (review L6)", () => {
  test("bare or quoted proto=https from loopback marks the cookie Secure", async () => {
    expect(await loginCookieVia({ peerAddress: "127.0.0.1" }, { Forwarded: "for=100.101.4.7;proto=https" })).toContain(
      "; Secure",
    );
    expect(
      await loginCookieVia({ peerAddress: "127.0.0.1" }, { Forwarded: 'for="[fd7a::7]";proto="HTTPS";host=hub' }),
    ).toContain("; Secure");
  });

  test("only the first element speaks for the browser, and proto=http stays plain", async () => {
    expect(
      await loginCookieVia({ peerAddress: "127.0.0.1" }, { Forwarded: "for=100.101.4.7;proto=http, for=10.0.0.1;proto=https" }),
    ).not.toContain("; Secure");
  });

  test("from a LAN peer nobody listed, Forwarded is ignored like X-Forwarded-Proto", async () => {
    expect(await loginCookieVia({ peerAddress: LAN_PEER }, { Forwarded: "proto=https" })).not.toContain("; Secure");
  });
});
