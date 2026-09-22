/**
 * THE REVALIDATION LANE, END TO END (1.0 spec 02 §3.6, §6, CCB-3/CCB-5/CCB-9).
 *
 * A claim is bound to a commit by the time it reaches the hub, and nothing
 * ever asks whether that commit is still the code. `get_diagnosis` is where a
 * reader is already waiting — inside MCP_TIMEOUT_MS, on no hook path — so it
 * is where the question gets asked, per distinct (commit, path-set) group,
 * under CLAIM_REVALIDATION_MAX_COMMITS and CLAIM_REVALIDATION_MAX_GIT_CALLS.
 *
 * THE DOWNGRADE MUST LAND ON *THIS* PULL. A leg that GETs the tree, computes
 * drift and POSTs it has told the hub something the reader will not see until
 * they pull again — and AT-2 says the downgrade is visible, not eventually
 * visible. The connector therefore renders the validity the hub DERIVED from
 * the write it just accepted, rather than deriving a second opinion locally:
 * one authority, one round trip, no second definition.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import { REVALIDATION_GROUPS_PER_PULL } from "../src/flows/claim-revalidation.ts";
import { prepareMcp } from "../src/mcp/context.ts";
import { findTool } from "../src/mcp/tools/index.ts";
import { writeSessionState } from "../src/state/session-state.ts";
import type { Env } from "../src/index.ts";
import { git, makeHome, makeRepo, writeRepoFile } from "./helpers.ts";

const ADMIN_TOKEN = "reval-admin-token";
const REPO_ID = "github.com/acme/api";
const SURFACE = "src/auth/verify.ts";

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
/** A hub too old to know the revalidation route: everything else passes. */
let oldHub: ReturnType<typeof Bun.serve>;
let oldHubUrl: string;
const cleanups: string[] = [];

interface Fixture {
  readonly env: Env;
  readonly repo: string;
  readonly apiKey: string;
  readonly developerId: string;
  readonly sessionId: string;
  readonly workContextId: string;
}

interface SetUpOptions {
  /** The repo the tree's SESSION registers under; the checkout stays REPO_ID. */
  readonly sessionRepo?: string;
  /** The hub the connector talks to; the fixture always seeds the real one. */
  readonly connectorHubUrl?: string;
}

const headOf = async (root: string): Promise<string> => {
  const proc = Bun.spawn({
    cmd: ["git", "rev-parse", "HEAD"],
    cwd: root,
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  return (await new Response(proc.stdout).text()).trim();
};

/**
 * A commit that has LANDED ON THE DEFAULT BRANCH, which is the only thing the
 * revalidation leg will look at.
 *
 * `refs/remotes/origin/main` is what a fetch leaves behind, and the leg asks
 * `X..origin/main` deliberately rather than `X..HEAD`: a reader sitting on an
 * unmerged feature branch must not mark a teammate's claim stale for the whole
 * team on the strength of their own work in progress, and the downgrade-only
 * rule would make that verdict unwalkable-back. So the fixture moves the
 * remote-tracking ref exactly as a fetch would.
 */
const land = async (repo: string): Promise<string> => {
  await git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return headOf(repo);
};

const commitAll = async (repo: string, message: string): Promise<string> => {
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", message]);
  return land(repo);
};

/** One landed commit that rewrites the surface, so X..origin/main names it. */
const rewrite = async (repo: string, body: string): Promise<string> => {
  await writeRepoFile(repo, SURFACE, body);
  return commitAll(repo, "rewrite");
};

const postAs = (
  apiKey: string,
  path: string,
  body: unknown,
): Promise<Response> =>
  fetch(`${hubUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

const envelope = (
  fixture: Pick<Fixture, "developerId" | "sessionId">,
  kind: string,
  body: unknown,
): unknown => ({
  cx: "0.1",
  id: `env_${crypto.randomUUID()}`,
  ts: new Date().toISOString(),
  producer: {
    developerId: fixture.developerId,
    agentKind: "claude-code",
    sessionId: fixture.sessionId,
  },
  kind,
  body,
});

const setUp = async (
  label: string,
  options: SetUpOptions = {},
): Promise<Fixture> => {
  const created = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: label, email: `${label}@example.com` }),
  });
  const account = (await created.json()) as {
    data: { developer: { id: string }; apiKey: string };
  };
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  cleanups.push(home, repo);
  await writeRepoFile(repo, SURFACE, "export const v = 1;\n");
  await commitAll(repo, "surface");

  const sessionId = `cc_${label}-uuid`;
  const workContextId = `wc_${sessionId}`;
  const startedAt = new Date().toISOString();
  const apiKey = account.data.apiKey;
  const developerId = account.data.developer.id;
  const ids = { developerId, sessionId };
  await postAs(apiKey, "/api/sessions", {
    id: sessionId,
    agentKind: "claude-code",
    repo: options.sessionRepo ?? REPO_ID,
    branch: "main",
    baseCommit: await headOf(repo),
    status: "analyzing",
  });
  await postAs(
    apiKey,
    "/api/records",
    envelope(ids, "work_context", {
      id: workContextId,
      sessionId,
      title: "Login 500s on staging",
      status: "analyzing",
      createdAt: startedAt,
    }),
  );
  // The context's own file target — the FALLBACK surface every claim that
  // declares no paths is revalidated against. Asserted, because a refused
  // record here is silent and turns every context-target case into a test
  // of an empty tree.
  const target = await postAs(
    apiKey,
    "/api/records",
    envelope(ids, "target", { workContextId, kind: "file", value: SURFACE }),
  );
  const targetOutcome = (await target.json()) as { data: { accepted: number } };
  expect(targetOutcome.data.accepted).toBe(1);
  const connectorHub = options.connectorHubUrl ?? hubUrl;
  await writeSessionState(home, {
    hostSessionKey: `${label}-uuid`,
    crosscheckSessionId: sessionId,
    workContextId,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl: connectorHub,
    developerId,
    startedAt,
    lastHeartbeatAt: startedAt,
    seenTargets: [],
  });
  return {
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: connectorHub,
      CROSSCHECK_API_KEY: apiKey,
    },
    repo,
    apiKey,
    developerId,
    sessionId,
    workContextId,
  };
};

const call = async (
  fixture: Fixture,
  name: string,
  args: unknown,
): Promise<string> => {
  const tool = findTool(name);
  if (tool === undefined) {
    throw new Error(`no tool ${name}`);
  }
  const setup = await prepareMcp(fixture.env, fixture.repo);
  if (!setup.ok) {
    throw new Error(`prepareMcp failed: ${setup.message}`);
  }
  const result = await tool.run(setup.ctx, args);
  return result.content.map((part) => part.text).join("\n");
};

/** A claim bound to the CURRENT head, declaring the surface it is about. */
const publish = async (
  fixture: Fixture,
  body: string,
  affectedPaths: readonly string[] = [SURFACE],
): Promise<void> => {
  await call(fixture, "publish_claim", {
    kind: "root_cause",
    body,
    status: "proposed",
    confidence: 0.7,
    affectedPaths,
  });
};

/**
 * Claims written straight to the hub, bound to `commit`, declaring nothing —
 * so the whole tree shares ONE (commit, path-set) group on the context
 * targets. One ingest batch, because a tool call per claim would spend the
 * case timeout on setup.
 */
const seedClaims = async (
  fixture: Fixture,
  count: number,
  commit: string,
): Promise<void> => {
  const createdAt = new Date().toISOString();
  const response = await postAs(fixture.apiKey, "/api/records", {
    records: Array.from({ length: count }, (_unused, index) =>
      envelope(fixture, "claim", {
        id: `clm_${fixture.sessionId}_${String(index)}`,
        workContextId: fixture.workContextId,
        authorSessionId: fixture.sessionId,
        kind: "observation",
        body: `The rotated key is dropped on path number ${String(index)}`,
        status: "proposed",
        confidence: 0.5,
        captureMode: "agent",
        provenance: "declared",
        evidenceRefs: [],
        observedAtCommit: commit,
        createdAt,
      }),
    ),
  });
  const outcome = (await response.json()) as { data: { accepted: number } };
  expect(outcome.data.accepted).toBe(count);
};

/** The STORED states, read around the connector — what was actually spent. */
const storedStates = async (
  fixture: Fixture,
): Promise<ReadonlyMap<string, string>> => {
  const response = await fetch(
    `${hubUrl}/api/work-contexts/${fixture.workContextId}/diagnosis`,
    { headers: { Authorization: `Bearer ${fixture.apiKey}` } },
  );
  const tree = (await response.json()) as {
    data: { claims: { body: string; validity: { state: string } }[] };
  };
  return new Map(
    tree.data.claims.map((claim) => [claim.body, claim.validity.state]),
  );
};

/**
 * PGlite's bootstrap is the whole of `db/bootstrap.sql` on every start and
 * measures 5-7 s on a loaded machine, either side of bun's 5 s default hook
 * timeout. The generous bound is about the FIXTURE, not about the code under
 * test: without it this file reports a hub that never booted as a failure of
 * the revalidation leg.
 */
const HUB_BOOT_TIMEOUT_MS = 60_000;
/** Each case drives many real git commits through a real hub. */
const CASE_TIMEOUT_MS = 60_000;
const HTTP_NOT_FOUND = 404;

beforeAll(async () => {
  db = await createDb();
  const app = createServer({ db, adminToken: ADMIN_TOKEN, embedder: null });
  server = Bun.serve({ port: 0, fetch: app.fetch });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  oldHub = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/claim-revalidations")) {
        return new Response(JSON.stringify({ error: "not_found" }), {
          status: HTTP_NOT_FOUND,
          headers: { "Content-Type": "application/json" },
        });
      }
      return app.fetch(new Request(`${hubUrl}${url.pathname}${url.search}`, request));
    },
  });
  oldHubUrl = `http://127.0.0.1:${String(oldHub.port)}`;
}, HUB_BOOT_TIMEOUT_MS);

afterAll(async () => {
  oldHub.stop(true);
  server.stop(true);
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("a pull asks whether the code under its claims moved", () => {
  test("the downgrade names the commits, on the pull that found it", async () => {
    // Arrange: CCB-3. A root cause recorded at X, then two commits that
    // rewrite exactly the file it declared.
    const fixture = await setUp("reval-names");
    await publish(fixture, "verifyToken drops the rotated signing key");
    const first = await rewrite(fixture.repo, "export const v = 2;\n");
    const second = await rewrite(fixture.repo, "export const v = 3;\n");

    // Act: ONE pull. Not two.
    const text = await call(fixture, "get_diagnosis", {
      workContextId: fixture.workContextId,
    });

    // Assert: still readable, no longer current, and the commits are named.
    expect(text).toContain("verifyToken drops the rotated signing key");
    expect(text).toContain("no longer current");
    expect(text).toContain(second.slice(0, 7));
    expect(text).toContain(first.slice(0, 7));
  }, CASE_TIMEOUT_MS);

  test("an untouched surface reads current, and says on what evidence", async () => {
    // Arrange: CCB-4's other half — same machinery, opposite verdict. The
    // commit that lands touches a DIFFERENT file, so the claim's declared
    // surface is untouched however much the repo moved.
    const fixture = await setUp("reval-untouched");
    await publish(fixture, "The rotated key never reaches the cache");
    await writeRepoFile(fixture.repo, "src/other.ts", "export const o = 1;\n");
    await commitAll(fixture.repo, "elsewhere");

    // Act
    const text = await call(fixture, "get_diagnosis", {
      workContextId: fixture.workContextId,
    });

    // Assert
    expect(text).toContain("current");
    // The sentence names WHAT WAS MEASURED. It used to read "those files
    // have not changed since" — a claim about the default branch, from a
    // reading taken against whatever copy of it this clone holds, on a path
    // that never fetches.
    expect(text).toContain("unchanged up to");
    expect(text).toContain("the default branch as this clone has it");
    expect(text).not.toContain("no longer current");
  }, CASE_TIMEOUT_MS);

  test("the cut is reported, never spent silently", async () => {
    // Arrange: CCB-9. One claim per commit, each declaring its own file, so
    // every claim is its own (commit, path-set) group — more groups than one
    // pull may measure.
    const fixture = await setUp("reval-cut");
    const groups = REVALIDATION_GROUPS_PER_PULL + 3;
    for (let index = 0; index < groups; index += 1) {
      const path = `src/mod-${String(index)}.ts`;
      await writeRepoFile(fixture.repo, path, "export const a = 1;\n");
      await commitAll(fixture.repo, `add ${path}`);
      await publish(fixture, `Claim about ${path} number ${String(index)}`, [
        path,
      ]);
    }

    // Act
    const text = await call(fixture, "get_diagnosis", {
      workContextId: fixture.workContextId,
    });

    // Assert: the surface states what it measured and what it did not.
    expect(text).toContain(
      `revalidated ${String(REVALIDATION_GROUPS_PER_PULL)} of ${String(groups)} claim groups`,
    );
    expect(text).toContain("in the other 3, claims show their last recorded reading");
  }, CASE_TIMEOUT_MS);

  test("the bound is spent newest-first, not at random", async () => {
    // Arrange: the same over-cap tree. The OLDEST groups are the ones that
    // must go unchecked — a bound spent at random is a measurement that
    // cannot be reasoned about (state/capture-health.ts).
    const fixture = await setUp("reval-order");
    const groups = REVALIDATION_GROUPS_PER_PULL + 2;
    const bodies: string[] = [];
    for (let index = 0; index < groups; index += 1) {
      const path = `src/mod-${String(index)}.ts`;
      await writeRepoFile(fixture.repo, path, "export const a = 1;\n");
      await commitAll(fixture.repo, `add ${path}`);
      const body = `Claim about ${path} number ${String(index)}`;
      bodies.push(body);
      await publish(fixture, body, [path]);
      // Every claim's own file is rewritten right after it, so each group
      // would read `changed` if it were checked at all.
      await writeRepoFile(fixture.repo, path, "export const a = 2;\n");
      await commitAll(fixture.repo, `edit ${path}`);
    }

    // Act
    await call(fixture, "get_diagnosis", {
      workContextId: fixture.workContextId,
    });

    // Assert: read the STORED rows, so this is about what was spent rather
    // than about what one render happened to fit. The two oldest go
    // unchecked; every newer one was measured.
    const states = await storedStates(fixture);
    expect(states.get(bodies[0] ?? "")).toBe("unknown");
    expect(states.get(bodies[1] ?? "")).toBe("unknown");
    expect(states.get(bodies[groups - 1] ?? "")).toBe("stale");
    expect(states.get(bodies[groups - 2] ?? "")).toBe("stale");
  }, CASE_TIMEOUT_MS);

  test("a tree larger than one report is revalidated whole", async () => {
    // Arrange: every claim of this tree shares one commit and the context's
    // file targets, so they are ONE group — one git answer for all of them.
    // The report still carries one entry per claim, and a report cap below
    // the hub's own diagnosis cap would refuse the whole reading for any
    // tree past it: nothing recorded, every claim `unknown`, forever.
    const fixture = await setUp("reval-large");
    const count = 60;
    await seedClaims(fixture, count, await headOf(fixture.repo));
    await rewrite(fixture.repo, "export const v = 2;\n");

    // Act
    const text = await call(fixture, "get_diagnosis", {
      workContextId: fixture.workContextId,
    });

    // Assert
    expect(text).not.toContain("the hub did not record the reading");
    const states = [...(await storedStates(fixture)).values()];
    expect(states.length).toBe(count);
    expect(new Set(states)).toEqual(new Set(["stale"]));
  }, CASE_TIMEOUT_MS);
});

describe("a pull that cannot measure says so, and vouches for nothing", () => {
  test("a repo with no fetched default branch", async () => {
    // Arrange: CCB-5's shape on the TRIGGER rather than on the git call. The
    // leg asks `X..origin/main`; a checkout that never fetched has no such
    // ref, so the question cannot be put at all. It must not fall back to
    // local HEAD — a reader on an unmerged branch would otherwise mark a
    // teammate's claim stale for the whole team off their own work in
    // progress, and the downgrade-only rule makes that unwalkable-back.
    const fixture = await setUp("reval-noref");
    await publish(fixture, "The cache never refetches the rotated key");
    await git(fixture.repo, ["update-ref", "-d", "refs/remotes/origin/main"]);
    await writeRepoFile(fixture.repo, SURFACE, "export const v = 9;\n");
    await git(fixture.repo, ["add", "-A"]);
    await git(fixture.repo, ["commit", "-m", "unfetched"]);

    // Act
    const text = await call(fixture, "get_diagnosis", {
      workContextId: fixture.workContextId,
    });

    // Assert: the claim is readable, its currency is unknown, and the pull
    // says out loud that it measured nothing — never a quiet `current`.
    expect(text).toContain("The cache never refetches the rotated key");
    expect(text).toContain("not revalidated on this pull");
    expect(text).toContain("no fetched default branch");
    expect(text).toContain("none of the 1 claim group was checked");
    expect(text).toContain("currency unknown");
    expect(text).not.toContain("unchanged up to");
  }, CASE_TIMEOUT_MS);

  test("a tree recorded in another repository", async () => {
    // Arrange: get_diagnosis reads ANY tree on the hub. This checkout's git
    // can only say `unknown` about commits it never held — and that reading
    // would still overwrite a teammate's real `unchanged` on every
    // cross-repo pull. So the leg asks nothing and says why.
    const fixture = await setUp("reval-foreign", {
      sessionRepo: "github.com/acme/other",
    });
    await seedClaims(fixture, 1, await headOf(fixture.repo));
    await rewrite(fixture.repo, "export const v = 2;\n");

    // Act
    const text = await call(fixture, "get_diagnosis", {
      workContextId: fixture.workContextId,
    });

    // Assert: said out loud, and nothing was written for this clone.
    expect(text).toContain("recorded in a different repository");
    expect([...(await storedStates(fixture)).values()]).toEqual(["unknown"]);
  }, CASE_TIMEOUT_MS);

  test("a hub that does not record the reading", async () => {
    // Arrange: a hub too old to know the route answers 404. git answered —
    // the surface really moved — but the connector does not render its own
    // opinion of that: the hub is the one authority, and it said nothing.
    const fixture = await setUp("reval-oldhub", {
      connectorHubUrl: oldHubUrl,
    });
    await publish(fixture, "The refresh handler keeps the stale key");
    await rewrite(fixture.repo, "export const v = 2;\n");

    // Act
    const text = await call(fixture, "get_diagnosis", {
      workContextId: fixture.workContextId,
    });

    // Assert
    expect(text).toContain("The refresh handler keeps the stale key");
    expect(text).toContain("the hub did not record the reading");
    expect(text).toContain("currency unknown");
    expect(text).not.toContain("no longer current");
  }, CASE_TIMEOUT_MS);
});
