/**
 * The state-less recovery race (adversarial review of trial finding #9):
 * PostToolUse without a state file re-registers and publishes state — and
 * when TWO such hooks race in a multi-repo workspace, the loser must adopt
 * the winner's binding, never overwrite it, and never capture under its own
 * repo when the winner bound the session elsewhere. The race is made
 * deterministic here by a hub whose register endpoint publishes the
 * sibling's state MID-CALL — exactly the window the claim serializes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { readSpoolLines, repoKey, runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import {
  UNKNOWN_DEVELOPER_ID,
  workContextRecord,
} from "@crosscheck/connector-core/capture/records.ts";
import { appendRecords } from "@crosscheck/connector-core/spool/append.ts";
import {
  deriveSessionState,
  readSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const FOREIGN_REPO_ID = "github.com/other/web";
const TIMEOUT_MS = "4000";

const paths: string[] = [];
const stops: (() => void)[] = [];

afterEach(async () => {
  for (const stop of stops) {
    stop();
  }
  stops.length = 0;
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

/** A hub whose register endpoint runs a side effect before answering ok. */
const startRaceHub = (
  onRegister: () => Promise<void>,
): { readonly url: string } => {
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/sessions" && request.method === "POST") {
        await onRegister();
        return Response.json({
          ok: true,
          data: { session: { id: "cc_race-uuid", developerId: "dev_race" } },
        });
      }
      // Everything else (flush, heartbeat) may answer garbage: hooks fail
      // open on it, and these tests assert the SPOOL, not the hub.
      return Response.json({ ok: true, data: {} });
    },
  });
  stops.push(() => {
    server.stop(true);
  });
  return { url: `http://127.0.0.1:${server.port}` };
};

const postToolUsePayload = (repo: string, sessionId: string): string =>
  JSON.stringify({
    session_id: sessionId,
    cwd: repo,
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: `${repo}/src/limiter.ts` },
    tool_response: {},
  });

const siblingState = (hubUrl: string, repoId: string, repoRoot: string) =>
  deriveSessionState({
    hostSessionKey: "race-uuid",
    repoId,
    repoRoot,
    hubUrl,
    developerId: "dev_sibling",
    startedAt: new Date("2026-08-19T08:00:00.000Z").toISOString(),
  });

describe("post-tool-use recovery racing a sibling's recovery", () => {
  test("a sibling bound to ANOTHER repo wins: adopted, dropped, nothing captured", async () => {
    // Arrange: our repo is acme/api; the sibling binds the session to
    // other/web while our register round-trip is in flight
    const repo = await makeRepo("race-foreign", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("race-foreign");
    paths.push(repo, home);
    await writeRepoFile(repo, "src/limiter.ts", "export const a = 1;\n");
    let hubUrl = "";
    const hub = startRaceHub(async () => {
      await writeSessionState(
        home,
        siblingState(hubUrl, FOREIGN_REPO_ID, "/tmp/web"),
      );
    });
    hubUrl = hub.url;
    const env: Env = {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_TIMEOUT_MS: TIMEOUT_MS,
    };

    // Act
    const stdout = await runHook(
      "post-tool-use",
      postToolUsePayload(repo, "race-uuid"),
      env,
    );

    // Assert: the sibling's binding SURVIVES, the foreign touch is counted,
    // and this repo's spool holds nothing — no work context, no target.
    expect(stdout).toBe("");
    const state = await readSessionState(home, "race-uuid");
    expect(state?.repoId).toBe(FOREIGN_REPO_ID);
    expect(state?.foreignRepoDrops).toBe(1);
    expect(await readSpoolLines(home, repoKey(hub.url, REPO_ID))).toEqual([]);
  });

  test("a sibling bound to the SAME repo wins: adopted, no second work context", async () => {
    // Arrange: the sibling recovered for the same repo and already appended
    // its work-context record — ours must not append a duplicate
    const repo = await makeRepo("race-same", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("race-same");
    paths.push(repo, home);
    await writeRepoFile(repo, "src/limiter.ts", "export const a = 1;\n");
    let hubUrl = "";
    const hub = startRaceHub(async () => {
      const sibling = siblingState(hubUrl, REPO_ID, repo);
      await writeSessionState(home, sibling);
      const now = new Date("2026-08-19T08:00:00.100Z");
      await appendRecords(
        home,
        repoKey(hubUrl, REPO_ID),
        "race-uuid",
        [
          workContextRecord(
            {
              workContextId: sibling.workContextId,
              sessionId: sibling.crosscheckSessionId,
              title: "main @ api",
              status: "implementing",
            },
            {
              developerId: sibling.developerId ?? UNKNOWN_DEVELOPER_ID,
              agentKind: "claude-code",
              sessionId: sibling.crosscheckSessionId,
            },
            now,
          ),
        ],
        now,
      );
    });
    hubUrl = hub.url;
    const env: Env = {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_TIMEOUT_MS: TIMEOUT_MS,
    };

    // Act
    const stdout = await runHook(
      "post-tool-use",
      postToolUsePayload(repo, "race-uuid"),
      env,
    );

    // Assert: capture proceeded under the ADOPTED state — the target is
    // spooled, the work context exists exactly once, and the drop counter
    // stayed untouched (same repo is not foreign).
    expect(stdout).toBe("");
    const records = (await readSpoolLines(home, repoKey(hub.url, REPO_ID))).map(
      (line) => JSON.parse(line) as { kind: string },
    );
    expect(records.filter((record) => record.kind === "work_context")).toHaveLength(1);
    expect(records.some((record) => record.kind === "target")).toBe(true);
    const state = await readSessionState(home, "race-uuid");
    expect(state?.repoId).toBe(REPO_ID);
    expect(state?.foreignRepoDrops).toBe(0);
    expect(state?.seenTargets).toContain("src/limiter.ts");
  });
});
