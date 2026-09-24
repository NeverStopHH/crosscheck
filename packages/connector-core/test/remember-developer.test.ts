/**
 * LEARNED IDENTITY IS WRITTEN ONTO THE CONFIG AS IT IS NOW, NOT AS IT WAS.
 *
 * A SessionStart hook loads the config, talks to the hub, then writes back
 * the developer id and name it learned (config.ts rememberDeveloper). A
 * `crosscheck key rotate` inside that window saves a new key and kills the
 * old one — and writing back the snapshot the hook started with would put
 * the dead key back into the config, locking this machine out without a
 * word: hooks fail silent, and the new key was never printed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { loadConfig, readStoredConfig, rememberDeveloper, saveConfig } from "../src/config/config.ts";
import { makeHome } from "./helpers.ts";

const HUB_URL = "https://hub.example";
const OLD_KEY = "a".repeat(64);
const NEW_KEY = "b".repeat(64);

const cleanups: string[] = [];

afterAll(async () => {
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

describe("rememberDeveloper", () => {
  test("keeps a key that was saved after the config was loaded", async () => {
    // Arrange — the hook has read the config, still holding the old key
    const home = await makeHome("remember-developer");
    cleanups.push(home);
    await saveConfig(home, { version: 1, hubUrl: HUB_URL, apiKey: OLD_KEY });
    const loaded = await loadConfig({ env: { CROSSCHECK_HOME: home, HOME: home } });
    if (loaded === null) {
      throw new Error("the stored config did not load");
    }

    // Act — a rotation lands in between, then the hook writes what it learned
    await saveConfig(home, { version: 1, hubUrl: HUB_URL, apiKey: NEW_KEY });
    await rememberDeveloper(loaded, "dev_nick", "Nick");

    // Assert — the new key survives, and the identity is still learned
    const stored = await readStoredConfig(home);
    expect(stored?.apiKey).toBe(NEW_KEY);
    expect(stored?.developerId).toBe("dev_nick");
    expect(stored?.developerName).toBe("Nick");
  });
});
