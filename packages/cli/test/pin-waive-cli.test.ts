/**
 * `crosscheck pin --waive` end to end (1.0 spec 04a §6): a REAL hub, a REAL
 * git repository, the command driven through `runCli`.
 *
 * THE INVERSE OF EVERY OTHER `pin` TEST. Pinning, retracting and confirming
 * need a person at a terminal; asking for a waiver deliberately does NOT —
 * an agent blocked by a protected conflict is exactly who should ask, and it
 * can only ask: the fence stays closed until a person approves with a passkey
 * at the page the command names.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";
import { EXIT_FAIL, EXIT_OK, EXIT_USAGE } from "@crosscheck/connector-core/constants.ts";

import { runCli } from "../src/index.ts";
import { git, makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";

const ADMIN_TOKEN = "pin-waive-admin";
const PINNED = "src/auth/refresh.ts";

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let home: string;
let repo: string;
let nickKey: string;
let pinId: string;

const runAs = (argv: readonly string[], interactive: boolean) =>
  runCli(
    [...argv],
    {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: nickKey,
      CROSSCHECK_TIMEOUT_MS: "4000",
    },
    repo,
    undefined,
    { isInteractive: () => interactive },
  );

const requestsOnHub = async (): Promise<{ status: string; reason: string }[]> => {
  const response = await fetch(`${hubUrl}/api/waiver-requests`, {
    headers: { Authorization: `Bearer ${nickKey}` },
  });
  return ((await response.json()) as { data: { requests: { status: string; reason: string }[] } })
    .data.requests;
};

beforeAll(async () => {
  db = await createDb();
  server = Bun.serve({ port: 0, fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  home = await makeHome("pin-waive");
  repo = await makeRepo("pin-waive", { remote: "git@github.com:acme/api.git" });
  await writeRepoFile(repo, PINNED, "export const refresh = 1;\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "refresh"]);
  const created = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Nick", email: "nick-pin-waive@example.com" }),
  });
  nickKey = ((await created.json()) as { data: { apiKey: string } }).data.apiKey;
  const pinned = await runAs(
    ["pin", "the refresh path keeps working", "--files", PINNED, "--check", "bun test src/auth"],
    true,
  );
  const match = /pinned (pin_[\w-]+):/.exec(pinned.stdout);
  if (match?.[1] === undefined) {
    throw new Error(`no pin id in: ${pinned.stdout}`);
  }
  pinId = match[1];
});

afterAll(async () => {
  server.stop(true);
  await rm(home, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

describe("crosscheck pin --waive — asking, not opening", () => {
  test("an agent (no terminal) may ask; the answer says the fence stays closed and where a person approves", async () => {
    // Act
    const result = await runAs(
      ["pin", "--waive", pinId, "--expires", "2d", "--reason", "Rollout is blocked; the fix lands Monday"],
      false,
    );

    // Assert
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("requested");
    expect(result.stdout).toContain("stays closed");
    expect(result.stdout).toContain(`${hubUrl}/ui/waivers`);
    expect(await requestsOnHub()).toEqual([
      expect.objectContaining({ status: "pending", reason: "Rollout is blocked; the fix lands Monday" }),
    ]);
  });

  test("pin list shows the request waiting for a person", async () => {
    // Act
    const result = await runAs(["pin", "list"], false);

    // Assert
    expect(result.stdout).toContain("waiver requested by Nick");
    expect(result.stdout).toContain("waiting for a person");
  });

  test("a second ask while one is pending is refused with the hub's sentence", async () => {
    // Act
    const result = await runAs(
      ["pin", "--waive", pinId, "--expires", "1d", "--reason", "asking again"],
      false,
    );

    // Assert
    expect(result.exitCode).toBe(EXIT_FAIL);
    expect(result.stdout).toContain("already waiting for a person");
  });

  test("no reason is a usage error — a waiver without a reason is a permission nobody can account for", async () => {
    // Act
    const result = await runAs(["pin", "--waive", pinId, "--expires", "1d"], false);

    // Assert
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stdout).toContain("--reason");
  });

  test("an --expires that is not a date or a number of hours or days is a usage error", async () => {
    // Act
    const result = await runAs(
      ["pin", "--waive", pinId, "--expires", "next tuesday", "--reason", "x"],
      false,
    );

    // Assert
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stdout).toContain("--expires");
  });

  test("a pin this repo does not have is named as such", async () => {
    // Act
    const result = await runAs(
      ["pin", "--waive", "pin_nothing", "--expires", "1d", "--reason", "x"],
      false,
    );

    // Assert
    expect(result.exitCode).toBe(EXIT_FAIL);
    expect(result.stdout).toContain("no pin pin_nothing on this repo");
  });
});
