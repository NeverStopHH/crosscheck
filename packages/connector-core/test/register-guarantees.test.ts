/**
 * THE DECLARATION RIDES THE REGISTER BODY (01a §3.6 Transport; loss-accounting
 * §4.9): the second optional enum-only block beside `losses`, sent on every
 * register a current connector makes. An absent block is read by the hub as
 * `undeclared` — safe, but a sentence about a different, older connector.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { foldGuaranteeDeclaration } from "@crosscheck/schema";

import { repoKey } from "../src/config/paths.ts";
import { registerSessionFlow } from "../src/flows/register-session.ts";
import type { HubContext } from "../src/http/client.ts";
import { getSessionOrderReport } from "../src/http/hub.ts";
import { guaranteeDeclarationFor } from "../src/guarantees/declarations.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
const bodies: Record<string, unknown>[] = [];
const cleanups: string[] = [];
/** What the fake hub's order route answers with, per test. */
let orderReport: Record<string, unknown> = { sessions: [] };

const server = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/sessions" && request.method === "POST") {
      bodies.push((await request.json()) as Record<string, unknown>);
      return Response.json({ session: { id: "cc_guarantees", developerId: "dev_self" } });
    }
    if (url.pathname === "/api/sessions/order") {
      return Response.json({ ok: true, data: orderReport });
    }
    return Response.json({ ok: true, data: { accepted: 0, duplicates: 0, ignored: 0, rejected: 0 } });
  },
});
const HUB_URL = `http://127.0.0.1:${String(server.port)}`;

const hubCtx = (home: string): HubContext => ({
  hubUrl: HUB_URL,
  apiKey: "test-key",
  timeoutMs: 2000,
  home,
  repoKey: repoKey(HUB_URL, REPO_ID),
  now: () => new Date(),
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

describe("registerSessionFlow sends the connector's declaration", () => {
  test("the register body carries the nine triples it was given, as a hub folds them", async () => {
    // Arrange
    const home = await makeHome("register-guarantees");
    const repo = await makeRepo("register-guarantees", { remote: "git@github.com:acme/api.git" });
    cleanups.push(home, repo);
    const key = repoKey(HUB_URL, REPO_ID);
    const declaration = guaranteeDeclarationFor("cursor-ide");

    // Act
    await registerSessionFlow({
      home,
      hub: { hubUrl: HUB_URL, apiKey: "test-key", timeoutMs: 2000, home, repoKey: key, now: () => new Date() },
      repoKey: key,
      hostSessionKey: "register-guarantees-uuid",
      repoId: REPO_ID,
      repoRoot: repo,
      hubUrl: HUB_URL,
      agentKind: "cursor-ide",
      branch: "main",
      baseCommit: "abc1234",
      status: "implementing",
      fallbackDeveloperId: "dev_self",
      title: "register guarantees",
      now: new Date(),
      guarantees: declaration,
    });

    // Assert
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.["guarantees"]).toEqual(declaration);
    expect(foldGuaranteeDeclaration(bodies[0]?.["guarantees"])).toEqual(declaration);
  });
});

describe("doctor's declaration_contradicted count, as the client reads it", () => {
  test("a hub's count is read as sent", async () => {
    // Arrange
    orderReport = { sessions: [], declarations: { contradicted: 2 } };
    // Act
    const result = await getSessionOrderReport(hubCtx("/tmp/does-not-exist"));
    // Assert
    expect(result.ok && result.data.contradictedDeclarations).toBe(2);
  });

  test("a hub that sent none, or one this client cannot read, is null — not measured, never zero", async () => {
    for (const declarations of [undefined, { contradicted: -1 }, { contradicted: "2" }, "many"]) {
      // Arrange
      orderReport = declarations === undefined ? { sessions: [] } : { sessions: [], declarations };
      // Act
      const result = await getSessionOrderReport(hubCtx("/tmp/does-not-exist"));
      // Assert
      expect(result.ok).toBe(true);
      expect(result.ok ? result.data.contradictedDeclarations : "failed").toBeNull();
    }
  });
});
