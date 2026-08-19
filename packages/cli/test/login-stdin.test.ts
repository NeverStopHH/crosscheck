import { describe, expect, test } from "bun:test";

import { LOGIN_STDIN_TIMEOUT_MS } from "@crosscheck/connector-core/constants.ts";
import { stdinSecretReader } from "../src/cli/login.ts";

/**
 * `crosscheck login <url>` is quickstart step 1, and any wrapper that hands it
 * an OPEN pipe stdin — npm lifecycle scripts, Makefiles, provisioning — used
 * to hang forever in Bun.stdin.text() with zero output. The reader must say
 * what it is waiting for and give up on its own.
 */
describe("login stdin reader", () => {
  const never = (): Promise<string> => new Promise<string>(() => {});

  test("returns null instead of hanging when a non-tty stdin never closes", async () => {
    // Arrange
    const reader = stdinSecretReader(
      50,
      never,
      () => false,
      () => {},
    );

    // Act
    const started = Date.now();
    const secret = await reader();

    // Assert: resolved by the timeout, not by the (never-ending) read
    expect(secret).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("says on stderr what it is waiting for before it blocks", async () => {
    // Arrange
    const warnings: string[] = [];
    const reader = stdinSecretReader(
      50,
      never,
      () => false,
      (line) => warnings.push(line),
    );

    // Act
    await reader();

    // Assert
    expect(warnings.join("")).toContain("api key");
    expect(warnings.join("")).toContain("stdin");
  });

  test("still reads a piped key that arrives and closes", async () => {
    // Arrange
    const reader = stdinSecretReader(
      5_000,
      () => Promise.resolve("  sk-123\n"),
      () => false,
      () => {},
    );

    // Act + Assert
    expect(await reader()).toBe("sk-123");
  });

  test("a tty yields null without reading — the usage text explains instead", async () => {
    // Arrange
    let didRead = false;
    const reader = stdinSecretReader(
      5_000,
      () => {
        didRead = true;
        return Promise.resolve("x");
      },
      () => true,
      () => {},
    );

    // Act + Assert
    expect(await reader()).toBeNull();
    expect(didRead).toBe(false);
  });

  test("the default timeout is generous enough for a slow pipe", () => {
    // A secret manager decrypting may take seconds; hooks-style millisecond
    // patience here would break legitimate `manager get key | crosscheck login`.
    expect(LOGIN_STDIN_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });
});
