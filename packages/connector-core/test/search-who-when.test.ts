/**
 * `search_related_work` learns WHO and WHEN (roadmap R1), against a REAL hub.
 *
 * The two arguments are only worth having if the ANSWER stays honest when
 * they are wrong, so that is what most of this file is about: a misspelt
 * teammate name must come back as a refusal naming the closest spellings,
 * never as an empty result — "no work contexts" in answer to "Alise" reads as
 * "Alice has done nothing", and an agent acts on that by redoing her work.
 *
 * A separate file from mcp-tools.test.ts on purpose: that one is already 954
 * lines, and this needs a developer with work of two different AGES rather
 * than the shared fixture's one context each.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import { prepareMcp } from "../src/mcp/context.ts";
import { findTool } from "../src/mcp/tools/index.ts";
import { writeSessionState } from "../src/state/session-state.ts";
import type { Env } from "../src/index.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ADMIN_TOKEN = "who-when-admin-token";
const REPO_ID = "github.com/acme/api";
const DAY_MS = 24 * 60 * 60 * 1000;

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
const cleanups: string[] = [];

interface Developer {
  readonly name: string;
  readonly email: string;
  readonly developerId: string;
  readonly apiKey: string;
  readonly repo: string;
  readonly env: Env;
  readonly sessionId: string;
  readonly workContextId: string;
}

let alice: Developer;
let bob: Developer;
/** Alice's second context, 60 days old — the row a `since` window drops. */
const ALICE_OLD_CONTEXT = "wc_alice_old";

const createDeveloper = async (
  name: string,
  email: string,
): Promise<{ developerId: string; apiKey: string }> => {
  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, email }),
  });
  const body = (await response.json()) as {
    data: { developer: { id: string }; apiKey: string };
  };
  return { developerId: body.data.developer.id, apiKey: body.data.apiKey };
};

const postWorkContext = async (
  developer: { developerId: string; apiKey: string },
  sessionId: string,
  id: string,
  title: string,
  createdAt: string,
): Promise<void> => {
  await fetch(`${hubUrl}/api/records`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${developer.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      cx: "0.1",
      id: `env_${crypto.randomUUID()}`,
      ts: createdAt,
      producer: {
        developerId: developer.developerId,
        agentKind: "claude-code",
        sessionId,
      },
      kind: "work_context",
      body: { id, sessionId, title, status: "analyzing", createdAt },
    }),
  });
};

const setUpDeveloper = async (
  label: string,
  name: string,
  email: string,
  title: string,
): Promise<Developer> => {
  const account = await createDeveloper(name, email);
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  cleanups.push(home, repo);

  const sessionId = `cc_${label}-uuid`;
  const workContextId = `wc_${sessionId}`;
  const startedAt = new Date().toISOString();

  await fetch(`${hubUrl}/api/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: sessionId,
      agentKind: "claude-code",
      repo: REPO_ID,
      branch: "main",
      baseCommit: "a1b2c3d4",
      status: "analyzing",
    }),
  });
  await postWorkContext(account, sessionId, workContextId, title, startedAt);
  await writeSessionState(home, {
    hostSessionKey: `${label}-uuid`,
    crosscheckSessionId: sessionId,
    workContextId,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl,
    developerId: account.developerId,
    startedAt,
    lastHeartbeatAt: startedAt,
    seenTargets: [],
  });

  return {
    ...account,
    name,
    email,
    repo,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: account.apiKey,
    },
    sessionId,
    workContextId,
  };
};

interface Called {
  readonly text: string;
  readonly isError: boolean;
}

const search = async (
  developer: Developer,
  args: Record<string, unknown>,
): Promise<Called> => {
  const tool = findTool("search_related_work");
  if (tool === undefined) {
    throw new Error("no search_related_work tool");
  }
  const setup = await prepareMcp(developer.env, developer.repo);
  if (!setup.ok) {
    throw new Error(`prepareMcp failed: ${setup.message}`);
  }
  const result = await tool.run(setup.ctx, args);
  return {
    text: result.content.map((part) => part.text).join("\n"),
    isError: result.isError === true,
  };
};

beforeAll(async () => {
  db = await createDb();
  const app = createServer({ db, adminToken: ADMIN_TOKEN });
  server = Bun.serve({ port: 0, fetch: app.fetch });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;

  alice = await setUpDeveloper(
    "who-alice",
    "Alice",
    "alice-who@example.com",
    "Login 500s on staging",
  );
  bob = await setUpDeveloper(
    "who-bob",
    "Bob",
    "bob-who@example.com",
    "Rate limiter drops burst traffic",
  );
  await postWorkContext(
    alice,
    alice.sessionId,
    ALICE_OLD_CONTEXT,
    "Login retries hammered the staging gateway",
    new Date(Date.now() - 60 * DAY_MS).toISOString(),
  );
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("search_related_work with a developer filter", () => {
  test("returns that teammate's work and names the filter it applied", async () => {
    // Act
    const result = await search(bob, { query: "login", developer: "Alice" });

    // Assert
    expect(result.isError).toBe(false);
    expect(result.text).toContain(alice.workContextId);
    expect(result.text).toContain("Filters: Alice");
    expect(result.text).not.toContain(bob.workContextId);
  });

  test("refuses a misspelt name with the closest spellings, not an empty result", async () => {
    // Arrange: THE point of the feature. "No work context matched" in answer
    // to "Alise" reads as "Alice has done nothing".
    // Act
    const result = await search(bob, { query: "login", developer: "Alise" });

    // Assert
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Alice");
    expect(result.text.toLowerCase()).not.toContain(
      "no work context on this repo matched",
    );
    // The dedicated sentence, not the generic hub failure: "the hub refused
    // the request (HTTP 400)" tells a model nothing it can act on, and the
    // hub's own message would satisfy a looser assertion on its own.
    expect(result.text).toContain("a filter did not resolve to what it names");
    expect(result.text).not.toContain("refused the request");
  });

  test("says when the filter names the reader, so it is not read as a teammate's", async () => {
    // Arrange: search does not exclude the caller (get_diagnosis on your own
    // tree would be unreachable), so a self-filter is legitimate — but the
    // result must not look like somebody else's work.
    // Act
    const result = await search(alice, {
      query: "login",
      developer: alice.email,
    });

    // Assert
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Filters: Alice (you)");
    expect(result.text).toContain(alice.workContextId);
  });

  test("an empty result under a filter says the filter is part of the answer", async () => {
    // Act
    const result = await search(bob, {
      query: "quantum entanglement in the billing service",
      developer: "Alice",
    });

    // Assert
    expect(result.isError).toBe(false);
    expect(result.text.toLowerCase()).toContain("no work context");
    expect(result.text).toContain("Alice");
    expect(result.text.toLowerCase()).toContain("part of that answer");
  });
});

describe("search_related_work with a since window", () => {
  test("drops work last active before the window and names the window", async () => {
    // Act
    const windowed = await search(bob, {
      query: "login",
      developer: "Alice",
      since: "14d",
    });
    const all = await search(bob, { query: "login", developer: "Alice" });

    // Assert: the 60-day-old context is reachable without the window and gone
    // with it — so the window filtered, rather than the query missing
    expect(all.text).toContain(ALICE_OLD_CONTEXT);
    expect(windowed.text).not.toContain(ALICE_OLD_CONTEXT);
    expect(windowed.text).toContain(alice.workContextId);
    expect(windowed.text).toContain("14d");
  });

  test("refuses a window it cannot parse and names the forms that work", async () => {
    // Act
    const result = await search(bob, {
      query: "login",
      since: "last fortnight",
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(result.text).toContain("14d");
    expect(result.text).toContain("a filter did not resolve to what it names");
    expect(result.text).not.toContain("refused the request");
  });
});
