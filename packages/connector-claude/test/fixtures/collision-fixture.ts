/**
 * The shared arrangement of the collision-notice hook tests: a registered
 * session on a throwaway repo and home, and an in-process hint hub on a
 * random 127.0.0.1 port that reports Nick's live session on OVERLAP_FILE.
 * Each test file calls `cleanupCollisionFixtures` from its own afterEach.
 */
import { rm } from "node:fs/promises";

import type { Env } from "../../src/index.ts";
import { deriveSessionState, writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo, writeRepoFile } from "../../../connector-core/test/helpers.ts";
import { activeTeammateSession, startHintHub } from "../../../connector-core/test/fixtures/hint-hub.ts";
import type { HintHub } from "../../../connector-core/test/fixtures/hint-hub.ts";

export const REPO_ID = "github.com/acme/api";
export const SESSION_ID = "collision-uuid";
export const OVERLAP_FILE = "src/auth/refresh.ts";
export const SECOND_FILE = "src/auth/rotate.ts";
export const SUBAGENT = { agent_id: "agent-abc123", agent_type: "general-purpose" } as const;

export const NICK_NOTICE =
  "crosscheck: Nick is working on refresh.ts on branch feat/refresh-fix (last active just now) — " +
  "talk before you both change it";

const paths: string[] = [];
const stops: (() => void)[] = [];

/** Stops every hub and removes every repo and home the fixtures made. */
export const cleanupCollisionFixtures = async (): Promise<void> => {
  for (const stop of stops) {
    stop();
  }
  stops.length = 0;
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
};

export interface CollisionFixture {
  readonly repo: string;
  readonly home: string;
  readonly hub: HintHub;
  readonly env: Env;
}

/** A registered session on a repo whose hub reports Nick on OVERLAP_FILE. */
export const collisionFixture = async (label: string): Promise<CollisionFixture> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  await writeRepoFile(repo, OVERLAP_FILE, "export const a = 1;\n");
  await writeRepoFile(repo, SECOND_FILE, "export const b = 2;\n");
  const hub = startHintHub();
  stops.push(hub.stop);
  hub.setTripwireSessions([activeTeammateSession()]);
  // No prompt hint in these tests: what a prompt carries is the relay alone.
  hub.setCandidates([]);
  await writeSessionState(home, {
    ...deriveSessionState({
      hostSessionKey: SESSION_ID,
      repoId: REPO_ID,
      repoRoot: repo,
      hubUrl: hub.url,
      developerId: "dev_self",
      startedAt: new Date().toISOString(),
    }),
    // The first-prompt intent fire is not what these tests are about.
    intentFireCount: 1,
  });
  return {
    repo,
    home,
    hub,
    env: { CROSSCHECK_HOME: home, CROSSCHECK_HUB_URL: hub.url, CROSSCHECK_API_KEY: "test-key" },
  };
};

/** Registers a path (and a server to stop) that a test made by other means. */
export const trackForCleanup = (path: string, stop?: () => void): void => {
  paths.push(path);
  if (stop !== undefined) {
    stops.push(stop);
  }
};

export const editPayload = (repo: string, file: string, extra: Record<string, string> = {}): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd: repo,
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: `${repo}/${file}` },
    ...extra,
  });

export const promptPayload = (repo: string): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd: repo,
    hook_event_name: "UserPromptSubmit",
    prompt: "weiter",
  });

export interface HookOutput {
  readonly systemMessage?: string;
  readonly hookSpecificOutput?: {
    readonly hookEventName?: string;
    readonly permissionDecision?: string;
    readonly permissionDecisionReason?: string;
    readonly additionalContext?: string;
  };
}

export const parsed = (stdout: string): HookOutput =>
  stdout.length === 0 ? {} : (JSON.parse(stdout) as HookOutput);

/** A second live teammate, Ken, on his own work context. */
export const kenSession = (): Record<string, unknown> => ({
  ...activeTeammateSession(),
  sessionId: "cc_ken",
  developerId: "dev_ken",
  developerName: "Ken",
  branch: "feat/ken-rotation",
  workContextId: "wc_ken",
  workContextTitle: "Key rotation cleanup",
});
