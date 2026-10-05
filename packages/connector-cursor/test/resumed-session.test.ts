/**
 * A REOPENED CURSOR CHAT IS CAPTURED AGAIN — the Cursor half of the pilot's
 * resumed-session loss (connector-claude/test/resumed-session.test.ts holds
 * the evidence). Cursor keys a session by `conversation_id`, and a chat
 * reopened after sessionEnd comes back under the same one: sessionEnd closed
 * its crosscheck session for good, so every life after the third — the old
 * ladder's last rung — was refused by the hub as a late write.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm, utimes } from "node:fs/promises";

import { MAX_SPOOL_AGE_DAYS, MS_PER_DAY } from "@crosscheck/connector-core/constants.ts";
import {
  repoKey,
  sessionHealPathForSlug,
  sessionLineagePathForSlug,
  sessionSlug,
} from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { getDiagnosis } from "@crosscheck/connector-core/http/hub.ts";
import type { HubContext } from "@crosscheck/connector-core/http/client.ts";
import { readDropDetail } from "@crosscheck/connector-core/spool/drops.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";

import { runCursorHook } from "../src/index.ts";
import type { CursorHookEvent } from "../src/index.ts";
import { bootCursorHub } from "./fixtures/hub.ts";
import type { CursorTestHub } from "./fixtures/hub.ts";
import {
  AFTER_FILE_EDIT_INPUT,
  SESSION_END_INPUT,
  SESSION_START_INPUT,
} from "./fixtures/cursor-contract/payloads.ts";
import { makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
/** More lives than the old three-rung ladder could give one conversation. */
const LIVES = 5;

let hub: CursorTestHub;
const cleanups: string[] = [];

beforeAll(async () => {
  hub = await bootCursorHub("cursor-resumed");
});

afterAll(async () => {
  await hub.close();
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

const inRepo = <T extends object>(
  payload: T,
  repo: string,
  conversationId: string,
): Record<string, unknown> => ({
  ...payload,
  conversation_id: conversationId,
  ...("session_id" in payload ? { session_id: conversationId } : {}),
  workspace_roots: [repo],
});

const run = (event: CursorHookEvent, payload: Record<string, unknown>, env: Env): Promise<string> =>
  runCursorHook(event, JSON.stringify(payload), env);

describe("a Cursor conversation reopened after sessionEnd", () => {
  test(`is captured in every one of ${String(LIVES)} lives, nothing refused`, async () => {
    // Arrange
    const repo = await makeRepo("cursor-resumed", { remote: "git@github.com:acme/api.git" });
    const home = await makeHome("cursor-resumed");
    cleanups.push(repo, home);
    const env: Env = {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.hubUrl,
      CROSSCHECK_API_KEY: hub.apiKey,
      CROSSCHECK_TIMEOUT_MS: "4000",
    };
    const key = repoKey(hub.hubUrl, REPO_ID);
    const hubCtx: HubContext = {
      hubUrl: hub.hubUrl,
      apiKey: hub.apiKey,
      timeoutMs: 4000,
      home,
      repoKey: key,
      now: () => new Date(),
    };
    const conv = "conv-resumed-1";
    const lives: { readonly workContextId: string; readonly file: string }[] = [];

    // Act: open → edit → close, again and again, under one conversation id
    for (let life = 0; life < LIVES; life += 1) {
      const file = `src/life-${String(life)}.ts`;
      await writeRepoFile(repo, file, "export const a = 1;\n");
      await run("sessionStart", inRepo(SESSION_START_INPUT, repo, conv), env);
      const state = await readSessionState(home, `cur-${conv}`);
      lives.push({ workContextId: state?.workContextId ?? "", file });
      await run(
        "afterFileEdit",
        { ...inRepo(AFTER_FILE_EDIT_INPUT, repo, conv), file_path: `${repo}/${file}` },
        env,
      );
      await run("sessionEnd", inRepo(SESSION_END_INPUT, repo, conv), env);
    }

    // Assert: each life's edit landed in that life's work context
    for (const { workContextId, file } of lives) {
      const diagnosis = await getDiagnosis(hubCtx, workContextId);
      if (!diagnosis.ok) throw new Error(`diagnosis unavailable for ${workContextId}`);
      expect(diagnosis.data.targets.map((target) => target.value)).toContain(file);
    }
    expect(new Set(lives.map((life) => life.workContextId)).size).toBe(LIVES);
    expect((await readDropDetail(home, key)).byReason["rejected"] ?? 0).toBe(0);
  });
});

describe("a Cursor conversation the hub ends while it keeps going", () => {
  test("the next afterFileEdit heals into the next life, and later edits land there", async () => {
    // Arrange: a live life, then a sessionEnd that ran in another window
    const repo = await makeRepo("cursor-mid-life", { remote: "git@github.com:acme/api.git" });
    const home = await makeHome("cursor-mid-life");
    cleanups.push(repo, home);
    const env: Env = {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.hubUrl,
      CROSSCHECK_API_KEY: hub.apiKey,
      CROSSCHECK_TIMEOUT_MS: "4000",
    };
    const key = repoKey(hub.hubUrl, REPO_ID);
    const hubCtx: HubContext = { hubUrl: hub.hubUrl, apiKey: hub.apiKey, timeoutMs: 4000, home, repoKey: key, now: () => new Date() };
    const conv = "conv-mid-life";
    const editOf = async (file: string): Promise<void> => {
      await writeRepoFile(repo, file, "export const a = 1;\n");
      await run("afterFileEdit", { ...inRepo(AFTER_FILE_EDIT_INPUT, repo, conv), file_path: `${repo}/${file}` }, env);
    };
    await run("sessionStart", inRepo(SESSION_START_INPUT, repo, conv), env);
    const first = await readSessionState(home, `cur-${conv}`);
    await fetch(`${hub.hubUrl}/api/sessions/${encodeURIComponent(first?.crosscheckSessionId ?? "")}/end`, {
      method: "POST",
      headers: { Authorization: `Bearer ${hub.apiKey}`, "Content-Type": "application/json" },
      body: "{}",
    });

    // Act: the edit the hub refuses, then the next one
    await editOf("src/refused.ts");
    await editOf("src/after.ts");

    // Assert
    const healed = await readSessionState(home, `cur-${conv}`);
    expect(healed?.crosscheckSessionId).toBe(`${first?.crosscheckSessionId ?? ""}~r1`);
    const diagnosis = await getDiagnosis(hubCtx, healed?.workContextId ?? "");
    if (!diagnosis.ok) throw new Error("diagnosis unavailable");
    expect(diagnosis.data.targets.map((target) => target.value)).toEqual(["src/after.ts"]);
    expect((await readDropDetail(home, key)).rejectedCauses).toEqual({ session_ended: 1 });
  });
});

describe("a Cursor-only machine sweeps the side files of lives that never came back (review finding 8)", () => {
  test("sessionStart removes lineage notes and heal stamps past their age", async () => {
    // Arrange: a week-old note and stamp of a conversation that never resumed
    const repo = await makeRepo("cursor-sweep", { remote: "git@github.com:acme/api.git" });
    const home = await makeHome("cursor-sweep");
    cleanups.push(repo, home);
    const env: Env = {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.hubUrl,
      CROSSCHECK_API_KEY: hub.apiKey,
      CROSSCHECK_TIMEOUT_MS: "4000",
    };
    const old = new Date(Date.now() - (MAX_SPOOL_AGE_DAYS + 1) * MS_PER_DAY);
    const sideFiles = [
      sessionLineagePathForSlug(home, sessionSlug("cur-gone")),
      sessionHealPathForSlug(home, sessionSlug("cur-gone")),
    ];
    for (const path of sideFiles) {
      await writeRepoFile(home, path.slice(home.length + 1), "{}\n");
      await utimes(path, old, old);
    }

    // Act
    await run("sessionStart", inRepo(SESSION_START_INPUT, repo, "conv-sweep"), env);

    // Assert
    for (const path of sideFiles) {
      expect(await Bun.file(path).exists()).toBe(false);
    }
  });
});
