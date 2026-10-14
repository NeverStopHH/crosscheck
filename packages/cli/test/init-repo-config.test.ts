/**
 * `crosscheck init` and the TEAM's `.crosscheck.json`: init owns two fields
 * of it — `hubUrl` and `protocol` — and nothing else. Every other field
 * (`authoritativeGenerated`, `landingBranches`, `landingFetch`, whatever a
 * later release adds) is the team's, so a re-run merges onto the file in
 * place, keeps its key order, and leaves it byte for byte when it already
 * says what init would write: the git diff shows only real changes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { PROTOCOL_VERSION } from "@crosscheck/schema";
import { renderRepoConfig } from "@crosscheck/connector-core/config/repo-config.ts";
import { runCli } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const HUB_URL = "https://hub.example.com";
const INIT = ["init", "--command-prefix", "crosscheck"] as const;

/** The team's own fields, as a repo would commit them. */
const TEAM_FIELDS = {
  authoritativeGenerated: ["api/openapi.json", "migrations/**", "clients/**"],
  landingBranches: ["staging", "release"],
  landingFetch: false,
  futureField: { nested: [1, "two", null], flag: true },
} as const;

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const fixture = async (): Promise<{
  readonly repo: string;
  readonly env: Env;
  readonly configPath: string;
  /** The same file as init names it: under the repo's resolved root. */
  readonly shownPath: string;
}> => {
  const repo = await makeRepo("init-repo-config", { remote: "git@github.com:acme/api.git" });
  const home = await makeHome("init-repo-config");
  paths.push(repo, home);
  return {
    repo,
    // HOME too, so the user-level wiring init reads is this fixture's, never
    // the machine's.
    env: { HOME: home, CROSSCHECK_HOME: home, CROSSCHECK_HUB_URL: HUB_URL, CROSSCHECK_API_KEY: "test-key" },
    configPath: join(repo, ".crosscheck.json"),
    shownPath: join(await realpath(repo), ".crosscheck.json"),
  };
};

describe("crosscheck init keeps the team's .crosscheck.json", () => {
  test("running init twice over a file with extra fields leaves it byte for byte", async () => {
    // Arrange: hand-formatted, the team's fields around init's own two, and
    // init's two already saying what init would write.
    const { repo, env, configPath, shownPath } = await fixture();
    const committed =
      `{ "authoritativeGenerated": ${JSON.stringify(TEAM_FIELDS.authoritativeGenerated)},\n` +
      `  "hubUrl": "${HUB_URL}", "landingBranches": ["staging", "release"],\n` +
      `  "protocol": "${PROTOCOL_VERSION}", "landingFetch": false,\n` +
      `  "futureField": ${JSON.stringify(TEAM_FIELDS.futureField)} }\n`;
    await writeFile(configPath, committed, "utf8");

    // Act
    const first = await runCli([...INIT], env, repo);
    const afterFirst = await readFile(configPath, "utf8");
    const second = await runCli([...INIT], env, repo);

    // Assert
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(afterFirst).toBe(committed);
    expect(await readFile(configPath, "utf8")).toBe(committed);
    expect(second.stdout).toContain(`kept ${shownPath} (it already connects this repo to ${HUB_URL})`);
  });

  test("a new hub changes only hubUrl and protocol, each in its place, and a second run changes nothing", async () => {
    // Arrange: an older hub, no protocol yet, the team's fields on both sides.
    const { repo, env, configPath, shownPath } = await fixture();
    const { authoritativeGenerated, landingBranches, landingFetch, futureField } = TEAM_FIELDS;
    await writeFile(
      configPath,
      `${JSON.stringify({ landingBranches, hubUrl: "https://old-hub.example.com", authoritativeGenerated, landingFetch, futureField }, null, 2)}\n`,
      "utf8",
    );

    // Act
    const first = await runCli([...INIT], env, repo);
    const afterFirst = await readFile(configPath, "utf8");
    const second = await runCli([...INIT], env, repo);

    // Assert: every team field survives, the order holds, protocol is added
    // last, and the re-run is a no-op.
    expect(first.exitCode).toBe(0);
    const written = JSON.parse(afterFirst) as Record<string, unknown>;
    expect(Object.keys(written)).toEqual([
      "landingBranches",
      "hubUrl",
      "authoritativeGenerated",
      "landingFetch",
      "futureField",
      "protocol",
    ]);
    expect(written).toEqual({ ...TEAM_FIELDS, hubUrl: HUB_URL, protocol: PROTOCOL_VERSION });
    expect(first.stdout).toContain(`wrote ${shownPath}\n`);
    expect(second.exitCode).toBe(0);
    expect(await readFile(configPath, "utf8")).toBe(afterFirst);
  });

  test("a hub url spelled differently that names the same hub is not rewritten", async () => {
    // Arrange: a trailing slash normalizes to the hub init resolved.
    const { repo, env, configPath } = await fixture();
    const committed = `${JSON.stringify({ hubUrl: `${HUB_URL}/`, protocol: PROTOCOL_VERSION, ...TEAM_FIELDS }, null, 2)}\n`;
    await writeFile(configPath, committed, "utf8");

    // Act
    const result = await runCli([...INIT], env, repo);

    // Assert
    expect(result.exitCode).toBe(0);
    expect(await readFile(configPath, "utf8")).toBe(committed);
  });

  test("a fresh repo gets exactly the file it always got", async () => {
    // Arrange
    const { repo, env, configPath } = await fixture();

    // Act
    const result = await runCli([...INIT], env, repo);

    // Assert
    expect(result.exitCode).toBe(0);
    expect(await readFile(configPath, "utf8")).toBe(renderRepoConfig(HUB_URL));
  });

  test.each([
    ["is not valid json", '{ "hubUrl": "https://hub.example.com", "landingBranches": ['],
    ["is not a json object", '["https://hub.example.com"]\n'],
  ])(
    "a .crosscheck.json that %s stops init before anything is written",
    async (clause, committed) => {
      // Arrange: a file init cannot merge onto must not be overwritten — that
      // would delete the team's fields along with the broken bytes.
      const { repo, env, configPath, shownPath } = await fixture();
      await writeFile(configPath, committed, "utf8");
      await mkdir(join(repo, ".claude"), { recursive: true });

      // Act
      const result = await runCli([...INIT], env, repo);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(`${shownPath} ${clause} — nothing was changed`);
      expect(await readFile(configPath, "utf8")).toBe(committed);
      expect(await Bun.file(join(repo, ".claude", "settings.json")).exists()).toBe(false);
      expect(await Bun.file(join(repo, ".mcp.json")).exists()).toBe(false);
    },
  );
});
