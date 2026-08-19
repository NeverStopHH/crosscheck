/**
 * The cross-connector E2E (DESIGN-agent-agnostic.md §4.5) — the branch's
 * crown proof, through the real everything: one real hub over PGlite, and
 * ALL THREE connectors as REAL SUBPROCESSES of the one `crosscheck` bin this
 * package ships.
 *
 *   Ada  — Claude Code: hook subprocesses + the MCP server as a child
 *          process; she publishes a diagnosis (an evidence-backed
 *          likely_root_cause claim) and hits a build failure.
 *   Ben  — ACP: the transparent proxy wrapping the scripted fake agent; his
 *          FIRST prompt block carries Ada's briefing, his edit lands as a
 *          target, and his agent reports the SAME failure text.
 *   Cleo — Cursor IDE: `cursor-hook` subprocesses; her sessionStart briefing
 *          arrives as `additional_context`, and the same failure on
 *          postToolUseFailure triggers the failure-matched hint (the hub's
 *          FTS over the failure text) that quotes Ada's published claim.
 *
 * What this file proves that no per-connector suite can:
 *   - fingerprint parity IN ANGER: the same failure text captured through
 *     three different wire shapes (Claude tool_response.stderr, ACP
 *     tool_call_update.rawOutput.stderr, Cursor error_message) lands on the
 *     hub as ONE distinct fingerprint value across three work contexts;
 *   - the fingerprint is CAUSALLY load-bearing, not just recorded: Ada's
 *     solved tree surfaces in the other developers' briefings THROUGH the
 *     solved-matches fingerprint tier (the only strong target her tree
 *     shares with their live work), with the work_context delivery row to
 *     match — break that tier and two steps here go red;
 *   - presence lists three sessions with three distinct agent kinds;
 *   - the §2.1 visibility rules hold across connectors: Ada's presence
 *     opt-out hides her live presence from Ben's and Cleo's surfaces while
 *     her published knowledge stays; Cleo muting Ada silences both the
 *     briefing pointers and the failure-matched hint about her — and the
 *     unmute control re-delivers the same hint to a fresh session, so the
 *     mute step's `{}` can never go vacuous under a future dedup;
 *   - every rendered agent-facing surface in the scenario carries the
 *     framing invariants (the quoted-data notice, balanced « » frames, no
 *     raw control bytes); the statusline is pinned by shape (it is a
 *     corpus-registered surface, not a briefing).
 *
 * Runtime is bounded — every step has its own 30 s cap and the whole
 * scenario runs against an in-process hub — so it rides the normal `bun
 * test` CI lane beside the existing per-connector e2e files; no separate
 * lane is warranted.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sql } from "drizzle-orm";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import { extractFailureText } from "@crosscheck/connector-core/capture/failure-text.ts";
import { fingerprint } from "@crosscheck/connector-core/capture/fingerprint.ts";
import { MAX_BRIEFING_CHARS } from "@crosscheck/connector-core/constants.ts";
import { QUOTED_DATA_NOTICE } from "@crosscheck/connector-core/briefing/render.ts";
import { makeHome, makeRepo, writeRepoFile } from "../../../connector-core/test/helpers.ts";
import {
  FAKE_AGENT_PATH,
  writeToSink,
} from "../../../connector-acp/test/fixtures/e2e-helpers.ts";

const BIN = resolve(import.meta.dir, "..", "..", "src", "bin", "crosscheck.ts");

const ADMIN_TOKEN = "cross-connector-admin";
const REPO_ID = "github.com/acme/api";
const REMOTE = "git@github.com:acme/api.git";
/** Wide enough that a cold PGlite query never trips a fail-open budget. */
const TEST_TIMEOUT_MS = "4000";
const STEP_TIMEOUT_MS = 30_000;
/**
 * The ACP briefing prefetch starts at session/new capture and announces
 * itself with a `briefing-prefetch-ready` line in the proxy log (engine.ts
 * logs it AFTER the cache slot flips) — polled here instead of a fixed
 * wall-clock sleep, so a slow machine waits exactly as long as it must and
 * a broken prefetch fails with a named error, never a false pass.
 */
const PREFETCH_READY_TIMEOUT_MS = 20_000;
const PREFETCH_POLL_MS = 50;

/**
 * The one failure all three developers hit. Lexically overlaps Ada's work
 * context title (limiter/rotation/build) so the hub's OR-joined FTS finds
 * her context when this text runs as the hint query.
 */
const FAILURE_TEXT =
  "error TS2304: cannot find name 'limiter' — the rotation build fails after key rotation";

const ADA_TITLE = "Limiter rotation build failing after key rotation";
const ADA_OBSERVATION =
  "The limiter build breaks only in the 30s window after the rotation job commits the new key";
const ADA_ROOT_CAUSE =
  "The limiter build reads the rotated key from a stale cache; warm the cache before building";

/** The fake agent's fixed ACP ids (fake-agent.ts): sessionId + agentInfo. */
const ACP_SESSION_ID = "sess_fake_1";
const BEN_CROSSCHECK_SESSION = `cc_acp-fake-agent--${ACP_SESSION_ID}`;
const CLEO_CONV_1 = "conv-cleo-1";
const CLEO_CROSSCHECK_SESSION_1 = `cc_cur-${CLEO_CONV_1}`;
/**
 * Ada's work context: `wc_cc_<host session id>` (state/session-state.ts).
 * Named because the solved-pointer assertions pin briefing lines and
 * `hint_deliveries` rows to exactly this id.
 */
const ADA_WORK_CONTEXT = "wc_cc_ada-uuid";
/** The one solved-pointer sentence SOLVED_MATCH_KIND_LABELS renders for a
 * fingerprint-tier match — the FTS text path cannot produce it. */
const FINGERPRINT_MATCH_LABEL = "shared error fingerprint with current work";

interface Developer {
  readonly developerId: string;
  readonly apiKey: string;
  readonly home: string;
  readonly repo: string;
  readonly env: Record<string, string>;
}

let db: Db;
let app: ReturnType<typeof createServer>;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let ada: Developer;
let ben: Developer;
let cleo: Developer;
const cleanups: string[] = [];
const liveProcs: { kill(): void }[] = [];

// ---------------------------------------------------------------------------
// Subprocess plumbing — every connector runs as a real child of the real bin
// ---------------------------------------------------------------------------

interface BinRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runBin = async (
  args: readonly string[],
  stdin: string,
  env: Record<string, string>,
  cwd?: string,
): Promise<BinRun> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, BIN, ...args],
    cwd: cwd ?? process.cwd(),
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env["PATH"] ?? "", ...env },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

/**
 * Structural reader type: Bun's global ReadableStreamDefaultReader and
 * node:stream/web's disagree about `readMany`, and this file needs neither —
 * only the classic read() contract.
 */
type ByteRead =
  | { readonly done: true; readonly value?: undefined }
  | { readonly done: false; readonly value: Uint8Array };
interface ByteReader {
  read(): Promise<ByteRead>;
}

/** A held-open ACP conversation: send frames, await reply lines, close late. */
class WireDriver {
  private readonly reader: ByteReader;
  private newlines = 0;
  constructor(private readonly proc: ReturnType<typeof Bun.spawn>) {
    this.reader = (
      proc.stdout as ReadableStream<Uint8Array>
    ).getReader() as unknown as ByteReader;
  }
  async send(frame: string): Promise<void> {
    await writeToSink(
      this.proc.stdin as { write(c: Uint8Array): unknown; flush(): unknown },
      frame,
    );
  }
  async readUntil(target: number): Promise<void> {
    while (this.newlines < target) {
      const { done, value } = await this.reader.read();
      if (done) {
        throw new Error(
          `proxy stdout ended at ${this.newlines}/${target} expected lines`,
        );
      }
      for (const byte of value) {
        if (byte === 0x0a) this.newlines += 1;
      }
    }
  }
  /** EOF to the client half; drains and returns the proxy's exit code. */
  async close(): Promise<number> {
    (this.proc.stdin as { end(): unknown }).end();
    for (;;) {
      const { done } = await this.reader.read();
      if (done) break;
    }
    return this.proc.exited;
  }
}

/** Minimal MCP client over the real `crosscheck mcp` child (stdio JSON-RPC). */
interface McpClient {
  readonly call: (name: string, args: unknown) => Promise<string>;
  readonly close: () => void;
}

const startMcp = (env: Record<string, string>, cwd: string): McpClient => {
  const proc = Bun.spawn({
    cmd: [process.execPath, BIN, "mcp"],
    cwd,
    env: { PATH: process.env["PATH"] ?? "", ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  liveProcs.push(proc);
  const pending = new Map<number, (envelope: Record<string, unknown>) => void>();
  let nextId = 1;
  void (async (): Promise<void> => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        // Tolerant by design: a stray non-JSON stdout line (a runtime
        // warning, a debug print) must not kill the whole file through an
        // unhandled rejection in this floating reader. Correctness is still
        // enforced per call — an unanswered id times out loudly.
        let envelope: Record<string, unknown>;
        try {
          envelope = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const id = envelope["id"];
        if (typeof id === "number" && pending.has(id)) {
          const answer = pending.get(id);
          pending.delete(id);
          answer?.(envelope);
        }
      }
    }
  })();
  return {
    call: async (name, args) => {
      const id = nextId;
      nextId += 1;
      const answered = new Promise<Record<string, unknown>>(
        (resolveCall, rejectCall) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            rejectCall(new Error(`mcp ${name} timed out`));
          }, STEP_TIMEOUT_MS);
          pending.set(id, (envelope) => {
            clearTimeout(timer);
            resolveCall(envelope);
          });
        },
      );
      proc.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`,
      );
      proc.stdin.flush();
      const envelope = await answered;
      const result = envelope["result"] as
        | { content?: readonly { text: string }[] }
        | undefined;
      return (result?.content ?? []).map((part) => part.text).join("\n");
    },
    close: () => {
      proc.kill();
    },
  };
};

/**
 * Poll the proxy's log dir (`<home>/logs/acp-<pid>.log`) until the engine's
 * `briefing-prefetch-ready` line lands. The line is logged AFTER the cache
 * slot flips, so seeing it guarantees the next prompt finds the briefing.
 */
const waitForPrefetchReady = async (home: string): Promise<void> => {
  const logsDir = join(home, "logs");
  const deadline = Date.now() + PREFETCH_READY_TIMEOUT_MS;
  for (;;) {
    const names = await readdir(logsDir).catch(() => [] as string[]);
    const texts = await Promise.all(
      names
        .filter((name) => name.startsWith("acp-") && name.endsWith(".log"))
        .map((name) =>
          Bun.file(join(logsDir, name))
            .text()
            .catch(() => ""),
        ),
    );
    if (texts.some((text) => text.includes("briefing-prefetch-ready"))) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `acp briefing prefetch never logged ready in ${String(PREFETCH_READY_TIMEOUT_MS)}ms`,
      );
    }
    await new Promise((tick) => setTimeout(tick, PREFETCH_POLL_MS));
  }
};

// ---------------------------------------------------------------------------
// Framing invariants — asserted on EVERY rendered surface in the scenario
// ---------------------------------------------------------------------------

/**
 * The §1.4 non-negotiables, checkable from outside: the quoted-data notice
 * is present, « » frames are balanced in order, and no raw C0 control byte
 * (newline excepted) reached the reader. The corpus suites prove the deeper
 * sanitizer properties per surface; this is the scenario-level seal that
 * every surface a developer saw HERE went through those renderers.
 */
const assertFramed = (surface: string, text: string): void => {
  expect(text, `${surface}: notice`).toContain(QUOTED_DATA_NOTICE);
  let depth = 0;
  for (const char of text) {
    if (char === "«") depth += 1;
    if (char === "»") {
      depth -= 1;
      expect(depth, `${surface}: frame balance`).toBeGreaterThanOrEqual(0);
    }
  }
  expect(depth, `${surface}: frames closed`).toBe(0);
  const controlByte = [...text].find((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 && code !== 0x0a;
  });
  expect(controlByte, `${surface}: control bytes`).toBeUndefined();
};

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const claudeSessionStart = (
  repo: string,
  sessionId: string,
  title?: string,
): string =>
  JSON.stringify({
    session_id: sessionId,
    cwd: repo,
    hook_event_name: "SessionStart",
    source: "startup",
    ...(title === undefined ? {} : { session_title: title }),
  });

const cursorBase = (repo: string, conversationId: string) => ({
  conversation_id: conversationId,
  generation_id: `gen-${conversationId}`,
  model: "test-model",
  model_id: "test-model",
  cursor_version: "1.7.2",
  workspace_roots: [repo],
  user_email: "cleo@example.com",
});

const cursorSessionStart = (repo: string, conversationId: string): string =>
  JSON.stringify({
    ...cursorBase(repo, conversationId),
    hook_event_name: "sessionStart",
    session_id: conversationId,
    is_background_agent: false,
    composer_mode: "agent",
  });

const cursorFailure = (repo: string, conversationId: string): string =>
  JSON.stringify({
    ...cursorBase(repo, conversationId),
    hook_event_name: "postToolUseFailure",
    tool_name: "Shell",
    tool_input: { command: "bun run build" },
    tool_use_id: `tool-${conversationId}`,
    cwd: repo,
    error_message: FAILURE_TEXT,
    failure_type: "error",
    duration: 4200,
    is_interrupt: false,
  });

const additionalContextOf = (stdout: string): string => {
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const value = parsed["additional_context"];
  return typeof value === "string" ? value : "";
};

const presenceAs = async (
  apiKey: string,
): Promise<readonly { developerId: string; agentKind: string; isSelf: boolean }[]> => {
  const response = await fetch(
    `${hubUrl}/api/presence?repo=${encodeURIComponent(REPO_ID)}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  const body = (await response.json()) as {
    data: {
      sessions: readonly { developerId: string; agentKind: string; isSelf: boolean }[];
    };
  };
  return body.data.sessions;
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

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

const setUp = async (label: string, name: string, email: string): Promise<Developer> => {
  const account = await createDeveloper(name, email);
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: REMOTE });
  cleanups.push(home, repo);
  return {
    ...account,
    home,
    repo,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: account.apiKey,
      CROSSCHECK_TIMEOUT_MS: TEST_TIMEOUT_MS,
    },
  };
};

beforeAll(async () => {
  db = await createDb();
  app = createServer({ db, adminToken: ADMIN_TOKEN });
  server = Bun.serve({ port: 0, fetch: app.fetch });
  hubUrl = `http://127.0.0.1:${server.port}`;
  ada = await setUp("xc-ada", "Ada", "ada-xc@example.com");
  ben = await setUp("xc-ben", "Ben", "ben-xc@example.com");
  cleo = await setUp("xc-cleo", "Cleo", "cleo-xc@example.com");
});

afterAll(async () => {
  for (const proc of liveProcs) {
    proc.kill();
  }
  server.stop(true);
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

// ---------------------------------------------------------------------------
// The scenario — steps share state and run in order
// ---------------------------------------------------------------------------

let adaClaimId = "";
let benDriver: WireDriver | null = null;
let benDumpPath = "";

describe("three connectors, one hub (§4.5)", () => {
  test(
    "Ada (Claude) registers through the real hook and publishes her diagnosis over real MCP",
    async () => {
      // Arrange + Act: the hook subprocess, then the MCP child process.
      const start = await runBin(
        ["hook", "session-start"],
        claudeSessionStart(ada.repo, "ada-uuid", ADA_TITLE),
        ada.env,
      );
      expect(start.exitCode).toBe(0);

      const mcp = startMcp(ada.env, ada.repo);
      const observation = await mcp.call("publish_claim", {
        kind: "observation",
        body: ADA_OBSERVATION,
        confidence: 0.8,
      });
      expect(observation).toContain("Recorded clm_");
      const observationId = /clm_[\w-]+/.exec(observation)?.[0] ?? "";
      expect(observationId.length).toBeGreaterThan(0);

      const rootCause = await mcp.call("publish_claim", {
        kind: "root_cause",
        body: ADA_ROOT_CAUSE,
        status: "likely_root_cause",
        confidence: 0.85,
        evidenceRefs: [observationId],
      });
      mcp.close();

      // Assert: the claim the hint must later quote exists, evidence-backed.
      expect(rootCause).toContain("Recorded clm_");
      adaClaimId = /clm_[\w-]+/.exec(rootCause)?.[0] ?? "";
      expect(adaClaimId.length).toBeGreaterThan(0);
      const claims = await db.execute(
        sql`select id, status from claims where id = ${adaClaimId}`,
      );
      expect(claims.rows).toHaveLength(1);
      expect(claims.rows[0]?.["status"]).toBe("likely_root_cause");
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "Ada hits the failure — one fingerprint row lands for her work context",
    async () => {
      // Act
      const run = await runBin(
        ["hook", "post-tool-use"],
        JSON.stringify({
          session_id: "ada-uuid",
          cwd: ada.repo,
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "bun run build" },
          tool_response: { exitCode: 1, stderr: FAILURE_TEXT },
        }),
        ada.env,
      );

      // Assert
      expect(run.exitCode).toBe(0);
      const expected = fingerprint(extractFailureText({ stderr: FAILURE_TEXT }));
      expect(expected).not.toBeNull();
      const prints = await db.execute(
        sql`select value from work_context_targets where kind = 'error_fingerprint'`,
      );
      expect(prints.rows.map((row) => row["value"])).toEqual([expected]);
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "Ben (ACP proxy): Ada's briefing rides his FIRST prompt block; his target and the same failure land",
    async () => {
      // Arrange: the scripted agent traffic — one edit with a location, one
      // failed update carrying the SAME failure bytes as Ada's Bash stderr.
      await writeRepoFile(ben.repo, "src/limiter-consumer.ts", "export const c = 3;\n");
      const updatesPath = join(ben.home, "updates.ndjson");
      await writeFile(
        updatesPath,
        [
          JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: ACP_SESSION_ID,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "call_ben_1",
                kind: "edit",
                status: "in_progress",
                locations: [{ path: join(ben.repo, "src/limiter-consumer.ts") }],
              },
            },
          }),
          JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: ACP_SESSION_ID,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "call_ben_1",
                status: "failed",
                rawOutput: { stderr: FAILURE_TEXT },
              },
            },
          }),
          "",
        ].join("\n"),
        "utf8",
      );
      benDumpPath = join(ben.home, "agent-stdin.dump");

      // Act: spawn the REAL bin's acp subcommand around the fake agent and
      // drive one conversation — holding the first prompt until the proxy
      // log carries the prefetch's ready-signal (started at session/new).
      const proc = Bun.spawn({
        cmd: [
          process.execPath,
          BIN,
          "acp",
          "--",
          process.execPath,
          FAKE_AGENT_PATH,
          "--updates-file",
          updatesPath,
          "--dump-stdin",
          benDumpPath,
        ],
        env: { ...process.env, ...ben.env },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      liveProcs.push(proc);
      benDriver = new WireDriver(proc);
      await benDriver.send(
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}\n',
      );
      await benDriver.readUntil(1);
      await benDriver.send(
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: ben.repo, mcpServers: [] } })}\n`,
      );
      await benDriver.readUntil(2);
      await waitForPrefetchReady(ben.home);
      await benDriver.send(
        `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: ACP_SESSION_ID, prompt: [{ type: "text", text: "why does the limiter build fail" }] } })}\n`,
      );
      // 2 scripted updates + thinking + done + result = 5 reply lines.
      await benDriver.readUntil(7);

      // Assert: the wire Ben's AGENT actually received.
      const dump = await Bun.file(benDumpPath).text();
      const frames = dump
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const sessionNew = frames.find((frame) => frame["method"] === "session/new");
      const servers = (
        sessionNew?.["params"] as { mcpServers: readonly { name: string }[] }
      ).mcpServers;
      expect(servers.map((entry) => entry.name)).toEqual(["crosscheck"]);

      const prompts = frames.filter((frame) => frame["method"] === "session/prompt");
      expect(prompts).toHaveLength(1);
      const blocks = (
        prompts[0]?.["params"] as {
          prompt: readonly { type: string; text: string }[];
        }
      ).prompt;
      // The user's own block rides untouched; the briefing is APPENDED.
      expect(blocks[0]?.text).toBe("why does the limiter build fail");
      expect(blocks).toHaveLength(2);
      const briefing = blocks[1]?.text ?? "";
      expect(briefing).toContain("Ada");
      expect(briefing).toContain(`«${ADA_TITLE}»`);
      assertFramed("ben-first-prompt-briefing", briefing);
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "Cleo (Cursor): the briefing arrives as additional_context on sessionStart",
    async () => {
      // Act
      const run = await runBin(
        ["cursor-hook", "sessionStart"],
        cursorSessionStart(cleo.repo, CLEO_CONV_1),
        cleo.env,
      );

      // Assert: exit 0 always, parseable JSON, the documented output key.
      expect(run.exitCode).toBe(0);
      const context = additionalContextOf(run.stdout);
      expect(context.length).toBeGreaterThan(0);
      expect(context.length).toBeLessThanOrEqual(MAX_BRIEFING_CHARS);
      expect(context).toContain("Ada");
      expect(context).toContain(`«${ADA_TITLE}»`);
      // Ben's live ACP session is presence to her briefing.
      expect(context).toContain("Ben");
      assertFramed("cleo-session-start-briefing", context);
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "presence lists all three sessions with three distinct agent kinds",
    async () => {
      // Act: the hub surface, and Ada's statusline (a rendered surface).
      const sessions = await presenceAs(ada.apiKey);
      const kinds = new Map(
        sessions.map((entry) => [entry.agentKind, entry.developerId]),
      );

      // Assert: one session per connector, each under its own agent kind.
      expect([...kinds.keys()].sort()).toEqual([
        "acp:fake-agent",
        "claude-code",
        "cursor-ide",
      ]);
      expect(kinds.get("claude-code")).toBe(ada.developerId);
      expect(kinds.get("acp:fake-agent")).toBe(ben.developerId);
      expect(kinds.get("cursor-ide")).toBe(cleo.developerId);

    },
    STEP_TIMEOUT_MS,
  );

  test(
    "Cleo's failure triggers the failure-matched hint quoting Ada's claim, and telemetry lands",
    async () => {
      // Act: the SAME failure text, through Cursor's documented failure
      // event. The match here is the hub's FTS over the failure text (the
      // hint pipeline's text tier); the FINGERPRINT-driven direction is
      // asserted separately in the solved-pointer steps below.
      const run = await runBin(
        ["cursor-hook", "postToolUseFailure"],
        cursorFailure(cleo.repo, CLEO_CONV_1),
        cleo.env,
      );

      // Assert: the hint is Ada's evidence-backed root cause, quoted and
      // attributed — substance, not a pointer (§4's asymmetry).
      expect(run.exitCode).toBe(0);
      const hint = additionalContextOf(run.stdout);
      expect(hint).toContain(`«${ADA_ROOT_CAUSE}»`);
      expect(hint).toContain("Ada");
      assertFramed("cleo-failure-hint", hint);

      // The delivery row carries the right receiver and Ada's claim. CLAIM
      // deliveries only: Ada's evidence-backed likely_root_cause makes her
      // tree SOLVED (services/solved.ts — derived per read), so briefings in
      // this scenario legitimately record solved-POINTER deliveries too
      // (ref_kind work_context); the hint pipeline's own telemetry is the
      // claim row.
      const deliveries = await db.execute(
        sql`select session_id, ref_id from hint_deliveries where ref_kind = 'claim'`,
      );
      expect(deliveries.rows).toEqual([
        {
          session_id: CLEO_CROSSCHECK_SESSION_1,
          ref_id: adaClaimId,
        },
      ]);
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "fingerprint parity in anger: three connectors, three work contexts, ONE hub fingerprint",
    async () => {
      // Arrange: end Ben's session — capture may flush at the failure
      // moment already; the proxy's exit drain is the backstop that
      // GUARANTEES his captured failure reached the hub (§2.2 lifecycle).
      expect(benDriver).not.toBeNull();
      const exitCode = await benDriver?.close();
      expect(exitCode).toBe(0);

      // Presence half of "knowledge outlives presence": his ENDED session
      // leaves live presence immediately (the hub excludes ended sessions
      // even inside the TTL) — the next step asserts the knowledge half.
      const afterClose = await presenceAs(ada.apiKey);
      expect(
        afterClose.some((entry) => entry.developerId === ben.developerId),
      ).toBe(false);

      // Act
      const rows = await db.execute(
        sql`select work_context_id, value from work_context_targets where kind = 'error_fingerprint'`,
      );

      // Assert: one row per connector's work context, one distinct value —
      // and it is exactly what the shared normalizer derives from the text.
      const contexts = new Set(rows.rows.map((row) => row["work_context_id"]));
      const values = new Set(rows.rows.map((row) => row["value"]));
      expect(rows.rows).toHaveLength(3);
      expect(contexts.size).toBe(3);
      expect(contexts.has(`wc_${BEN_CROSSCHECK_SESSION}`)).toBe(true);
      expect(contexts.has(`wc_${CLEO_CROSSCHECK_SESSION_1}`)).toBe(true);
      expect([...values]).toEqual([
        fingerprint(extractFailureText({ stderr: FAILURE_TEXT })),
      ]);

      // Ben's edit location landed repo-relative beside the fingerprint.
      const files = await db.execute(
        sql`select value from work_context_targets
            where kind = 'file' and work_context_id = ${`wc_${BEN_CROSSCHECK_SESSION}`}`,
      );
      expect(files.rows.map((row) => row["value"])).toEqual([
        "src/limiter-consumer.ts",
      ]);
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "Ada's next Claude briefing shows the other connectors' work",
    async () => {
      // Act: a second Claude session for Ada, through the real hook.
      const run = await runBin(
        ["hook", "session-start"],
        claudeSessionStart(ada.repo, "ada-uuid-2"),
        ada.env,
      );

      // Assert: Cleo is live presence; Ben's ended session left his work
      // context visible (knowledge outlives presence).
      expect(run.exitCode).toBe(0);
      const parsed = JSON.parse(run.stdout) as {
        hookSpecificOutput: { additionalContext: string };
      };
      const context = parsed.hookSpecificOutput.additionalContext;
      expect(context).toContain("Cleo");
      expect(context).toContain("Ben");
      expect(context.length).toBeLessThanOrEqual(MAX_BRIEFING_CHARS);
      assertFramed("ada-second-briefing", context);

      // THE FINGERPRINT SURFACES (§4.5): Ada's solved tree (evidence-backed
      // likely_root_cause ⇒ SOLVED, services/solved.ts) matches the other
      // connectors' live work through the solved-matches fingerprint tier —
      // the ONLY strong target her tree shares with theirs (she has no file
      // target). Break that tier and this line disappears: the fingerprint
      // rows of the previous step are causally load-bearing here, not
      // merely recorded.
      expect(context).toContain(FINGERPRINT_MATCH_LABEL);
      expect(context).toContain(`get_diagnosis ${ADA_WORK_CONTEXT}`);

      // Her statusline (a rendered surface, via the same subprocess bin)
      // reads the presence cache this session-start just refreshed: Cleo's
      // live Cursor session is on it.
      const line = await runBin(
        ["statusline"],
        JSON.stringify({ session_id: "ada-uuid-2", cwd: ada.repo }),
        ada.env,
      );
      expect(line.stdout).toMatch(/^cx \d+ · /);
      expect(line.stdout).toContain("Cleo");
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "Ada's presence opt-out hides her LIVE presence from both other connectors — not her knowledge",
    async () => {
      // Act: the CLI subprocess, then the surfaces.
      const off = await runBin(["presence", "off"], "", ada.env, ada.repo);
      expect(off.exitCode).toBe(0);
      expect(off.stdout).toContain("hidden");

      // Assert: the hub presence surface, per viewer.
      const benView = await presenceAs(ben.apiKey);
      const cleoView = await presenceAs(cleo.apiKey);
      const adaView = await presenceAs(ada.apiKey);
      expect(benView.some((entry) => entry.developerId === ada.developerId)).toBe(false);
      expect(cleoView.some((entry) => entry.developerId === ada.developerId)).toBe(false);
      // Her own view of herself is unaffected.
      expect(
        adaView.some((entry) => entry.developerId === ada.developerId && entry.isSelf),
      ).toBe(true);

      // A fresh Cursor session's RENDERED briefing: no Ada in the presence
      // section, while her published work context stays a pointer (opt-out
      // hides live presence, never retracts knowledge — §2.1).
      const run = await runBin(
        ["cursor-hook", "sessionStart"],
        cursorSessionStart(cleo.repo, "conv-cleo-2"),
        cleo.env,
      );
      const context = additionalContextOf(run.stdout);
      const contextsHeaderAt = context.indexOf("Teammate work contexts");
      expect(contextsHeaderAt).toBeGreaterThan(-1);
      const presencePart = context.slice(0, contextsHeaderAt);
      const knowledgePart = context.slice(contextsHeaderAt);
      expect(presencePart).not.toContain("Ada");
      expect(knowledgePart).toContain(`«${ADA_TITLE}»`);
      // The solved pointer is knowledge too: the fingerprint-tier match
      // rides through her opt-out ("a solved tree is published knowledge",
      // services/solved-matches.ts) …
      expect(knowledgePart).toContain(FINGERPRINT_MATCH_LABEL);
      assertFramed("cleo-briefing-after-optout", context);

      // … and its delivery row lands for THIS session (ref_kind
      // work_context — the solved-pointer telemetry the claim-row filters
      // elsewhere in this file deliberately exclude). This is the §4.5
      // sentence made positive: an error fingerprint recorded by one
      // connector surfaces in another's briefing, with the row to prove it.
      const solvedDeliveries = await db.execute(
        sql`select ref_id from hint_deliveries
            where ref_kind = 'work_context'
              and session_id = ${"cc_cur-conv-cleo-2"}`,
      );
      expect(solvedDeliveries.rows).toEqual([{ ref_id: ADA_WORK_CONTEXT }]);
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "Cleo muting Ada silences her briefing pointers AND the failure-matched hint, across connectors",
    async () => {
      // Arrange: reader-side mute, set through the CLI subprocess.
      const mute = await runBin(["mute", "Ada"], "", cleo.env, cleo.repo);
      expect(mute.exitCode).toBe(0);

      // Act: a fresh Cursor session and the SAME failure that produced the
      // hint in conv-cleo-1 (the unmuted control earlier in this scenario).
      const start = await runBin(
        ["cursor-hook", "sessionStart"],
        cursorSessionStart(cleo.repo, "conv-cleo-3"),
        cleo.env,
      );
      const failure = await runBin(
        ["cursor-hook", "postToolUseFailure"],
        cursorFailure(cleo.repo, "conv-cleo-3"),
        cleo.env,
      );

      // Assert: no Ada anywhere on Cleo's surfaces — briefing or hint. The
      // briefing is still a RENDERED surface (Ben's context remains
      // visible knowledge), so it passes the same framing seal as the rest.
      expect(start.exitCode).toBe(0);
      const briefing = additionalContextOf(start.stdout);
      expect(briefing.length).toBeGreaterThan(0);
      expect(briefing).not.toContain("Ada");
      expect(briefing).not.toContain(`«${ADA_TITLE}»`);
      assertFramed("cleo-briefing-after-mute", briefing);
      expect(failure.exitCode).toBe(0);
      expect(failure.stdout.trim()).toBe("{}");
      // And the telemetry: the claim deliveries are exactly the pre-mute
      // single row, and the muted session recorded NOTHING of any kind —
      // a muted candidate is never delivered, so the connector never
      // records it (services/visibility.ts).
      const claimDeliveries = await db.execute(
        sql`select ref_id from hint_deliveries where ref_kind = 'claim'`,
      );
      expect(claimDeliveries.rows).toEqual([{ ref_id: adaClaimId }]);
      const mutedSessionRows = await db.execute(
        sql`select ref_id from hint_deliveries where session_id = ${"cc_cur-conv-cleo-3"}`,
      );
      expect(mutedSessionRows.rows).toEqual([]);
    },
    STEP_TIMEOUT_MS,
  );

  test(
    "unmute restores the hint to a fresh session — the mute was the cause, not dedup",
    async () => {
      // Arrange: reverse the mute through the CLI. This is the positive
      // re-delivery control for the previous step: hint dedup is
      // per-session (state.deliveredHintRefs), so a fresh session CAN
      // receive the same claim — if `{}` above had come from any dedup
      // instead of the hub's mute exclusion, this step would stay `{}` too
      // and go red.
      const unmute = await runBin(["unmute", "Ada"], "", cleo.env, cleo.repo);
      expect(unmute.exitCode).toBe(0);

      // Act: a fresh Cursor session hits the SAME failure once more.
      const start = await runBin(
        ["cursor-hook", "sessionStart"],
        cursorSessionStart(cleo.repo, "conv-cleo-4"),
        cleo.env,
      );
      expect(start.exitCode).toBe(0);
      const failure = await runBin(
        ["cursor-hook", "postToolUseFailure"],
        cursorFailure(cleo.repo, "conv-cleo-4"),
        cleo.env,
      );

      // Assert: the hint is back — same claim, same substance, attributed —
      // and its claim delivery row lands beside the pre-mute one.
      expect(failure.exitCode).toBe(0);
      const hint = additionalContextOf(failure.stdout);
      expect(hint).toContain(`«${ADA_ROOT_CAUSE}»`);
      expect(hint).toContain("Ada");
      assertFramed("cleo-hint-after-unmute", hint);
      const claimDeliveries = await db.execute(
        sql`select session_id, ref_id from hint_deliveries
            where ref_kind = 'claim' order by session_id`,
      );
      expect(claimDeliveries.rows).toEqual([
        { session_id: CLEO_CROSSCHECK_SESSION_1, ref_id: adaClaimId },
        { session_id: "cc_cur-conv-cleo-4", ref_id: adaClaimId },
      ]);
    },
    STEP_TIMEOUT_MS,
  );
});
