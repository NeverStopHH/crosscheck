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
import { guaranteeDeclarationFor } from "../src/guarantees/declarations.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
const bodies: Record<string, unknown>[] = [];
const cleanups: string[] = [];

const server = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/sessions" && request.method === "POST") {
      bodies.push((await request.json()) as Record<string, unknown>);
      return Response.json({ session: { id: "cc_guarantees", developerId: "dev_self" } });
    }
    return Response.json({ ok: true, data: { accepted: 0, duplicates: 0, ignored: 0, rejected: 0 } });
  },
});
const HUB_URL = `http://127.0.0.1:${String(server.port)}`;

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
