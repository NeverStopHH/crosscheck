/**
 * Shared drive-train for the Block-4 capture suites: a real in-process hub,
 * an engine wired to it, and the ACP wire spoken as ObservedLine events
 * exactly as the proxy's observer emits them. EXTRACTED VERBATIM from
 * capture-engine.test.ts when the hardening suite
 * (capture-hardening.test.ts) needed the same harness — one implementation,
 * two suites, zero assertion changes (the flow-extraction rule).
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { createDb, createServer } from "@crosscheck/server";

import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import type { HubContext } from "@crosscheck/connector-core/http/client.ts";

import { createAcpCapture } from "../../src/capture/engine.ts";
import type { AcpLogger } from "../../src/logger.ts";
import type { ObservedLine } from "../../src/observer.ts";
import { makeHome, makeRepo } from "../../../connector-core/test/helpers.ts";

export const REPO_ID = "github.com/acme/api";
export const REMOTE = "git@github.com:acme/api.git";
export const TIMEOUT_MS = "4000";
export const SHUTDOWN_BUDGET_MS = 4000;

export interface CaptureHub {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly hubUrl: string;
  readonly apiKey: string;
}

/** One in-process hub per test file; the label keeps tokens/emails distinct. */
export const bootCaptureHub = async (label: string): Promise<CaptureHub> => {
  const db = await createDb();
  const adminToken = `${label}-admin`;
  const app = createServer({ db, adminToken });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const hubUrl = `http://127.0.0.1:${server.port}`;
  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "Acp Dev", email: `${label}@example.com` }),
  });
  const body = (await response.json()) as { data: { apiKey: string } };
  return { server, hubUrl, apiKey: body.data.apiKey };
};

/** In-memory AcpLogger: capture must not need a real log file to be tested. */
export interface StubLogger extends AcpLogger {
  readonly lines: readonly string[];
}

export const stubLogger = (): StubLogger => {
  const lines: string[] = [];
  return {
    lines,
    path: "/dev/null",
    line: (text: string) => {
      lines.push(text);
    },
    writeFailures: () => 0,
    droppedLines: () => 0,
    flush: () => Promise.resolve(),
  };
};

export const wireLine = (value: unknown): ObservedLine => ({
  kind: "line",
  text: JSON.stringify(value),
  parsedOk: true,
  bytes: 0,
  atEof: false,
});

export interface Harness {
  readonly home: string;
  readonly repo: string;
  readonly logger: StubLogger;
  readonly hub: HubContext;
  readonly clock: { value: Date };
  readonly capture: ReturnType<typeof createAcpCapture>;
}

export interface HarnessOptions {
  readonly agentKindFlag?: string;
  /** Extra env entries merged over the defaults (the test fault seams). */
  readonly env?: Env;
  /** Reuse an existing home/repo — the cross-proxy-lifetime scenarios. */
  readonly home?: string;
  readonly repo?: string;
}

export const createHarness = async (
  hub: CaptureHub,
  cleanups: string[],
  label: string,
  options: HarnessOptions = {},
): Promise<Harness> => {
  const home = options.home ?? (await makeHome(label));
  const repo = options.repo ?? (await makeRepo(label, { remote: REMOTE }));
  if (options.home === undefined) {
    cleanups.push(home);
  }
  if (options.repo === undefined) {
    cleanups.push(repo);
  }
  const env: Env = {
    CROSSCHECK_HOME: home,
    CROSSCHECK_HUB_URL: hub.hubUrl,
    CROSSCHECK_API_KEY: hub.apiKey,
    CROSSCHECK_TIMEOUT_MS: TIMEOUT_MS,
    ...options.env,
  };
  const logger = stubLogger();
  const clock = { value: new Date("2026-08-19T12:00:00.000Z") };
  const capture = createAcpCapture({
    env,
    logger,
    agentKindFlag: options.agentKindFlag,
    now: () => clock.value,
  });
  return {
    home,
    repo,
    logger,
    clock,
    capture,
    hub: {
      hubUrl: hub.hubUrl,
      apiKey: hub.apiKey,
      timeoutMs: Number(TIMEOUT_MS),
      home,
      repoKey: repoKey(hub.hubUrl, REPO_ID),
      now: () => new Date(),
    },
  };
};

export const advanceClock = (h: Harness, ms: number): void => {
  h.clock.value = new Date(h.clock.value.getTime() + ms);
};

export const handshake = (h: Harness, sessionId: string, cwd: string): void => {
  h.capture.offer(
    "c2a",
    wireLine({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }),
  );
  h.capture.offer(
    "a2c",
    wireLine({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "fake-agent", version: "1.0.0" },
      },
    }),
  );
  h.capture.offer(
    "c2a",
    wireLine({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } }),
  );
  h.capture.offer("a2c", wireLine({ jsonrpc: "2.0", id: 2, result: { sessionId } }));
};

export const toolCallUpdate = (
  sessionId: string,
  update: Record<string, unknown>,
): ObservedLine =>
  wireLine({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update },
  });

export const listFilesRecursively = async (
  root: string,
): Promise<readonly string[]> => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(
    () => [],
  );
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
};
