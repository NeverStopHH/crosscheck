/**
 * loss-accounting §10 item 4 (Nick, 2026-10-02): `crosscheck pin` refuses a
 * file no capture can observe.
 *
 * A file the capture denylist excludes is never recorded, so a pin over it is
 * a permanent attribution blind spot: `crosscheck trace` can never name who
 * touched it. The door refuses it by name, with the rule that excludes it,
 * and the rule is the EFFECTIVE denylist this machine's capture applies — the
 * shipped defaults, extended or replaced by `denylist` in the stored config —
 * never a second copy. A sweep never moves a pin onto such a path either.
 *
 * A REAL hub over PGlite, a REAL git repository, the commands through
 * `runCli`, so the sentences asserted are the ones a person reads.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createDb, createServer } from "@crosscheck/server";
import { sql } from "drizzle-orm";
import type { Db } from "@crosscheck/server";
import { EXIT_USAGE } from "@crosscheck/connector-core/constants.ts";

import { runCli } from "../src/index.ts";
import { git, makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";

const ADMIN_TOKEN = "pin-denylist-admin";
const PLAIN = "src/workbench/usePlayback.ts";
/** Excluded by the shipped `**\/generated/**`. */
const GENERATED = "src/generated/client.ts";
const GENERATED_RULE = "**/generated/**";
/** Excluded by the shipped `package-lock.json`. */
const LOCKFILE = "package-lock.json";
/** Excluded only by the developer's own `extend` line below. */
const LEGACY = "src/legacy/old.ts";
const LEGACY_RULE = "**/legacy/**";
const MOVED_FROM = "src/core/engine.ts";
const MOVED_TO = "src/generated/engine.ts";
const WHY = "no session's touch of these files is ever recorded, so a guard over them could never say who broke them";

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let repo: string;
let apiKey: string;
const homes: string[] = [];

const createDeveloper = async (): Promise<string> => {
  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Nick", email: "nick-pin-denylist@example.com" }),
  });
  const body = (await response.json()) as { data: { apiKey: string } };
  return body.data.apiKey;
};

/** A crosscheck home whose stored config carries `denylist`, or none at all. */
const homeWith = async (label: string, denylist?: { mode: "extend" | "replace"; patterns: string[] }): Promise<string> => {
  const home = await makeHome(label);
  homes.push(home);
  if (denylist !== undefined) {
    await writeFile(
      join(home, "config.json"),
      `${JSON.stringify({ version: 1, hubUrl, apiKey, denylist })}\n`,
    );
  }
  return home;
};

const run = (home: string, argv: readonly string[]): Promise<{ stdout: string; exitCode: number }> =>
  runCli(
    [...argv],
    {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: apiKey,
      CROSSCHECK_TIMEOUT_MS: "4000",
    },
    repo,
    undefined,
    { isInteractive: () => true },
  );

const pin = (home: string, files: readonly string[]): Promise<{ stdout: string; exitCode: number }> =>
  run(home, ["pin", "Client still builds", "--files", ...files, "--check", "run the build"]);

const pinCount = async (): Promise<number> => {
  const rows = await db.execute(sql`SELECT count(*)::int AS n FROM pins`);
  return Number((rows.rows[0] as { n: number }).n);
};

beforeAll(async () => {
  db = await createDb();
  server = Bun.serve({ port: 0, fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  repo = await makeRepo("pin-denylist", { remote: "git@github.com:acme/api.git" });
  for (const path of [PLAIN, GENERATED, LOCKFILE, LEGACY, MOVED_FROM]) {
    await writeRepoFile(repo, path, "export const x = 1;\n");
  }
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "files"]);
  apiKey = await createDeveloper();
});

afterAll(async () => {
  server.stop(true);
  await Promise.all([repo, ...homes].map((path) => rm(path, { recursive: true, force: true })));
});

describe("the pin door refuses a file no capture can observe (loss-accounting §10 item 4)", () => {
  test("a pin over a file the shipped denylist excludes is refused by name and rule, and nothing is pinned", async () => {
    // Arrange
    const home = await homeWith("shipped");
    const before = await pinCount();

    // Act
    const refused = await pin(home, [PLAIN, GENERATED]);

    // Assert
    expect(refused.exitCode).toBe(EXIT_USAGE);
    expect(refused.stdout).toContain("nothing was pinned");
    expect(refused.stdout).toContain(`${GENERATED} (excluded by ${GENERATED_RULE})`);
    expect(refused.stdout).not.toContain(`${PLAIN} (excluded`);
    expect(refused.stdout).toContain(WHY);
    expect(await pinCount()).toBe(before);
  });

  test("every excluded file is named with the rule that excludes it", async () => {
    // Arrange
    const home = await homeWith("two-rules");

    // Act
    const refused = await pin(home, [GENERATED, LOCKFILE]);

    // Assert
    expect(refused.stdout).toContain(`${GENERATED} (excluded by ${GENERATED_RULE})`);
    expect(refused.stdout).toContain(`${LOCKFILE} (excluded by ${LOCKFILE})`);
  });

  test("a rule the developer's own config adds refuses the pin too, as it stops capture on this machine", async () => {
    // Arrange
    const home = await homeWith("extend", { mode: "extend", patterns: [LEGACY_RULE] });
    const before = await pinCount();

    // Act
    const refused = await pin(home, [LEGACY]);

    // Assert
    expect(refused.exitCode).toBe(EXIT_USAGE);
    expect(refused.stdout).toContain(`${LEGACY} (excluded by ${LEGACY_RULE})`);
    expect(await pinCount()).toBe(before);
  });

  test("a config that replaces the shipped denylist lets the file be pinned, as capture records it", async () => {
    // Arrange: capture on this machine applies no rule at all, so it records
    // every touch of the generated client — the door asks the same list.
    const home = await homeWith("replace", { mode: "replace", patterns: [] });

    // Act
    const created = await pin(home, [GENERATED]);

    // Assert
    expect(created.stdout).toContain("pinned pin_");
  });
});

describe("a sweep never moves a pin onto a path no capture observes", () => {
  test("a rename into an excluded path is recorded as missing and named with its rule", async () => {
    // Arrange: a live pin, then the rename into generated output
    const home = await homeWith("sweep");
    const created = await pin(home, [MOVED_FROM]);
    expect(created.stdout).toContain("pinned pin_");
    await git(repo, ["mv", MOVED_FROM, MOVED_TO]);
    await git(repo, ["commit", "-m", "generate the engine"]);

    // Act
    const swept = await run(home, ["pin", "--sweep"]);
    const listed = await run(home, ["pin", "list"]);

    // Assert: the pin reads BROKEN instead of watching a file nobody records,
    // and the summary counts the move the way it was recorded
    expect(swept.stdout).toContain(`${MOVED_FROM} moved to ${MOVED_TO} (excluded by ${GENERATED_RULE})`);
    expect(swept.stdout).toContain("recorded as missing");
    expect(swept.stdout).toContain("0 renamed, 1 missing");
    expect(listed.stdout).not.toContain(MOVED_TO);
    expect(listed.stdout).toContain("BROKEN — 1 of 1 paths missing");
  });
});
