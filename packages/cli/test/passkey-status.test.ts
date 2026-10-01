/**
 * PK-10's reader half (1.0 spec 04a §4.3): an enrolment is announced where a
 * person already looks — `crosscheck status` and `doctor` — with the developer,
 * the device name, the authenticator and when it can act, and the one action
 * that matters if it was not them.
 */
import { describe, expect, test } from "bun:test";

import type { PasskeyAnnouncements } from "@crosscheck/connector-core/http/hub.ts";

import {
  HUB_PREDATES_PASSKEYS,
  announcementAnswerOf,
  passkeyDoctorCheck,
  passkeyStatusLines,
} from "../src/cli/passkey-status.ts";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const HUB = "https://hub.tailnet.ts.net";

const enrolment = (over: Partial<PasskeyAnnouncements["enrolments"][number]> = {}) => ({
  passkeyId: "pk_1",
  developerName: "Ken",
  label: "MacBook",
  authenticator: "unknown authenticator",
  createdAt: "2026-09-30T10:00:00.000Z",
  usableFrom: "2026-10-01T10:00:00.000Z",
  coolingOff: true,
  revoked: false,
  ...over,
});

const view = (over: Partial<PasskeyAnnouncements> = {}): PasskeyAnnouncements => ({
  enrolments: [],
  usablePasskeys: 1,
  enrolmentsTotal: null,
  coolingOff: null,
  ...over,
});

describe("status lines", () => {
  test("a cooling-off enrolment names who, which device, which authenticator, when it can act, and how to stop it", () => {
    const lines = passkeyStatusLines(view({ enrolments: [enrolment()] }), HUB, NOW).join("\n");

    expect(lines).toContain("passkey enrolled for Ken");
    expect(lines).toContain("MacBook");
    expect(lines).toContain("unknown authenticator");
    expect(lines).toContain("can approve waivers from 2026-10-01T10:00:00.000Z");
    expect(lines).toContain(`not expected? revoke it at ${HUB}/ui/passkeys`);
  });

  test("an enrolment past its cool-off says it can approve now", () => {
    const lines = passkeyStatusLines(
      view({ enrolments: [enrolment({ coolingOff: false })] }),
      HUB,
      NOW,
    ).join("\n");

    expect(lines).toContain("can approve waivers now");
  });

  test("a revoked enrolment says it was revoked, so the person sees that it took", () => {
    const lines = passkeyStatusLines(
      view({ enrolments: [enrolment({ revoked: true })] }),
      HUB,
      NOW,
    ).join("\n");

    expect(lines).toContain("revoked");
    expect(lines).not.toContain("can approve");
  });

  test("a hub where no passkey can approve says so — a protected conflict cannot be waived there", () => {
    const lines = passkeyStatusLines(view({ usablePasskeys: 0 }), HUB, NOW).join("\n");

    expect(lines).toContain("no passkey on this hub can approve a waiver yet");
  });

  test("a hub that did not answer is unknown, never 'no enrolments'", () => {
    expect(passkeyStatusLines(null, HUB, NOW)).toEqual([
      "passkeys: unknown — the hub did not answer, so an enrolment would not show here",
    ]);
  });
});

describe("doctor check", () => {
  test("a cooling-off enrolment is a WARN that counts and points at status — doctor prints no names", () => {
    const check = passkeyDoctorCheck(view({ enrolments: [enrolment()] }), HUB);

    expect(check.level).toBe("WARN");
    expect(check.detail).toContain("1 passkey enrolment is still cooling off");
    expect(check.detail).toContain("crosscheck status");
    expect(check.detail).not.toContain("Ken");
  });

  test("nothing cooling off is a PASS with the count of passkeys that can approve", () => {
    const check = passkeyDoctorCheck(view({ usablePasskeys: 2 }), HUB);

    expect(check).toEqual({
      level: "PASS",
      name: "passkeys",
      detail: "2 can approve waivers on this hub; no enrolment is cooling off",
    });
  });

  test("an unanswered hub is a WARN — silence is not 'nothing enrolled'", () => {
    expect(passkeyDoctorCheck(null, HUB)).toEqual({
      level: "WARN",
      name: "passkeys",
      detail: "unknown — the hub did not answer, so an enrolment would not show here",
    });
  });

  test("the hub's own count decides, not the rows it listed", () => {
    // Arrange — the hub lists 20 rows at most; the 21st cooling enrolment
    // must still count.
    const check = passkeyDoctorCheck(view({ enrolments: [], coolingOff: 3, enrolmentsTotal: 25 }), HUB);

    // Assert
    expect(check.level).toBe("WARN");
    expect(check.detail).toContain("3 passkey enrolments are still cooling off");
  });

  test("a hub that predates passkeys has nothing to announce, and says how fences open there", () => {
    expect(passkeyDoctorCheck(HUB_PREDATES_PASSKEYS, HUB).level).toBe("PASS");
    expect(passkeyStatusLines(HUB_PREDATES_PASSKEYS, HUB, NOW).join("\n")).toContain(
      "this hub predates passkeys",
    );
  });

  test("the answer is read from the hub's reply: 404 predates, any other failure is unknown", () => {
    const failure = (status: number) =>
      ({ ok: false, kind: "http", status, code: "x", message: "x" }) as const;

    expect(announcementAnswerOf(failure(404))).toBe(HUB_PREDATES_PASSKEYS);
    expect(announcementAnswerOf(failure(500))).toBeNull();
  });
});

describe("a listing the hub cut short", () => {
  test("status says how many more enrolments there were", () => {
    const lines = passkeyStatusLines(
      view({ enrolments: [enrolment()], enrolmentsTotal: 26, coolingOff: 1 }),
      HUB,
      NOW,
    ).join("\n");

    expect(lines).toContain(`and 25 more enrolment(s) this week — all of them at ${HUB}/ui/passkeys`);
  });
});
