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

/**
 * A hub from BEFORE the filters, in front of the real one.
 *
 * It is the rollout order this repo already documents ("one hub serves
 * connectors of several versions at once", server services/refusal.ts): a
 * connector updates on one machine while the shared hub is still last week's
 * build. Such a hub does not read `developer=` or `since=` off the query string
 * and its response carries no `filters` block — so it answers the filtered
 * question with EVERYONE'S work over ALL of history, and every field the
 * connector can check says the call succeeded.
 *
 * Both halves are simulated rather than asserted about, because both are what
 * an older hub really does: the params are stripped on the way in (its schema
 * never had them) and `filters` is deleted on the way out (its response never
 * had it).
 */
let oldHub: ReturnType<typeof Bun.serve>;
/** Bob's connector, pointed at the old hub — same account, same repo. */
let bobOnOldHub: Developer;

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

/**
 * The same developer, same repo, same session — talking to a different hub.
 *
 * A second CROSSCHECK_HOME rather than an edit to the first, so the two hubs
 * are asked the same question by two independent connectors and neither test
 * can disturb the other's state.
 */
const pointAt = async (
  developer: Developer,
  label: string,
  url: string,
): Promise<Developer> => {
  const home = await makeHome(label);
  cleanups.push(home);
  const startedAt = new Date().toISOString();
  await writeSessionState(home, {
    hostSessionKey: `${label}-uuid`,
    crosscheckSessionId: developer.sessionId,
    workContextId: developer.workContextId,
    repoId: REPO_ID,
    repoRoot: developer.repo,
    hubUrl: url,
    developerId: developer.developerId,
    startedAt,
    lastHeartbeatAt: startedAt,
    seenTargets: [],
  });
  return {
    ...developer,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: url,
      CROSSCHECK_API_KEY: developer.apiKey,
    },
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

  oldHub = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const incoming = new URL(request.url);
      // The half an older hub's SearchQuerySchema does not have.
      incoming.searchParams.delete("developer");
      incoming.searchParams.delete("since");
      const forwarded = await fetch(
        `${hubUrl}${incoming.pathname}${incoming.search}`,
        { method: request.method, headers: request.headers },
      );
      const body = (await forwarded.json()) as {
        data?: Record<string, unknown>;
      };
      // The half an older hub's response does not have.
      delete body.data?.["filters"];
      return new Response(JSON.stringify(body), {
        status: forwarded.status,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  bobOnOldHub = await pointAt(
    bob,
    "who-bob-old",
    `http://127.0.0.1:${String(oldHub.port)}`,
  );
});

afterAll(async () => {
  oldHub.stop(true);
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

/**
 * THE FILTERS ARE THE QUESTION, so a hub that ignored them did not answer it.
 *
 * Every other "an older hub omits this field" case in http/hub.ts costs a
 * DETAIL — a tier label, a solved marker, an intent — and the answer around it
 * stays true. This one is different in kind: the omitted field is the only
 * evidence that the question the caller asked was ever applied, and the rows
 * beside it are a true answer to a DIFFERENT question. Rendered as an ordinary
 * success they are read as "here is Bob's work from the last two weeks" while
 * being everybody's work over all of history — the confident-wrong answer this
 * whole feature was built to make impossible, arriving through the success path
 * rather than the refusal path.
 */
describe("search_related_work against a hub that predates the filters", () => {
  test("refuses rather than pass off unfiltered rows as a filtered answer", async () => {
    // Arrange: the same call that works against the current hub.
    // Act
    const result = await search(bobOnOldHub, {
      query: "login",
      developer: "Alice",
      since: "14d",
    });

    // Assert: no answer at all, and the reason names both filters and the fix.
    // Alice's 60-day-old context is the row that proves the point — an
    // unfiltered answer contains it, and this must not be one.
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(ALICE_OLD_CONTEXT);
    expect(result.text).not.toContain(alice.workContextId);
    expect(result.text).toContain("developer and since filters");
    expect(result.text.toLowerCase()).toContain("nothing was searched");
  });

  test("still answers a question that asked for no filter at all", async () => {
    // Arrange: the missing block only matters when something was ASKED for.
    // Refusing every search against an older hub would be a different bug.
    // Act
    const result = await search(bobOnOldHub, { query: "login" });

    // Assert
    expect(result.isError).toBe(false);
    expect(result.text).toContain(alice.workContextId);
    expect(result.text).not.toContain("Filters:");
  });

  test("refuses on the developer alone, and on the window alone", async () => {
    // Act
    const person = await search(bobOnOldHub, {
      query: "login",
      developer: "Alice",
    });
    const window = await search(bobOnOldHub, { query: "login", since: "14d" });

    // Assert: each names the filter that went unapplied and not the other, so
    // the sentence cannot be read as a blanket complaint about the hub. The
    // header says "other developers" on every surface, so the assertions are
    // on the FILTER phrase rather than on the bare word.
    expect(person.isError).toBe(true);
    expect(person.text).toContain("the developer filter this call sent");
    expect(person.text).not.toContain("since filter");
    expect(window.isError).toBe(true);
    expect(window.text).toContain("the since filter this call sent");
    expect(window.text).not.toContain("developer filter");
  });
});
