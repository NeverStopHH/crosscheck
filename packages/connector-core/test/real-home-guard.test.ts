/**
 * NO TEST RESOLVES THE REAL USER'S HOME (integration review of batch 2, track
 * A). A test that passed an empty env resolved the developer's own
 * `~/.crosscheck` — and, through the legacy key binding, wrote it. Two layers
 * now stand in the way:
 *
 *   - the shared preload (test/network-guard.ts) writes the real home down
 *     and points HOME, CROSSCHECK_HOME and XDG_* at a temp directory of this
 *     process's own, before any module reads them, and every child inherits it;
 *   - the src home resolvers (config/paths.ts crosscheckHome, userHomeOf)
 *     throw in a test process whenever a path would still land on the real
 *     home or one of its guarded entries.
 *
 * Paths only: nothing here, and nothing in the guard, stats or opens any path
 * under the real home.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TEST_REAL_HOME_ENV, crosscheckHome, refuseRealHome, userHomeOf } from "../src/config/paths.ts";

/** A real home that does not exist: the guard must decide on the path alone. */
const ABSENT_REAL_HOME = "/cx-absent-real-home/someone";

const recorded = process.env[TEST_REAL_HOME_ENV];
afterEach(() => {
  process.env[TEST_REAL_HOME_ENV] = recorded;
});

const realHome = (): string => {
  if (recorded === undefined || recorded === "") {
    throw new Error("the preload recorded no real home for this run");
  }
  return recorded;
};

const isTemp = (path: string | undefined): boolean =>
  path !== undefined && [tmpdir(), "/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"].some((root) => path.startsWith(root));

describe("the preload gives every test process a home of its own (review batch 2, track A)", () => {
  test("it wrote the real home down and pointed HOME, CROSSCHECK_HOME and XDG_* at temp directories", () => {
    // Act + Assert
    expect(isTemp(realHome())).toBe(false);
    expect(isTemp(process.env["HOME"])).toBe(true);
    expect(isTemp(process.env["CROSSCHECK_HOME"])).toBe(true);
    for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
      expect(isTemp(process.env[key])).toBe(true);
    }
  });

  test("a child handed the real HOME starts on a temp one, and keeps the record", async () => {
    // Arrange: a test that spawns with the real HOME spelled out in its env
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", `console.log(JSON.stringify({ home: process.env.HOME, real: process.env.${TEST_REAL_HOME_ENV} }))`],
      env: { ...process.env, HOME: realHome() },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Act
    const seen = JSON.parse(await new Response(child.stdout).text()) as { home?: string; real?: string };
    await child.exited;

    // Assert
    expect(isTemp(seen.home)).toBe(true);
    expect(seen.real).toBe(realHome());
  });
});

describe("a home resolver that would land on the real home throws (review batch 2, track A)", () => {
  test("crosscheckHome refuses the real ~/.crosscheck and its kin", () => {
    // Act + Assert
    expect(() => crosscheckHome({ CROSSCHECK_HOME: join(realHome(), ".crosscheck") })).toThrow("test home guard");
    expect(() => crosscheckHome({ CROSSCHECK_HOME: join(realHome(), ".crosscheck-hub") })).toThrow("test home guard");
  });

  test("userHomeOf refuses the real home, and the user-level wiring under it", () => {
    // Act + Assert
    expect(() => userHomeOf({ HOME: realHome() })).toThrow("test home guard");
    expect(() => refuseRealHome(join(realHome(), ".claude", "settings.json"))).toThrow("test home guard");
  });

  test("with no home of its own, a test resolves the temp one the preload set", () => {
    // Act + Assert: what the empty-env test that wrote ~/.crosscheck now gets
    expect(crosscheckHome({})).toBe(join(process.env["HOME"] ?? "", ".crosscheck"));
    expect(userHomeOf({})).toBe(process.env["HOME"] ?? "");
  });

  test("it decides on the path alone: a real home that does not exist is refused all the same", () => {
    // Arrange
    process.env[TEST_REAL_HOME_ENV] = ABSENT_REAL_HOME;

    // Act + Assert
    expect(() => crosscheckHome({ CROSSCHECK_HOME: `${ABSENT_REAL_HOME}/.crosscheck` })).toThrow("test home guard");
    expect(refuseRealHome(`${ABSENT_REAL_HOME}/worktrees/repo`)).toBe(`${ABSENT_REAL_HOME}/worktrees/repo`);
  });

  test("outside a test process — no record — every path passes unchanged", () => {
    // Arrange
    delete process.env[TEST_REAL_HOME_ENV];

    // Act + Assert
    expect(crosscheckHome({ CROSSCHECK_HOME: `${ABSENT_REAL_HOME}/.crosscheck` })).toBe(`${ABSENT_REAL_HOME}/.crosscheck`);
  });
});
