/**
 * The number-preservation guard behind §2.3 rule 1's injection exception:
 * the two write points re-serialize ONE message from a parse, and that
 * re-serialization must be VALUE-preserving. JSON.parse reads every number
 * as a double, so a raw token past 2^53 (a JVM/Rust JSON-RPC stack's 64-bit
 * request id) silently ROUNDS — the agent then answers under an id the
 * client never sent and the session hangs on the one path that edits bytes.
 *
 * VERIFY: bun -e 'console.log(JSON.stringify(JSON.parse("{\"id\":9007199254740993}")))'
 * PRINTS: {"id":9007199254740992}
 *
 * The guard is a raw-text scan (json-guard.ts): value-LOSSY tokens (rounded
 * integers, magnitudes past double range) flag the line so the injector
 * skips it; value-preserving RESPELLINGS (`1.0` → `1`, `1e2` → `100`) do
 * not — every JSON consumer reading doubles receives the identical value,
 * and blocking on spelling would turn injection off for whole client
 * classes (Python's json spells floats `1.0`).
 */
import { describe, expect, test } from "bun:test";

import { hasLossyNumberToken } from "../src/inject/json-guard.ts";

describe("value-lossy tokens are flagged", () => {
  test("an integer id past 2^53 rounds under JSON.parse — flagged", () => {
    // Arrange: 9007199254740993 = 2^53 + 1, the first unrepresentable int.
    const raw = '{"jsonrpc":"2.0","id":9007199254740993,"method":"session/new"}';

    // Act + Assert
    expect(hasLossyNumberToken(raw)).toBe(true);
  });

  test("a negative integer past -(2^53) is flagged too", () => {
    expect(hasLossyNumberToken('{"id":-9007199254740993}')).toBe(true);
  });

  test("a 21-digit params value is flagged wherever it sits", () => {
    expect(
      hasLossyNumberToken('{"params":{"big":123456789012345678901}}'),
    ).toBe(true);
  });

  test("a magnitude past double range parses to Infinity — flagged", () => {
    // JSON.stringify(Infinity) is "null": not rounding but full replacement.
    expect(hasLossyNumberToken('{"x":1e400}')).toBe(true);
    expect(hasLossyNumberToken(`{"x":1${"0".repeat(400)}}`)).toBe(true);
  });
});

describe("value-preserving tokens pass", () => {
  test("safe integers of any spelling pass", () => {
    expect(hasLossyNumberToken('{"id":1,"n":-42,"z":0}')).toBe(false);
    // 15 digits is always exact; 2^53 itself is exact at 16.
    expect(hasLossyNumberToken('{"id":999999999999999}')).toBe(false);
    expect(hasLossyNumberToken('{"id":9007199254740992}')).toBe(false);
  });

  test("float respellings are value-preserving — not flagged", () => {
    // 1.0 → 1 and 1e2 → 100 change spelling, never the double value.
    expect(hasLossyNumberToken('{"f":1.0,"e":1e2,"tenth":0.1,"neg":-0}')).toBe(
      false,
    );
  });

  test("numbers INSIDE strings are data, not tokens — never flagged", () => {
    expect(
      hasLossyNumberToken('{"text":"my id is 9007199254740993, quoted"}'),
    ).toBe(false);
  });

  test("an escaped quote does not derail the string tracking", () => {
    // The \" stays inside the string; the number after the string is real.
    expect(
      hasLossyNumberToken('{"a":"he said \\" and left","n":9007199254740993}'),
    ).toBe(true);
    // A trailing backslash-escape pair closes cleanly; the safe int passes.
    expect(hasLossyNumberToken('{"a":"x\\\\","n":1}')).toBe(false);
  });
});
