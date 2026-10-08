/**
 * EVERY POINTER A RENDERER PRINTS RESOLVES (the release-gate e2e finding).
 *
 * The id alphabet the renderers print through (`safeId`, briefing/sanitize.ts)
 * and the one the tool arguments and the hub's schemas validate against
 * (`SAFE_ID_PATTERN`) had no `~`, while the connector's own ids carry it: a
 * healed or resumed life is `cc_<key>~r<n>`, and its work context
 * `wc_cc_<key>~r<n>`. Every pointer to such a context named an id that does
 * not exist — `get_diagnosis wc_cc_p1-nick-long-sessionr1` — and an agent that
 * typed the right one was refused by the argument check.
 *
 * Two halves. The GRAMMAR: every id shape the connector mints survives
 * `safeId`, the tool arguments and the hub's schemas unchanged, and a `~` that
 * is not one of the grammar's own suffixes — `~~` above all, markdown's
 * strikethrough — is stripped as before. The ROUND TRIP: on a real hub, a
 * healed life's work context is pointed at by the search tool, the
 * prompt-time hint and the briefing's question block, and every id those
 * print is read back through `get_diagnosis` and the route behind it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";
import { SAFE_ID_PATTERN as HUB_SAFE_ID_PATTERN } from "@crosscheck/schema";

import { safeId, SAFE_ID_PATTERN } from "../src/briefing/sanitize.ts";
import { repoKey } from "../src/config/paths.ts";
import { assembleBriefing } from "../src/flows/briefing.ts";
import { selectAndRenderHint } from "../src/flows/hint.ts";
import type { HubContext } from "../src/http/client.ts";
import { prepareMcp } from "../src/mcp/context.ts";
import type { McpContext } from "../src/mcp/context.ts";
import { findTool } from "../src/mcp/tools/index.ts";
import { idArg } from "../src/mcp/tools/shared.ts";
import { deriveSessionState, writeSessionState } from "../src/state/session-state.ts";
import { INJECTION_CORPUS } from "./fixtures/injection-corpus.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ADMIN_TOKEN = "round-trip-admin";
const REPO_ID = "github.com/acme/api";
const UUID = "0f8e7d6c-5b4a-4392-8170-6a5b4c3d2e1f";

/** Every id shape the connector mints, a healed or resumed life's included. */
export const MINTED_IDS: readonly string[] = [
  `cc_${UUID}`,
  `wc_cc_${UUID}`,
  `cc_${UUID}~r1`,
  `wc_cc_${UUID}~r1`,
  `wc_cc_${UUID}~r12`,
  `wc_cc_cur-${UUID}~r3`,
  "wc_cc_acp-gemini-cli--sess_abc123~r2",
];

describe("the id grammar", () => {
  test("every id the connector mints survives the renderer, the tool arguments and the hub unchanged", () => {
    const argument = idArg("work context", "test");
    for (const id of MINTED_IDS) {
      expect({ id, rendered: safeId(id) }).toEqual({ id, rendered: id });
      expect({ id, connector: SAFE_ID_PATTERN.test(id), hub: HUB_SAFE_ID_PATTERN.test(id) }).toEqual({
        id,
        connector: true,
        hub: true,
      });
      expect(argument.safeParse(id).success).toBe(true);
    }
  });

  test("a ~ the grammar does not name is stripped, and ~~ never survives", () => {
    expect(safeId("wc_a~~b")).toBe("wc_ab");
    expect(safeId("wc_a~r")).toBe("wc_ar");
    expect(safeId("wc_a~x1")).toBe("wc_ax1");
    expect(safeId("wc_a~r1~r2")).toBe("wc_ar1r2");
    expect(safeId("~r1")).toBe("r1");
    expect(safeId("wc_a~r1 «x»")).toBe("wc_ar1x");
    for (const id of ["wc_a~~b", "wc_a~r", "~r1", "wc_a~r1~r2", "wc_~~r1"]) {
      expect({ id, connector: SAFE_ID_PATTERN.test(id), hub: HUB_SAFE_ID_PATTERN.test(id) }).toEqual({
        id,
        connector: false,
        hub: false,
      });
    }
  });

  test("nothing in the injection corpus comes out of safeId carrying ~~ or an id the pattern refuses", () => {
    for (const { payload } of INJECTION_CORPUS) {
      const rendered = safeId(payload);
      expect(rendered.includes("~~")).toBe(false);
      expect(rendered === "" || SAFE_ID_PATTERN.test(rendered)).toBe(true);
    }
  });
});

describe("a healed life's work context, pointed at and read back", () => {
  let db: Db;
  let server: ReturnType<typeof Bun.serve>;
  let hubUrl: string;
  const cleanups: string[] = [];

  beforeAll(async () => {
    db = await createDb();
    server = Bun.serve({ port: 0, fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch });
    hubUrl = `http://127.0.0.1:${String(server.port)}`;
  });

  afterAll(async () => {
    server.stop(true);
    await (db as unknown as { $client: { close: () => Promise<void> } }).$client.close().catch(() => undefined);
    await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
  });

  const post = (path: string, apiKey: string, body: unknown): Promise<Response> =>
    fetch(`${hubUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  interface Developer {
    readonly developerId: string;
    readonly apiKey: string;
    readonly home: string;
    readonly repo: string;
    readonly hostSessionKey: string;
    readonly workContextId: string;
    readonly hub: HubContext;
    readonly mcp: McpContext;
  }

  /** A developer on a LIFE of their own choosing — `~r1` is a healed one — with its work context and state. */
  const developerOn = async (label: string, name: string, life: string, title: string): Promise<Developer> => {
    const created = await post("/api/developers", ADMIN_TOKEN, { name, email: `${label}@example.com` });
    const account = ((await created.json()) as { data: { developer: { id: string }; apiKey: string } }).data;
    const home = await makeHome(label);
    const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
    cleanups.push(home, repo);
    const hostSessionKey = `${label}-host`;
    const sessionId = `cc_${hostSessionKey}${life}`;
    const workContextId = `wc_${sessionId}`;
    const now = new Date().toISOString();
    await post("/api/sessions", account.apiKey, {
      id: sessionId,
      agentKind: "claude-code",
      repo: REPO_ID,
      branch: "main",
      baseCommit: "a1b2c3d4",
      status: "implementing",
    });
    await post("/api/records", account.apiKey, {
      cx: "0.1",
      id: `env_${crypto.randomUUID()}`,
      ts: now,
      producer: { developerId: account.developer.id, agentKind: "claude-code", sessionId },
      kind: "work_context",
      body: { id: workContextId, sessionId, title, status: "implementing", createdAt: now },
    });
    await writeSessionState(home, {
      ...deriveSessionState({
        hostSessionKey,
        repoId: REPO_ID,
        repoRoot: repo,
        hubUrl,
        developerId: account.developer.id,
        startedAt: now,
      }),
      crosscheckSessionId: sessionId,
      workContextId,
      workContextTitle: title,
      workContextStatus: "implementing",
      agentKind: "claude-code",
    });
    const setup = await prepareMcp(
      { CROSSCHECK_HOME: home, CROSSCHECK_HUB_URL: hubUrl, CROSSCHECK_API_KEY: account.apiKey },
      repo,
    );
    if (!setup.ok) throw new Error(setup.message);
    const key = repoKey(hubUrl, REPO_ID);
    return {
      developerId: account.developer.id,
      apiKey: account.apiKey,
      home,
      repo,
      hostSessionKey,
      workContextId,
      hub: { hubUrl, apiKey: account.apiKey, timeoutMs: 4000, home, repoKey: key, now: () => new Date() },
      mcp: setup.ctx,
    };
  };

  const run = async (
    who: Developer,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ readonly text: string; readonly isError: boolean }> => {
    const found = findTool(tool);
    if (found === undefined) throw new Error(`no ${tool}`);
    const result = await found.run(who.mcp, args);
    return { text: result.content.map((part) => part.text).join("\n"), isError: result.isError === true };
  };

  /** Every id a rendered text points at: what follows `get_diagnosis`, and every bare work-context id. */
  const pointersIn = (text: string): readonly string[] => [
    ...new Set([
      ...[...text.matchAll(/get_diagnosis\s+([^\s,;)]+?)[.]?(?=[\s,;)]|$)/gu)].map((match) => match[1] ?? ""),
      ...[...text.matchAll(/\bwc_[A-Za-z0-9_.:~-]+?(?=[.]?(?:[\s,;)·]|$))/gu)].map((match) => match[0]),
    ]),
  ];

  test("search, the prompt-time hint and the briefing's question block point at ids get_diagnosis reads", async () => {
    // Arrange: Alice works on a healed life; Bob is the reader, and asks her about it
    const TITLE = "Importer drops the header row on CSV upload";
    const alice = await developerOn("rt-alice", "Alice", "~r1", TITLE);
    const bob = await developerOn("rt-bob", "Bob", "", "Reviewing the billing export");
    // A stated intent is what earns a claimless context the prompt-time pointer.
    const declared = await run(alice, "set_intent", { summary: "Stop the importer dropping the header row on CSV upload" });
    const asked = await run(bob, "ask_teammate", {
      question: "Did the importer fix also cover the TSV path?",
      workContextId: alice.workContextId,
    });

    // Act: every renderer that points at Alice's context
    const search = await run(bob, "search_related_work", { query: "importer header row CSV upload" });
    const hint = await selectAndRenderHint({
      home: bob.home,
      repoKey: bob.hub.repoKey,
      hub: bob.hub,
      hostSessionKey: bob.hostSessionKey,
      repoId: REPO_ID,
      repoRoot: bob.repo,
      agentKind: "claude-code",
      prompt: "why does the importer drop the header row on CSV upload",
      now: new Date(),
    });
    const briefing = await assembleBriefing({
      hub: alice.hub,
      repoId: REPO_ID,
      repoRoot: alice.repo,
      selfDeveloperId: alice.developerId,
      now: new Date(),
    });

    // Assert: the question was taken, every surface named Alice's real id, and each id reads back
    expect(declared).toMatchObject({ isError: false });
    expect(asked).toMatchObject({ isError: false });
    const surfaces = { search: search.text, hint, briefing: briefing.briefing };
    for (const [surface, text] of Object.entries(surfaces)) {
      expect({ surface, names: pointersIn(text).includes(alice.workContextId) }).toEqual({ surface, names: true });
    }
    const pointed = [...new Set(Object.values(surfaces).flatMap(pointersIn))];
    for (const id of pointed) {
      const read = await run(bob, "get_diagnosis", { workContextId: id });
      const route = await fetch(`${hubUrl}/api/work-contexts/${encodeURIComponent(id)}/diagnosis`, {
        headers: { Authorization: `Bearer ${bob.apiKey}` },
      });
      expect({ id, isError: read.isError, status: route.status }).toEqual({ id, isError: false, status: 200 });
    }
  });
});
