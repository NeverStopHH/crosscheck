/**
 * The draft review nudge behind the ACP proxy, through the REAL capture
 * engine and injector against a REAL in-process hub: ACP's one write point a
 * nudge can use is the appended prompt block (--inject mode), so the nudge
 * rides the first prompt after a finished turn on which neither the briefing
 * nor a hint spoke — once per session. Prompts stay under the intent gate's
 * floor, so no model is ever spawned.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import {
  DRAFT_NUDGE_MIN_AGE_HOURS,
  MS_PER_DAY,
} from "@crosscheck/connector-core/constants.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import {
  readSessionState,
  updateSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";

import { ACP_CAPABILITY_MANIFEST } from "../src/capabilities.ts";
import { createAcpCapture } from "../src/capture/engine.ts";
import { createAcpInjector } from "../src/inject/injector.ts";
import type { DeliverDraftNudgeInput, PreparedDraftNudge } from "@crosscheck/connector-core/flows/draft-nudge.ts";
import { stubLogger, wireLine } from "./fixtures/capture-harness.ts";
import { BIN_PATH } from "./fixtures/e2e-helpers.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";
import { bootDraftHub } from "../../connector-core/test/fixtures/draft-hub.ts";
import type { DraftHub } from "../../connector-core/test/fixtures/draft-hub.ts";

const REPO_ID = "github.com/acme/api";
const SESSION_ID = "sess-nudge";
const HOST_KEY = `acp-fake-agent--${SESSION_ID}`;
const OLD_MS = (DRAFT_NUDGE_MIN_AGE_HOURS + 3) * (MS_PER_DAY / 24);
const WAIT_STEP_MS = 20;
const WAIT_MAX_MS = 4000;

let hub: DraftHub;
const cleanups: string[] = [];

beforeAll(async () => {
  hub = await bootDraftHub({
    label: "acp-nudge",
    repoId: REPO_ID,
    sessionId: `cc_${HOST_KEY}`,
    workContextId: `wc_cc_${HOST_KEY}`,
  });
  await hub.seedDraft({ kind: "observation", body: "The proxy log rotates at 2 MB", ageMs: OLD_MS });
});

afterAll(async () => {
  await hub.close();
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

const waitFor = async <T>(produce: () => Promise<T | null>): Promise<T> => {
  const deadline = Date.now() + WAIT_MAX_MS;
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

let promptId = 100;
const promptLine = (text: string): string => {
  promptId += 1;
  return JSON.stringify({
    jsonrpc: "2.0",
    id: promptId,
    method: "session/prompt",
    params: { sessionId: SESSION_ID, prompt: [{ type: "text", text }] },
  });
};

const appendedText = (decision: string | null): string => {
  if (decision === null) {
    return "";
  }
  const parsed = JSON.parse(decision) as { params: { prompt: readonly { text: string }[] } };
  return parsed.params.prompt.length > 1 ? (parsed.params.prompt.at(-1)?.text ?? "") : "";
};

describe("draft review nudge on the ACP prompt block", () => {
  test("rides the first quiet prompt after a finished turn, once per session", async () => {
    // Arrange: a registered session whose briefing has already been shown
    const home = await makeHome("acp-nudge");
    const repo = await makeRepo("acp-nudge", { remote: "git@github.com:acme/api.git" });
    cleanups.push(home, repo);
    const env: Env = {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.hubUrl,
      CROSSCHECK_API_KEY: hub.apiKey,
      CROSSCHECK_TIMEOUT_MS: "2000",
      PATH: "",
    };
    const logger = stubLogger();
    const capture = createAcpCapture({ env, logger, injection: true });
    try {
      const injector = createAcpInjector({ env, logger, capture, entryPath: BIN_PATH, notify: () => undefined });
      const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } };
      const initResult = { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, agentInfo: { name: "fake-agent", version: "1.0.0" } } };
      await injector.decideLine(JSON.stringify(init));
      injector.offerA2c(wireLine(initResult));
      capture.offer("c2a", wireLine(init));
      capture.offer("a2c", wireLine(initResult));
      capture.offer("c2a", wireLine({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: repo, mcpServers: [] } }));
      capture.offer("a2c", wireLine({ jsonrpc: "2.0", id: 2, result: { sessionId: SESSION_ID } }));
      await capture.settle();
      const briefed = appendedText(await waitFor(() => injector.decideLine(promptLine("first look at it"))));
      expect(briefed).not.toContain("auto-captured draft claims");
      await updateSessionState(home, HOST_KEY, (fresh) => ({ ...fresh, stopTurnCount: 1 }));

      // Act
      const nudged = appendedText(await injector.decideLine(promptLine("and the next bit")));
      const after = appendedText(await injector.decideLine(promptLine("one more thing")));

      // Assert
      expect(nudged).toContain("1 of your own auto-captured draft claims has waited");
      expect(nudged).toContain("ask the person");
      expect(nudged).toContain("review_draft clm_");
      expect(after).not.toContain("auto-captured draft claims");
      expect((await readSessionState(home, HOST_KEY))?.draftNudge).toBe("delivered");
      expect(injector.counters().nudges).toBe(1);
      expect(logger.lines.some((entry) => entry.includes("inject draft-nudge"))).toBe(true);
    } finally {
      await capture.shutdown(500).catch(() => undefined);
    }
  });
});

describe("the slot is spent only once the nudge is actually in the prompt", () => {
  /**
   * A registered session past its briefing, with the injector's prompt budget
   * set by `injectorTimeoutMs` and its nudge preparation swapped for `prepareNudge`.
   */
  const pastTheBriefing = async (
    label: string,
    prepareNudge: (input: DeliverDraftNudgeInput) => Promise<PreparedDraftNudge | null>,
    injectorTimeoutMs: string,
  ) => {
    const home = await makeHome(label);
    const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
    cleanups.push(home, repo);
    const env: Env = {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.hubUrl,
      CROSSCHECK_API_KEY: hub.apiKey,
      CROSSCHECK_TIMEOUT_MS: "2000",
      PATH: "",
    };
    const logger = stubLogger();
    const capture = createAcpCapture({ env, logger, injection: true });
    const injector = createAcpInjector({
      env: { ...env, CROSSCHECK_TIMEOUT_MS: injectorTimeoutMs },
      logger,
      capture,
      entryPath: BIN_PATH,
      notify: () => undefined,
      prepareNudge,
    });
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } };
    const initResult = { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, agentInfo: { name: "fake-agent", version: "1.0.0" } } };
    await injector.decideLine(JSON.stringify(init));
    injector.offerA2c(wireLine(initResult));
    capture.offer("c2a", wireLine(init));
    capture.offer("a2c", wireLine(initResult));
    capture.offer("c2a", wireLine({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: repo, mcpServers: [] } }));
    capture.offer("a2c", wireLine({ jsonrpc: "2.0", id: 2, result: { sessionId: SESSION_ID } }));
    await capture.settle();
    await waitFor(() => injector.decideLine(promptLine("first look at it")));
    return { injector, capture };
  };

  test("a nudge the prompt budget abandoned is never marked delivered", async () => {
    // Arrange: the preparation outlives a 200 ms prompt budget
    let commits = 0;
    const late = (): Promise<PreparedDraftNudge> =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({ text: "LATE-NUDGE-TEXT", commit: () => { commits += 1; return Promise.resolve(true); } });
        }, 600);
      });
    const { injector, capture } = await pastTheBriefing("acp-nudge-late", late, "100");
    try {
      // Act
      const decision = await injector.decideLine(promptLine("and the next bit"));
      await sleep(900);

      // Assert: not shown, and so never spent
      expect(appendedText(decision)).not.toContain("LATE-NUDGE-TEXT");
      expect(commits).toBe(0);
    } finally {
      await capture.shutdown(500).catch(() => undefined);
    }
  });

  test("a nudge that made the prompt is committed exactly once, before it ships", async () => {
    let commits = 0;
    const ready = (): Promise<PreparedDraftNudge> =>
      Promise.resolve({ text: "READY-NUDGE-TEXT", commit: () => { commits += 1; return Promise.resolve(true); } });
    const { injector, capture } = await pastTheBriefing("acp-nudge-ready", ready, "2000");
    try {
      const decision = await injector.decideLine(promptLine("and the next bit"));

      expect(appendedText(decision)).toContain("READY-NUDGE-TEXT");
      expect(commits).toBe(1);
    } finally {
      await capture.shutdown(500).catch(() => undefined);
    }
  });

  test("nothing due spends the slot, so later prompts look no more (review round 2, survivor M5)", async () => {
    // Nothing shows, so nothing can be lost by spending it: without the
    // commit every later prompt of the session fetches the drafts again.
    let commits = 0;
    const nothingDue = (): Promise<PreparedDraftNudge> =>
      Promise.resolve({ text: "", commit: () => { commits += 1; return Promise.resolve(true); } });
    const { injector, capture } = await pastTheBriefing("acp-nudge-nothing-due", nothingDue, "2000");
    try {
      await injector.decideLine(promptLine("and the next bit"));

      expect(commits).toBe(1);
    } finally {
      await capture.shutdown(500).catch(() => undefined);
    }
  });

  test("a slot another prompt already spent is not shown", async () => {
    const taken = (): Promise<PreparedDraftNudge> =>
      Promise.resolve({ text: "TAKEN-NUDGE-TEXT", commit: () => Promise.resolve(false) });
    const { injector, capture } = await pastTheBriefing("acp-nudge-taken", taken, "2000");
    try {
      expect(appendedText(await injector.decideLine(promptLine("and the next bit")))).not.toContain("TAKEN-NUDGE-TEXT");
    } finally {
      await capture.shutdown(500).catch(() => undefined);
    }
  });
});

describe("where the ACP proxy cannot nudge, doctor says so", () => {
  test("a --no-inject proxy's silence is a declared refusal", () => {
    const refusal = ACP_CAPABILITY_MANIFEST.refusals.find((entry) => entry.name === "draft review nudge without --inject");

    expect(refusal?.sentence).toContain("--no-inject");
  });
});
