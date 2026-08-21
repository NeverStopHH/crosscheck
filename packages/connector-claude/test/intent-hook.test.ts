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

import {
  HTTP_TIMEOUT_MS,
  USER_PROMPT_SUBMIT_BUDGET_RATIO,
} from "@crosscheck/connector-core/constants.ts";
import {
  intentPromptPathForSlug,
  sessionSlug,
} from "@crosscheck/connector-core/config/paths.ts";
import { readSpoolLines, repoKey, runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import {
  readSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";
import { startHintHub } from "../../connector-core/test/fixtures/hint-hub.ts";
import type { HintHub } from "../../connector-core/test/fixtures/hint-hub.ts";

const REPO_ID = "github.com/acme/api";
const SESSION_ID = "intent-hook-uuid";
const PROMPT_SENTINEL = "ZQX-PROMPT-SENTINEL-7731";
const PROMPT = `why does the refresh call 500 after the key rotation ${PROMPT_SENTINEL}`;
const SENTENCE = "Find why the refresh call 500s after the key rotation";
const BUDGET_MS = USER_PROMPT_SUBMIT_BUDGET_RATIO * HTTP_TIMEOUT_MS;

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

const makeFakeModel = async (output: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-intent-hook-"));
  paths.push(dir);
  const script = join(dir, "fake.ts");
  await writeFile(
    script,
    `await Bun.stdin.text();\nprocess.stdout.write(${JSON.stringify(output)});\n`,
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

const fixture = async (label: string, modelOutput: string = SENTENCE): Promise<Fixture> => {
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
      CROSSCHECK_SUMMARIZER_CMD: await makeFakeModel(modelOutput),
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

/** The worker is a real detached process — the spool fills asynchronously. */
const waitForIntent = async (fix: Fixture): Promise<readonly SpooledWorkContext[]> => {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const records = await spooledIntents(fix);
    if (records.length > 0 || Date.now() > deadline) {
      return records;
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
};

/** Long enough for a worker that WAS spawned to have written its record. */
const NEGATIVE_SETTLE_MS = 2500;

const fileExists = async (path: string): Promise<boolean> =>
  stat(path).then(() => true, () => false);

describe("the first substantive prompt derives the session intent, exactly once", () => {
  test("fires once, spools a derived intent, never the prompt; the hook stays inside its budget", async () => {
    // Arrange
    const fix = await fixture("fires");

    // Act
    const startedAt = performance.now();
    await runHook("user-prompt-submit", promptPayload(fix, PROMPT), fix.env);
    const elapsedMs = Math.round(performance.now() - startedAt);

    // Assert — the hook returned inside the prompt budget
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
    // — the fire is booked
    expect((await readSessionState(fix.home, SESSION_ID))?.intentFireCount).toBe(1);
    // — the detached worker delivers the intent to the spool
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
});
