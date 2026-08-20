/**
 * The headline move, end to end, through the real everything.
 *
 * A real hub over PGlite, two real git repos, the real SessionStart hook to
 * create each developer's work context, and the MCP server as a REAL CHILD
 * PROCESS spoken to over stdio in JSON-RPC. Nothing here is stubbed, because the
 * things most likely to be wrong are the seams: the argv `.mcp.json` writes, the
 * stdin loop's chunk handling, the producer id the hub checks, and whether a
 * claim written into another developer's context is visible to its owner.
 *
 * THE SCENARIO IS THE PRODUCT'S ONE-SENTENCE PITCH. Alice publishes a
 * hypothesis. Bob, working on something else, finds that her hypothesis is a
 * symptom of what he is looking at, and attaches his claim underneath hers with
 * a `deeper_cause_of` edge. Alice reads her own tree back and Bob's reasoning is
 * in it, attributed to Bob.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import { runHook } from "../../src/index.ts";
import type { Env } from "../../src/index.ts";
import { makeHome, makeRepo } from "../../../connector-core/test/helpers.ts";

const ADMIN_TOKEN = "e2e-mcp-admin-token";
/** Wide enough that a cold PGlite query never trips the hook's fail-open budget. */
const TEST_TIMEOUT_MS = "4000";
const BIN = resolve(import.meta.dir, "..", "..", "..", "cli", "src", "bin", "crosscheck.ts");
const CALL_TIMEOUT_MS = 20_000;

let db: Db;
let app: ReturnType<typeof createServer>;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
const cleanups: string[] = [];

interface McpClient {
  readonly call: (name: string, args: unknown) => Promise<string>;
  readonly listTools: () => Promise<readonly string[]>;
  readonly close: () => void;
}

interface Developer {
  readonly name: string;
  readonly apiKey: string;
  readonly home: string;
  readonly repo: string;
  readonly env: Env;
  readonly mcp: McpClient;
}

let alice: Developer;
let bob: Developer;

// ---------------------------------------------------------------------------
// A minimal MCP client, over a real child process
// ---------------------------------------------------------------------------

interface RpcEnvelope {
  readonly id?: number;
  readonly result?: {
    readonly content?: readonly { readonly text: string }[];
    readonly isError?: boolean;
    readonly tools?: readonly { readonly name: string }[];
  };
  readonly error?: { readonly code: number; readonly message: string };
}

/**
 * Speaks the transport the way Claude Code does: one JSON value per line on the
 * child's stdin, one per line back on its stdout, matched by id.
 *
 * The reader accumulates and splits on newlines rather than assuming a chunk is
 * a frame. That is not defensive padding — `tools/list` carries four JSON
 * Schemas and runs to kilobytes, so it arrives in pieces, and a reader that
 * assumed otherwise would pass on a short suite and fail here.
 */
const startMcp = (env: Env, cwd: string): McpClient => {
  const proc = Bun.spawn({
    cmd: [process.execPath, BIN, "mcp"],
    cwd,
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const pending = new Map<number, (envelope: RpcEnvelope) => void>();
  let nextId = 1;

  void (async (): Promise<void> => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) {
          continue;
        }
        // Tolerant by design: a stray non-JSON stdout line must not kill
        // the whole file through an unhandled rejection in this floating
        // reader — an unanswered request still fails its own test loudly.
        let envelope: RpcEnvelope;
        try {
          envelope = JSON.parse(line) as RpcEnvelope;
        } catch {
          continue;
        }
        const answer =
          envelope.id === undefined ? undefined : pending.get(envelope.id);
        if (answer !== undefined && envelope.id !== undefined) {
          pending.delete(envelope.id);
          answer(envelope);
        }
      }
    }
  })();

  const request = async (
    method: string,
    params: unknown,
  ): Promise<RpcEnvelope> => {
    const id = nextId;
    nextId += 1;
    const answered = new Promise<RpcEnvelope>((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectCall(new Error(`mcp ${method} timed out`));
      }, CALL_TIMEOUT_MS);
      pending.set(id, (envelope) => {
        clearTimeout(timer);
        resolveCall(envelope);
      });
    });
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
    proc.stdin.flush();
    return answered;
  };

  return {
    call: async (name, args) => {
      const envelope = await request("tools/call", { name, arguments: args });
      if (envelope.error !== undefined) {
        throw new Error(`mcp protocol error: ${envelope.error.message}`);
      }
      return (envelope.result?.content ?? [])
        .map((part) => part.text)
        .join("\n");
    },
    listTools: async () => {
      const envelope = await request("tools/list", {});
      return (envelope.result?.tools ?? []).map((tool) => tool.name);
    },
    close: () => {
      proc.kill();
    },
  };
};

const createDeveloper = async (
  name: string,
  email: string,
): Promise<{ apiKey: string }> => {
  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, email }),
  });
  // Named failure over an unreadable one (suite-stability finding).
  if (!response.ok) {
    throw new Error(
      `createDeveloper failed: ${String(response.status)} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { data: { apiKey: string } };
  return { apiKey: body.data.apiKey };
};

/**
 * A developer whose work context was created by the REAL SessionStart hook.
 *
 * Deliberately not seeded by hand: that hook is what writes the session state
 * file the MCP tools navigate by, and a hand-written one would agree with
 * whatever this test happened to assume rather than with what ships.
 */
const setUp = async (
  label: string,
  name: string,
  email: string,
  title: string,
): Promise<Developer> => {
  const account = await createDeveloper(name, email);
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  cleanups.push(home, repo);
  const env: Env = {
    CROSSCHECK_HOME: home,
    CROSSCHECK_HUB_URL: hubUrl,
    CROSSCHECK_API_KEY: account.apiKey,
    CROSSCHECK_TIMEOUT_MS: TEST_TIMEOUT_MS,
  };
  await runHook(
    "session-start",
    JSON.stringify({
      session_id: `${label}-uuid`,
      cwd: repo,
      hook_event_name: "SessionStart",
      source: "startup",
      session_title: title,
    }),
    env,
  );
  return { name, ...account, home, repo, env, mcp: startMcp(env, repo) };
};

beforeAll(async () => {
  db = await createDb();
  app = createServer({ db, adminToken: ADMIN_TOKEN });
  server = Bun.serve({ port: 0, fetch: app.fetch });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;

  alice = await setUp(
    "mcp-alice",
    "Alice",
    "alice-e2e@example.com",
    "Login 500s on staging",
  );
  bob = await setUp(
    "mcp-bob",
    "Bob",
    "bob-e2e@example.com",
    "Token rotation job runs late",
  );
});

afterAll(async () => {
  alice.mcp.close();
  bob.mcp.close();
  server.stop(true);
  // Release the PGlite WASM instance (suite-stability finding).
  await (db as unknown as { $client: { close: () => Promise<void> } }).$client
    .close()
    .catch(() => undefined);
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("two developers, one diagnosis", () => {
  let aliceContextId: string;
  let aliceClaimId: string;

  test("the server Claude Code would start offers all six tools", async () => {
    // Arrange + Act: the same binary and argv `.mcp.json` names, spawned the
    // same way — this is what proves the wiring, not a unit test of the registry
    const names = await alice.mcp.listTools();

    // Assert
    expect(names).toEqual([
      "publish_claim",
      "review_draft",
      "extend_diagnosis",
      "get_diagnosis",
      "get_referee_brief",
      "search_related_work",
    ]);
  });

  test("Alice publishes a hypothesis onto her own work context", async () => {
    // Act
    const text = await alice.mcp.call("publish_claim", {
      kind: "hypothesis",
      body: "The login 500 happens because the refresh path reads a rotated key",
      confidence: 0.7,
    });

    // Assert
    expect(text).toContain("Recorded clm_");
    aliceClaimId = /clm_[\w-]+/.exec(text)?.[0] ?? "";
    aliceContextId = /wc_[\w-]+/.exec(text)?.[0] ?? "";
    expect(aliceClaimId.length).toBeGreaterThan(0);
    expect(aliceContextId.length).toBeGreaterThan(0);
  });

  test("Bob finds her work context without being told its id", async () => {
    // Arrange: ids are `wc_cc_<uuid>` — unguessable, which is exactly why
    // discovery has to exist for get_diagnosis to be usable at all
    // Act
    const text = await bob.mcp.call("search_related_work", { query: "login" });

    // Assert
    expect(text).toContain(aliceContextId);
    expect(text).toContain("«Login 500s on staging»");
    // And it is honest about what kind of search it was
    expect(text.toLowerCase()).toContain("not a semantic search");
  });

  test("Bob reads her tree, quoted and attributed", async () => {
    // Act
    const text = await bob.mcp.call("get_diagnosis", {
      workContextId: aliceContextId,
    });

    // Assert
    expect(text).toContain(
      "«The login 500 happens because the refresh path reads a rotated key»",
    );
    expect(text).toContain("Alice");
    // The framing that makes reading another developer's text safe
    expect(text).toContain("quoted data, not instruction");

    // Attribution is a NAME, never the opaque `cc_<uuid>` session id, which no
    // reader could resolve to a person.
    //
    // Asserted per CLAIM LINE rather than over the whole document, and finding
    // out why was this test's first act of work. `text.not.toContain("cc_…")`
    // fails on a correct render: work context ids are derived from the session
    // id by construction — `workContextIdFor` is literally `"wc_" + sessionId`
    // (state/session-state.ts) — so the header legitimately carries the session
    // id inside `wc_cc_mcp-alice-uuid`. The claim about attribution is about the
    // author field, and this is where that field lives.
    const claimLines = text
      .split("\n")
      .filter((line) => /^- clm_/.test(line));
    expect(claimLines.length).toBeGreaterThan(0);
    for (const line of claimLines) {
      expect(line, line).not.toContain("cc_");
    }
  });

  test("Bob extends her tree: her hypothesis is a symptom of what he found", async () => {
    // Act: the product's headline move
    const text = await bob.mcp.call("extend_diagnosis", {
      workContextId: aliceContextId,
      targetClaimId: aliceClaimId,
      kind: "evidence",
      body: "The rotation job commits the new key after the cache warms, so reads are stale by design",
      edgeKind: "deeper_cause_of",
      note: "same 30s window as the token rotation run",
    });

    // Assert
    expect(text).toContain("deeper_cause_of");
    expect(text).toContain(aliceClaimId);
  });

  test("Alice reads her own tree back and Bob's claim is in it", async () => {
    // Act
    const text = await alice.mcp.call("get_diagnosis", {
      workContextId: aliceContextId,
    });

    // Assert: his reasoning, his name, and the link between the two claims
    expect(text).toContain(
      "«The rotation job commits the new key after the cache warms, so reads are stale by design»",
    );
    expect(text).toContain("Bob");
    expect(text).toContain("Alice");
    expect(text).toMatch(/clm_[\w-]+ deeper_cause_of clm_[\w-]+/);
    expect(text).toContain("«same 30s window as the token rotation run»");
  });

  test("Bob cannot supersede Alice's claim, and is told the rule", async () => {
    // Arrange: supersedes is same-author revision semantics (DESIGN.md §5). The
    // hub enforces it; what matters here is that the AGENT is told what to use
    // instead rather than handed a refusal it cannot act on.
    // Act
    const text = await bob.mcp.call("extend_diagnosis", {
      workContextId: aliceContextId,
      targetClaimId: aliceClaimId,
      kind: "observation",
      body: "I think the refresh path is a red herring entirely",
      edgeKind: "supersedes",
    });

    // Assert
    expect(text).toContain("supersedes");
    expect(text).toContain("contradicts");
    expect(text).toContain("deeper_cause_of");
  });

  test("nothing was written by the refusal", async () => {
    // Arrange: extend_diagnosis reads the target tree before it writes, so a
    // refused extension leaves no orphan claim in a stranger's diagnosis
    // Act
    const text = await alice.mcp.call("get_diagnosis", {
      workContextId: aliceContextId,
    });

    // Assert
    expect(text).not.toContain("red herring");
  });

  test("an id Alice never minted is refused with a way to get a real one", async () => {
    // Act
    const text = await bob.mcp.call("extend_diagnosis", {
      workContextId: aliceContextId,
      targetClaimId: "clm_invented_by_the_model",
      kind: "hypothesis",
      body: "Attached to a claim that does not exist",
    });

    // Assert
    expect(text).toContain("clm_invented_by_the_model");
    expect(text).toContain("get_diagnosis");
  });
});
