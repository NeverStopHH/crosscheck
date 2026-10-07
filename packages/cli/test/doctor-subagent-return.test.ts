/**
 * DOCTOR'S SUBAGENT-RETURN LINE, ROUND TWO (review of feat/collision-visible,
 * round 2, L8 and L9). Doctor vouched for the hook by its NAME alone, so an
 * entry registered async — whose `systemMessage` nobody sees — or matched on
 * tools no subagent returns through read as installed; and it FAILed every
 * install from before the hook existed, though capture works without it.
 * Now a drifted entry is named for what is wrong with it, and the missing or
 * drifted hook is a WARN with the command that fixes it, in either scope.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runCli } from "../src/index.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

/** Unreachable on purpose: the wiring checks run whether the hub answers. */
const HUB_URL = "http://127.0.0.1:9";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

interface HookGroup {
  matcher?: string;
  hooks: { command: string; async?: boolean }[];
}

interface Settings {
  hooks: Record<string, HookGroup[]>;
}

const doctorEnv = (home: string): Record<string, string> => ({
  HOME: home,
  CROSSCHECK_HOME: join(home, ".crosscheck"),
  CROSSCHECK_HUB_URL: HUB_URL,
  CROSSCHECK_API_KEY: "test-key",
});

const isSubagentReturn = (group: HookGroup): boolean =>
  group.hooks.some((hook) => hook.command.endsWith("hook subagent-return"));

/** The hooks line of a doctor run. */
const hooksLineOf = (stdout: string): string =>
  stdout.split("\n").find((line) => /\b(?:PASS|WARN|FAIL) +hooks registered /.test(line)) ?? "";

/** `init` in a fresh repo, then the subagent-return group of its settings rewritten by `change`. */
const projectInstall = async (
  slug: string,
  change: (group: HookGroup) => HookGroup,
): Promise<{ readonly repo: string; readonly env: Record<string, string> }> => {
  const home = await makeHome(slug);
  const repo = await makeRepo(slug, { remote: "git@github.com:acme/api.git" });
  paths.push(home, repo);
  const env = doctorEnv(home);
  expect((await runCli(["init", "--command-prefix", "crosscheck"], env, repo)).exitCode).toBe(0);
  const settingsPath = join(repo, ".claude", "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Settings;
  settings.hooks["PostToolUse"] = (settings.hooks["PostToolUse"] ?? []).map((group) =>
    isSubagentReturn(group) ? change(group) : group,
  );
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  return { repo, env };
};

describe("a subagent-return entry is checked for how it is registered, not only that it is (round 2, L8)", () => {
  test("registered async, it does not count, and the hooks line says why", async () => {
    // Arrange
    const { repo, env } = await projectInstall("dsr-async", (group) => ({
      ...group,
      hooks: group.hooks.map((hook) => ({ ...hook, async: true })),
    }));

    // Act
    const hooksLine = hooksLineOf((await runCli(["doctor"], env, repo)).stdout);

    // Assert
    expect(hooksLine).toContain("WARN");
    expect(hooksLine).toContain("missing: PostToolUse (subagent-return)");
    expect(hooksLine).toContain("found PostToolUse (subagent-return) registered async");
    expect(hooksLine).toContain("rerun crosscheck init");
  });

  test("matched on tools no subagent returns through, it does not count either", async () => {
    // Arrange
    const { repo, env } = await projectInstall("dsr-matcher", (group) => ({ ...group, matcher: "Edit" }));

    // Act
    const hooksLine = hooksLineOf((await runCli(["doctor"], env, repo)).stdout);

    // Assert
    expect(hooksLine).toContain("WARN");
    expect(hooksLine).toContain("found PostToolUse (subagent-return) matched on Edit");
  });

  test("registered as init writes it, the hooks line passes", async () => {
    // Arrange
    const { repo, env } = await projectInstall("dsr-exact", (group) => group);

    // Act
    const hooksLine = hooksLineOf((await runCli(["doctor"], env, repo)).stdout);

    // Assert
    expect(hooksLine).toContain("PASS");
    expect(hooksLine).toContain("PostToolUse (subagent-return)");
  });
});

describe("a missing subagent-return hook is a WARN with its fix in user scope too (round 2, L9)", () => {
  test("a global install from before the hook is warned to re-run init --global", async () => {
    // Arrange: a global install, then its subagent-return group dropped
    const home = await makeHome("dsr-global");
    const repo = await makeRepo("dsr-global", { remote: "git@github.com:acme/api.git" });
    paths.push(home, repo);
    const env = doctorEnv(home);
    expect((await runCli(["init", "--global", "--command-prefix", "crosscheck"], env, "/")).exitCode).toBe(0);
    const settingsPath = join(home, ".claude", "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Settings;
    settings.hooks["PostToolUse"] = (settings.hooks["PostToolUse"] ?? []).filter((group) => !isSubagentReturn(group));
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");

    // Act
    const hooksLine = hooksLineOf((await runCli(["doctor"], env, repo)).stdout);

    // Assert
    expect(hooksLine).toContain("WARN");
    expect(hooksLine).not.toContain("FAIL");
    expect(hooksLine).toContain("missing: PostToolUse (subagent-return)");
    expect(hooksLine).toContain("rerun crosscheck init --global");
  });

  test("a capture hook missing beside it is still a FAIL", async () => {
    // Arrange: drop the subagent-return hook AND PostToolUseFailure
    const { repo, env } = await projectInstall("dsr-both", (group) => ({ ...group, hooks: [] }));
    const settingsPath = join(repo, ".claude", "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Settings;
    delete settings.hooks["PostToolUseFailure"];
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");

    // Act
    const hooksLine = hooksLineOf((await runCli(["doctor"], env, repo)).stdout);

    // Assert
    expect(hooksLine).toContain("FAIL");
    expect(hooksLine).toContain("PostToolUseFailure");
  });
});
