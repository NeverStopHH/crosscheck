/**
 * The ghost check at INTENT DECLARATION (VISION.md §3), against a real hub.
 *
 * Declaring the plan is the first instant it can be compared with anybody
 * else's, so `set_intent` answers with the deterministic overlap — and only
 * with that. What this file pins is the shape of the deal: a POINTER block in
 * the answer, the model half merely OWED (a flag in session state, paid by a
 * later hook), and every failure of the new query costing the notice and
 * never the intent that was just recorded.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import { GHOST_SECTION_HEADER } from "../src/briefing/ghost.ts";
import { QUOTED_DATA_NOTICE } from "../src/briefing/render.ts";
import { prepareMcp } from "../src/mcp/context.ts";
import { findTool } from "../src/mcp/tools/index.ts";
import { readSessionState, writeSessionState } from "../src/state/session-state.ts";
import type { SessionState } from "../src/state/session-state.ts";
import type { Env } from "../src/index.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ADMIN_TOKEN = "ghost-declare-admin";
const REPO_ID = "github.com/acme/api";
const TITLE = "detached@0badc0f · fix: refresh 500s @ api";
const SHARED = ["src/auth/token.ts", "src/auth/session.ts"] as const;

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let olderHub: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let olderHubUrl: string;
const cleanups: string[] = [];

interface Developer {
  readonly developerId: string;
  readonly apiKey: string;
  readonly home: string;
  readonly repo: string;
  readonly env: Env;
  readonly hostSessionKey: string;
  readonly sessionId: string;
  readonly workContextId: string;
  readonly startedAt: string;
}

let alice: Developer;
let ken: Developer;
/** A developer whose hub is the OLDER one — see the fail-open test. */
let dora: Developer;

const post = async (
  path: string,
  apiKey: string,
  body: unknown,
  base: string = hubUrl,
): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const envelope = (
  developer: { developerId: string; sessionId: string },
  kind: string,
  body: Record<string, unknown>,
  ts: string,
): Record<string, unknown> => ({
  cx: "0.1",
  id: `env_${crypto.randomUUID()}`,
  ts,
  producer: {
    developerId: developer.developerId,
    agentKind: "claude-code",
    sessionId: developer.sessionId,
  },
  kind,
  body,
});

const setUpDeveloper = async (
  label: string,
  name: string,
  email: string,
  base: string = hubUrl,
): Promise<Developer> => {
  const created = await post("/api/developers", ADMIN_TOKEN, { name, email }, base);
  const account = (await created.json()) as {
    data: { developer: { id: string }; apiKey: string };
  };
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  cleanups.push(home, repo);
  const hostSessionKey = `${label}-uuid`;
  const sessionId = `cc_${hostSessionKey}`;
  const workContextId = `wc_${sessionId}`;
  const startedAt = new Date().toISOString();
  const developer = {
    developerId: account.data.developer.id,
    apiKey: account.data.apiKey,
    sessionId,
    workContextId,
    startedAt,
  };
  await post(
    "/api/sessions",
    developer.apiKey,
    {
      id: sessionId,
      agentKind: "claude-code",
      repo: REPO_ID,
      branch: "detached@0badc0f",
      baseCommit: "a1b2c3d4",
      status: "analyzing",
    },
    base,
  );
  await post(
    "/api/records",
    developer.apiKey,
    {
      records: [
        envelope(
          developer,
          "work_context",
          {
            id: workContextId,
            sessionId,
            title: TITLE,
            status: "analyzing",
            createdAt: startedAt,
          },
          startedAt,
        ),
      ],
    },
    base,
  );
  await writeSessionState(home, {
    hostSessionKey,
    crosscheckSessionId: sessionId,
    workContextId,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl: base,
    developerId: developer.developerId,
    startedAt,
    lastHeartbeatAt: startedAt,
    seenTargets: [],
    workContextTitle: TITLE,
    workContextStatus: "analyzing",
  });
  return {
    ...developer,
    home,
    repo,
    hostSessionKey,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: base,
      CROSSCHECK_API_KEY: developer.apiKey,
    },
  };
};

const addTargets = async (
  developer: Developer,
  values: readonly string[],
): Promise<void> => {
  const response = await post("/api/records", developer.apiKey, {
    records: values.map((value) =>
      envelope(
        developer,
        "target",
        { workContextId: developer.workContextId, kind: "file", value },
        developer.startedAt,
      ),
    ),
  });
  const body = (await response.json()) as { data: { rejected: number } };
  if (body.data.rejected > 0) {
    throw new Error("target seed rejected");
  }
};

const declare = async (
  developer: Developer,
  summary: string,
  env: Env = developer.env,
): Promise<string> => {
  const tool = findTool("set_intent");
  if (tool === undefined) {
    throw new Error("no tool set_intent");
  }
  const setup = await prepareMcp(env, developer.repo);
  if (!setup.ok) {
    throw new Error(`prepareMcp failed: ${setup.message}`);
  }
  const result = await tool.run(setup.ctx, { summary });
  const text = result.content.map((part) => part.text).join("\n");
  if (result.isError === true) {
    throw new Error(`set_intent refused: ${text}`);
  }
  return text;
};

const stateOf = async (developer: Developer): Promise<SessionState> => {
  const state = await readSessionState(developer.home, developer.hostSessionKey);
  if (state === null) {
    throw new Error("no session state");
  }
  return state;
};

beforeAll(async () => {
  db = await createDb();
  server = Bun.serve({
    port: 0,
    fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch,
  });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  // The SAME hub, one route older: everything is forwarded except
  // /api/ghost-checks, which 404s the way a deployment that predates this
  // feature does. That is what fail open has to survive, and forwarding the
  // rest is what makes the comparison honest — only the new route differs.
  olderHub = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/ghost-checks") {
        return new Response("not found", { status: 404 });
      }
      return fetch(`${hubUrl}${url.pathname}${url.search}`, request);
    },
  });
  olderHubUrl = `http://127.0.0.1:${String(olderHub.port)}`;
  alice = await setUpDeveloper("gd-alice", "Alice", "alice-ghost@example.com");
  ken = await setUpDeveloper("gd-ken", "Ken", "ken-ghost@example.com");
  dora = await setUpDeveloper(
    "gd-dora",
    "Dora",
    "dora-ghost@example.com",
    olderHubUrl,
  );
});

afterAll(async () => {
  olderHub.stop(true);
  server.stop(true);
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

describe("set_intent and the ghost check", () => {
  test("no overlap costs nothing, and the ghost debt is still booked", async () => {
    const text = await declare(alice, "Rework how verifyToken refetches the JWKS");
    expect(text).toContain(QUOTED_DATA_NOTICE);
    expect(text).toContain(`Recorded your intent on work context ${alice.workContextId}`);
    expect(text).not.toContain(GHOST_SECTION_HEADER);
    // The silence above is an empty overlap and not an unwired tool: the same
    // call books the sentence the ghost worker will compare and the debt that
    // makes it run — no model call, no notice, one flag.
    const state = await stateOf(alice);
    expect(state.workContextIntent).toBe(
      "Rework how verifyToken refetches the JWKS",
    );
    expect(state.ghostPending).toBe(true);
    expect(state.ghostNoticeCount).toBe(0);
  });

  test("a teammate live in the same files is named, as a pointer", async () => {
    await addTargets(alice, SHARED);
    await addTargets(ken, SHARED);
    await declare(ken, "Move the session store behind an interface");

    const text = await declare(alice, "Rework how verifyToken refetches the JWKS");
    expect(text).toContain(GHOST_SECTION_HEADER);
    expect(text).toContain("- Ken · last active");
    expect(text).toContain(`also on ${SHARED[1]}, ${SHARED[0]}`);
    expect(text).toContain("intent: «Move the session store behind an interface»");
    expect(text).toContain(`get_diagnosis ${ken.workContextId}`);
    // A POINTER: the answer carries no claim body and asks for no decision.
    expect(text).toContain("nothing here blocks you");
    expect((await stateOf(alice)).ghostNoticeCount).toBeGreaterThan(0);
  });

  test("a hub that cannot answer the overlap still records the intent", async () => {
    // Dora sits on the older hub for everything, so this is not a mismatched
    // configuration — it is the same product against a deployment whose only
    // difference is the missing route.
    await addTargets(dora, SHARED);
    const text = await declare(dora, "Rewrite the token refresh guard");
    expect(text).toContain(
      `Recorded your intent on work context ${dora.workContextId}`,
    );
    expect(text).not.toContain(GHOST_SECTION_HEADER);
    // The debt is still booked: the plan exists, only the comparison is
    // missing, and a hub upgrade must not need a new declaration.
    const state = await stateOf(dora);
    expect(state.ghostPending).toBe(true);
    expect(state.ghostNoticeCount).toBe(0);

    // The control: Alice, on the SAME data through the current hub, is told
    // about Dora — so what silenced the block above is the 404 and not an
    // empty overlap.
    const alicesText = await declare(
      alice,
      "Rework how verifyToken refetches the JWKS",
    );
    expect(alicesText).toContain(GHOST_SECTION_HEADER);
    expect(alicesText).toContain("- Dora · last active");
  });
});
