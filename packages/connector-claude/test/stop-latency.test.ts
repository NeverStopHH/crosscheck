/**
 * THE STOP HOOK NEVER WAITS ON THE MODEL (DESIGN.md §3 Tier 1) — pinned by
 * wall clock, the way hint-hook-latency.test.ts pins the prompt path. Every
 * other Stop test uses a fast fake, so a regression that blocks the hook on
 * the worker (Bun.spawn → spawnSync is the one-token version) would keep the
 * whole suite green while every real Stop stalls up to SUMMARIZER_TIMEOUT_MS
 * on the developer's keyboard. Here the fake summarizer SLEEPS far past the
 * ceiling: the hook must return while the worker is still running, and the
 * draft must still arrive afterwards — proving the spawn really happened and
 * really was detached. scripts/mutation-check.ts re-introduces the blocking
 * spawn and this file must go red.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSpoolLines, repoKey, runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import {
  readSessionState,
  writeSessionState,
} from "../src/state/session-state.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
const SESSION_ID = "stop-latency-session-uuid";
/** Port 1 refuses instantly: an unreachable hub without the wait. */
const DEAD_HUB_URL = "http://127.0.0.1:1";

/** Far past the ceiling below — a blocked hook cannot make the assert. */
const SLOW_SUMMARIZER_MS = 5000;
/**
 * Generous for the hook's real work (state, transcript tail, spawn, a dead
 * hub's instant refusal) yet half the fake's sleep: only a hook that does
 * NOT wait on the worker can finish under it.
 */
const HOOK_RETURN_CEILING_MS = 2500;

const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 15_000;

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const makeSlowSummarizer = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-stop-latency-"));
  paths.push(dir);
  const script = join(dir, "slow.ts");
  await writeFile(
    script,
    [
      "await Bun.stdin.text();",
      `await Bun.sleep(${String(SLOW_SUMMARIZER_MS)});`,
      `process.stdout.write(${JSON.stringify(
        JSON.stringify({
          kind: "hypothesis",
          body: "The stale cursor id survives the reap",
          confidence: 0.4,
        }),
      )});`,
    ].join("\n"),
    "utf8",
  );
  const wrapper = join(dir, "slow.sh");
  await writeFile(
    wrapper,
    `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`,
    "utf8",
  );
  await chmod(wrapper, 0o755);
  return wrapper;
};

const transcriptLine = (type: string, blocks: unknown[]): string =>
  `${JSON.stringify({ type, message: { role: type, content: blocks } })}\n`;

/** A turn that trips the gate: test command + error output + hypothesis. */
const diagnosisTranscript = (): string =>
  transcriptLine("user", [{ type: "text", text: "why is bun test red" }]) +
  transcriptLine("assistant", [
    { type: "tool_use", name: "Bash", input: { command: "bun test packages/api" } },
  ]) +
  transcriptLine("user", [
    { type: "tool_result", content: "1 fail — TypeError: cursor is undefined" },
  ]) +
  transcriptLine("assistant", [
    { type: "text", text: "The root cause is the stale cursor id" },
  ]);

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly transcript: string;
  readonly env: Env;
  readonly key: string;
}

const fixture = async (): Promise<Fixture> => {
  const repo = await makeRepo("stop-latency", {
    remote: "git@github.com:acme/api.git",
  });
  const home = await makeHome("stop-latency");
  paths.push(repo, home);
  const dir = await mkdtemp(join(tmpdir(), "cx-stop-latency-tr-"));
  paths.push(dir);
  const transcript = join(dir, "transcript.jsonl");
  await writeFile(transcript, diagnosisTranscript(), "utf8");
  await writeSessionState(home, {
    claudeSessionId: SESSION_ID,
    crosscheckSessionId: `cc_${SESSION_ID}`,
    workContextId: `wc_cc_${SESSION_ID}`,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl: DEAD_HUB_URL,
    developerId: "dev_self",
    startedAt: new Date().toISOString(),
  });
  return {
    repo,
    home,
    transcript,
    key: repoKey(DEAD_HUB_URL, REPO_ID),
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: DEAD_HUB_URL,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_SUMMARIZER_CMD: await makeSlowSummarizer(),
      PATH: process.env["PATH"],
    },
  };
};

const claimCount = async (fix: Fixture): Promise<number> =>
  (await readSpoolLines(fix.home, fix.key))
    .map((line) => JSON.parse(line) as { kind: string })
    .filter((record) => record.kind === "claim").length;

describe("stop hook wall clock against a slow model", () => {
  test(
    "the hook returns while the worker is still summarizing",
    async () => {
      // Arrange
      const fix = await fixture();

      // Act
      const startedAt = Date.now();
      const stdout = await runHook(
        "stop",
        JSON.stringify({
          session_id: SESSION_ID,
          cwd: fix.repo,
          hook_event_name: "Stop",
          transcript_path: fix.transcript,
          stop_hook_active: false,
        }),
        fix.env,
      );
      const elapsed = Date.now() - startedAt;

      // Assert: the hook came back well before the model did …
      expect(stdout).toBe("");
      expect(elapsed).toBeLessThan(HOOK_RETURN_CEILING_MS);
      // … having recorded the fire synchronously …
      const state = await readSessionState(fix.home, SESSION_ID);
      expect(state?.summarizerFireCount).toBe(1);
      // … and the DETACHED worker still delivers the draft afterwards — the
      // positive control that a spawn happened at all (a mutation that
      // never spawns would also pass the wall-clock half).
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let claims = await claimCount(fix);
      while (claims === 0 && Date.now() < deadline) {
        await Bun.sleep(POLL_INTERVAL_MS);
        claims = await claimCount(fix);
      }
      expect(claims).toBe(1);
    },
    30_000,
  );
});
