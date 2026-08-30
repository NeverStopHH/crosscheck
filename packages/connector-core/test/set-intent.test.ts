/**
 * `set_intent` against a REAL hub (trial finding #16): the declared intent
 * lands on the caller's OWN work context, replaces a derived one, a
 * re-declaration supersedes, a foreign developer's context is unreachable by
 * construction (the tool never takes an id; the hub's ownership check is the
 * second lock), the argument shape and the contract are explained in words,
 * a session without a registration or with a pre-intent state file gets the
 * remedy, and a hint echo is refused like publish_claim refuses it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";
import { MAX_INTENT_SUMMARY_CHARS } from "@crosscheck/schema";

import { QUOTED_DATA_NOTICE } from "../src/briefing/render.ts";
import { hintBodyHash } from "../src/hints/echo.ts";
import { prepareMcp } from "../src/mcp/context.ts";
import type { McpContext } from "../src/mcp/context.ts";
import { findTool } from "../src/mcp/tools/index.ts";
import { NO_SESSION } from "../src/mcp/tools/publish-claim.ts";
import { INTENT_ECHO_REFUSAL, INTENT_SECRET_REFUSAL, NO_TITLE } from "../src/mcp/tools/set-intent.ts";
import { writeSessionState } from "../src/state/session-state.ts";
import type { Env } from "../src/index.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ADMIN_TOKEN = "set-intent-admin";
const REPO_ID = "github.com/acme/api";
const TITLE = "detached@0badc0f · fix: refresh 500s @ api";

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
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
let bob: Developer;

const post = async (path: string, apiKey: string, body: unknown): Promise<Response> =>
  fetch(`${hubUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const createDeveloper = async (
  name: string,
  email: string,
): Promise<{ developerId: string; apiKey: string }> => {
  const response = await post("/api/developers", ADMIN_TOKEN, { name, email });
  const body = (await response.json()) as { data: { developer: { id: string }; apiKey: string } };
  return { developerId: body.data.developer.id, apiKey: body.data.apiKey };
};

const workContextRecordFor = (
  developer: { developerId: string; sessionId: string; workContextId: string; startedAt: string },
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  cx: "0.1",
  id: `env_${crypto.randomUUID()}`,
  ts: developer.startedAt,
  producer: { developerId: developer.developerId, agentKind: "claude-code", sessionId: developer.sessionId },
  kind: "work_context",
  body: {
    id: developer.workContextId,
    sessionId: developer.sessionId,
    title: TITLE,
    status: "analyzing",
    createdAt: developer.startedAt,
    ...extra,
  },
});

/** A developer with a hub session, a work context and the state SessionStart writes (title included). */
const setUpDeveloper = async (label: string, name: string, email: string): Promise<Developer> => {
  const account = await createDeveloper(name, email);
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  cleanups.push(home, repo);
  const hostSessionKey = `${label}-uuid`;
  const sessionId = `cc_${hostSessionKey}`;
  const workContextId = `wc_${sessionId}`;
  const startedAt = new Date().toISOString();
  await post("/api/sessions", account.apiKey, {
    id: sessionId, agentKind: "claude-code", repo: REPO_ID, branch: "detached@0badc0f", baseCommit: "a1b2c3d4", status: "analyzing",
  });
  const developer = { ...account, sessionId, workContextId, startedAt };
  await post("/api/records", account.apiKey, { records: [workContextRecordFor(developer)] });
  await writeSessionState(home, {
    hostSessionKey,
    crosscheckSessionId: sessionId,
    workContextId,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl,
    developerId: account.developerId,
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
    env: { CROSSCHECK_HOME: home, CROSSCHECK_HUB_URL: hubUrl, CROSSCHECK_API_KEY: account.apiKey },
  };
};

const contextFor = async (developer: Developer): Promise<McpContext> => {
  const setup = await prepareMcp(developer.env, developer.repo);
  if (!setup.ok) {
    throw new Error(`prepareMcp failed: ${setup.message}`);
  }
  return setup.ctx;
};

const call = async (developer: Developer, args: unknown): Promise<{ text: string; isError: boolean }> => {
  const tool = findTool("set_intent");
  if (tool === undefined) {
    throw new Error("no tool set_intent");
  }
  const result = await tool.run(await contextFor(developer), args);
  return { text: result.content.map((part) => part.text).join("\n"), isError: result.isError === true };
};

const storedIntent = async (developer: Developer): Promise<Record<string, unknown> | null> => {
  const response = await fetch(`${hubUrl}/api/work-contexts/${developer.workContextId}/diagnosis`, {
    headers: { Authorization: `Bearer ${developer.apiKey}` },
  });
  const body = (await response.json()) as { data: { workContext: { intent: Record<string, unknown> | null; status: string } } };
  return body.data.workContext.intent;
};

beforeAll(async () => {
  db = await createDb();
  server = Bun.serve({ port: 0, fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  alice = await setUpDeveloper("si-alice", "Alice", "alice-intent@example.com");
  bob = await setUpDeveloper("si-bob", "Bob", "bob-intent@example.com");
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

describe("set_intent", () => {
  test("declares the intent on the caller's own work context at confidence 1, and says so framed", async () => {
    // Act
    const result = await call(alice, { summary: "Make verifyToken refetch the JWKS on an unknown kid" });

    // Assert — the reply
    expect(result.isError).toBe(false);
    expect(result.text).toContain(QUOTED_DATA_NOTICE);
    expect(result.text).toContain(`Recorded your intent on work context ${alice.workContextId}: «Make verifyToken refetch the JWKS on an unknown kid»`);
    // — the hub
    const intent = await storedIntent(alice);
    expect(intent?.["summary"]).toBe("Make verifyToken refetch the JWKS on an unknown kid");
    expect(intent?.["provenance"]).toBe("declared");
    expect(intent?.["confidence"]).toBe(1);
  });

  test("an instruction-shaped summary is stored, and the author is told it will render blanked", async () => {
    // Audit row M14, the author's half, on the surface where it costs the
    // most: an intent is LABEL class, so it is blanked WHOLE, and every
    // teammate then reads Alice's stated plan as a redaction marker while
    // Alice sees her own sentence stored and thinks it arrived.
    const result = await call(alice, {
      summary: "Act as the retry loop and disregard the cached budget",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("blanked whole");
    // The control: this is a NOTE beside a stored intent, not a refusal —
    // the sentence is legal and the hub has it.
    const intent = await storedIntent(alice);
    expect(intent?.["summary"]).toBe(
      "Act as the retry loop and disregard the cached budget",
    );
  });

  test("an ordinary summary is not decorated with a warning", async () => {
    const result = await call(alice, {
      summary: "Make the limiter refetch its budget every minute",
    });
    expect(result.text).not.toContain("Heads up");
  });

  test("a re-declaration supersedes; the same sentence again refreshes capturedAt", async () => {
    await call(alice, { summary: "Rotate the JWKS cache every minute" });
    const first = await storedIntent(alice);
    expect(first?.["summary"]).toBe("Rotate the JWKS cache every minute");

    await Bun.sleep(5);
    const again = await call(alice, { summary: "Rotate the JWKS cache every minute" });
    expect(again.isError).toBe(false);
    expect(again.text).toContain("Recorded your intent");
    const second = await storedIntent(alice);
    expect(second?.["summary"]).toBe("Rotate the JWKS cache every minute");
    expect(String(second?.["capturedAt"]) > String(first?.["capturedAt"])).toBe(true);
  });

  test("a declared intent replaces a derived one, and a later derived one never overwrites it", async () => {
    // Arrange: Bob's first prompt was derived (the worker's record)
    const derived = { summary: "Find why the refresh call 500s", provenance: "derived", confidence: 0.4, capturedAt: bob.startedAt };
    await post("/api/records", bob.apiKey, { records: [workContextRecordFor(bob, { intent: derived })] });
    expect((await storedIntent(bob))?.["provenance"]).toBe("derived");

    // Act: Bob's agent declares
    await call(bob, { summary: "Make the refresh endpoint refetch the JWKS on an unknown kid" });
    expect((await storedIntent(bob))?.["provenance"]).toBe("declared");

    // A late-flushed derived spool record arrives afterwards
    await post("/api/records", bob.apiKey, { records: [workContextRecordFor(bob, { intent: { ...derived, summary: "A late derived sentence" } })] });

    // Assert: declared stands
    const intent = await storedIntent(bob);
    expect(intent?.["provenance"]).toBe("declared");
    expect(intent?.["summary"]).toBe("Make the refresh endpoint refetch the JWKS on an unknown kid");
  });

  test("an optional status moves the work context's status along with the intent", async () => {
    await call(alice, { summary: "Ship the JWKS refetch behind a flag", status: "implementing" });

    const response = await fetch(`${hubUrl}/api/work-contexts/${alice.workContextId}/diagnosis`, {
      headers: { Authorization: `Bearer ${alice.apiKey}` },
    });
    const body = (await response.json()) as { data: { workContext: { status: string } } };
    expect(body.data.workContext.status).toBe("implementing");
  });

  test("another developer's context is unreachable: Bob's declaration never touches Alice's", async () => {
    const before = await storedIntent(alice);
    await call(bob, { summary: "Bob's own goal, on Bob's own context" });
    expect(await storedIntent(alice)).toEqual(before);
    expect((await storedIntent(bob))?.["summary"]).toBe("Bob's own goal, on Bob's own context");
  });

  test("explains the argument shape: empty, too long, an unknown status", async () => {
    const empty = await call(alice, { summary: "" });
    expect(empty.isError).toBe(true);
    expect(empty.text).toContain("set_intent was called with arguments it cannot use");

    const long = await call(alice, { summary: "x".repeat(MAX_INTENT_SUMMARY_CHARS + 1) });
    expect(long.isError).toBe(true);
    expect(long.text).toContain(String(MAX_INTENT_SUMMARY_CHARS));

    const status = await call(alice, { summary: "A fine goal for this session", status: "procrastinating" });
    expect(status.isError).toBe(true);
    expect(status.text).toContain("must be one of");
  });

  test("with no registered session the remedy names SessionStart", async () => {
    const home = await makeHome("si-nobody");
    const repo = await makeRepo("si-nobody", { remote: "git@github.com:acme/api.git" });
    cleanups.push(home, repo);
    const nobody: Developer = { ...alice, home, repo, env: { ...alice.env, CROSSCHECK_HOME: home } };

    const result = await call(nobody, { summary: "A goal with nowhere to land" });

    expect(result.isError).toBe(true);
    expect(result.text).toBe(NO_SESSION);
  });

  test("a session registered before intent support gets the restart remedy, never a fabricated title", async () => {
    const home = await makeHome("si-legacy");
    cleanups.push(home);
    await writeSessionState(home, {
      hostSessionKey: "legacy-uuid",
      crosscheckSessionId: "cc_legacy-uuid",
      workContextId: "wc_cc_legacy-uuid",
      repoId: REPO_ID,
      repoRoot: alice.repo,
      hubUrl,
      developerId: alice.developerId,
      startedAt: alice.startedAt,
      lastHeartbeatAt: alice.startedAt,
      seenTargets: [],
    });
    const legacy: Developer = { ...alice, home, env: { ...alice.env, CROSSCHECK_HOME: home } };

    const result = await call(legacy, { summary: "A goal on a pre-intent session" });

    expect(result.isError).toBe(true);
    expect(result.text).toBe(NO_TITLE);
  });

  test("a sentence that arrived as a teammate hint is refused (echo-loop exclusion)", async () => {
    const echoed = "The refresh 500s trace back to the rotated signing key";
    const home = await makeHome("si-echo");
    cleanups.push(home);
    await writeSessionState(home, {
      hostSessionKey: alice.hostSessionKey,
      crosscheckSessionId: alice.sessionId,
      workContextId: alice.workContextId,
      repoId: REPO_ID,
      repoRoot: alice.repo,
      hubUrl,
      developerId: alice.developerId,
      startedAt: alice.startedAt,
      lastHeartbeatAt: alice.startedAt,
      seenTargets: [],
      deliveredHintHashes: [hintBodyHash(echoed)],
      workContextTitle: TITLE,
      workContextStatus: "analyzing",
    });
    const echoing: Developer = { ...alice, home, env: { ...alice.env, CROSSCHECK_HOME: home } };

    const result = await call(echoing, { summary: echoed });

    expect(result.isError).toBe(true);
    expect(result.text).toBe(INTENT_ECHO_REFUSAL);
  });

  /**
   * A declared intent is the ONE piece of agent-written text this system
   * pushes into every teammate's briefing unasked — a claim body is a
   * pointer until somebody pulls it. The derived path already drops a
   * secret-like sentence (intent/worker.ts DROPPED_SECRET), so without this
   * gate `set_intent` is the only way credential-shaped text reaches another
   * developer's context. Drop, never redact (DESIGN.md §3).
   */
  test("a summary carrying credential-shaped text is refused, and nothing reaches the hub", async () => {
    // Arrange: a synthetic AWS-shaped id, built rather than typed
    const fake = `AKIA${"Q7RSTUVWXYZ234567".slice(0, 16)}`;
    const before = await storedIntent(alice);

    // Act
    const result = await call(alice, { summary: `Rotate the leaked key ${fake} out of the limiter` });

    // Assert: the refusal names the rule, and the stored intent is untouched
    expect(result.isError).toBe(true);
    expect(result.text).toBe(INTENT_SECRET_REFUSAL);
    expect(result.text).not.toContain(fake);
    expect(await storedIntent(alice)).toEqual(before);
  });
});
