/**
 * The "Ken receives it" proof (trial finding #12), end to end through the
 * real everything: a real hub over PGlite, two real developers, the REAL
 * Stop hook firing the widened gate on a conclusion-corpus fixture, the REAL
 * detached worker spooling the draft (only the summarizer binary is faked,
 * emitting the corpus distillation), and the real briefing/MCP/hint surfaces
 * delivering it to the teammate.
 *
 * EVERY STEP OF THE DELIVERY CONTRACT IS PINNED, including the discipline
 * (DESIGN.md §3 Tier 1 + §4, the non-negotiable counterweight):
 *   1. A's conclusion turn fires the gate; the worker spools a draft with
 *      auto/derived/capped semantics and the hub ingests it.
 *   2. B's briefing carries A's work context as a POINTER — never the draft
 *      body. Automation widened WHAT is captured, not HOW it is delivered.
 *   3. B's deliberate get_diagnosis pull shows the draft inside A's tree,
 *      provenance-labeled derived.
 *   4. A's next session gets the promotion reminder (review_draft line).
 *   5. A confirms; the draft is superseded by a DECLARED claim and leaves
 *      the reminder list.
 *   6. The promoted claim is hint-eligible for B under the normal anchoring
 *      rules: declared now, but proposed and evidence-free, so it arrives
 *      as a pointer — never as substance.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sql } from "drizzle-orm";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import { readSpoolLines, repoKey, runHook } from "../../src/index.ts";
import type { Env } from "../../src/index.ts";
import { makeHome, makeRepo } from "../../../connector-core/test/helpers.ts";
import { loadConclusionCorpus } from "../fixtures/conclusion-corpus/format.ts";

const ADMIN_TOKEN = "e2e-conclusion-admin-token";
const REPO_ID = "github.com/acme/api";
/** Wide enough that a cold PGlite query never trips the fail-open budget. */
const TEST_TIMEOUT_MS = "4000";
const BIN = resolve(import.meta.dir, "..", "..", "..", "cli", "src", "bin", "crosscheck.ts");
const CALL_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 15_000;
/** Generous per-test budget: real hub, real child processes. */
const E2E_TEST_TIMEOUT_MS = 60_000;

/** The corpus fixture dev A's day is modeled on: the CRITICAL review find. */
const fixture = loadConclusionCorpus()[0];
if (fixture?.name !== "adversarial_review_critical") {
  throw new Error("corpus order changed — this e2e rides fixture[0]");
}
const DISTILLATION = fixture.distillation;
if (DISTILLATION === undefined) {
  throw new Error("adversarial_review_critical lost its distillation");
}

let db: Db;
let app: ReturnType<typeof createServer>;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
const cleanups: string[] = [];

interface Developer {
  readonly apiKey: string;
  readonly home: string;
  readonly repo: string;
  readonly env: Env;
}

let alice: Developer;
let bob: Developer;

// ---------------------------------------------------------------------------
// Minimal MCP client over a real child process (extend-diagnosis's client).
// ---------------------------------------------------------------------------

interface RpcEnvelope {
  readonly id?: number;
  readonly result?: {
    readonly content?: readonly { readonly text: string }[];
    readonly isError?: boolean;
  };
  readonly error?: { readonly code: number; readonly message: string };
}

interface McpClient {
  readonly call: (name: string, args: unknown) => Promise<string>;
  readonly close: () => void;
}

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
      for (const rpcLine of lines) {
        if (rpcLine.trim().length === 0) {
          continue;
        }
        let envelope: RpcEnvelope;
        try {
          envelope = JSON.parse(rpcLine) as RpcEnvelope;
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
  if (!response.ok) {
    throw new Error(
      `createDeveloper failed: ${String(response.status)} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { data: { apiKey: string } };
  return { apiKey: body.data.apiKey };
};

/** A fake summarizer that answers with the corpus fixture's distillation. */
const makeFakeSummarizer = async (home: string): Promise<string> => {
  const script = join(home, "fake-summarizer.ts");
  await writeFile(
    script,
    `await Bun.stdin.text();\nprocess.stdout.write(${JSON.stringify(
      JSON.stringify(DISTILLATION),
    )});\n`,
    "utf8",
  );
  const wrapper = join(home, "fake-summarizer.sh");
  await writeFile(
    wrapper,
    `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`,
    "utf8",
  );
  await chmod(wrapper, 0o755);
  return wrapper;
};

const sessionStart = async (
  dev: Developer,
  sessionId: string,
  title?: string,
): Promise<string> =>
  runHook(
    "session-start",
    JSON.stringify({
      session_id: sessionId,
      cwd: dev.repo,
      hook_event_name: "SessionStart",
      source: "startup",
      ...(title === undefined ? {} : { session_title: title }),
    }),
    dev.env,
  );

const additionalContext = (stdout: string): string =>
  stdout.length === 0
    ? ""
    : (
        JSON.parse(stdout) as {
          hookSpecificOutput: { additionalContext: string };
        }
      ).hookSpecificOutput.additionalContext;

beforeAll(async () => {
  db = await createDb();
  app = createServer({ db, adminToken: ADMIN_TOKEN });
  server = Bun.serve({ port: 0, fetch: app.fetch });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;

  const setUp = async (label: string, name: string, email: string): Promise<Developer> => {
    const account = await createDeveloper(name, email);
    const home = await makeHome(label);
    const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
    cleanups.push(home, repo);
    return {
      apiKey: account.apiKey,
      home,
      repo,
      env: {
        CROSSCHECK_HOME: home,
        CROSSCHECK_HUB_URL: hubUrl,
        CROSSCHECK_API_KEY: account.apiKey,
        CROSSCHECK_TIMEOUT_MS: TEST_TIMEOUT_MS,
        // The detached worker inherits PATH through the hook's allowlist.
        PATH: process.env["PATH"],
      },
    };
  };
  alice = await setUp("concl-alice", "Alice", "alice-concl@example.com");
  bob = await setUp("concl-bob", "Bob", "bob-concl@example.com");
});

afterAll(async () => {
  server.stop(true);
  // Release the PGlite WASM instance (suite-stability finding).
  await (db as unknown as { $client: { close: () => Promise<void> } }).$client
    .close()
    .catch(() => undefined);
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

interface DraftRow {
  readonly id: string;
  readonly work_context: string;
  readonly kind: string;
  readonly status: string;
  readonly provenance: string;
  readonly capture_mode: string;
  readonly confidence: number;
}

const draftRows = async (): Promise<readonly DraftRow[]> => {
  const rows = await db.execute(
    sql`select id, work_context_id as work_context, kind, status, provenance,
        capture_mode, confidence
        from claims where provenance = 'derived' order by created_at`,
  );
  return rows.rows as unknown as readonly DraftRow[];
};

describe("conclusion drafts flow from dev A's turn to dev B, automatically", () => {
  let draftId: string;
  let contextId: string;
  let promotedId: string;

  test(
    "A's conclusion turn fires the widened gate and the draft reaches the hub",
    async () => {
      // Arrange: A's session, and the fixture transcript as A's real turn.
      await sessionStart(alice, "a1-uuid", "Adversarial review of the hint pipeline");
      const transcript = join(alice.home, "transcript.jsonl");
      await writeFile(transcript, fixture.transcript, "utf8");
      const fake = await makeFakeSummarizer(alice.home);
      const env: Env = { ...alice.env, CROSSCHECK_SUMMARIZER_CMD: fake };

      // Act 1: the REAL Stop hook — gate, detached worker, spool.
      const stopOut = await runHook(
        "stop",
        JSON.stringify({
          session_id: "a1-uuid",
          cwd: alice.repo,
          hook_event_name: "Stop",
          transcript_path: transcript,
          stop_hook_active: false,
        }),
        env,
      );
      expect(stopOut).toBe("");

      // The worker is a real detached process: poll the spool for its draft.
      const key = repoKey(hubUrl, REPO_ID);
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let spooled: readonly string[] = [];
      for (;;) {
        spooled = (await readSpoolLines(alice.home, key)).filter((entry) =>
          entry.includes('"claim"'),
        );
        if (spooled.length > 0 || Date.now() > deadline) {
          break;
        }
        await Bun.sleep(POLL_INTERVAL_MS);
      }
      expect(spooled).toHaveLength(1);

      // Act 2: the next hook's maintenance flushes the spool to the hub —
      // the spool-flush pattern the worker's header promises.
      await runHook(
        "post-tool-use",
        JSON.stringify({
          session_id: "a1-uuid",
          cwd: alice.repo,
          hook_event_name: "PostToolUse",
          tool_name: "Edit",
          tool_input: { file_path: `${alice.repo}/src/flows/hint.ts` },
          tool_response: {},
        }),
        env,
      );

      // Assert: the hub holds ONE draft, with draft semantics intact.
      const drafts = await draftRows();
      expect(drafts).toHaveLength(1);
      const draft = drafts[0];
      expect(draft?.kind).toBe(DISTILLATION.kind);
      expect(draft?.status).toBe("proposed");
      expect(draft?.provenance).toBe("derived");
      expect(draft?.capture_mode).toBe("auto");
      expect(draft?.confidence ?? 1).toBeLessThanOrEqual(0.5);
      draftId = draft?.id ?? "";
      contextId = draft?.work_context ?? "";
      expect(draftId.length).toBeGreaterThan(0);
    },
    E2E_TEST_TIMEOUT_MS,
  );

  test(
    "B's briefing carries the POINTER, never the draft's substance",
    async () => {
      // Act
      const stdout = await sessionStart(bob, "b1-uuid", "Rate limiter drops burst traffic");
      const context = additionalContext(stdout);

      // Assert: A's work context is pointed at…
      expect(context).toContain("Alice");
      expect(context).toContain("«Adversarial review of the hint pipeline»");
      // …but the draft body is NOT injected (§4: drafts are never proactive
      // substance), and B gets no review reminder for A's draft.
      expect(context).not.toContain("containsSecret");
      expect(context).not.toContain("unscanned");
      expect(context).not.toContain("review_draft");
    },
    E2E_TEST_TIMEOUT_MS,
  );

  test(
    "B's deliberate get_diagnosis pull shows the draft, labeled derived",
    async () => {
      const mcp = startMcp(bob.env, bob.repo);
      try {
        const tree = await mcp.call("get_diagnosis", { workContextId: contextId });
        expect(tree).toContain("containsSecret");
        expect(tree).toContain("provenance derived");
        expect(tree).toContain(DISTILLATION.kind);
      } finally {
        mcp.close();
      }
    },
    E2E_TEST_TIMEOUT_MS,
  );

  test(
    "A's next session gets the promotion reminder for its own draft",
    async () => {
      // Act: a NEW session for A — the promotion loop's trigger.
      const stdout = await sessionStart(alice, "a2-uuid", "Follow-up on the review");
      const context = additionalContext(stdout);

      // Assert: the reminder names the draft and the review_draft action,
      // and shows A (and only A) the draft's own body — capped at the
      // briefing's title budget, so the pin sits inside the first 80 chars.
      expect(context).toContain(`review_draft ${draftId}`);
      expect(context).toContain("unreviewed draft");
      expect(context).toContain("Adversarial review confirmed the hint query");
    },
    E2E_TEST_TIMEOUT_MS,
  );

  test(
    "A confirms: the draft becomes a DECLARED claim and leaves the list",
    async () => {
      const mcp = startMcp(alice.env, alice.repo);
      try {
        // Act
        const answer = await mcp.call("review_draft", {
          draft_claim_id: draftId,
          action: "confirm",
        });
        expect(answer).toContain("Promoted");

        // Assert: a declared revision supersedes the derived draft.
        const promoted = await db.execute(
          sql`select c.id, c.provenance, c.capture_mode from claims c
              join claim_edges e on e.from_claim_id = c.id
              where e.to_claim_id = ${draftId} and e.kind = 'supersedes'`,
        );
        expect(promoted.rows).toHaveLength(1);
        expect(promoted.rows[0]?.["provenance"]).toBe("declared");
        promotedId = String(promoted.rows[0]?.["id"]);

        // The next A session no longer lists the reviewed draft.
        const stdout = await sessionStart(alice, "a3-uuid");
        expect(additionalContext(stdout)).not.toContain(`review_draft ${draftId}`);
      } finally {
        mcp.close();
      }
    },
    E2E_TEST_TIMEOUT_MS,
  );

  test(
    "the promoted claim is hint-eligible for B under the normal anchoring rules",
    async () => {
      // Assert (hub fact): B's candidates now carry the promoted claim as
      // DECLARED — the isDeclared gate that excluded it as a draft is open.
      const response = await fetch(
        `${hubUrl}/api/hints/candidates?repo=${encodeURIComponent(REPO_ID)}&query=${encodeURIComponent(
          "reviewing the hint pipeline for secret egress",
        )}`,
        { headers: { Authorization: `Bearer ${bob.apiKey}` } },
      );
      expect(response.ok).toBe(true);
      const body = (await response.json()) as {
        data: {
          candidates: readonly {
            workContext: { id: string };
            claims: readonly {
              id: string;
              provenance: string;
              status: string;
              evidenceRefCount: number;
            }[];
          }[];
        };
      };
      const candidate = body.data.candidates.find(
        (entry) => entry.workContext.id === contextId,
      );
      expect(candidate).toBeDefined();
      const claim = candidate?.claims.find((entry) => entry.id === promotedId);
      expect(claim?.provenance).toBe("declared");
      // The superseded draft is out of the pool entirely.
      expect(
        candidate?.claims.some((entry) => entry.id === draftId),
      ).toBe(false);

      // Assert (delivery fact): B's prompt hook surfaces the context as a
      // POINTER — proposed and evidence-free never arrives as substance
      // (§4 anchoring asymmetry, unchanged by promotion).
      const hintOut = await runHook(
        "user-prompt-submit",
        JSON.stringify({
          session_id: "b1-uuid",
          cwd: bob.repo,
          hook_event_name: "UserPromptSubmit",
          prompt: "reviewing the hint pipeline for secret egress",
        }),
        bob.env,
      );
      expect(hintOut).toContain("Adversarial review of the hint pipeline");
      expect(hintOut).toContain("get_diagnosis");
      expect(hintOut).not.toContain("containsSecret");
    },
    E2E_TEST_TIMEOUT_MS,
  );
});
