/**
 * `crosscheck doctor` / `crosscheck status` answer "why does my agent share
 * nothing?" (connector-core derive/sharing.ts) — through the real CLI, a
 * REAL in-process hub holding the developer's own drafts, and a real home
 * whose derive history outlived its sessions. No model runs: the runner probe
 * is switched off, and no binary the env names is ever spawned.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { DRAFT_NUDGE_MIN_AGE_HOURS, MS_PER_DAY } from "@crosscheck/connector-core/constants.ts";
import { deriveHistoryPath, repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { deriveSessionState, writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";

import { runCli } from "../src/index.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";
import { bootDraftHub } from "../../connector-core/test/fixtures/draft-hub.ts";
import type { DraftHub } from "../../connector-core/test/fixtures/draft-hub.ts";

const REPO_ID = "github.com/acme/api";
const SESSION_ID = "cc_sharing-uuid";
const OLD_MS = (DRAFT_NUDGE_MIN_AGE_HOURS + 5) * (MS_PER_DAY / 24);

let hub: DraftHub;
const paths: string[] = [];

beforeAll(async () => {
  hub = await bootDraftHub({
    label: "doctor-sharing",
    repoId: REPO_ID,
    sessionId: SESSION_ID,
    workContextId: `wc_${SESSION_ID}`,
  });
  await hub.seedDraft({ kind: "root_cause", body: "The reaper closes a flushing session", ageMs: OLD_MS });
  await hub.seedDraft({ kind: "decision", body: "Keep the spool cap at 1500 lines", ageMs: OLD_MS });
});

afterAll(async () => {
  await hub.close();
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

interface Machine {
  readonly home: string;
  readonly repo: string;
  readonly env: Env;
}

const machine = async (label: string, extraEnv: Env = {}): Promise<Machine> => {
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  paths.push(home, repo);
  return {
    home,
    repo,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.hubUrl,
      CROSSCHECK_API_KEY: hub.apiKey,
      CROSSCHECK_SSH_CANONICALIZE: "off",
      CROSSCHECK_DOCTOR_NO_PROBE: "1",
      ...extraEnv,
    },
  };
};

/** An ended session whose every model run could not start — kept by the history. */
const writeEndedSpawnFailure = async (home: string): Promise<void> => {
  const path = deriveHistoryPath(home, repoKey(hub.hubUrl, REPO_ID));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      folded: 1,
      sessions: [
        {
          stopTurnCount: 6,
          summarizerFireCount: 1,
          summarizerNoneCount: 0,
          summarizerDraftCount: 0,
          summarizerFailCount: 1,
          summarizerLastFailure: 'could not start: Executable not found in $PATH "claude"',
          summarizerRejectCount: 0,
          summarizerUnreadableCount: 0,
          summarizerNoSliceCount: 0,
          summarizerLastNoSlice: null,
          intentFireCount: 1,
          intentNoneCount: 0,
          intentSetCount: 0,
          intentFailCount: 1,
          intentLastFailure: 'could not start: Executable not found in $PATH "claude"',
        },
      ],
    }),
    "utf8",
  );
};

const sharingLines = (stdout: string): readonly string[] =>
  stdout.split("\n").filter((line) => line.includes("  sharing  "));

describe("doctor: why does my agent share nothing", () => {
  test("drafts nobody reviewed are named, with review_draft as the fix", async () => {
    // Arrange
    const m = await machine("sharing-drafts", { CROSSCHECK_SUMMARIZER_CMD: "/opt/model/wrapper.sh" });

    // Act
    const { stdout } = await runCli(["doctor"], m.env, m.repo);

    // Assert
    const lines = sharingLines(stdout);
    expect(lines.some((line) => line.startsWith("WARN  sharing  teammates see none of your agent's findings because 2 of your own drafts"))).toBe(true);
    expect(lines.join("\n")).toContain("review_draft");
  });

  test("an ended session's spawn failure still explains the silence after it closed", async () => {
    // Arrange: no live session at all — only what the history kept
    const m = await machine("sharing-history", { CROSSCHECK_SUMMARIZER_CMD: "/opt/model/wrapper.sh" });
    await writeEndedSpawnFailure(m.home);

    // Act
    const { stdout } = await runCli(["doctor"], m.env, m.repo);

    // Assert
    expect(sharingLines(stdout).join("\n")).toContain(
      "your agent shares nothing because the hooks could not start the model",
    );
  });

  test("no model backend on this PATH is its own WARN", async () => {
    const m = await machine("sharing-nobackend", { PATH: "/nonexistent" });

    const { stdout } = await runCli(["doctor"], m.env, m.repo);

    expect(sharingLines(stdout).join("\n")).toContain("no model backend is reachable");
  });

  test("a machine that drafted and derived reads PASS, with what was read", async () => {
    // Arrange: an empty hub of its own, a backend, and one productive session
    const own = await bootDraftHub({ label: "doctor-sharing-ok", repoId: REPO_ID, sessionId: SESSION_ID, workContextId: `wc_${SESSION_ID}` });
    try {
      const m = await machine("sharing-ok", {
        CROSSCHECK_HUB_URL: own.hubUrl,
        CROSSCHECK_API_KEY: own.apiKey,
        CROSSCHECK_SUMMARIZER_CMD: "/opt/model/wrapper.sh",
      });
      await writeSessionState(m.home, {
        ...deriveSessionState({
          hostSessionKey: "sharing-ok-uuid",
          repoId: REPO_ID,
          repoRoot: m.repo,
          hubUrl: own.hubUrl,
          developerId: own.developerId,
          startedAt: new Date().toISOString(),
        }),
        lastHeartbeatAt: new Date().toISOString(),
        stopTurnCount: 4,
        summarizerFireCount: 1,
        summarizerDraftCount: 1,
        intentFireCount: 1,
        intentSetCount: 1,
      });

      // Act
      const { stdout } = await runCli(["doctor"], m.env, m.repo);

      // Assert
      const lines = sharingLines(stdout);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toStartWith("PASS  sharing  1 live and 0 recently ended session: 1 drafts and 1 intents derived");
    } finally {
      await own.close();
    }
  });
});

describe("status: the one-liner", () => {
  test("names the first reason and points at doctor for the rest", async () => {
    const m = await machine("sharing-status", { PATH: "/nonexistent" });

    const { stdout } = await runCli(["status"], m.env, m.repo);

    const line = stdout.split("\n").find((entry) => entry.startsWith("sharing: "));
    expect(line).toContain("no model backend");
    expect(line).toContain("crosscheck doctor");
  });
});
