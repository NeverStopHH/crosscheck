/**
 * Where the crosscheck home is (config/paths.ts crosscheckHome).
 *
 * Review 2026-10-06 (L6): `CROSSCHECK_HOME=""` is not nullish, so it came
 * back as the home itself — and every path under it (state/, spool/,
 * config.json, and the temp sweep's deletions) resolved relative to the
 * directory the hook ran in, which is the developer's repo. These are pure
 * resolutions: nothing here reads or writes any home, real or temporary.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { crosscheckHome } from "../src/config/paths.ts";

/**
 * `~/.crosscheck` of this process's HOME — a temp home the test preload set
 * (test/network-guard.ts), never the developer's real one, which no test
 * may resolve (test/real-home-guard.test.ts).
 */
const DEFAULT_HOME = join(process.env["HOME"] ?? "", ".crosscheck");

describe("crosscheckHome", () => {
  test("a set CROSSCHECK_HOME is used exactly as given", () => {
    // Arrange
    const env = { CROSSCHECK_HOME: "/tmp/cx-somewhere" };

    // Act + Assert
    expect(crosscheckHome(env)).toBe("/tmp/cx-somewhere");
  });

  test("an unset CROSSCHECK_HOME is ~/.crosscheck", () => {
    // Act + Assert
    expect(crosscheckHome({})).toBe(DEFAULT_HOME);
  });

  test("an EMPTY CROSSCHECK_HOME is unset, not the current directory", () => {
    // Act + Assert
    expect(crosscheckHome({ CROSSCHECK_HOME: "" })).toBe(DEFAULT_HOME);
  });

  test("a whitespace-only CROSSCHECK_HOME is unset too", () => {
    // Act + Assert
    expect(crosscheckHome({ CROSSCHECK_HOME: " \t " })).toBe(DEFAULT_HOME);
  });
});
