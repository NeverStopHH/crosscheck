/**
 * The persistence rule for a login-measured timeout, as pure decisions.
 *
 * THE RULE, in one sentence: login rewrites only values it measured itself —
 * a timeoutMs carrying timeoutSource "measured" — and never touches an
 * explicit CROSSCHECK_TIMEOUT_MS or a stored value a human set by hand, so
 * the existing precedence (env > stored > default, config.ts resolveTimeoutMs)
 * is never overwritten silently.
 */
import { describe, expect, test } from "bun:test";

import { HTTP_TIMEOUT_MS } from "../src/constants.ts";
import { MEASURED_TIMEOUT_SOURCE } from "../src/config/config.ts";
import type { Config } from "../src/config/config.ts";
import {
  decideTimeoutUpdate,
  timeoutOwner,
  withTimeoutDecision,
} from "../src/config/timeout-policy.ts";

const BASE_CONFIG: Config = {
  version: 1,
  hubUrl: "https://hub.example.com",
  apiKey: "test-key",
};

const RAISED_MS = 2_200;

describe("timeoutOwner", () => {
  test("an explicit CROSSCHECK_TIMEOUT_MS owns the timeout over everything stored", () => {
    expect(
      timeoutOwner(
        { CROSSCHECK_TIMEOUT_MS: "3000" },
        { ...BASE_CONFIG, timeoutMs: RAISED_MS, timeoutSource: MEASURED_TIMEOUT_SOURCE },
      ),
    ).toBe("env");
  });

  test("an unparseable env value falls through, exactly like resolveTimeoutMs", () => {
    expect(timeoutOwner({ CROSSCHECK_TIMEOUT_MS: "soon" }, null)).toBe("none");
    expect(timeoutOwner({ CROSSCHECK_TIMEOUT_MS: "-5" }, null)).toBe("none");
  });

  test("a stored value is login's own only when it carries the measured marker", () => {
    expect(
      timeoutOwner({}, { ...BASE_CONFIG, timeoutMs: RAISED_MS, timeoutSource: MEASURED_TIMEOUT_SOURCE }),
    ).toBe("login");
    expect(timeoutOwner({}, { ...BASE_CONFIG, timeoutMs: RAISED_MS })).toBe("manual");
  });

  test("nothing set anywhere is nobody's", () => {
    expect(timeoutOwner({}, null)).toBe("none");
    expect(timeoutOwner({}, BASE_CONFIG)).toBe("none");
  });
});

describe("decideTimeoutUpdate", () => {
  test("stores a raised recommendation when nobody set a timeout", () => {
    expect(decideTimeoutUpdate("none", RAISED_MS)).toEqual({
      kind: "store",
      timeoutMs: RAISED_MS,
    });
  });

  test("refreshes a value login itself measured on an earlier run", () => {
    expect(decideTimeoutUpdate("login", RAISED_MS)).toEqual({
      kind: "store",
      timeoutMs: RAISED_MS,
    });
  });

  test("never overwrites an explicit env or hand-set stored value", () => {
    // Assert: the no-silent-overwrite rule — both owners keep their value even
    // when the measurement disagrees with it.
    expect(decideTimeoutUpdate("env", RAISED_MS)).toEqual({ kind: "keep" });
    expect(decideTimeoutUpdate("manual", RAISED_MS)).toEqual({ kind: "keep" });
  });

  test("resets its own stale value when the hub is close again", () => {
    // Arrange: the teammate moved back onto the LAN; the recommendation clamps
    // to the default. A recommendation AT the default is not "exceeds" —
    // nothing may be stored, and login's old value must not linger.
    expect(decideTimeoutUpdate("login", HTTP_TIMEOUT_MS)).toEqual({ kind: "reset" });
    expect(decideTimeoutUpdate("none", HTTP_TIMEOUT_MS)).toEqual({ kind: "reset" });
  });
});

describe("withTimeoutDecision", () => {
  test("store writes the value plus the measured marker", () => {
    const next = withTimeoutDecision(BASE_CONFIG, {
      kind: "store",
      timeoutMs: RAISED_MS,
    });

    expect(next.timeoutMs).toBe(RAISED_MS);
    expect(next.timeoutSource).toBe(MEASURED_TIMEOUT_SOURCE);
  });

  test("reset removes login's own fields entirely, not sets them to the default", () => {
    // Arrange: a number equal to the default stored in the file would still
    // LOOK hand-set to the next reader; absence is the honest state.
    const next = withTimeoutDecision(
      { ...BASE_CONFIG, timeoutMs: RAISED_MS, timeoutSource: MEASURED_TIMEOUT_SOURCE },
      { kind: "reset" },
    );

    expect("timeoutMs" in next).toBe(false);
    expect("timeoutSource" in next).toBe(false);
  });

  test("keep returns the config untouched and never mutates its input", () => {
    const base: Config = { ...BASE_CONFIG, timeoutMs: 9_000 };

    const kept = withTimeoutDecision(base, { kind: "keep" });
    const stored = withTimeoutDecision(base, { kind: "store", timeoutMs: RAISED_MS });

    expect(kept).toEqual(base);
    // The store built a NEW object; the caller's copy still says 9000.
    expect(stored.timeoutMs).toBe(RAISED_MS);
    expect(base.timeoutMs).toBe(9_000);
    expect("timeoutSource" in base).toBe(false);
  });
});
