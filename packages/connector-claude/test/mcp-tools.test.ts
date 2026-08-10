/**
 * The four tools, against a REAL hub.
 *
 * Not a mock: `createServer` over PGlite, the same stack the e2e test drives, so
 * the rules these tools have to explain — the dedup gate, the supersedes
 * ownership rule, the liveness gate on the producer session — are enforced by
 * the code that actually enforces them rather than by a fixture that agrees with
 * the test.
 *
 * WHAT IS ASSERTED HERE is behaviour and failure text. The adversarial rendering
 * half lives in test/mcp-injection.test.ts, and the wire framing in
 * test/mcp-protocol.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import type { Db, Embedder } from "@crosscheck/server";
import { MAX_CLAIM_BODY_LENGTH } from "@crosscheck/schema";

import { MAX_SEARCH_QUERY_CHARS } from "../src/constants.ts";

import { prepareMcp } from "../src/mcp/context.ts";
import type { McpContext } from "../src/mcp/context.ts";
import { findTool } from "../src/mcp/tools/index.ts";
import { writeSessionState } from "../src/state/session-state.ts";
import type { Env } from "../src/index.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ADMIN_TOKEN = "mcp-admin-token";
const REPO_ID = "github.com/acme/api";

let db: Db;
let app: ReturnType<typeof createServer>;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
const cleanups: string[] = [];

interface Developer {
  readonly developerId: string;
  readonly apiKey: string;
  readonly home: string;
  readonly repo: string;
  readonly env: Env;
  readonly sessionId: string;
  readonly workContextId: string;
}

let alice: Developer;
let bob: Developer;

const envFor = (home: string, apiKey: string): Env => ({
  CROSSCHECK_HOME: home,
  CROSSCHECK_HUB_URL: hubUrl,
  CROSSCHECK_API_KEY: apiKey,
});

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

/**
 * A developer with a hub session, a work context, and the session state file
 * SessionStart would have written — which is the only thing the MCP tools have
 * to find their way back to their own work context.
 */
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
  await fetch(`${hubUrl}/api/records`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      cx: "0.1",
      id: `env_${crypto.randomUUID()}`,
      ts: startedAt,
      producer: {
        developerId: account.developerId,
        agentKind: "claude-code",
        sessionId,
      },
      kind: "work_context",
      body: {
        id: workContextId,
        sessionId,
        title,
        status: "analyzing",
        createdAt: startedAt,
      },
    }),
  });
  await writeSessionState(home, {
    claudeSessionId: `${label}-uuid`,
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
    home,
    repo,
    env: envFor(home, account.apiKey),
    sessionId,
    workContextId,
  };
};

const contextFor = async (developer: Developer): Promise<McpContext> => {
  const setup = await prepareMcp(developer.env, developer.repo);
  if (!setup.ok) {
    throw new Error(`prepareMcp failed: ${setup.message}`);
  }
  return setup.ctx;
};

interface Called {
  readonly text: string;
  readonly isError: boolean;
}

const call = async (
  developer: Developer,
  name: string,
  args: unknown,
): Promise<Called> => {
  const tool = findTool(name);
  if (tool === undefined) {
    throw new Error(`no tool ${name}`);
  }
  const result = await tool.run(await contextFor(developer), args);
  return {
    text: result.content.map((part) => part.text).join("\n"),
    isError: result.isError === true,
  };
};

beforeAll(async () => {
  db = await createDb();
  app = createServer({ db, adminToken: ADMIN_TOKEN });
  server = Bun.serve({ port: 0, fetch: app.fetch });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;

  alice = await setUpDeveloper(
    "alice",
    "Alice",
    "alice-mcp@example.com",
    "Login 500s on staging",
  );
  bob = await setUpDeveloper(
    "bob",
    "Bob",
    "bob-mcp@example.com",
    "Rate limiter drops burst traffic",
  );
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("the tool registry", () => {
  test("declares exactly the four tools, each with a usable schema", () => {
    // Arrange: `tools/list` is how a model learns what it may call, so a tool
    // with no description or no schema is a tool it will call wrongly
    const names = [
      "publish_claim",
      "extend_diagnosis",
      "get_diagnosis",
      "search_related_work",
    ];

    // Act + Assert
    for (const name of names) {
      const tool = findTool(name);
      expect(tool, name).toBeDefined();
      expect(tool?.definition.description.length, name).toBeGreaterThan(80);
      expect(tool?.definition.inputSchema["type"], name).toBe("object");
    }
  });

  test("search_related_work says in its own description what it is not", () => {
    // Arrange: the semantic search block does not exist. A model told only
    // "search related work" will read an empty result as "nobody has worked on
    // this", which is a conclusion the lexical match cannot support.
    const description =
      findTool("search_related_work")?.definition.description ?? "";

    // Assert
    expect(description.toLowerCase()).toContain("lexical");
    expect(description.toLowerCase()).toContain("this repo");
    expect(description.toLowerCase()).toContain("not");
  });
});

describe("publish_claim", () => {
  test("records a claim on the caller's own work context", async () => {
    // Act
    const result = await call(alice, "publish_claim", {
      kind: "hypothesis",
      body: "The refresh path never reloads the rotated key",
    });

    // Assert
    expect(result.isError).toBe(false);
    expect(result.text).toContain("clm_");

    // And it is really in the tree, not merely acknowledged
    const read = await call(alice, "get_diagnosis", {
      workContextId: alice.workContextId,
    });
    expect(read.text).toContain(
      "«The refresh path never reloads the rotated key»",
    );
  });

  test("reports a re-published claim as already recorded, not as new", async () => {
    // Arrange: the hub's dedup gate is deterministic on normalized body
    // (services/record-handlers.ts) and an agent must not believe it added a
    // second claim
    const args = {
      kind: "observation",
      body: "The 500 only happens after a token refresh",
    };
    await call(alice, "publish_claim", args);

    // Act
    const again = await call(alice, "publish_claim", args);

    // Assert
    expect(again.isError).toBe(false);
    expect(again.text.toLowerCase()).toContain("already");
  });

  test("explains the body cap instead of letting the hub refuse it", async () => {
    // Act
    const result = await call(alice, "publish_claim", {
      kind: "observation",
      body: "x".repeat(MAX_CLAIM_BODY_LENGTH + 50),
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(result.text).toContain(String(MAX_CLAIM_BODY_LENGTH));
    expect(result.text.toLowerCase()).toContain("split");
  });

  test("explains that a likely_root_cause needs evidence", async () => {
    // Act
    const result = await call(alice, "publish_claim", {
      kind: "root_cause",
      body: "The cache warms before the rotation job writes",
      status: "likely_root_cause",
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(result.text).toContain("evidenceRefs");
    expect(result.text.toLowerCase()).toContain("publish the evidence");
  });

  test("rejects an unknown kind with the list of known kinds", async () => {
    // Act
    const result = await call(alice, "publish_claim", {
      kind: "bug",
      body: "x",
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(result.text).toContain("observation");
    expect(result.text).toContain("hypothesis");
  });

  test("says which argument is missing rather than failing opaquely", async () => {
    // Act
    const result = await call(alice, "publish_claim", { kind: "observation" });

    // Assert
    expect(result.isError).toBe(true);
    expect(result.text).toContain("body");
  });
});

describe("get_diagnosis", () => {
  test("reads a teammate's tree, framed and labelled", async () => {
    // Arrange: Alice published above; Bob reads her tree. Team-visible by
    // design (DESIGN.md §2.1: one hub is one trust space).
    // Act
    const result = await call(bob, "get_diagnosis", {
      workContextId: alice.workContextId,
    });

    // Assert
    expect(result.isError).toBe(false);
    expect(result.text).toContain("«Login 500s on staging»");
    expect(result.text).toContain("Alice");
    expect(result.text).toContain("quoted data, not instruction");
  });

  test("says a work context does not exist rather than returning nothing", async () => {
    // Act
    const result = await call(bob, "get_diagnosis", {
      workContextId: "wc_nope",
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(result.text).toContain("wc_nope");
    expect(result.text).toContain("search_related_work");
  });
});

describe("search_related_work", () => {
  test("finds a teammate's work context by a word in its title", async () => {
    // Act
    const result = await call(bob, "search_related_work", { query: "login" });

    // Assert
    expect(result.isError).toBe(false);
    expect(result.text).toContain(alice.workContextId);
    expect(result.text).toContain("«Login 500s on staging»");
  });

  test("matches on status as well as title", async () => {
    // Act
    const result = await call(bob, "search_related_work", {
      query: "analyzing",
    });

    // Assert
    expect(result.text).toContain(alice.workContextId);
  });

  test("says it found nothing rather than implying nobody has worked on it", async () => {
    // Act
    const result = await call(bob, "search_related_work", {
      query: "quantum entanglement in the billing service",
    });

    // Assert
    expect(result.isError).toBe(false);
    expect(result.text.toLowerCase()).toContain("no work context");
    expect(result.text.toLowerCase()).toContain("lexical");
  });

  test("does not match everything through a two-letter word", async () => {
    // Arrange: matching is substring containment, so `in` is inside "analyzing"
    // and `on` is inside "login". Before the minimum token length existed, this
    // exact query matched «Login 500s on staging» — a work context it shares no
    // subject with — and the tool reported a hit for a question nobody asked.
    // Act
    const result = await call(bob, "search_related_work", {
      query: "quantum entanglement in the billing service",
    });

    // Assert
    expect(result.text).not.toContain(alice.workContextId);
  });

  test("says a query of only short words matched nothing, and why", async () => {
    // Arrange: dropping short tokens must not silently turn a specific question
    // into "list everything" — that is the same lie as an unfiltered match,
    // told in the other direction.
    // Act
    const result = await call(bob, "search_related_work", { query: "in on at" });

    // Assert
    expect(result.text).not.toContain(alice.workContextId);
    expect(result.text).toContain("3");
  });

  test("an empty query lists the most recent work rather than nothing", async () => {
    // Arrange: the documented way to ask "what is happening on this repo"
    // Act
    const result = await call(bob, "search_related_work", { query: "" });

    // Assert
    expect(result.text).toContain(alice.workContextId);
  });

  test("truncates an oversized query instead of bouncing off the hub cap", async () => {
    // Arrange: the tool invites "distinctive words of the problem" and agents
    // paste whole stack traces. The hub rejects queries past its boundary
    // (server SEARCH_MAX_QUERY_CHARS → 400); the connector sends the first
    // MAX_SEARCH_QUERY_CHARS characters instead of relaying that refusal.
    const pasted = `login ${"y".repeat(3 * MAX_SEARCH_QUERY_CHARS)}`;

    // Act
    const result = await call(bob, "search_related_work", { query: pasted });

    // Assert: searched and answered — the leading words still matched
    expect(result.isError).toBe(false);
    expect(result.text).toContain(alice.workContextId);
  });

  test("returns the caller's own context too — discovery is not filtered", async () => {
    // Arrange: unlike the briefing, which hides the reader's own work because it
    // would be noise, search answers a question the agent asked. Hiding its own
    // tree would make `get_diagnosis` on itself unreachable.
    // Act
    const result = await call(alice, "search_related_work", { query: "login" });

    // Assert
    expect(result.text).toContain(alice.workContextId);
  });
});

describe("extend_diagnosis", () => {
  test("adds Bob's claim and a deeper_cause_of edge to Alice's tree", async () => {
    // Arrange: the product's headline move — "your root cause is my symptom"
    const target = await call(alice, "publish_claim", {
      kind: "hypothesis",
      body: "The token endpoint returns a stale key",
    });
    const targetId = /clm_[\w-]+/.exec(target.text)?.[0] ?? "";
    expect(targetId.length).toBeGreaterThan(0);

    // Act
    const result = await call(bob, "extend_diagnosis", {
      workContextId: alice.workContextId,
      targetClaimId: targetId,
      kind: "evidence",
      body: "The rotation job commits after the cache warm, so the key is stale by design",
      edgeKind: "deeper_cause_of",
      note: "same window as the rate limiter incident",
    });

    // Assert
    expect(result.isError).toBe(false);

    // And Alice sees it when she reads her own tree back
    const tree = await call(alice, "get_diagnosis", {
      workContextId: alice.workContextId,
    });
    expect(tree.text).toContain("Bob");
    expect(tree.text).toContain("«The rotation job commits after the cache warm");
    expect(tree.text).toContain("deeper_cause_of");
  });

  test("explains the supersedes rule instead of echoing a refusal", async () => {
    // Arrange: supersedes is same-author revision semantics (DESIGN.md §5), so
    // Bob may not use it against Alice's claim
    const target = await call(alice, "publish_claim", {
      kind: "observation",
      body: "Retries make the 500 more likely, not less",
    });
    const targetId = /clm_[\w-]+/.exec(target.text)?.[0] ?? "";

    // Act
    const result = await call(bob, "extend_diagnosis", {
      workContextId: alice.workContextId,
      targetClaimId: targetId,
      kind: "observation",
      body: "Retries are unrelated — the 500 predates the retry policy",
      edgeKind: "supersedes",
    });

    // Assert: the RULE, and what to use instead
    expect(result.isError).toBe(true);
    expect(result.text).toContain("supersedes");
    expect(result.text).toContain("contradicts");
    expect(result.text).toContain("deeper_cause_of");
    expect(result.text).not.toContain("403");
  });

  test("says a target claim does not exist rather than orphaning a claim", async () => {
    // Act
    const result = await call(bob, "extend_diagnosis", {
      workContextId: alice.workContextId,
      targetClaimId: "clm_does_not_exist",
      kind: "hypothesis",
      body: "Something about a claim that is not there",
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(result.text.toLowerCase()).toContain("claim");
  });

  test("says an unknown work context is unknown", async () => {
    // Act
    const result = await call(bob, "extend_diagnosis", {
      workContextId: "wc_nope",
      targetClaimId: "clm_whatever",
      kind: "hypothesis",
      body: "Into a tree that does not exist",
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(result.text).toContain("wc_nope");
  });
});

describe("a hub that is not answering", () => {
  const DEAD_PORT = 1;

  test("every tool says the hub is unreachable, and names it", async () => {
    // Arrange: fail LOUDLY — the opposite of the hook path, which fails open.
    //
    // The session state has to be seeded FOR THE DEAD HUB, and finding that out
    // was this test's first act of work. Pointing only the env at a dead port
    // left publish_claim answering "no active session for this repo", which is
    // correct rather than evasive: session state is hub-scoped, so a session
    // registered against the live hub is genuinely not a session on the dead
    // one. Without this seed the test would have been asserting a message the
    // network never got the chance to produce.
    const deadHub = `http://127.0.0.1:${String(DEAD_PORT)}`;
    const startedAt = new Date().toISOString();
    await writeSessionState(alice.home, {
      claudeSessionId: "dead-uuid",
      crosscheckSessionId: "cc_dead-uuid",
      workContextId: "wc_cc_dead-uuid",
      repoId: REPO_ID,
      repoRoot: alice.repo,
      hubUrl: deadHub,
      developerId: alice.developerId,
      startedAt,
      lastHeartbeatAt: startedAt,
      seenTargets: [],
    });
    const deadEnv: Env = {
      CROSSCHECK_HOME: alice.home,
      CROSSCHECK_HUB_URL: deadHub,
      CROSSCHECK_API_KEY: alice.apiKey,
    };
    const setup = await prepareMcp(deadEnv, alice.repo);
    if (!setup.ok) {
      throw new Error(setup.message);
    }

    // Act + Assert
    for (const [name, args] of [
      ["publish_claim", { kind: "observation", body: "anything at all" }],
      ["get_diagnosis", { workContextId: "wc_x" }],
      ["search_related_work", { query: "anything" }],
    ] as const) {
      const tool = findTool(name);
      const result = await tool?.run(setup.ctx, args);
      const text = (result?.content ?? []).map((part) => part.text).join("\n");
      expect(result?.isError, name).toBe(true);
      expect(text, name).toContain("127.0.0.1");
    }
  });

  test("an invalid api key is reported as an invalid api key", async () => {
    // Arrange
    const badEnv: Env = {
      CROSSCHECK_HOME: alice.home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: "cx_not_a_real_key",
    };
    const setup = await prepareMcp(badEnv, alice.repo);
    if (!setup.ok) {
      throw new Error(setup.message);
    }

    // Act
    const result = await findTool("search_related_work")?.run(setup.ctx, {
      query: "login",
    });
    const text = (result?.content ?? []).map((part) => part.text).join("\n");

    // Assert
    expect(result?.isError).toBe(true);
    expect(text.toLowerCase()).toContain("api key");
    expect(text).toContain("crosscheck login");
  });
});

describe("a repo with no crosscheck session", () => {
  test("publish_claim says the session hook has not run", async () => {
    // Arrange: an MCP server can be started before any SessionStart wrote state
    const home = await makeHome("mcp-sessionless");
    const repo = await makeRepo("mcp-sessionless", {
      remote: "git@github.com:acme/api.git",
    });
    cleanups.push(home, repo);

    // Act
    const result = await call(
      { ...alice, home, repo, env: envFor(home, alice.apiKey) },
      "publish_claim",
      { kind: "observation", body: "nowhere to put this" },
    );

    // Assert: names the cause and the fix, rather than failing on a null id
    expect(result.isError).toBe(true);
    expect(result.text.toLowerCase()).toContain("session");
    expect(result.text).toContain("crosscheck");
  });

  test("get_diagnosis still works — reading needs no session of your own", async () => {
    // Arrange: the asymmetry is deliberate. Writing needs a work context to
    // write to; reading someone else's tree does not.
    const home = await makeHome("mcp-readonly");
    const repo = await makeRepo("mcp-readonly", {
      remote: "git@github.com:acme/api.git",
    });
    cleanups.push(home, repo);

    // Act
    const result = await call(
      { ...alice, home, repo, env: envFor(home, alice.apiKey) },
      "get_diagnosis",
      { workContextId: alice.workContextId },
    );

    // Assert
    expect(result.isError).toBe(false);
    expect(result.text).toContain("«Login 500s on staging»");
  });
});

describe("search_related_work runs on the hub's search block", () => {
  test("reaches words that live only in claim bodies", async () => {
    // Arrange: "keystore" appears in no title and no status — a client-side
    // title match cannot find it; the hub's FTS over claim summaries can
    await call(alice, "publish_claim", {
      kind: "observation",
      body: "The keystore rotation drops the active alias",
    });

    // Act
    const result = await call(bob, "search_related_work", {
      query: "keystore",
    });

    // Assert
    expect(result.isError).toBe(false);
    expect(result.text).toContain(alice.workContextId);
  });

  test("announces the semantic tier only when the hub has an embedder", async () => {
    // Arrange keyless half: the shared hub has no embedder, so the method
    // line must keep saying so
    const keyless = await call(bob, "search_related_work", { query: "login" });
    expect(keyless.text.toLowerCase()).toContain("not a semantic search");

    // Arrange semantic half: a second hub WITH an embedder. The fake maps
    // login-flavored text onto one axis, everything else onto another, so
    // "authentication timeouts" is a pure cross-vocabulary match — zero
    // shared lexemes with "Login 500s on staging".
    const embedder: Embedder = {
      model: "fake:test-axes@768d",
      embed: (texts) =>
        Promise.resolve(
          texts.map((text) => {
            const vector = new Array<number>(768).fill(0);
            vector[/login|authentication|signin/i.test(text) ? 0 : 1] = 1;
            return vector;
          }),
        ),
    };
    const semanticDb = await createDb();
    const semanticApp = createServer({
      db: semanticDb,
      adminToken: ADMIN_TOKEN,
      embedder,
    });
    const semanticServer = Bun.serve({ port: 0, fetch: semanticApp.fetch });
    const semanticHubUrl = `http://127.0.0.1:${String(semanticServer.port)}`;
    try {
      const response = await fetch(`${semanticHubUrl}/api/developers`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Eve", email: "eve-mcp@example.com" }),
      });
      const created = (await response.json()) as {
        data: { developer: { id: string }; apiKey: string };
      };
      const apiKey = created.data.apiKey;
      const sessionId = "cc_eve-uuid";
      const workContextId = `wc_${sessionId}`;
      const startedAt = new Date().toISOString();
      await fetch(`${semanticHubUrl}/api/sessions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
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
      await fetch(`${semanticHubUrl}/api/records`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          cx: "0.1",
          id: `env_${crypto.randomUUID()}`,
          ts: startedAt,
          producer: {
            developerId: created.data.developer.id,
            agentKind: "claude-code",
            sessionId,
          },
          kind: "work_context",
          body: {
            id: workContextId,
            sessionId,
            title: "Login 500s on staging",
            status: "analyzing",
            createdAt: startedAt,
          },
        }),
      });
      const home = await makeHome("mcp-semantic");
      const repo = await makeRepo("mcp-semantic", {
        remote: "git@github.com:acme/api.git",
      });
      cleanups.push(home, repo);
      await writeSessionState(home, {
        claudeSessionId: "eve-uuid",
        crosscheckSessionId: sessionId,
        workContextId,
        repoId: REPO_ID,
        repoRoot: repo,
        hubUrl: semanticHubUrl,
        developerId: created.data.developer.id,
        startedAt,
        lastHeartbeatAt: startedAt,
        seenTargets: [],
      });
      const eve: Developer = {
        developerId: created.data.developer.id,
        apiKey,
        home,
        repo,
        env: {
          CROSSCHECK_HOME: home,
          CROSSCHECK_HUB_URL: semanticHubUrl,
          CROSSCHECK_API_KEY: apiKey,
        },
        sessionId,
        workContextId,
      };

      // Act: zero lexical overlap — only the vector tier can find this
      const semantic = await call(eve, "search_related_work", {
        query: "authentication timeouts",
      });

      // Assert: found across vocabulary, and the method line stops denying
      // semantic search
      expect(semantic.isError).toBe(false);
      expect(semantic.text).toContain(workContextId);
      expect(semantic.text.toLowerCase()).not.toContain(
        "not a semantic search",
      );
      expect(semantic.text.toLowerCase()).toContain("semantic");
    } finally {
      semanticServer.stop(true);
    }
  });
});
