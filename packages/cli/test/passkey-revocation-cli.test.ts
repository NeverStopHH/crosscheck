/**
 * 04a D-PK-1 end to end: an admin revokes the passkey that approved an open
 * waiver, and `crosscheck pin list` and `crosscheck status` say the fence was
 * closed because that passkey was revoked — a REAL hub over PGlite, the
 * commands through `runCli`, so the field names on the wire and the sentences
 * a person reads are the ones under test.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";
import { sql } from "drizzle-orm";

import { runCli } from "../src/index.ts";
import { git, makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";

const ADMIN_TOKEN = "passkey-revocation-admin";
const REPO_ID = "github.com/acme/api";
const PINNED = "src/auth/refresh.ts";
const HOUR = 3_600_000;

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let home: string;
let repo: string;
let nickKey: string;
let nickId: string;

const run = (argv: readonly string[]): Promise<{ stdout: string; exitCode: number }> =>
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
    { isInteractive: () => true },
  );

/** A usable passkey and a live grant it signed, written as the approval would leave them. */
const seedApprovedWaiver = async (pinId: string): Promise<string> => {
  const now = Date.now();
  await db.execute(sql`
    INSERT INTO passkeys (id, developer_id, credential_id, public_key, sign_count, transports, rp_id, aaguid,
      backed_up, label, enrolled_via, created_at, usable_from)
    VALUES ('pk_laptop', ${nickId}, 'cred_laptop', 'seeded', 0, '["internal"]'::jsonb, 'localhost',
      '00000000-0000-0000-0000-000000000000', false, 'laptop', 'admin',
      ${new Date(now - 48 * HOUR).toISOString()}::timestamptz, ${new Date(now - 24 * HOUR).toISOString()}::timestamptz)`);
  await db.execute(sql`
    INSERT INTO fence_waivers (id, repo, pin_id, pin_version, kind, granted_by, capture_mode, reason, expires_at,
      supersedes, created_at, authority, credential_id, request_id)
    VALUES ('fw_laptop', ${REPO_ID}, ${pinId}, 1, 'grant', ${nickId}, 'human', 'the fix lands Monday',
      ${new Date(now + 24 * HOUR).toISOString()}::timestamptz, NULL, ${new Date(now - HOUR).toISOString()}::timestamptz,
      'passkey', 'cred_laptop', NULL)`);
  return "pk_laptop";
};

beforeAll(async () => {
  db = await createDb();
  server = Bun.serve({ port: 0, fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  home = await makeHome("passkey-revocation");
  repo = await makeRepo("passkey-revocation", { remote: "git@github.com:acme/api.git" });
  await writeRepoFile(repo, PINNED, "export const refresh = 1;\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "refresh"]);
  const created = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Nick", email: "nick-passkey-revocation@example.com" }),
  });
  const body = (await created.json()) as { data: { apiKey: string; developer: { id: string } } };
  nickKey = body.data.apiKey;
  nickId = body.data.developer.id;
});

afterAll(async () => {
  server.stop(true);
  await Promise.all([home, repo].map((path) => rm(path, { recursive: true, force: true })));
});

describe("a revoked passkey's waiver, as the CLI shows it (04a D-PK-1)", () => {
  test("pin list and status say the fence closed because the passkey that approved it was revoked", async () => {
    // Arrange: a pin, a waiver its owner's laptop approved, then the laptop lost
    const pinned = await run(["pin", "the refresh path keeps working", "--files", PINNED, "--check", "bun test src/auth"]);
    const pinId = /pinned (pin_[\w-]+):/.exec(pinned.stdout)?.[1] ?? "";
    const passkeyId = await seedApprovedWaiver(pinId);
    expect((await run(["pin", "list"])).stdout).toContain("WAIVED by Nick");

    // Act
    const revoked = await fetch(`${hubUrl}/api/developers/${nickId}/passkeys/${passkeyId}/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const listed = await run(["pin", "list"]);
    const status = await run(["status"]);

    // Assert
    expect(revoked.status).toBe(200);
    expect(listed.stdout).not.toContain("WAIVED by Nick");
    expect(listed.stdout).toContain("waiver fw_laptop CLOSED by the hub");
    expect(listed.stdout).toContain("the passkey that approved it was revoked");
    expect(status.stdout).toContain("1 waiver(s) closed by the hub because the passkey that approved them was revoked");
  });
});
