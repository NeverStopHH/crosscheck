/**
 * The draft review nudge through the REAL UserPromptSubmit hook against a
 * REAL in-process hub: the first prompt after a finished turn carries it in
 * `additionalContext`, once per session; the opening prompt and a headless
 * run never do. No model runs — the intent fire is already spent in state,
 * and the landing fetch is switched off.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import {
  DRAFT_NUDGE_MIN_AGE_HOURS,
  HTTP_TIMEOUT_MS,
  LANDING_FETCH_ENV,
  LANDING_FETCH_OFF,
  MS_PER_DAY,
  TRIPWIRE_MODE_ENV,
  TRIPWIRE_MODE_NOTICE,
} from "@crosscheck/connector-core/constants.ts";
import {
  readSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import { claudeDoctorChecks, runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";
import { bootDraftHub } from "../../connector-core/test/fixtures/draft-hub.ts";
import type { DraftHub } from "../../connector-core/test/fixtures/draft-hub.ts";

const REPO_ID = "github.com/acme/api";
const HOST_KEY = "claude-nudge-uuid";
const SESSION_ID = `cc_${HOST_KEY}`;
const OLD_MS = (DRAFT_NUDGE_MIN_AGE_HOURS + 3) * (MS_PER_DAY / 24);
/** Under the intent gate's floor, so even a fresh state could not fire a model. */
const PROMPT = "next one please";

let hub: DraftHub;
const cleanups: string[] = [];

/**
 * Booting the in-process hub (PGlite) and seeding its drafts took longer
 * than bun's 5 s hook default on a loaded machine (the load run's round 5);
 * the boot is not what this file measures.
 */
const HUB_BOOT_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  hub = await bootDraftHub({
    label: "claude-nudge",
    repoId: REPO_ID,
    sessionId: SESSION_ID,
    workContextId: `wc_${SESSION_ID}`,
  });
  await hub.seedDraft({ kind: "root_cause", body: "The reaper closes a flushing session", ageMs: OLD_MS });
  await hub.seedDraft({ kind: "decision", body: "Keep the spool cap at 1500 lines", ageMs: OLD_MS });
}, HUB_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await hub.close();
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly env: Env;
}

const fixture = async (label: string, finishedTurns: number, extraEnv: Env = {}): Promise<Fixture> => {
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
    workContextTitle: "main @ api",
    workContextStatus: "analyzing",
    stopTurnCount: finishedTurns,
    intentFireCount: 1,
  });
  return {
    repo,
    home,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.hubUrl,
      CROSSCHECK_API_KEY: hub.apiKey,
      CROSSCHECK_TIMEOUT_MS: String(HTTP_TIMEOUT_MS),
      [LANDING_FETCH_ENV]: LANDING_FETCH_OFF,
      PATH: process.env["PATH"],
      ...extraEnv,
    },
  };
};

const prompt = (fix: Fixture): Promise<string> =>
  runHook(
    "user-prompt-submit",
    JSON.stringify({
      session_id: HOST_KEY,
      cwd: fix.repo,
      hook_event_name: "UserPromptSubmit",
      prompt: PROMPT,
    }),
    fix.env,
  );

const contextOf = (stdout: string): string => {
  if (stdout.length === 0) {
    return "";
  }
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  return parsed.hookSpecificOutput.additionalContext;
};

describe("draft review nudge on UserPromptSubmit", () => {
  test("the first prompt after a finished turn carries it, and only that one", async () => {
    // Arrange
    const fix = await fixture("claude-nudge-once", 1);

    // Act
    const first = contextOf(await prompt(fix));
    const second = contextOf(await prompt(fix));

    // Assert
    expect(first).toContain("2 of your own auto-captured draft claims have waited");
    expect(first).toContain("1 root_cause, 1 decision");
    expect(first).toContain("ask the person");
    expect(first).toContain("review_draft clm_");
    expect(second).not.toContain("draft claims");
    expect((await readSessionState(fix.home, HOST_KEY))?.draftNudge).toBe("delivered");
  });

  test("the opening prompt never carries it", async () => {
    const fix = await fixture("claude-nudge-opening", 0);

    expect(contextOf(await prompt(fix))).not.toContain("draft claims");
    expect((await readSessionState(fix.home, HOST_KEY))?.draftNudge).toBeNull();
  });

  test("a headless run (notice mode) is never asked to ask a person", async () => {
    const fix = await fixture("claude-nudge-headless", 1, { [TRIPWIRE_MODE_ENV]: TRIPWIRE_MODE_NOTICE });

    expect(contextOf(await prompt(fix))).not.toContain("draft claims");
    expect((await readSessionState(fix.home, HOST_KEY))?.draftNudge).toBeNull();
  });
});

describe("where Claude Code cannot nudge, doctor says so", () => {
  test("the headless refusal is a doctor line", () => {
    const line = claudeDoctorChecks().find((entry) => entry.name === "draft review nudge in headless runs (claude-code)");

    expect(line?.detail).toContain("CROSSCHECK_TRIPWIRE=notice");
    expect(line?.detail).toContain("Stop");
  });
});
