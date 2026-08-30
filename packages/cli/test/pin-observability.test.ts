/**
 * The regression guard's observability half (Stage 1, part C): what `status`
 * and `doctor` say about the registry, against a REAL hub over PGlite and a
 * REAL git repository, driven through `runCli`.
 *
 * Every assertion here is a failure that would otherwise be invisible, and
 * invisible is the one thing this feature may never be:
 *
 *   1. THE DENOMINATOR. "pins: 2" reads as protection. "pins: 2 (3 files …)
 *      — nothing else is watched" reads as what it is. Both the empty and the
 *      populated case are pinned, because a repo with no pins is the case
 *      where the sentence matters most.
 *   2. A RENAME ORPHANED A PIN. The pin still counts in the registry while
 *      watching a path git can no longer find — fail-silent-dead, so it is a
 *      WARN naming the remedy.
 *   3. THE DENYLIST SHADOWS A PINNED FILE. The hot-file denylist lives in
 *      ~/.crosscheck/config.json, outside every repo root; a denied path
 *      never becomes a target, so `suspect` answers "no session touched this
 *      surface" with total confidence. The suppression is a printed count and
 *      the pattern is named — the config is NOT made unwritable, because that
 *      would be a block.
 *   4. THE HUB DID NOT ANSWER. Coverage unknown is not coverage zero, and a
 *      PASS that means "could not check" is worse than no check at all.
 *   5. THE TEAM SETTINGS ARE PRINTED. `suspect` naming sessions is a decision
 *      about what this tool makes visible concerning people; everybody it is
 *      about must be able to read that it is on without reading the source.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";
import {
  configPath,
  ensureDir,
} from "@crosscheck/connector-core/config/paths.ts";

import { runCli } from "../src/index.ts";
import {
  git,
  makeHome,
  makeRepo,
  writeRepoFile,
} from "../../connector-core/test/helpers.ts";

const ADMIN_TOKEN = "pin-observability-admin";
const PINNED = "src/workbench/usePlayback.ts";
const SECOND = "src/workbench/PlaybackControls.tsx";
/** Port 1 refuses instantly: an unreachable hub without the wait. */
const DEAD_HUB_URL = "http://127.0.0.1:1";

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let home: string;
let repo: string;
let nickKey: string;

const createDeveloper = async (
  name: string,
  email: string,
): Promise<string> => {
  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, email }),
  });
  const body = (await response.json()) as { data: { apiKey: string } };
  return body.data.apiKey;
};

interface RunOptions {
  readonly hub?: string;
}

const runFor = (
  argv: readonly string[],
  options: RunOptions = {},
): Promise<{ stdout: string; exitCode: number }> =>
  runCli(
    [...argv],
    {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: options.hub ?? hubUrl,
      CROSSCHECK_API_KEY: nickKey,
      CROSSCHECK_TIMEOUT_MS: "4000",
    },
    repo,
    undefined,
    { isInteractive: () => true },
  );

/**
 * The denylist lives in ~/.crosscheck/config.json, which is exactly why it is
 * written here as a FILE rather than passed as an argument: the point of the
 * shadowing warning is that this file is edited where nothing watches. The
 * home is a mkdtemp directory, so no real config is ever touched.
 */
const writeDenylist = async (patterns: readonly string[]): Promise<void> => {
  await ensureDir(home);
  await writeFile(
    configPath(home),
    JSON.stringify({
      version: 1,
      hubUrl,
      apiKey: nickKey,
      denylist: { mode: "extend", patterns },
    }),
    "utf8",
  );
};

const pinIdFrom = (stdout: string): string => {
  const match = /pinned (pin_[\w-]+):/.exec(stdout);
  if (match?.[1] === undefined) {
    throw new Error(`no pin id in: ${stdout}`);
  }
  return match[1];
};

beforeAll(async () => {
  db = await createDb();
  server = Bun.serve({
    port: 0,
    fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch,
  });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  home = await makeHome("pin-observability");
  repo = await makeRepo("pin-observability", {
    remote: "git@github.com:acme/api.git",
  });
  await writeRepoFile(repo, PINNED, "export const play = 1;\n");
  await writeRepoFile(repo, SECOND, "export const Controls = 1;\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "workbench"]);
  nickKey = await createDeveloper("Nick", "nick-pinobs@example.com");
  await writeDenylist([]);
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(
    [home, repo].map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("crosscheck status: the coverage denominator", () => {
  test("says nothing is watched before anybody pins", async () => {
    // Act
    const result = await runFor(["status"]);

    // Assert: the empty case is the one that must not read as safety.
    expect(result.stdout).toContain(
      "pins: 0 — nothing in this repo is watched",
    );
  });

  test("prints the team's guard settings beside the coverage", async () => {
    // Act
    const result = await runFor(["status"]);

    // Assert: everybody the feature is ABOUT can read what it does.
    expect(result.stdout).toContain("guard settings: anyone may pin");
    expect(result.stdout).toContain(
      "suspect names sessions and their declared intents",
    );
    expect(result.stdout).toContain("shipped defaults");
  });

  test("carries the file count, the oldest age and its own limit", async () => {
    // Arrange
    const created = await runFor([
      "pin",
      "Play button plays/pauses",
      "--files",
      PINNED,
      SECOND,
      "--check",
      "open /workbench, press Play",
    ]);
    expect(created.stdout).toContain("pinned pin_");

    // Act
    const result = await runFor(["status"]);

    // Assert
    expect(result.stdout).toContain("pins: 1 (2 files, oldest verified");
    expect(result.stdout).toContain("— nothing else is watched");
  });
});

describe("crosscheck doctor: the pin checks", () => {
  test("reports coverage as a PASS carrying the denominator", async () => {
    // Act
    const result = await runFor(["doctor"]);

    // Assert
    expect(result.stdout).toContain("PASS  pins");
    expect(result.stdout).toContain("— nothing else is watched");
  });

  test("WARNs, names the pattern and says what the shadow costs", async () => {
    // Arrange: one line in a file no repo hook ever sees.
    await writeDenylist(["**/workbench/**"]);

    // Act
    const result = await runFor(["doctor"]);

    // Assert: the count, the path, the pattern AND the consequence.
    expect(result.stdout).toContain("WARN  pin denylist");
    expect(result.stdout).toContain("2 pinned file(s) are never captured");
    expect(result.stdout).toContain(PINNED);
    expect(result.stdout).toContain("**/workbench/**");
    expect(result.stdout).toContain("no session touched this surface");

    // Cleanup: the remaining tests are about other failures.
    await writeDenylist([]);
  });

  test("passes the shadow check when nothing is shadowed, with the pattern count", async () => {
    // Act
    const result = await runFor(["doctor"]);

    // Assert: a PASS that states the denominator of its own check.
    expect(result.stdout).toContain("PASS  pin denylist");
    expect(result.stdout).toMatch(
      /no pinned file is shadowed by the \d+ effective hot-file pattern/,
    );
  });

  test("WARNs when a rename orphaned a pin, and names the remedy", async () => {
    // Arrange: the weekly rename, then the sweep that records what git found.
    const created = await runFor([
      "pin",
      "Controls render",
      "--files",
      SECOND,
      "--check",
      "open /workbench, look at the controls",
    ]);
    const pinId = pinIdFrom(created.stdout);
    await git(repo, ["rm", "-q", SECOND]);
    await git(repo, ["commit", "-m", "drop the controls"]);
    await runFor(["pin", "--sweep"]);

    // Act
    const result = await runFor(["doctor"]);

    // Assert: a pin that watches nothing must never read as a pin that works.
    expect(result.stdout).toContain("WARN  pins");
    expect(result.stdout).toContain("BROKEN");
    expect(result.stdout).toContain("crosscheck pin --sweep");
    expect(pinId).toContain("pin_");
  });

  test("says coverage is UNKNOWN when the hub does not answer, never PASS", async () => {
    // Act
    const result = await runFor(["doctor"], { hub: DEAD_HUB_URL });

    // Assert: a green that means "could not check" is worse than no check.
    expect(result.stdout).toContain("WARN  pins");
    expect(result.stdout).toContain("coverage unknown");
    expect(result.stdout).not.toContain("PASS  pins");
  });
});
