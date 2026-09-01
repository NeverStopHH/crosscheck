import { describe, expect, test } from "bun:test";

import { containsSecret } from "../src/index.ts";

describe("containsSecret", () => {
  test("detects one sample of every guarded pattern", () => {
    // Arrange
    const positives = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "xoxb-1234567890-abcdefghij",
      "sk-ant-api03-abcdefghijklmnop",
      "AIzaSyA1234567890abcdefghijklmnopqrstuvw",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP",
      "postgresql://svc:hunter2hunter2@db.internal:5432/app",
      "api_key: A1b2C3d4E5f6G7h8I9j0",
    ];

    // Act & Assert
    for (const sample of positives) {
      expect(containsSecret(sample)).toBe(true);
    }
  });

  test("costs no more on an adversarial near-miss than on plain prose", () => {
    // Arrange: two patterns backtrack quadratically on repeated near-miss
    // prefixes. The JWT branch needs a dot after `eyJ` and never finds one in
    // "eyJeyJeyJ…", so it rescanned to the end from EVERY start position; the
    // database-URL branch does the same through its unanchored `[^\s@]+@`
    // tail. At the old 400-character body cap that was invisible. At
    // MAX_CLAIM_BODY_LENGTH it measured 17 ms for one call — about 540 times
    // the 400-char cost for 25 times the length — against 0.05 ms for
    // ordinary prose of the same size.
    //
    // ASSERTED AS A RATIO, not as milliseconds: absolute timings differ per
    // host and per load and would pin nothing, but "an attacker-shaped string
    // costs about what prose costs" is the property, and it survives a slow
    // machine. The bound is loose enough for a noisy CI box and still two
    // orders of magnitude under the defect.
    const size = 10_000;
    const fill = (unit: string): string =>
      unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
    const prose = fill("the rotation job overruns its window ");
    const jwtNearMiss = fill("eyJ");
    const dbUrlNearMiss = fill("postgres://a:b");
    const p50 = (sample: string): number => {
      for (let index = 0; index < 5; index++) {
        containsSecret(sample);
      }
      const runs = Array.from({ length: 20 }, () => {
        const started = Bun.nanoseconds();
        containsSecret(sample);
        return Bun.nanoseconds() - started;
      }).sort((left, right) => left - right);
      return runs[10] ?? 0;
    };

    // Act
    const baseline = Math.max(p50(prose), 1);
    const jwtRatio = p50(jwtNearMiss) / baseline;
    const dbUrlRatio = p50(dbUrlNearMiss) / baseline;

    // Assert: and none of the three is a secret, so the cost is pure
    // backtracking rather than an early exit on a hit.
    expect(containsSecret(prose)).toBe(false);
    expect(containsSecret(jwtNearMiss)).toBe(false);
    expect(containsSecret(dbUrlNearMiss)).toBe(false);
    expect(jwtRatio).toBeLessThan(20);
    expect(dbUrlRatio).toBeLessThan(20);
  });

  test("leaves ordinary paths and stack traces alone", () => {
    // Arrange
    const negatives = [
      "src/auth/token.ts",
      "packages/api/src/modules/agents/openclaw-config.service.ts",
      "TypeError: cannot read property 'sub' of undefined",
      "at verifyToken (/app/src/auth/verify.ts:88:3)",
      "secret sauce",
      "",
    ];

    // Act & Assert
    for (const sample of negatives) {
      expect(containsSecret(sample)).toBe(false);
    }
  });
});
