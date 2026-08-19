/**
 * The Block-5 injector (src/inject/injector.ts) against the REAL capture
 * engine and a fully canned hub — every §2.5 decision pinned:
 *
 *   - version gate: no decided version / version ≠ 1 → forward, one notice;
 *   - mcpServers append: exactly one owned entry, user entries untouched,
 *     conservative skips (no array, conflicts, unconnected cwd) logged;
 *   - prompt path: briefing-pending fallback → briefing once → hints under
 *     the seen-set, telemetry rows spooled BEFORE the text ships, budget
 *     blown → forward unmodified;
 *   - privacy: prompt text reaches no file.
 *
 * The hub is canned (hint-hub.ts philosophy) rather than the real server:
 * injection decisions need latency DIALS (a deliberately slow presence GET
 * is what makes "briefing not ready → skipped → next prompt gets it"
 * deterministic instead of a race).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QUOTED_DATA_NOTICE } from "@crosscheck/connector-core/briefing/render.ts";
import { repoKey, sessionSlug } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { readSessionSpool } from "@crosscheck/connector-core/spool/files.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";

import { createAcpCapture } from "../src/capture/engine.ts";
import type { AcpCapture } from "../src/capture/engine.ts";
import { createAcpInjector } from "../src/inject/injector.ts";
import type { AcpInjector } from "../src/inject/injector.ts";
import { stubLogger, wireLine } from "./fixtures/capture-harness.ts";
import type { StubLogger } from "./fixtures/capture-harness.ts";
import { BIN_PATH } from "./fixtures/e2e-helpers.ts";
import { startCannedHub } from "./fixtures/canned-hub.ts";
import type { CannedHub } from "./fixtures/canned-hub.ts";
import {
  CANDIDATE_BODY,
  CANDIDATE_CLAIM_ID,
} from "../../connector-core/test/fixtures/hint-hub.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const REMOTE = "git@github.com:acme/api.git";
const SESSION_ID = "sess-1";
const HOST_KEY = "acp-fake-agent--sess-1";
const WAIT_STEP_MS = 20;
const WAIT_MAX_MS = 4000;

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

interface Fixture {
  readonly home: string;
  readonly repo: string;
  readonly hub: CannedHub;
  readonly env: Env;
  readonly logger: StubLogger;
  readonly capture: AcpCapture;
  readonly injector: AcpInjector;
  readonly notices: string[];
  readonly key: string;
}

const cleanups: string[] = [];
const hubs: CannedHub[] = [];
const captures: AcpCapture[] = [];

afterEach(async () => {
  for (const capture of captures) {
    await capture.shutdown(500).catch(() => undefined);
  }
  captures.length = 0;
  for (const hub of hubs) {
    hub.stop();
  }
  hubs.length = 0;
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
  cleanups.length = 0;
});

const fixture = async (
  label: string,
  options: { injectorTimeoutMs?: string } = {},
): Promise<Fixture> => {
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: REMOTE });
  cleanups.push(home, repo);
  const hub = startCannedHub();
  hubs.push(hub);
  const env: Env = {
    CROSSCHECK_HOME: home,
    CROSSCHECK_HUB_URL: hub.url,
    CROSSCHECK_API_KEY: "test-key",
    CROSSCHECK_TIMEOUT_MS: "2000",
    // Empty PATH: the launcher must deterministically fall back to the
    // running entry script instead of whatever this machine calls crosscheck.
    PATH: "",
  };
  const logger = stubLogger();
  const capture = createAcpCapture({ env, logger, injection: true });
  captures.push(capture);
  const notices: string[] = [];
  const injector = createAcpInjector({
    // The budget test skews the injector's request timeout BELOW the flow's
    // (which rides the engine's env): in production both derive from one
    // env and the race fires only when the flow's whole pipeline overflows
    // the ratio; the skew makes that overflow deterministic in a test.
    env:
      options.injectorTimeoutMs === undefined
        ? env
        : { ...env, CROSSCHECK_TIMEOUT_MS: options.injectorTimeoutMs },
    logger,
    capture,
    entryPath: BIN_PATH,
    notify: (line) => {
      notices.push(line);
    },
  });
  return {
    home,
    repo,
    hub,
    env,
    logger,
    capture,
    injector,
    notices,
    key: repoKey(hub.url, REPO_ID),
  };
};

const line = (value: unknown): string => JSON.stringify(value);

const initRequest = (id: number): string =>
  line({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: 1 } });

const openGate = async (f: Fixture, protocolVersion = 1): Promise<void> => {
  await f.injector.decideLine(initRequest(1));
  f.injector.offerA2c(
    wireLine({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion, agentInfo: { name: "fake-agent", version: "1.0.0" } },
    }),
  );
};

const sessionNewLine = (
  f: Fixture,
  extra: Record<string, unknown> = {},
  method = "session/new",
): string =>
  line({
    jsonrpc: "2.0",
    id: 2,
    method,
    params: { cwd: f.repo, mcpServers: [], ...extra },
  });

/** Drives the ENGINE through the session/new exchange (register + prefetch). */
const registerSession = async (f: Fixture): Promise<void> => {
  f.capture.offer(
    "c2a",
    wireLine({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }),
  );
  f.capture.offer(
    "a2c",
    wireLine({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: 1, agentInfo: { name: "fake-agent", version: "1.0.0" } },
    }),
  );
  f.capture.offer(
    "c2a",
    wireLine({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: f.repo, mcpServers: [] } }),
  );
  f.capture.offer("a2c", wireLine({ jsonrpc: "2.0", id: 2, result: { sessionId: SESSION_ID } }));
  await f.capture.settle();
};

let promptId = 100;
const promptLine = (text: string, sessionId: string = SESSION_ID): string => {
  promptId += 1;
  return line({
    jsonrpc: "2.0",
    id: promptId,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text }] },
  });
};

/** Retries an async producer until it yields non-null (bounded). */
const waitFor = async <T>(
  produce: () => Promise<T | null>,
  maxMs: number = WAIT_MAX_MS,
): Promise<T> => {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const value = await produce();
    if (value !== null) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("waitFor: gave up");
    }
    await sleep(WAIT_STEP_MS);
  }
};

/**
 * The launcher resolution is async at construction; a probe append proves it
 * settled (and warms the cwd cache) before the skip-reason tests run.
 */
const waitForLauncher = async (f: Fixture): Promise<void> => {
  await waitFor(() => f.injector.decideLine(sessionNewLine(f)));
};

describe("version gate (§2.3 rule 7)", () => {
  test("no decided version → every decision forwards, logged", async () => {
    const f = await fixture("inj-gate-undecided");

    const decision = await f.injector.decideLine(sessionNewLine(f));

    expect(decision).toBeNull();
    expect(f.logger.lines.some((entry) => entry.includes("skip why=version-gate"))).toBe(true);
  });

  test("protocol ≠ 1 → injection off for the connection, ONE stderr notice", async () => {
    const f = await fixture("inj-gate-v2");
    await openGate(f, 2);

    expect(await f.injector.decideLine(sessionNewLine(f))).toBeNull();
    expect(await f.injector.decideLine(promptLine("does this get a hint"))).toBeNull();
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]).toContain("protocol version 2");
    expect(f.logger.lines.some((entry) => entry.includes("inject off protocol=2"))).toBe(true);
  });
});

describe("write point 1: the mcpServers append (§2.5)", () => {
  test("appends exactly one owned entry; the user's entries stay untouched", async () => {
    const f = await fixture("inj-mcp-happy");
    await openGate(f);
    const userEntry = { name: "team-tools", command: "/usr/local/bin/team", args: [], env: [] };

    const decision = await waitFor(() =>
      f.injector.decideLine(sessionNewLine(f, { mcpServers: [userEntry], extraField: 7 })),
    );

    const replaced = JSON.parse(decision) as {
      id: number;
      method: string;
      params: {
        cwd: string;
        extraField: number;
        mcpServers: readonly { name: string; command: string; args: readonly string[] }[];
      };
    };
    expect(replaced.method).toBe("session/new");
    expect(replaced.params.extraField).toBe(7);
    expect(replaced.params.mcpServers).toHaveLength(2);
    expect(replaced.params.mcpServers[0]).toEqual(userEntry);
    const own = replaced.params.mcpServers[1];
    expect(own?.name).toBe("crosscheck");
    expect(own?.command).toBe(process.execPath);
    expect(own?.args).toEqual([BIN_PATH, "mcp"]);
  });

  test("session/load gets the same append", async () => {
    const f = await fixture("inj-mcp-load");
    await openGate(f);

    const decision = await waitFor(() =>
      f.injector.decideLine(sessionNewLine(f, { sessionId: SESSION_ID }, "session/load")),
    );

    const replaced = JSON.parse(decision) as {
      params: { mcpServers: readonly { name: string }[] };
    };
    expect(replaced.params.mcpServers.at(-1)?.name).toBe("crosscheck");
  });

  test("no mcpServers array → conservative skip (open question 3)", async () => {
    const f = await fixture("inj-mcp-noarray");
    await openGate(f);
    await waitForLauncher(f);

    const decision = await f.injector.decideLine(
      line({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: f.repo } }),
    );

    expect(decision).toBeNull();
    expect(f.logger.lines.some((entry) => entry.includes("why=no-mcpservers-array"))).toBe(true);
  });

  test("an existing crosscheck entry is never clobbered — owned or foreign", async () => {
    const f = await fixture("inj-mcp-conflict");
    await openGate(f);
    await waitForLauncher(f);

    const owned = { name: "crosscheck", command: "crosscheck", args: ["mcp"], env: [] };
    expect(
      await f.injector.decideLine(sessionNewLine(f, { mcpServers: [owned] })),
    ).toBeNull();
    expect(f.logger.lines.some((entry) => entry.includes("why=already-present"))).toBe(true);

    const foreign = { name: "crosscheck", command: "evil-tool", args: ["--serve"], env: [] };
    expect(
      await f.injector.decideLine(sessionNewLine(f, { mcpServers: [foreign] })),
    ).toBeNull();
    expect(
      f.logger.lines.some((entry) => entry.includes("why=foreign-crosscheck-entry")),
    ).toBe(true);
  });

  test("an unconnected cwd stays a pure pipe", async () => {
    const f = await fixture("inj-mcp-unconnected");
    await openGate(f);
    await waitForLauncher(f);
    const plainDir = await mkdtemp(join(tmpdir(), "cx-not-a-repo-"));
    cleanups.push(plainDir);

    const decision = await f.injector.decideLine(sessionNewLine(f, { cwd: plainDir }));

    expect(decision).toBeNull();
    expect(f.logger.lines.some((entry) => entry.includes("why=unconnected-cwd"))).toBe(true);
  });
});

describe("write point 2: the prompt block (§2.5)", () => {
  test("briefing pending → skip; the NEXT prompt gets it; hints follow; seen-set holds", async () => {
    const f = await fixture("inj-prompt-full");
    // The dial that makes "not ready" deterministic instead of a race.
    f.hub.latency.presence = 300;
    await openGate(f);
    await registerSession(f);

    // Prompt while the prefetch hangs on the slow presence GET: skipped.
    const early = await f.injector.decideLine(promptLine("first question about refresh"));
    expect(early).toBeNull();
    expect(f.logger.lines.some((entry) => entry.includes("why=briefing-pending"))).toBe(true);

    // The next prompt (after the prefetch lands) carries the briefing as ONE
    // APPENDED trailing block; the user's own block is byte-equal.
    const briefingDecision = await waitFor(() =>
      f.injector.decideLine(promptLine("second question about refresh")),
    );
    const briefed = JSON.parse(briefingDecision) as {
      params: { prompt: readonly { type: string; text: string }[] };
    };
    expect(briefed.params.prompt).toHaveLength(2);
    expect(briefed.params.prompt[0]).toEqual({
      type: "text",
      text: "second question about refresh",
    });
    expect(briefed.params.prompt[1]?.type).toBe("text");
    expect(briefed.params.prompt[1]?.text).toContain(QUOTED_DATA_NOTICE);
    expect(briefed.params.prompt[1]?.text).toContain("Nick");

    // Third prompt: the hint path — evidence-backed substance, appended.
    const hintDecision = await waitFor(() =>
      f.injector.decideLine(promptLine("SECRET-ACP-MARKER why does refresh rotation fail")),
    );
    const hinted = JSON.parse(hintDecision) as {
      params: { prompt: readonly { type: string; text: string }[] };
    };
    expect(hinted.params.prompt[1]?.text).toContain(CANDIDATE_BODY);

    // Telemetry recorded BEFORE the text shipped; the seen-set now silences
    // the same ref; and the prompt text reached no file (privacy pin).
    const spool = await readSessionSpool(f.home, f.key, sessionSlug(HOST_KEY));
    const kinds = spool.lines.map((entry) => (JSON.parse(entry) as { kind: string }).kind);
    expect(kinds).toContain("hint_delivery");
    expect(spool.lines.join("\n")).not.toContain("SECRET-ACP-MARKER");
    const state = await readSessionState(f.home, HOST_KEY);
    expect(state?.deliveredHintRefs).toEqual([CANDIDATE_CLAIM_ID]);
    expect(JSON.stringify(state)).not.toContain("SECRET-ACP-MARKER");

    const again = await f.injector.decideLine(
      promptLine("same question, new words: refresh rotation"),
    );
    expect(again).toBeNull();

    expect(f.injector.counters().briefings).toBe(1);
    expect(f.injector.counters().hints).toBe(1);
  });

  test("an unknown session skips (fail open, next prompt may know it)", async () => {
    const f = await fixture("inj-prompt-unknown");
    await openGate(f);

    const decision = await f.injector.decideLine(promptLine("hello", "sess-never-seen"));

    expect(decision).toBeNull();
    expect(f.logger.lines.some((entry) => entry.includes("why=unknown-session"))).toBe(true);
  });

  test("a non-array prompt cannot be appended to — skip (append-don't-edit)", async () => {
    const f = await fixture("inj-prompt-noarray");
    await openGate(f);
    await registerSession(f);

    const decision = await f.injector.decideLine(
      line({
        jsonrpc: "2.0",
        id: 900,
        method: "session/prompt",
        params: { sessionId: SESSION_ID, prompt: "bare string" },
      }),
    );

    expect(decision).toBeNull();
    expect(f.logger.lines.some((entry) => entry.includes("why=no-prompt-array"))).toBe(true);
  });

  test("hint budget blown → prompt forwarded unmodified (§4.2 pin)", async () => {
    // 50 ms injector timeout → 100 ms prompt budget, while the flow's own
    // hub timeout stays 2000 ms and its candidates GET takes 400 ms — the
    // race must fire first. The flow finishes in the background — the slot
    // is spent, the wire untouched (the documented lost-slot direction).
    const f = await fixture("inj-prompt-budget", { injectorTimeoutMs: "50" });
    f.hub.latency.candidates = 400;
    await openGate(f);
    await registerSession(f);

    // Spend the briefing first (it resolves quickly; presence is fast here).
    await waitFor(() => f.injector.decideLine(promptLine("briefing spender")));

    const start = Date.now();
    const decision = await f.injector.decideLine(promptLine("this one must not wait long"));
    const elapsed = Date.now() - start;

    expect(decision).toBeNull();
    expect(f.logger.lines.some((entry) => entry.includes("why=budget"))).toBe(true);
    // Budget + margin, far below the hub latency that would otherwise gate.
    expect(elapsed).toBeLessThan(350);
  });

  test("session/cancel is never awaited on — the decision is synchronous null", async () => {
    const f = await fixture("inj-cancel");
    await openGate(f);
    await registerSession(f);

    const decision = await f.injector.decideLine(
      line({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: SESSION_ID } }),
    );

    expect(decision).toBeNull();
    // No skip row, no log line: a notification is not a write point at all.
    expect(f.logger.lines.some((entry) => entry.includes("session/cancel"))).toBe(false);
  });
});
