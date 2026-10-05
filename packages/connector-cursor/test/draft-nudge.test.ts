/**
 * The draft review nudge on Cursor, driven through the REAL postToolUse
 * handler against a REAL in-process hub. Cursor's only mid-session channel
 * that can add context is postToolUse's documented `additional_context`
 * ("injected after the tool result"); beforeSubmitPrompt can only block and
 * stop's followup_message would speak AS the user, which this connector never
 * does. So the nudge rides the first postToolUse after a finished turn, once
 * per session, and never in a background agent.
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
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";

import { runCursorHook } from "../src/index.ts";
import { CURSOR_CAPABILITY_MANIFEST } from "../src/capabilities.ts";
import { POST_TOOL_USE_INPUT } from "./fixtures/cursor-contract/payloads.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";
import { bootDraftHub } from "../../connector-core/test/fixtures/draft-hub.ts";
import type { DraftHub } from "../../connector-core/test/fixtures/draft-hub.ts";

const REPO_ID = "github.com/acme/api";
const CONVERSATION_ID = "conv-nudge-1";
const HOST_KEY = `cur-${CONVERSATION_ID}`;
const SESSION_ID = `cc_${HOST_KEY}`;
const OLD_MS = (DRAFT_NUDGE_MIN_AGE_HOURS + 3) * (MS_PER_DAY / 24);

let hub: DraftHub;
const cleanups: string[] = [];

beforeAll(async () => {
  hub = await bootDraftHub({
    label: "cursor-nudge",
    repoId: REPO_ID,
    sessionId: SESSION_ID,
    workContextId: `wc_${SESSION_ID}`,
  });
  await hub.seedDraft({ kind: "rejected_approach", body: "Retrying the flush inside the lock", ageMs: OLD_MS });
});

afterAll(async () => {
  await hub.close();
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly env: Env;
}

const fixture = async (label: string, finishedTurns: number): Promise<Fixture> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  cleanups.push(repo, home);
  await writeSessionState(home, {
    hostSessionKey: HOST_KEY,
    crosscheckSessionId: SESSION_ID,
    workContextId: `wc_${SESSION_ID}`,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl: hub.hubUrl,
    developerId: hub.developerId,
    startedAt: new Date().toISOString(),
    stopTurnCount: finishedTurns,
  });
  return {
    repo,
    home,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.hubUrl,
      CROSSCHECK_API_KEY: hub.apiKey,
      CROSSCHECK_TIMEOUT_MS: "4000",
    },
  };
};

const toolUse = (fix: Fixture, extra: Record<string, unknown> = {}): Promise<string> =>
  runCursorHook(
    "postToolUse",
    JSON.stringify({
      ...POST_TOOL_USE_INPUT,
      conversation_id: CONVERSATION_ID,
      workspace_roots: [fix.repo],
      cwd: fix.repo,
      ...extra,
    }),
    fix.env,
  );

const contextOf = (stdout: string): string => {
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const value = parsed["additional_context"];
  return typeof value === "string" ? value : "";
};

describe("draft review nudge on Cursor postToolUse", () => {
  test("rides the first tool result after a finished turn, once per session", async () => {
    // Arrange
    const fix = await fixture("cursor-nudge-once", 1);

    // Act
    const first = await toolUse(fix);
    const second = await toolUse(fix);

    // Assert
    expect(contextOf(first)).toContain("1 of your own auto-captured draft claims has waited");
    expect(contextOf(first)).toContain("rejected_approach");
    expect(contextOf(first)).toContain("ask the person");
    expect(contextOf(second)).toBe("");
    expect(JSON.parse(first)).not.toHaveProperty("followup_message");
    expect((await readSessionState(fix.home, HOST_KEY))?.draftNudge).toBe("delivered");
  });

  test("never inside the opening turn", async () => {
    const fix = await fixture("cursor-nudge-opening", 0);

    expect(contextOf(await toolUse(fix))).toBe("");
    expect((await readSessionState(fix.home, HOST_KEY))?.draftNudge).toBeNull();
  });

  test("never in a background agent, where no person reads", async () => {
    const fix = await fixture("cursor-nudge-background", 1);

    expect(contextOf(await toolUse(fix, { is_background_agent: true }))).toBe("");
    expect((await readSessionState(fix.home, HOST_KEY))?.draftNudge).toBeNull();
  });
});

describe("where Cursor cannot nudge, doctor says so", () => {
  test("the background-agent and no-tool-call limits are a declared refusal", () => {
    const refusal = CURSOR_CAPABILITY_MANIFEST.refusals.find((entry) => entry.name === "draft review nudge");

    expect(refusal?.sentence).toContain("background or cloud agent");
    expect(refusal?.sentence).toContain("followup_message");
  });
});
