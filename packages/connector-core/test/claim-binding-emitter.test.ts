/**
 * THE EMITTER'S OWN HEAD, at zero marginal cost (1.0 spec 02 §3.1, §6).
 *
 * `prepareMcp` resolves a RepoIdentity per call and `resolveRepoIdentity` runs
 * `git rev-parse HEAD` inside it, so the commit a claim was observed at is
 * ALREADY IN HAND when the body is built: bytes on a request, not a round trip
 * and not a git call. No hook gains anything — the 800 ms budget is untouched.
 *
 * Without this the hub falls back to `agent_sessions.base_commit`, which is
 * rewritten on every re-registration and can therefore sit LATER than the
 * observation — narrowing the revalidation window and making the claim read
 * fresher than it is.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import { prepareMcp } from "../src/mcp/context.ts";
import { findTool } from "../src/mcp/tools/index.ts";
import { writeSessionState } from "../src/state/session-state.ts";
import type { Env } from "../src/index.ts";
import { git, makeHome, makeRepo, writeRepoFile } from "./helpers.ts";

const ADMIN_TOKEN = "binding-admin-token";
const REPO_ID = "github.com/acme/api";

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
const cleanups: string[] = [];

interface Fixture {
  readonly env: Env;
  readonly repo: string;
  readonly head: string;
  readonly workContextId: string;
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

const setUp = async (label: string): Promise<Fixture> => {
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
  const developerId = account.data.developer.id;
  const apiKey = account.data.apiKey;
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  cleanups.push(home, repo);
  await writeRepoFile(repo, "src/auth/verify.ts", "export const v = 1;\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "surface"]);

  const sessionId = `cc_${label}-uuid`;
  const workContextId = `wc_${sessionId}`;
  const startedAt = new Date().toISOString();
  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${hubUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  // The SESSION registers with a stale base commit on purpose: the emitter's
  // own HEAD has to win over it, or this test proves nothing.
  await post("/api/sessions", {
    id: sessionId,
    agentKind: "claude-code",
    repo: REPO_ID,
    branch: "main",
    baseCommit: "a1b2c3d4",
    status: "analyzing",
  });
  await post("/api/records", {
    cx: "0.1",
    id: `env_${crypto.randomUUID()}`,
    ts: startedAt,
    producer: { developerId, agentKind: "claude-code", sessionId },
    kind: "work_context",
    body: {
      id: workContextId,
      sessionId,
      title: "Login 500s on staging",
      status: "analyzing",
      createdAt: startedAt,
    },
  });
  await writeSessionState(home, {
    hostSessionKey: `${label}-uuid`,
    crosscheckSessionId: sessionId,
    workContextId,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl,
    developerId,
    startedAt,
    lastHeartbeatAt: startedAt,
    seenTargets: [],
  });
  return {
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: apiKey,
    },
    repo,
    head: await headOf(repo),
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

interface WireValidity {
  readonly observedAtCommit: string | null;
  readonly commitBinding: string;
  readonly state: string;
}

/** Read back through the hub's own wire, so the binding is checked where a
 * reader actually meets it rather than in a column only this test can see. */
const validities = async (
  fixture: Fixture,
): Promise<readonly WireValidity[]> => {
  const response = await fetch(
    `${hubUrl}/api/work-contexts/${fixture.workContextId}/diagnosis`,
    { headers: { Authorization: `Bearer ${fixture.env.CROSSCHECK_API_KEY ?? ""}` } },
  );
  const body = (await response.json()) as {
    data: { claims: { validity: WireValidity }[] };
  };
  return body.data.claims.map((claim) => claim.validity);
};

beforeAll(async () => {
  db = await createDb();
  const app = createServer({ db, adminToken: ADMIN_TOKEN, embedder: null });
  server = Bun.serve({ port: 0, fetch: app.fetch });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("an emitted claim carries the emitter's own commit", () => {
  test("publish_claim binds to this checkout's HEAD, not the session's base", async () => {
    // Arrange
    const fixture = await setUp("emit-publish");

    // Act
    const text = await call(fixture, "publish_claim", {
      kind: "root_cause",
      body: "The refresh path drops the rotated signing key",
      status: "proposed",
      confidence: 0.7,
      affectedPaths: ["src/auth/verify.ts"],
    });

    // Assert
    expect(text).toContain("Recorded");
    const stored = await validities(fixture);
    expect(stored[0]?.commitBinding).toBe("reported");
    expect(stored[0]?.observedAtCommit).toBe(fixture.head);
    expect(stored[0]?.observedAtCommit).not.toBe("a1b2c3d4");
  });
});
