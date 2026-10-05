/**
 * loss-accounting §10 item 4 (Nick, 2026-10-02): `crosscheck pin` refuses a
 * file no capture can observe.
 *
 * A file the capture denylist excludes is never recorded, so a pin over it is
 * a permanent attribution blind spot: `crosscheck trace` can never name who
 * touched it. The door refuses it by name, with the rule that excludes it.
 * The rules are the EFFECTIVE denylist this machine's capture applies — the
 * shipped defaults, extended or replaced by `denylist` in the stored config —
 * plus the shipped defaults themselves: the denylist is per-machine config, so
 * a teammate who kept the shipped list never records a touch this machine's
 * replacement would. A sweep never moves a pin onto such a path either.
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
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import { PIN_PRESENCE_TERMINAL } from "@crosscheck/schema";

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
const SECOND_FROM = "src/core/renderer.ts";
const SECOND_TO = "src/generated/renderer.ts";
/** The reason for a file this machine AND every machine on the shipped list skip. */
const WHY = "no session here, nor on any machine that keeps the shipped denylist, records touching them";
/** The reason for a file only this machine's own rule skips. */
const WHY_HERE = "this machine's own denylist skips them; teammates who kept the shipped denylist record them";
const HERE_ONLY = "on this machine only";
const CONFIG_REMEDY = "or change the denylist in the crosscheck config";
const SHIPPED_NOTE = "on crosscheck's shipped default list";
/** How a rule is named when this machine records the file and the shipped list does not. */
const ELSEWHERE = "on machines that keep the shipped denylist";
const WHY_ELSEWHERE = "this machine records touching them, but no machine that keeps the shipped denylist does";

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
  for (const path of [PLAIN, GENERATED, LOCKFILE, LEGACY, MOVED_FROM, SECOND_FROM]) {
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

    // Assert: named as this machine's rule alone, and never as unrecorded by
    // everyone — a teammate on the shipped list does record the file
    expect(refused.exitCode).toBe(EXIT_USAGE);
    expect(refused.stdout).toContain(`${LEGACY} (excluded by ${LEGACY_RULE} ${HERE_ONLY})`);
    expect(refused.stdout).toContain(`${LEGACY}: ${WHY_HERE}`);
    expect(refused.stdout).not.toContain(WHY);
    expect(await pinCount()).toBe(before);
  });

  test("a refusal over files of different reach gives each its own reason, naming the files", async () => {
    // Arrange: the lockfile is skipped here and on the shipped list, the
    // legacy file only by this machine's own extend line
    const home = await homeWith("mixed-reach", { mode: "extend", patterns: [LEGACY_RULE] });

    // Act
    const refused = await pin(home, [LOCKFILE, LEGACY]);

    // Assert: two reason lines, each about its own file, never one sentence
    // that is false of the other
    expect(refused.stdout).toContain(`${LOCKFILE}: ${WHY}`);
    expect(refused.stdout).toContain(`${LEGACY}: ${WHY_HERE}`);
    expect(refused.stdout).not.toContain(`${LOCKFILE}, ${LEGACY}: `);
  });

  test("a rule only this machine's config adds keeps the config remedy", async () => {
    // Arrange
    const home = await homeWith("extend-remedy", { mode: "extend", patterns: [LEGACY_RULE] });

    // Act
    const refused = await pin(home, [LEGACY]);

    // Assert
    expect(refused.stdout).toContain(CONFIG_REMEDY);
    expect(refused.stdout).not.toContain(SHIPPED_NOTE);
  });

  test("a config that replaces the shipped denylist still cannot pin a file the shipped list excludes", async () => {
    // Arrange: capture HERE records every touch of the generated client, but
    // the denylist is per-machine config — every teammate who kept the
    // shipped list never records one, so the pin would be blind on their side
    const home = await homeWith("replace", { mode: "replace", patterns: [] });
    const before = await pinCount();

    // Act
    const refused = await pin(home, [GENERATED]);

    // Assert: refused by the shipped rule, named as the rule of OTHER
    // machines — this one records the file — and no config remedy is
    // offered, because no config on this machine changes what teammates capture
    expect(refused.exitCode).toBe(EXIT_USAGE);
    expect(refused.stdout).toContain(`${GENERATED} (excluded by ${GENERATED_RULE} ${ELSEWHERE})`);
    expect(refused.stdout).toContain(WHY_ELSEWHERE);
    expect(refused.stdout).not.toContain(WHY);
    expect(refused.stdout).toContain(SHIPPED_NOTE);
    expect(refused.stdout).not.toContain(CONFIG_REMEDY);
    expect(await pinCount()).toBe(before);
  });

  test("a local rule that a shipped rule backs up offers no config remedy", async () => {
    // Arrange: this machine's own rule names the lockfile, and so does the
    // shipped list — dropping the local rule would change capture here and
    // the pin would still be refused
    // (spelled differently from the shipped `package-lock.json`, so only a
    // MATCH against the shipped list can tell — never string equality)
    const localRule = "**/package-lock.json";
    const home = await homeWith("replace-backed", { mode: "replace", patterns: [localRule] });

    // Act
    const refused = await pin(home, [LOCKFILE]);

    // Assert
    expect(refused.exitCode).toBe(EXIT_USAGE);
    expect(refused.stdout).toContain(`${LOCKFILE} (excluded by ${localRule})`);
    expect(refused.stdout).toContain(WHY);
    expect(refused.stdout).toContain(SHIPPED_NOTE);
    expect(refused.stdout).not.toContain(CONFIG_REMEDY);
  });

  test("status names a pinned file the shipped list excludes even when this machine replaced it", async () => {
    // Arrange: a pin registered before the door existed — straight through
    // the hub, the only way one can exist now
    const home = await homeWith("replace-status", { mode: "replace", patterns: [] });
    const identity = await resolveRepoIdentity(repo);
    const created = await fetch(`${hubUrl}/api/pins`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: `pin_${crypto.randomUUID()}`,
        repo: identity?.repoId,
        surface: "Legacy client guard",
        files: [GENERATED],
        check: "run the build",
        presence: PIN_PRESENCE_TERMINAL,
        verifiedAtCommit: identity?.baseCommit,
      }),
    });
    expect(created.ok).toBe(true);

    // Act
    const status = await run(home, ["status"]);

    // Assert: named as blind on the machines that keep the shipped list —
    // never as blind for everyone, since this machine records it
    expect(status.stdout).toContain(`pinned file(s) are never captured ${ELSEWHERE}`);
    expect(status.stdout).toContain(`${GENERATED} (${GENERATED_RULE})`);
    expect(status.stdout).not.toContain("no matter who did");

    // And doctor asks the same list, so the two never disagree
    const doctor = await run(home, ["doctor"]);
    expect(doctor.stdout).toContain("WARN  pin denylist");
    expect(doctor.stdout).toContain(`${GENERATED} (${GENERATED_RULE})`);
    expect(doctor.stdout).toContain(ELSEWHERE);
    expect(doctor.stdout).not.toContain("no matter who did");
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

  test("a rename into a path only the shipped list excludes is missing on a machine that replaced it too", async () => {
    // Arrange
    const home = await homeWith("sweep-replace", { mode: "replace", patterns: [] });
    const created = await pin(home, [SECOND_FROM]);
    expect(created.stdout).toContain("pinned pin_");
    await git(repo, ["mv", SECOND_FROM, SECOND_TO]);
    await git(repo, ["commit", "-m", "generate the renderer"]);

    // Act
    const swept = await run(home, ["pin", "--sweep"]);

    // Assert
    expect(swept.stdout).toContain(
      `${SECOND_FROM} moved to ${SECOND_TO} (excluded by ${GENERATED_RULE} ${ELSEWHERE})`,
    );
    expect(swept.stdout).toContain("recorded as missing");
    expect(swept.stdout).toContain(WHY_ELSEWHERE);
  });
});
