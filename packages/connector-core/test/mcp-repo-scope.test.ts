/**
 * WHICH AXIS THE TRUST BOUNDARY RUNS ON: the hub, not the repo.
 *
 * Two repos — `github.com/acme/api` and `github.com/acme/web` — against ONE
 * hub. Alice works in the first, Carol in the second, and both hold keys to the
 * same hub. The question this file settles is whether Carol may read and extend
 * Alice's diagnosis, and it settles it by ASSERTING THE ANSWER rather than
 * leaving it to whichever way the code happens to lean.
 *
 * THE ANSWER IS YES, AND IT IS A DESIGN DECISION (DESIGN.md §2.1):
 *
 *   - "One hub = one trust space… a 'team' is exactly the set of people holding
 *     keys to a hub." The repo decides where a session REPORTS, not what a
 *     member may read.
 *   - "Later, not v0: per-repo ACLs within one hub. Until then the rule is
 *     simple: different trust requirements → different hubs." Enforcing a repo
 *     boundary here would be shipping the feature that line defers, and §9
 *     lists per-repo ACLs among the explicit non-goals.
 *   - It is the product. A claim about an API contract published from
 *     `acme/api` is exactly what somebody in `acme/web` needs before they spend
 *     a day rediscovering it.
 *
 * WHY THIS FILE EXISTS AT ALL. The decision was previously unwritten and
 * untested, so it held only by accident. HISTORICAL, measured on this branch
 * before this file was added and not re-derivable from this tree: enforcing the
 * opposite — `get_diagnosis` refusing any work context not listed for the
 * caller's repo — left the whole suite at 483 pass / 0 fail. A product axis
 * that can be inverted without a single test going red is not a decision, it is
 * a coincidence.
 *
 * With this file present that same inversion turns "Carol, in the web repo,
 * reads Alice's api-repo tree in full" red — ONE test, not all seven, and the
 * difference is worth stating. The read is the load-bearing assertion; the two
 * that follow it depend on the read having worked, and the two search tests are
 * about the OTHER half of the decision, so an inversion of `get_diagnosis`
 * alone leaves them green by construction. Measured, restored, source
 * unchanged.
 *
 * WHAT IS *NOT* CLAIMED. `search_related_work` really is repo-scoped, and the
 * last two tests hold it to that — but that scoping is RELEVANCE, not a
 * boundary. The repo is derived from the git remote on the CALLER's machine
 * (`ctx.identity.repoId`), so the hub cannot re-derive it from the API key: one
 * developer legitimately works across many repos against one hub. A filter
 * whose value the client chooses can order results; it cannot contain anybody.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import { prepareMcp } from "../src/mcp/context.ts";
import type { McpContext } from "../src/mcp/context.ts";
import { findTool } from "../src/mcp/tools/index.ts";
import { writeSessionState } from "../src/state/session-state.ts";
import type { Env } from "../src/index.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ADMIN_TOKEN = "repo-scope-admin-token";

const API_REPO = "github.com/acme/api";
const WEB_REPO = "github.com/acme/web";

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
let carol: Developer;

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
 * A developer whose session is in a NAMED repo — that argument is the whole
 * point of this file, so it is a parameter rather than a constant.
 */
const setUpDeveloper = async (
  label: string,
  name: string,
  email: string,
  title: string,
  repoId: string,
  remote: string,
): Promise<Developer> => {
  const account = await createDeveloper(name, email);
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote });
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
      repo: repoId,
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
    hostSessionKey: `${label}-uuid`,
    crosscheckSessionId: sessionId,
    workContextId,
    repoId,
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
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: account.apiKey,
    },
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
    "rs-alice",
    "Alice",
    "alice-reposcope@example.com",
    "Login 500s on staging",
    API_REPO,
    "git@github.com:acme/api.git",
  );
  carol = await setUpDeveloper(
    "rs-carol",
    "Carol",
    "carol-reposcope@example.com",
    "Checkout page blank after deploy",
    WEB_REPO,
    "git@github.com:acme/web.git",
  );
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("the trust boundary is the hub, not the repo", () => {
  let aliceClaimId: string;

  test("the two developers really are in different repos", async () => {
    // Arrange + Act: through prepareMcp, so this is the id the tools use rather
    // than the one this file hoped they would.
    const aliceCtx = await contextFor(alice);
    const carolCtx = await contextFor(carol);

    // Assert
    expect(aliceCtx.identity.repoId).toBe(API_REPO);
    expect(carolCtx.identity.repoId).toBe(WEB_REPO);
  });

  test("Alice publishes onto her own work context in the api repo", async () => {
    // Act
    const published = await call(alice, "publish_claim", {
      kind: "hypothesis",
      body: "The login 500s start when the token rotation job overruns its window.",
      confidence: 0.7,
    });

    // Assert
    expect(published.isError).toBe(false);
    const found = /clm_[0-9a-f-]+/.exec(published.text);
    expect(found).not.toBeNull();
    aliceClaimId = found?.[0] ?? "";
  });

  test("Carol, in the web repo, reads Alice's api-repo tree in full", async () => {
    // Act
    const read = await call(carol, "get_diagnosis", {
      workContextId: alice.workContextId,
    });

    // Assert: the whole tree, not a stub — the body is what makes it worth
    // reading, and it is the thing a repo boundary would have withheld.
    expect(read.isError).toBe(false);
    expect(read.text).toContain(aliceClaimId);
    expect(read.text).toContain("token rotation job overruns its window");
    expect(read.text).toContain("Alice");
  });

  test("Carol contradicts a claim in a repo she is not working in", async () => {
    // Act
    const extended = await call(carol, "extend_diagnosis", {
      workContextId: alice.workContextId,
      targetClaimId: aliceClaimId,
      kind: "evidence",
      body: "The rotation job finished inside its window on every 500 we sampled.",
      edgeKind: "contradicts",
    });

    // Assert
    expect(extended.isError).toBe(false);
    expect(extended.text).toContain("contradicts");
  });

  test("Alice sees Carol's cross-repo claim in her own tree, attributed", async () => {
    // Act
    const reread = await call(alice, "get_diagnosis", {
      workContextId: alice.workContextId,
    });

    // Assert: attribution is the point — a claim from another repo must arrive
    // with a name on it, not anonymously.
    expect(reread.isError).toBe(false);
    expect(reread.text).toContain("finished inside its window");
    expect(reread.text).toContain("Carol");
  });

  test("search_related_work stays scoped to the caller's own repo", async () => {
    // Act: Carol searches for the words of ALICE's title, from the web repo.
    const searched = await call(carol, "search_related_work", {
      query: "login staging",
    });

    // Assert: scoping is relevance, and it holds — Alice's api-repo context is
    // not listed, even though the previous tests prove Carol may read it by id.
    expect(searched.isError).toBe(false);
    expect(searched.text).not.toContain(alice.workContextId);
  });

  test("and Alice's own search does find her own repo's work", async () => {
    // Act: the same query from the repo it belongs to, so the test above is
    // shown to be about the REPO rather than about the query missing.
    const searched = await call(alice, "search_related_work", {
      query: "login staging",
    });

    // Assert
    expect(searched.isError).toBe(false);
    expect(searched.text).toContain(alice.workContextId);
  });
});
