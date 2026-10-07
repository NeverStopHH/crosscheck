/**
 * A LOCALHOST PASSKEY CEREMONY IS OFF ON A HUB PEOPLE REACH REMOTELY
 * (routes/ui-ceremony.ts, review H6).
 *
 * Behind `tailscale serve`, every request reaches the hub from loopback, so
 * "a localhost origin only from a loopback peer" admitted a remote agent: it
 * asks for a ceremony at RP ID `localhost` through the ts.net name, serves
 * its own page at its own machine's localhost, and the person's prompt says
 * only "localhost". So when any https origin is configured, or the request
 * came through a trusted proxy, a localhost or loopback-IP origin is refused
 * for every action, options and verify alike.
 */
import { describe, expect, test } from "bun:test";

import { mintEnrolmentCode } from "../src/services/passkeys.ts";
import { TEST_WEBAUTHN_ORIGIN, createTestDeveloper, createTestHarness } from "./helpers.ts";
import type { TestHarnessOptions } from "./helpers.ts";
import { ceremony, errorCodeOf, viewerOf } from "./fixtures/ceremony-driver.ts";

const HTTPS_ORIGIN = "https://hub.example.ts.net";
const LOOPBACK_IP_ORIGIN = "http://127.0.0.1:7100";
const TAILNET_CLIENT = "100.101.4.7";
const EXPIRES_AT = "2026-07-26T09:00:00.000Z";

/** One schema-valid body per ceremony action: the origin is refused before any of them is looked up. */
const EVERY_ACTION: readonly Record<string, unknown>[] = [
  { action: "enrol", code: "AAAA-AAAA-AAAA-AAAA", label: "MacBook" },
  { action: "authorise_enrolment" },
  { action: "approve", subjectId: "wr_any", expiresAt: EXPIRES_AT, reason: "rollout" },
  { action: "amend", subjectId: "fw_any", expiresAt: EXPIRES_AT, reason: "rollout" },
  { action: "revoke_waiver", subjectId: "fw_any", reason: "rollout" },
  { action: "revoke_passkey", subjectId: "pk_any" },
];

/** What verify needs on top of the fields to get past its own validation. */
const ANSWER = { ceremonyId: "cer_any", response: { id: "cred_any", response: {} } };

const signedIn = async (options: TestHarnessOptions) => {
  const harness = await createTestHarness(options);
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  return { harness, nick, viewer: await viewerOf(harness, nick) };
};

/** The refusal codes every action meets at `origin` with `headers`, options then verify. */
const refusalsAt = async (
  options: TestHarnessOptions,
  origin: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<readonly string[]> => {
  const { harness, viewer } = await signedIn(options);
  const codes: string[] = [];
  for (const fields of EVERY_ACTION) {
    codes.push(await errorCodeOf(await ceremony(harness, viewer, "options", fields, { origin, headers })));
    codes.push(
      await errorCodeOf(await ceremony(harness, viewer, "verify", { ...fields, ...ANSWER }, { origin, headers })),
    );
  }
  return codes;
};

const everyOne = (code: string): readonly string[] => EVERY_ACTION.flatMap(() => [code, code]);

describe("a hub with an https origin takes no passkey at localhost", () => {
  test("every ceremony at localhost is refused, options and verify alike, from a loopback peer", async () => {
    const codes = await refusalsAt({ webauthnOrigins: [TEST_WEBAUTHN_ORIGIN, HTTPS_ORIGIN] }, TEST_WEBAUTHN_ORIGIN);

    expect(codes).toEqual(everyOne("localhost_origin_off"));
  });

  test("a loopback-IP origin is refused the same way", async () => {
    const codes = await refusalsAt({ webauthnOrigins: [TEST_WEBAUTHN_ORIGIN, HTTPS_ORIGIN] }, LOOPBACK_IP_ORIGIN);

    expect(codes).toEqual(everyOne("localhost_origin_off"));
  });

  test("the https origin itself still runs a ceremony", async () => {
    // Arrange
    const { harness, nick, viewer } = await signedIn({ webauthnOrigins: [TEST_WEBAUTHN_ORIGIN, HTTPS_ORIGIN] });
    const { code } = await mintEnrolmentCode({
      db: harness.db,
      developerId: nick.developerId,
      source: "admin",
      now: harness.clock.now(),
    });

    // Act
    const response = await ceremony(
      harness,
      viewer,
      "options",
      { action: "enrol", code, label: "MacBook" },
      { origin: HTTPS_ORIGIN, headers: { "X-Forwarded-For": TAILNET_CLIENT, "X-Forwarded-Proto": "https" } },
    );

    // Assert
    expect(response.status).toBe(200);
  });
});

describe("a request through a trusted proxy takes no passkey at localhost", () => {
  test("tailscale serve's X-Forwarded-For from loopback refuses localhost, with no https origin configured", async () => {
    const codes = await refusalsAt({}, TEST_WEBAUTHN_ORIGIN, { "X-Forwarded-For": TAILNET_CLIENT });

    expect(codes).toEqual(everyOne("localhost_origin_off"));
  });

  test("a listed proxy's forwarded request is refused the same way", async () => {
    const codes = await refusalsAt(
      { peerAddress: "172.18.0.5", trustedProxies: "172.18.0.0/16" },
      TEST_WEBAUTHN_ORIGIN,
      { "X-Forwarded-For": TAILNET_CLIENT },
    );

    expect(codes).toEqual(everyOne("localhost_origin_off"));
  });

  test("a forwarded header from a peer nobody listed changes nothing: the loopback rule decides", async () => {
    const codes = await refusalsAt({ peerAddress: "192.168.1.20" }, TEST_WEBAUTHN_ORIGIN, {
      "X-Forwarded-For": "127.0.0.1",
    });

    expect(codes).toEqual(everyOne("origin_not_local"));
  });
});

describe("the hub's own browser keeps localhost where nothing else reaches the hub", () => {
  test("no https origin and no proxy: a localhost enrolment ceremony still starts", async () => {
    // Arrange
    const { harness, nick, viewer } = await signedIn({});
    const { code } = await mintEnrolmentCode({
      db: harness.db,
      developerId: nick.developerId,
      source: "admin",
      now: harness.clock.now(),
    });

    // Act
    const response = await ceremony(harness, viewer, "options", { action: "enrol", code, label: "MacBook" });

    // Assert
    expect(response.status).toBe(200);
  });
});
