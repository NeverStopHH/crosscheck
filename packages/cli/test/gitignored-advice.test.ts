/**
 * Advice that respects the repo's .gitignore (trial finding M11).
 *
 * Three surfaces told developers to rely on files their repo throws away.
 * `init` printed "commit .mcp.json so teammates get the mcp tools on git
 * pull"; `doctor` said "teammates get the tools from a committed …/.mcp.json";
 * and the double-wiring WARN recommended `crosscheck init --global --remove`.
 * In the monorepo the trial ran in, `git check-ignore -v` puts `.mcp.json` at
 * `.gitignore:5` and `.claude/*` at `:13` — so the first two are impossible
 * and the third is actively harmful: removing the global install there leaves
 * a project install nobody else can ever receive, which is the state
 * incidents #9 and #11 were about.
 *
 * A REAL git repo with a REAL .gitignore, so real `git check-ignore` decides.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runCli } from "../src/index.ts";
import { runDoctor } from "../src/cli/doctor.ts";
import { isPathIgnored } from "@crosscheck/connector-core/git/check-ignore.ts";
import { git, makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

/** Unreachable on purpose: none of these lines needs a hub. */
const HUB_URL = "http://127.0.0.1:9";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

const OWNED_HOOKS = {
  hooks: Object.fromEntries(
    [
      "SessionStart",
      "PostToolUse",
      "SessionEnd",
      "UserPromptSubmit",
      "PreToolUse",
      "Stop",
    ].map((event) => [
      event,
      [{ hooks: [{ type: "command", command: `crosscheck hook ${event}` }] }],
    ]),
  ),
};

const OWNED_MCP = {
  mcpServers: {
    crosscheck: { type: "stdio", command: "crosscheck", args: ["mcp"] },
  },
};

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly env: Record<string, string>;
}

/**
 * A repo wired project-scoped, a machine wired globally, and — when
 * `ignoreProjectFiles` — a committed .gitignore that swallows both project
 * files. That is the double-wiring shape the WARN fires on.
 */
const fixture = async (ignoreProjectFiles: boolean): Promise<Fixture> => {
  const repo = await makeRepo("gitignored-advice", {
    remote: "git@github.com:acme/api.git",
  });
  const home = await makeHome("gitignored-advice");
  paths.push(repo, home);
  if (ignoreProjectFiles) {
    await writeFile(join(repo, ".gitignore"), ".mcp.json\n.claude/\n", "utf8");
    await git(repo, ["add", ".gitignore"]);
    await git(repo, ["commit", "-m", "ignore local tooling"]);
  }
  await mkdir(join(repo, ".claude"), { recursive: true });
  await writeFile(
    join(repo, ".claude", "settings.json"),
    `${JSON.stringify(OWNED_HOOKS, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(repo, ".mcp.json"),
    `${JSON.stringify(OWNED_MCP, null, 2)}\n`,
    "utf8",
  );
  // The user-level install, which is what makes it DOUBLE wiring.
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(
    join(home, ".claude", "settings.json"),
    `${JSON.stringify(OWNED_HOOKS, null, 2)}\n`,
    "utf8",
  );
  return {
    repo,
    home,
    env: {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: HUB_URL,
      CROSSCHECK_API_KEY: "test-key",
    },
  };
};

describe("isPathIgnored", () => {
  test("answers true, false and null for the three states", async () => {
    // Arrange
    const ignored = await fixture(true);
    const plain = await fixture(false);
    const notARepo = await makeHome("gitignored-advice-not-a-repo");
    paths.push(notARepo);

    // Act + Assert
    expect(await isPathIgnored(ignored.repo, ".mcp.json")).toBe(true);
    expect(await isPathIgnored(plain.repo, ".mcp.json")).toBe(false);
    // git cannot answer outside a work tree — and null must never be read as
    // "not ignored", which is why it is its own value.
    expect(await isPathIgnored(notARepo, ".mcp.json")).toBeNull();
  });
});

describe("doctor's advice under a .gitignore", () => {
  test("the double-wiring remedy never says --remove when the project copy is ignored", async () => {
    // Arrange
    const { repo, env } = await fixture(true);

    // Act
    const result = await runDoctor(env, repo, async () => null);

    // Assert
    expect(result.stdout).toContain("WARN  global install");
    expect(result.stdout).toContain("keep the global install");
    expect(result.stdout).not.toContain("crosscheck init --global --remove");
  });

  test("without a .gitignore the original remedy stands", async () => {
    // Arrange
    const { repo, env } = await fixture(false);

    // Act
    const result = await runDoctor(env, repo, async () => null);

    // Assert
    expect(result.stdout).toContain("crosscheck init --global --remove");
    expect(result.stdout).not.toContain("keep the global install");
  });

  test("a gitignored .mcp.json turns the registration PASS into a WARN", async () => {
    // Arrange
    const { repo, env } = await fixture(true);

    // Act
    const result = await runDoctor(env, repo, async () => null);

    // Assert
    expect(result.stdout).toContain("WARN  mcp tools registered");
    expect(result.stdout).toContain("gitignored");
    expect(result.stdout).toContain("crosscheck init --global");
  });
});

describe("init's advice under a .gitignore", () => {
  test("tells the truth instead of 'commit .mcp.json'", async () => {
    // Arrange: a repo whose .gitignore swallows both project files
    const repo = await makeRepo("gitignored-init", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("gitignored-init");
    paths.push(repo, home);
    await writeFile(join(repo, ".gitignore"), ".mcp.json\n.claude/\n", "utf8");
    await git(repo, ["add", ".gitignore"]);
    await git(repo, ["commit", "-m", "ignore local tooling"]);

    // Act
    const result = await runCli(
      ["init", "--command-prefix", "crosscheck"],
      {
        CROSSCHECK_HOME: home,
        HOME: home,
        CROSSCHECK_HUB_URL: HUB_URL,
        CROSSCHECK_API_KEY: "test-key",
      },
      repo,
    );

    // Assert
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("is gitignored in this repo");
    expect(result.stdout).not.toContain(
      "so teammates get the mcp tools on git pull",
    );
  });

  test("a repo that commits them keeps the original line", async () => {
    // Arrange
    const repo = await makeRepo("gitignored-init-plain", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("gitignored-init-plain");
    paths.push(repo, home);

    // Act
    const result = await runCli(
      ["init", "--command-prefix", "crosscheck"],
      {
        CROSSCHECK_HOME: home,
        HOME: home,
        CROSSCHECK_HUB_URL: HUB_URL,
        CROSSCHECK_API_KEY: "test-key",
      },
      repo,
    );

    // Assert
    expect(result.stdout).toContain("so teammates get the mcp tools on git pull");
  });
});
