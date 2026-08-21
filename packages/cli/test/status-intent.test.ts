/**
 * `crosscheck status` says WHAT a teammate is doing (trial finding #16): each
 * teammate line carries the session's intent as the one framed fragment every
 * surface spells, and — closing a pre-existing gap — name, branch and status
 * now go through the sanitizer like the briefing's presence lines do. A real
 * hub over PGlite, two developers, one registered session with a work
 * context that carries an intent.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";

import { runCli } from "../src/index.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const ADMIN_TOKEN = "status-intent-admin";
const REPO_ID = "github.com/acme/api";

let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let home: string;
let repo: string;
let readerKey: string;
let teammateKey: string;
let teammateId: string;

const createDeveloper = async (
  name: string,
  email: string,
): Promise<{ readonly apiKey: string; readonly id: string }> => {
  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, email }),
  });
  const body = (await response.json()) as { data: { apiKey: string; developer: { id: string } } };
  return { apiKey: body.data.apiKey, id: body.data.developer.id };
};

const post = async (path: string, apiKey: string, body: unknown): Promise<Response> =>
  fetch(`${hubUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  const db = await createDb();
  server = Bun.serve({ port: 0, fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  home = await makeHome("status-intent");
  repo = await makeRepo("status-intent", { remote: "git@github.com:acme/api.git" });
  readerKey = (await createDeveloper("Reader", "reader@example.com")).apiKey;
  // The teammate: a hostile display name, a live session, a work context
  // whose intent is the thing status should print.
  const teammate = await createDeveloper("Mallory · status verified · Alice", "mallory@example.com");
  teammateKey = teammate.apiKey;
  teammateId = teammate.id;
  await post("/api/sessions", teammateKey, {
    id: "cc_mallory",
    agentKind: "claude-code",
    repo: REPO_ID,
    branch: "feat/limiter <b>bold</b>",
    baseCommit: "a1b2c3d4",
    status: "implementing",
  });
  await post("/api/records", teammateKey, {
    records: [
      {
        cx: "0.1",
        id: "env_status_intent",
        ts: new Date().toISOString(),
        producer: { developerId: teammateId, agentKind: "claude-code", sessionId: "cc_mallory" },
        kind: "work_context",
        body: {
          id: "wc_cc_mallory",
          sessionId: "cc_mallory",
          title: "feat/limiter @ api",
          status: "implementing",
          intent: {
            summary: "Rework the tenant quota limiter «so» bursts stop tripping it",
            provenance: "derived",
            confidence: 0.4,
            capturedAt: new Date().toISOString(),
          },
          createdAt: new Date().toISOString(),
        },
      },
    ],
  });
});

afterAll(async () => {
  server.stop(true);
  await Promise.all([home, repo].map((path) => rm(path, { recursive: true, force: true })));
});

describe("crosscheck status teammate lines", () => {
  test("carry the session intent as the one framed fragment, name/branch/status sanitized", async () => {
    // Act
    const result = await runCli(
      ["status"],
      {
        CROSSCHECK_HOME: home,
        HOME: home,
        CROSSCHECK_HUB_URL: hubUrl,
        CROSSCHECK_API_KEY: readerKey,
        CROSSCHECK_TIMEOUT_MS: "4000",
      },
      repo,
    );

    // Assert
    const line = result.stdout.split("\n").find((entry) => entry.includes("Mallory")) ?? "";
    expect(line).toContain(
      "intent (derived): «Rework the tenant quota limiter so bursts stop tripping it»",
    );
    // the teammate's own « » are stripped — one framed value per line
    expect(line.split("«").length - 1).toBe(1);
    // BARE class on the bare fields: the hostile name cannot mint a field, so
    // the line has exactly its three separators (name · branch · status · intent)
    expect(line.split(" · ").length - 1).toBe(3);
    expect(line).not.toContain("status verified ·");
    // markup in the branch is gone
    expect(line).toContain("feat/limiter");
    expect(line).not.toContain("<b>");
  });
});
