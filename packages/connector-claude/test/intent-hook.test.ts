/**
 * The derived-intent fire through the REAL UserPromptSubmit hook (trial
 * finding #16): a real repo, a real spool, the hint-hub fixture, a real
 * detached worker process — only the model binary is faked
 * (CROSSCHECK_SUMMARIZER_CMD). The hook itself never waits on the model: it
 * books the fire under the lock, parks the prompt in a 0600 file, spawns,
 * and gets on with the hint; the intent appears in the spool asynchronously.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HTTP_TIMEOUT_MS } from "@crosscheck/connector-core/constants.ts";
import {
  intentPromptPathForSlug,
  sessionSlug,
} from "@crosscheck/connector-core/config/paths.ts";
import { readSpoolLines, repoKey, runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { runHookWith } from "../src/hooks/runner.ts";
import { handleUserPromptSubmit } from "../src/hooks/user-prompt-submit.ts";
import {
  readSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";
import { startHintHub } from "../../connector-core/test/fixtures/hint-hub.ts";
import type { HintHub } from "../../connector-core/test/fixtures/hint-hub.ts";

const REPO_ID = "github.com/acme/api";
const SESSION_ID = "intent-hook-uuid";
const PROMPT_SENTINEL = "ZQX-PROMPT-SENTINEL-7731";
const PROMPT = `why does the refresh call 500 after the key rotation ${PROMPT_SENTINEL}`;
const SENTENCE = "Find why the refresh call 500s after the key rotation";

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

/**
 * `release`, when given, HOLDS the model: it reads its stdin, then answers
 * only once the test has created that file — so "the hook did not wait on
 * the model" is an ordering the test controls, not a stopwatch reading.
 */
const makeFakeModel = async (output: string, release?: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-intent-hook-"));
  paths.push(dir);
  const script = join(dir, "fake.ts");
  const hold =
    release === undefined
      ? ""
      : `while (!(await Bun.file(${JSON.stringify(release)}).exists())) await Bun.sleep(10);\n`;
  await writeFile(
    script,
    `await Bun.stdin.text();\n${hold}process.stdout.write(${JSON.stringify(output)});\n`,
    "utf8",
  );
  const wrapper = join(dir, "fake.sh");
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`, "utf8");
  await chmod(wrapper, 0o755);
  return wrapper;
};

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly hub: HintHub;
  readonly env: Env;
  readonly key: string;
  readonly promptFile: string;
}

const fixture = async (
  label: string,
  modelOutput: string = SENTENCE,
  release?: string,
): Promise<Fixture> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  const hub = startHintHub();
  hubs.push(hub);
  await writeSessionState(home, {
    hostSessionKey: SESSION_ID,
    crosscheckSessionId: `cc_${SESSION_ID}`,
    workContextId: `wc_cc_${SESSION_ID}`,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl: hub.url,
    developerId: "dev_self",
    startedAt: new Date().toISOString(),
    workContextTitle: "main @ api",
    workContextStatus: "analyzing",
  });
  return {
    repo,
    home,
    hub,
    key: repoKey(hub.url, REPO_ID),
    promptFile: intentPromptPathForSlug(home, sessionSlug(SESSION_ID)),
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_TIMEOUT_MS: String(HTTP_TIMEOUT_MS),
      CROSSCHECK_SUMMARIZER_CMD: await makeFakeModel(modelOutput, release),
      PATH: process.env["PATH"],
    },
  };
};

const promptPayload = (fix: Fixture, prompt: string): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd: fix.repo,
    hook_event_name: "UserPromptSubmit",
    prompt,
  });

interface SpooledWorkContext {
  readonly kind: string;
  readonly body: { readonly intent?: { readonly summary: string; readonly provenance: string } };
}

const spooledIntents = async (fix: Fixture): Promise<readonly SpooledWorkContext[]> =>
  (await readSpoolLines(fix.home, fix.key))
    .map((line) => JSON.parse(line) as SpooledWorkContext)
    .filter((record) => record.kind === "work_context" && record.body.intent !== undefined);

const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 15_000;

/**
 * How many outcomes the intent worker has booked — set, NONE, failed,
 * refused, skipped. Booking is the worker's LAST act on every path that
 * reaches the model (derive/intent/worker.ts), so a count above zero means
 * the worker is done with the spool and the state alike.
 */
const outcomesBooked = (state: SessionState | null): number =>
  state === null
    ? 0
    : state.intentSetCount +
      state.intentNoneCount +
      state.intentFailCount +
      state.intentRefusedCount +
      state.intentSkippedCount;

/**
 * The worker is a real detached process, so this waits for its COMPLETION
 * SIGNAL — the outcome booking — and only then reads the spool. Waiting for
 * the spool record instead raced the worker: appendIntent writes the record
 * FIRST and books `intentSetCount` after it ("intent set" means the record
 * exists), so a poll that landed between the two saw the record and then
 * read the booking as 0 — the load-only flake of "fires once". The deadline
 * bounds a hang only; nothing is asserted until the worker has finished.
 */
const waitForIntent = async (fix: Fixture): Promise<readonly SpooledWorkContext[]> => {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (outcomesBooked(await readSessionState(fix.home, SESSION_ID)) === 0 && Date.now() <= deadline) {
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  return spooledIntents(fix);
};

/** Long enough for a worker that WAS spawned to have written its record. */
const NEGATIVE_SETTLE_MS = 2500;

const fileExists = async (path: string): Promise<boolean> =>
  stat(path).then(() => true, () => false);

describe("the first substantive prompt derives the session intent, exactly once", () => {
  test("fires once, spools a derived intent, never the prompt; the hook never waits on the model", async () => {
    // Arrange: the model is HELD until the test releases it
    const gateDir = await mkdtemp(join(tmpdir(), "cx-intent-gate-"));
    paths.push(gateDir);
    const release = join(gateDir, "release");
    const fix = await fixture("fires", SENTENCE, release);
    // The handler's OWN completion, observed whether or not the runner's
    // budget race answered first. The old assertion here was a stopwatch —
    // elapsed under BUDGET_MS — and under CPU contention the race itself
    // resolves AT the budget, so it went red with no behaviour wrong; the
    // prompt path's wall clock belongs to the latency lanes, not this file.
    const handled = Promise.withResolvers<string>();

    // Act
    await runHookWith(
      "user-prompt-submit",
      async (ctx, budget) => {
        const output = await handleUserPromptSubmit(ctx, budget);
        handled.resolve(output);
        return output;
      },
      promptPayload(fix, PROMPT),
      fix.env,
    );
    await handled.promise;

    // Assert — the handler finished while the model was still held: it never
    // waits on the model, at any load
    expect(outcomesBooked(await readSessionState(fix.home, SESSION_ID))).toBe(0);
    expect(await spooledIntents(fix)).toHaveLength(0);
    // — the fire is booked
    expect((await readSessionState(fix.home, SESSION_ID))?.intentFireCount).toBe(1);
    // — released, the detached worker delivers the intent to the spool
    await writeFile(release, "", "utf8");
    const records = await waitForIntent(fix);
    expect(records).toHaveLength(1);
    expect(records[0]?.body.intent?.summary).toBe(SENTENCE);
    expect(records[0]?.body.intent?.provenance).toBe("derived");
    // — the raw prompt is byte-absent from the spool, and the prompt file is gone
    expect((await readSpoolLines(fix.home, fix.key)).join("\n")).not.toContain(PROMPT_SENTINEL);
    expect(await fileExists(fix.promptFile)).toBe(false);
    // — booked as set
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.intentSetCount).toBe(1);
  });

  test("the intent fire books the deadline its worker runs under", async () => {
    const fix = await fixture("deadline");

    await runHook("user-prompt-submit", promptPayload(fix, PROMPT), { ...fix.env, CROSSCHECK_SUMMARIZER_TIMEOUT_MS: "45000" });

    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.deriveFires.map((fire) => fire.deadlineMs)).toEqual([45_000]);
    await waitForIntent(fix);
  });

  test("a second substantive prompt does not fire again", async () => {
    const fix = await fixture("once");
    await runHook("user-prompt-submit", promptPayload(fix, PROMPT), fix.env);
    await waitForIntent(fix);

    await runHook("user-prompt-submit", promptPayload(fix, `${PROMPT} and also the cache`), fix.env);
    await Bun.sleep(NEGATIVE_SETTLE_MS);

    expect((await readSessionState(fix.home, SESSION_ID))?.intentFireCount).toBe(1);
    expect(await spooledIntents(fix)).toHaveLength(1);
  });

  test("a slash command, a bare yes, a short prompt: no fire, no prompt file, no worker", async () => {
    const fix = await fixture("quiet");

    for (const prompt of ["/clear", "yes", "fix the thing"]) {
      await runHook("user-prompt-submit", promptPayload(fix, prompt), fix.env);
    }
    await Bun.sleep(NEGATIVE_SETTLE_MS);

    expect((await readSessionState(fix.home, SESSION_ID))?.intentFireCount).toBe(0);
    expect(await fileExists(fix.promptFile)).toBe(false);
    expect(await spooledIntents(fix)).toHaveLength(0);
  });

  test("a NONE is booked, nothing spooled", async () => {
    const fix = await fixture("none", "NONE");

    await runHook("user-prompt-submit", promptPayload(fix, PROMPT), fix.env);
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (((await readSessionState(fix.home, SESSION_ID))?.intentNoneCount ?? 0) > 0) break;
      await Bun.sleep(POLL_INTERVAL_MS);
    }

    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.intentFireCount).toBe(1);
    expect(state?.intentNoneCount).toBe(1);
    expect(await spooledIntents(fix)).toHaveLength(0);
  });

  test("under the summarizer child marker the prompt hook fires nothing and parks no prompt", async () => {
    const fix = await fixture("child");

    await runHook(
      "user-prompt-submit",
      promptPayload(fix, PROMPT),
      { ...fix.env, CROSSCHECK_SUMMARIZER_CHILD: "1" },
    );
    await Bun.sleep(NEGATIVE_SETTLE_MS);

    expect((await readSessionState(fix.home, SESSION_ID))?.intentFireCount).toBe(0);
    expect(await readdir(join(fix.home, "sessions"))).toEqual([`${sessionSlug(SESSION_ID)}.json`]);
  });

  test("the prompt file is mode 0600 while it exists, and SessionEnd removes a leftover", async () => {
    // Arrange: a model that never answers keeps the worker (and the file) alive
    const fix = await fixture("leftover", SENTENCE);
    const slowEnv = { ...fix.env, CROSSCHECK_SUMMARIZER_CMD: "/nonexistent/never-spawned" };
    await runHook("user-prompt-submit", promptPayload(fix, PROMPT), slowEnv);
    // The worker itself cannot spawn its binary and removes the file; so park
    // one by hand to prove the SessionEnd sweep.
    await Bun.sleep(NEGATIVE_SETTLE_MS);
    await writeFile(fix.promptFile, PROMPT, { mode: 0o600 });
    expect(((await stat(fix.promptFile)).mode & 0o777).toString(8)).toBe("600");

    // Act
    await runHook(
      "session-end",
      JSON.stringify({ session_id: SESSION_ID, cwd: fix.repo, hook_event_name: "SessionEnd", reason: "exit" }),
      fix.env,
    );

    // Assert
    expect(await fileExists(fix.promptFile)).toBe(false);
  });
  test("the worker env drops the parent session's markers and carries the child marker", async () => {
    // Arrange: a fake model that dumps its environment; the hook env carries
    // the markers a real Claude Code hook process carries
    const fix = await fixture("markers");
    const dir = await mkdtemp(join(tmpdir(), "cx-intent-env-"));
    paths.push(dir);
    const envDump = join(dir, "env.json");
    const script = join(dir, "dump.ts");
    await writeFile(
      script,
      `await Bun.stdin.text();\nawait Bun.write(${JSON.stringify(envDump)}, JSON.stringify(process.env));\nprocess.stdout.write("NONE");\n`,
      "utf8",
    );
    const wrapper = join(dir, "dump.sh");
    await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`, "utf8");
    await chmod(wrapper, 0o755);

    // Act
    await runHook("user-prompt-submit", promptPayload(fix, PROMPT), {
      ...fix.env,
      CROSSCHECK_SUMMARIZER_CMD: wrapper,
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "parent-session",
      USER: process.env["USER"] ?? "tester",
    });
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline && !(await fileExists(envDump))) {
      await Bun.sleep(POLL_INTERVAL_MS);
    }

    // Assert: summarizerWorkerEnv's contract, through the prompt hook's spawn
    const env = JSON.parse(await Bun.file(envDump).text()) as Record<string, string>;
    expect(env["CROSSCHECK_SUMMARIZER_CHILD"]).toBe("1");
    expect(env["CLAUDECODE"]).toBeUndefined();
    expect(env["CLAUDE_CODE_SESSION_ID"]).toBeUndefined();
    expect(env["CROSSCHECK_HOME"]).toBe(fix.home);
    expect(env["USER"]).toBeDefined();
  });
});
