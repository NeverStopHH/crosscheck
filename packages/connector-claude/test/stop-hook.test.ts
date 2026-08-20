/**
 * The Stop hook end-to-end through `runHook`: a real repo, a real spool, a
 * real detached worker process — only the summarizer binary is faked
 * (CROSSCHECK_SUMMARIZER_CMD) and the hub is either dead or the hint-hub
 * fixture. The hook itself must never wait on the model: it gates, spawns,
 * and exits; the draft appears in the spool asynchronously.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SUMMARIZER_MAX_FIRES_PER_SESSION } from "@crosscheck/connector-core/constants.ts";
import { readSpoolLines, repoKey, runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import {
  readSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionStateInput } from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";
import { CANDIDATE_BODY, startHintHub } from "../../connector-core/test/fixtures/hint-hub.ts";
import type { HintHub } from "../../connector-core/test/fixtures/hint-hub.ts";

const REPO_ID = "github.com/acme/api";
const SESSION_ID = "stop-session-uuid";
/** Port 1 refuses instantly: an unreachable hub without the wait. */
const DEAD_HUB_URL = "http://127.0.0.1:1";

const paths: string[] = [];
const hubs: HintHub[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
  for (const hub of hubs) {
    hub.stop();
  }
  hubs.length = 0;
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-stop-"));
  paths.push(dir);
  return dir;
};

const makeFakeSummarizer = async (output: string): Promise<string> => {
  const dir = await tempDir();
  const script = join(dir, "fake.ts");
  await writeFile(
    script,
    `await Bun.stdin.text();\nprocess.stdout.write(${JSON.stringify(output)});\n`,
    "utf8",
  );
  const wrapper = join(dir, "fake.sh");
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

/** A turn with nothing to capture: no error, no test, no hypothesis. */
const quietTranscript = (): string =>
  transcriptLine("user", [{ type: "text", text: "rename that variable please" }]) +
  transcriptLine("assistant", [{ type: "text", text: "Renamed as requested" }]);

/**
 * A turn that trips ONLY the conclusion wing: a verdict beside a green run,
 * with no error output and no hypothesis language anywhere — the hook fires
 * exactly because stop.ts consults isCaptureMoment, never through the
 * debugging wing. Pins trial finding #12's actual fix point (the wiring);
 * the mutation catalogue reverts stop.ts to the diagnosis-only gate and this
 * transcript's test must go red.
 */
const conclusionTranscript = (): string =>
  transcriptLine("user", [
    { type: "text", text: "run the gauntlet on the branch and call it" },
  ]) +
  transcriptLine("assistant", [
    { type: "tool_use", name: "Bash", input: { command: "bun test" } },
  ]) +
  transcriptLine("user", [
    { type: "tool_result", content: "1658 pass, 0 skip across 170 files." },
  ]) +
  transcriptLine("assistant", [
    {
      type: "text",
      text: "Verdict: the branch is safe to merge — the gauntlet came back clean.",
    },
  ]);

const draftJson = (body: string): string =>
  JSON.stringify({ kind: "hypothesis", body, confidence: 0.4 });

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly transcript: string;
  readonly env: Env;
  readonly key: string;
  readonly hubUrl: string;
}

interface FixtureOptions {
  readonly transcriptContent?: string;
  readonly summarizerOutput?: string;
  readonly stateOverrides?: Partial<SessionStateInput>;
  readonly hubUrl?: string;
}

const fixture = async (
  label: string,
  options: FixtureOptions = {},
): Promise<Fixture> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  const dir = await tempDir();
  const transcript = join(dir, "transcript.jsonl");
  await writeFile(transcript, options.transcriptContent ?? diagnosisTranscript(), "utf8");
  const hubUrl = options.hubUrl ?? DEAD_HUB_URL;
  await writeSessionState(home, {
    hostSessionKey: SESSION_ID,
    crosscheckSessionId: `cc_${SESSION_ID}`,
    workContextId: `wc_cc_${SESSION_ID}`,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl,
    developerId: "dev_self",
    startedAt: new Date().toISOString(),
    ...options.stateOverrides,
  });
  const fake = await makeFakeSummarizer(
    options.summarizerOutput ?? draftJson("The stale cursor id survives the reap"),
  );
  return {
    repo,
    home,
    transcript,
    key: repoKey(hubUrl, REPO_ID),
    hubUrl,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_SUMMARIZER_CMD: fake,
      PATH: process.env["PATH"],
    },
  };
};

const stopPayload = (
  fix: Fixture,
  overrides: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd: fix.repo,
    hook_event_name: "Stop",
    transcript_path: fix.transcript,
    stop_hook_active: false,
    ...overrides,
  });

interface SpooledRecord {
  readonly kind: string;
  readonly body: { readonly body?: string; readonly provenance?: string };
}

const spooledClaims = async (fix: Fixture): Promise<readonly SpooledRecord[]> =>
  (await readSpoolLines(fix.home, fix.key))
    .map((line) => JSON.parse(line) as SpooledRecord)
    .filter((record) => record.kind === "claim");

const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 15_000;

/** The worker is a real detached process — the spool fills asynchronously. */
const waitForClaims = async (
  fix: Fixture,
): Promise<readonly SpooledRecord[]> => {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const claims = await spooledClaims(fix);
    if (claims.length > 0 || Date.now() > deadline) {
      return claims;
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
};

/** Long enough for a worker that WAS spawned to have written its claim. */
const NEGATIVE_SETTLE_MS = 2500;

describe("stop hook gates, spawns detached, and never blocks", () => {
  test("a diagnosis-moment turn produces a spooled draft claim", async () => {
    // Arrange
    const fix = await fixture("fires");

    // Act
    const stdout = await runHook("stop", stopPayload(fix), fix.env);

    // Assert — the hook itself says nothing (never blocks, never continues)
    expect(stdout).toBe("");
    // — the detached worker delivers the draft to the spool
    const claims = await waitForClaims(fix);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.body.provenance).toBe("derived");
    // — and the state carries the fire bookkeeping the cost surfaces read
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.stopTurnCount).toBe(1);
    expect(state?.summarizerFireCount).toBe(1);
    expect(state?.summarizerLastFireTurn).toBe(1);
    expect(state?.summarizerEstimatedTokens ?? 0).toBeGreaterThan(0);
  });

  test("a conclusion-only turn (no hypothesis language) spends a fire slot", async () => {
    // Arrange — a verdict beside a green run, nothing for the debugging wing
    const fix = await fixture("conclusion-wiring", {
      transcriptContent: conclusionTranscript(),
      summarizerOutput: "NONE",
    });

    // Act
    await runHook("stop", stopPayload(fix), fix.env);

    // Assert — the fire is recorded through the WIDENED gate at the stop.ts
    // call site; reverting that line to isDiagnosisMoment leaves this at 0
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.stopTurnCount).toBe(1);
    expect(state?.summarizerFireCount).toBe(1);
    expect(state?.summarizerLastFireTurn).toBe(1);
  });

  test("a quiet turn counts the turn but never spawns", async () => {
    const fix = await fixture("quiet", { transcriptContent: quietTranscript() });

    await runHook("stop", stopPayload(fix), fix.env);

    await Bun.sleep(NEGATIVE_SETTLE_MS);
    expect(await spooledClaims(fix)).toHaveLength(0);
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.stopTurnCount).toBe(1);
    expect(state?.summarizerFireCount).toBe(0);
  });

  test("the turn right after a fire is debounced", async () => {
    const fix = await fixture("debounce", {
      stateOverrides: {
        stopTurnCount: 3,
        summarizerFireCount: 1,
        summarizerLastFireTurn: 3,
      },
    });

    await runHook("stop", stopPayload(fix), fix.env);

    await Bun.sleep(NEGATIVE_SETTLE_MS);
    expect(await spooledClaims(fix)).toHaveLength(0);
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.stopTurnCount).toBe(4);
    expect(state?.summarizerFireCount).toBe(1);
  });

  test("the hard cap holds even on a perfect diagnosis turn", async () => {
    const fix = await fixture("cap", {
      stateOverrides: {
        stopTurnCount: 30,
        summarizerFireCount: SUMMARIZER_MAX_FIRES_PER_SESSION,
        summarizerLastFireTurn: 20,
      },
    });

    await runHook("stop", stopPayload(fix), fix.env);

    await Bun.sleep(NEGATIVE_SETTLE_MS);
    expect(await spooledClaims(fix)).toHaveLength(0);
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.summarizerFireCount).toBe(SUMMARIZER_MAX_FIRES_PER_SESSION);
  });

  test("stop_hook_active skips capture entirely (no double turn)", async () => {
    const fix = await fixture("active");

    await runHook("stop", stopPayload(fix, { stop_hook_active: true }), fix.env);

    await Bun.sleep(NEGATIVE_SETTLE_MS);
    expect(await spooledClaims(fix)).toHaveLength(0);
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.stopTurnCount).toBe(0);
  });

  test("no session state means silence and no spawn", async () => {
    const fix = await fixture("no-state");
    await rm(join(fix.home, "sessions"), { recursive: true, force: true });

    const stdout = await runHook("stop", stopPayload(fix), fix.env);

    expect(stdout).toBe("");
    await Bun.sleep(NEGATIVE_SETTLE_MS);
    expect(await spooledClaims(fix)).toHaveLength(0);
  });

  test(
    "a worker whose summarizer binary is missing still spends the slot",
    async () => {
      // Arrange: the fire path's contract — the slot is recorded BEFORE the
      // spawn, and a worker that dies produces nothing and is never retried
      // (a crash costs one unspent fire, the honest direction).
      const fix = await fixture("missing-binary");
      const env = {
        ...fix.env,
        CROSSCHECK_SUMMARIZER_CMD: "/nonexistent/claude",
      };

      // Act: two Stop turns on the same diagnosis transcript. The fire is
      // recorded synchronously by the hook, so the state reads need no
      // settle; only the final negative spool assert does.
      await runHook("stop", stopPayload(fix), env);
      const afterFirst = await readSessionState(fix.home, SESSION_ID);
      await runHook("stop", stopPayload(fix), env);
      await Bun.sleep(NEGATIVE_SETTLE_MS);

      // Assert: slot spent on turn one, nothing spooled, no retry on turn
      // two — the debounce holds because the fire WAS recorded before the
      // worker failed.
      expect(afterFirst?.summarizerFireCount).toBe(1);
      const state = await readSessionState(fix.home, SESSION_ID);
      expect(state?.summarizerFireCount).toBe(1);
      expect(state?.stopTurnCount).toBe(2);
      expect(await spooledClaims(fix)).toHaveLength(0);
    },
    15_000,
  );
});

describe("echo-loop exclusion, end to end (DESIGN.md §3, judge-mandated)", () => {
  test("a hint delivered this session is never re-captured as a draft", async () => {
    // Arrange: a live hub whose candidates deliver Nick's claim as a hint
    const hub = startHintHub();
    hubs.push(hub);
    const fix = await fixture("echo", {
      hubUrl: hub.url,
      // The turn quotes the hint verbatim AND looks like a diagnosis moment,
      // and the faked summarizer dutifully echoes the teammate's body.
      transcriptContent:
        transcriptLine("user", [
          { type: "text", text: "why does the refresh test still fail" },
        ]) +
        transcriptLine("assistant", [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "bun test packages/api" },
          },
        ]) +
        transcriptLine("user", [
          { type: "tool_result", content: "FAIL refresh.test.ts — 500 error" },
        ]) +
        transcriptLine("assistant", [
          {
            type: "text",
            text: `Turns out a teammate already found it: ${CANDIDATE_BODY}`,
          },
        ]),
      summarizerOutput: draftJson(CANDIDATE_BODY),
    });

    // Act 1: the prompt hook delivers the hint (records the echo hash)
    await runHook(
      "user-prompt-submit",
      JSON.stringify({
        session_id: SESSION_ID,
        cwd: fix.repo,
        hook_event_name: "UserPromptSubmit",
        prompt: "why does the refresh call fail after key rotation",
      }),
      fix.env,
    );
    const afterHint = await readSessionState(fix.home, SESSION_ID);
    expect(afterHint?.deliveredHintHashes.length).toBe(1);

    // Act 2: the Stop hook summarizes the turn that contains the hint's text
    await runHook("stop", stopPayload(fix), fix.env);

    // Assert: the summarizer DID run (fire recorded) but Robin's hypothesis
    // never came back as this session's own independent observation.
    await Bun.sleep(NEGATIVE_SETTLE_MS);
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.summarizerFireCount).toBe(1);
    expect(await spooledClaims(fix)).toHaveLength(0);
  });

  test("a hint delivered in an EARLIER session is excluded in the next one", async () => {
    // Arrange: same repo, but the summarizing session is a NEW one whose
    // state never saw the delivery — the exact judge-mandated scenario
    // across a session boundary (DESIGN.md §3 has no session qualifier).
    const hub = startHintHub();
    hubs.push(hub);
    const fix = await fixture("echo-across-sessions", {
      hubUrl: hub.url,
      transcriptContent:
        transcriptLine("user", [
          { type: "text", text: "why does the refresh test still fail" },
        ]) +
        transcriptLine("assistant", [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "bun test packages/api" },
          },
        ]) +
        transcriptLine("user", [
          { type: "tool_result", content: "FAIL refresh.test.ts — 500 error" },
        ]) +
        transcriptLine("assistant", [
          {
            type: "text",
            text: `Turns out a teammate already found it: ${CANDIDATE_BODY}`,
          },
        ]),
      summarizerOutput: draftJson(CANDIDATE_BODY),
    });

    // Act 1: SESSION ONE delivers the hint, then ends
    await runHook(
      "user-prompt-submit",
      JSON.stringify({
        session_id: SESSION_ID,
        cwd: fix.repo,
        hook_event_name: "UserPromptSubmit",
        prompt: "why does the refresh call fail after key rotation",
      }),
      fix.env,
    );
    await rm(join(fix.home, "sessions"), { recursive: true, force: true });

    // Act 2: SESSION TWO (fresh state, zero delivered hashes) summarizes a
    // turn quoting the hint, with the faked summarizer echoing its body
    const nextSessionId = "stop-session-uuid-next";
    await writeSessionState(fix.home, {
      hostSessionKey: nextSessionId,
      crosscheckSessionId: `cc_${nextSessionId}`,
      workContextId: `wc_cc_${nextSessionId}`,
      repoId: REPO_ID,
      repoRoot: fix.repo,
      hubUrl: fix.hubUrl,
      developerId: "dev_self",
      startedAt: new Date().toISOString(),
    });
    await runHook(
      "stop",
      stopPayload(fix, { session_id: nextSessionId }),
      fix.env,
    );

    // Assert: fire recorded on the new session, zero claims spooled
    await Bun.sleep(NEGATIVE_SETTLE_MS);
    const state = await readSessionState(fix.home, nextSessionId);
    expect(state?.summarizerFireCount).toBe(1);
    expect(await spooledClaims(fix)).toHaveLength(0);
  }, 15_000);
});
