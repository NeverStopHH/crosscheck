/**
 * One hand-typed word must not brick the whole stored config.
 *
 * timeoutSource is the first config field whose semantics the UX describes in
 * prose (doctor prints "set by hand" / "measured at login"), which invites
 * edits like `"timeoutSource": "manual"`. Under a strict literal parse that
 * one word made readStoredConfig return null: every hook silently fell back
 * to the 400 ms default (re-creating the incident the field exists to fix),
 * loadConfig returned null so CLI and MCP no-opped, and the next login saw
 * existing=null and rebuilt the file — dropping developerId, developerName,
 * denylist and any hand-set timeoutMs. The schema therefore accepts any
 * value there and lets timeout-policy.ts read everything but login's own
 * marker as "somebody's deliberate choice".
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { MEASURED_TIMEOUT_SOURCE, readStoredConfig } from "../src/config/config.ts";
import { timeoutOwner } from "../src/config/timeout-policy.ts";
import { makeHome } from "./helpers.ts";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const writeConfig = async (home: string, config: unknown): Promise<void> => {
  await writeFile(join(home, "config.json"), JSON.stringify(config), "utf8");
};

const BASE = {
  version: 1,
  hubUrl: "https://hub.example.com",
  apiKey: "test-key",
  developerId: "dev-1",
  timeoutMs: 2_200,
};

describe("readStoredConfig survives a hand-edited timeoutSource", () => {
  test('treats "manual" as a hand-set value instead of rejecting the file', async () => {
    // Arrange: the plausible edit — the field's own semantics are "absent
    // means hand-set", and nothing in the file says so
    const home = await makeHome("config-parse-manual");
    paths.push(home);
    await writeConfig(home, { ...BASE, timeoutSource: "manual" });

    // Act
    const stored = await readStoredConfig(home);

    // Assert: the file parses, every other field survives, and anything but
    // login's own marker reads as somebody's deliberate choice
    expect(stored).not.toBeNull();
    expect(stored?.timeoutMs).toBe(2_200);
    expect(stored?.developerId).toBe("dev-1");
    expect(timeoutOwner({}, stored)).toBe("manual");
  });

  test("drops a non-string timeoutSource instead of rejecting the file", async () => {
    // Arrange
    const home = await makeHome("config-parse-junk");
    paths.push(home);
    await writeConfig(home, { ...BASE, timeoutSource: 5 });

    // Act
    const stored = await readStoredConfig(home);

    // Assert: the junk value degrades to absence — hand-set — not to a
    // rejected config
    expect(stored).not.toBeNull();
    expect(stored?.timeoutSource).toBeUndefined();
    expect(timeoutOwner({}, stored)).toBe("manual");
  });

  test("still recognises login's own marker exactly", async () => {
    // Arrange
    const home = await makeHome("config-parse-measured");
    paths.push(home);
    await writeConfig(home, { ...BASE, timeoutSource: MEASURED_TIMEOUT_SOURCE });

    // Act
    const stored = await readStoredConfig(home);

    // Assert
    expect(stored?.timeoutSource).toBe(MEASURED_TIMEOUT_SOURCE);
    expect(timeoutOwner({}, stored)).toBe("login");
  });
});
