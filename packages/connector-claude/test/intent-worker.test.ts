/**
 * The detached derived-intent worker (trial finding #16) end to end with a
 * FAKED binary — no real claude, no network, no git repo (a home directory
 * and a state file are all it reads), so this file runs unchanged in the
 * oven/bun:1 lane. What it pins: the prompt reaches the model on stdin and
 * NEVER the spool; the one sentence that comes back is bounded, scanned,
 * echo-checked, contract-checked, then spooled as a work_context UPDATE with
 * provenance derived under the cap; every outcome is booked; the prompt
 * file is gone afterwards whatever happened; the child marker rides.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DERIVED_CONFIDENCE_CAP, MAX_INTENT_SUMMARY_CHARS } from "@crosscheck/schema";

import { INTENT_DERIVED_CONFIDENCE } from "@crosscheck/connector-core/constants.ts";
import {
  intentPromptPathForSlug,
  repoKey,
  sessionSlug,
  writePrivateFile,
} from "@crosscheck/connector-core/config/paths.ts";
import { recordDeliveredHintHash } from "@crosscheck/connector-core/hints/delivered-store.ts";
import { hintBodyHash } from "@crosscheck/connector-core/hints/echo.ts";
import { readSpoolLines } from "@crosscheck/connector-core/spool/files.ts";
import {
  readSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome } from "../../connector-core/test/helpers.ts";
import { INTENT_MAX_CHARS } from "@crosscheck/connector-core/constants.ts";
import { resolveIntentArgv } from "@crosscheck/connector-core/derive/intent/prompt.ts";
import { parseIntentWorkerArgs, runIntentWorker } from "@crosscheck/connector-core/derive/intent/worker.ts";

const SESSION_ID = "intent-worker-uuid";
const REPO_ID = "github.com/acme/api";
const HUB_URL = "http://127.0.0.1:1";
const TITLE = "detached@0badc0f · fix: refresh 500s @ api";
/** Byte-unique: if it ever shows up in the spool, the prompt leaked. */
const PROMPT_SENTINEL = "ZQX-PROMPT-SENTINEL-7731";
const PROMPT = `why does the refresh call 500 after the key rotation ${PROMPT_SENTINEL}`;
const SENTENCE = "Find why the refresh call 500s after the key rotation";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-intent-"));
  paths.push(dir);
  return dir;
};

interface FakeOptions {
  readonly output?: string;
  readonly sleepMs?: number;
  readonly stdinDump?: string;
  readonly exitCode?: number;
  readonly envDump?: string;
}

/** An executable the runner can spawn: a /bin/sh wrapper around a bun script. */
const makeFakeModel = async (options: FakeOptions): Promise<string> => {
  const dir = await tempDir();
  const script = join(dir, "fake-model.ts");
  await writeFile(
    script,
    [
      "const stdin = await Bun.stdin.text();",
      options.stdinDump === undefined ? "" : `await Bun.write(${JSON.stringify(options.stdinDump)}, stdin);`,
      options.envDump === undefined
        ? ""
        : `await Bun.write(${JSON.stringify(options.envDump)}, JSON.stringify(process.env));`,
      options.sleepMs === undefined ? "" : `await Bun.sleep(${String(options.sleepMs)});`,
      `process.stdout.write(${JSON.stringify(options.output ?? "NONE")});`,
      options.exitCode === undefined ? "" : `process.exitCode = ${String(options.exitCode)};`,
    ].join("\n"),
    "utf8",
  );
  const wrapper = join(dir, "fake-model.sh");
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`, "utf8");
  await chmod(wrapper, 0o755);
  return wrapper;
};

interface Fixture {
  readonly home: string;
  readonly promptFile: string;
  readonly key: string;
}

const fixture = async (
  stateOverrides: Record<string, unknown> = {},
  prompt: string = PROMPT,
): Promise<Fixture> => {
  const home = await makeHome("intent-worker");
  paths.push(home);
  await writeSessionState(home, {
    hostSessionKey: SESSION_ID,
    crosscheckSessionId: `cc_${SESSION_ID}`,
    workContextId: `wc_cc_${SESSION_ID}`,
    repoId: REPO_ID,
    repoRoot: home,
    hubUrl: HUB_URL,
    developerId: "dev_self",
    startedAt: new Date().toISOString(),
    workContextTitle: TITLE,
    workContextStatus: "analyzing",
    intentFireCount: 1,
    ...stateOverrides,
  });
  const promptFile = intentPromptPathForSlug(home, sessionSlug(SESSION_ID));
  await writePrivateFile(promptFile, prompt);
  return { home, promptFile, key: repoKey(HUB_URL, REPO_ID) };
};

const workerArgs = (fix: Fixture): readonly string[] => [
  "--session",
  SESSION_ID,
  "--prompt-file",
  fix.promptFile,
];

interface SpooledWorkContext {
  readonly kind: string;
  readonly body: {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly intent?: {
      readonly summary: string;
      readonly provenance: string;
      readonly confidence: number;
      readonly capturedAt: string;
    };
  };
}

const spooledIntents = async (fix: Fixture): Promise<readonly SpooledWorkContext[]> =>
  (await readSpoolLines(fix.home, fix.key))
    .map((line) => JSON.parse(line) as SpooledWorkContext)
    .filter((record) => record.kind === "work_context");

const fileExists = async (path: string): Promise<boolean> =>
  stat(path).then(() => true, () => false);

const run = (fix: Fixture, fake: string, extraEnv: Record<string, string> = {}) =>
  runIntentWorker(workerArgs(fix), {
    CROSSCHECK_HOME: fix.home,
    CROSSCHECK_SUMMARIZER_CMD: fake,
    PATH: process.env["PATH"],
    ...extraEnv,
  });

describe("parseIntentWorkerArgs / resolveIntentArgv", () => {
  test("both flags are required", () => {
    expect(parseIntentWorkerArgs(["--session", "s", "--prompt-file", "/p"])).toEqual({
      claudeSessionId: "s",
      promptFile: "/p",
    });
    expect(parseIntentWorkerArgs(["--session", "s"])).toBeNull();
  });

  test("the argv is headless claude -p on the haiku-class model; the override replaces it wholesale", () => {
    const argv = resolveIntentArgv({});
    expect(argv[0]).toBe("claude");
    expect(argv[1]).toBe("-p");
    expect(argv.join(" ")).toContain("haiku");
    expect(argv.join(" ")).toContain("--setting-sources");
    expect(resolveIntentArgv({ CROSSCHECK_SUMMARIZER_CMD: "/tmp/fake" })).toEqual(["/tmp/fake"]);
  });

  /**
   * The number the model is given must be the number every surface can
   * actually show. INTENT_MAX_CHARS is the render cap (briefing/intent.ts);
   * asking for more guarantees an ellipsis on a sentence the model was told
   * to keep short, which is the one thing a one-line intent cannot afford.
   */
  test("the prompt asks for a sentence that fits the render cap, not one that will be cut", () => {
    const prompt = resolveIntentArgv({})[2] ?? "";

    // Exactly one character bound is stated, and it is the render cap —
    // matched on the phrase, so the "500s" inside the example sentence is
    // not mistaken for a bound.
    const bounds = [...prompt.matchAll(/at most (\d+) characters/g)].map((match) =>
      Number(match[1]),
    );
    expect(bounds, prompt).toEqual([INTENT_MAX_CHARS]);
  });
});

describe("runIntentWorker (end to end, faked binary)", () => {
  test("a sentence is spooled as a derived intent on the session's work context", async () => {
    // Arrange
    const fix = await fixture();
    const fake = await makeFakeModel({ output: `${SENTENCE}\n` });

    // Act
    const exitCode = await run(fix, fake);

    // Assert — the update record, derived under the cap, title/status from state
    expect(exitCode).toBe(0);
    const records = await spooledIntents(fix);
    expect(records).toHaveLength(1);
    const body = records[0]?.body;
    expect(body?.id).toBe(`wc_cc_${SESSION_ID}`);
    expect(body?.title).toBe(TITLE);
    expect(body?.status).toBe("analyzing");
    expect(body?.intent?.summary).toBe(SENTENCE);
    expect(body?.intent?.provenance).toBe("derived");
    expect(body?.intent?.confidence).toBe(INTENT_DERIVED_CONFIDENCE);
    expect(body?.intent?.confidence ?? 1).toBeLessThanOrEqual(DERIVED_CONFIDENCE_CAP);
    // — booked as set, nothing else
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.intentSetCount).toBe(1);
    expect(state?.intentNoneCount).toBe(0);
    expect(state?.intentFailCount).toBe(0);
  });

  test("the raw prompt reaches the model on stdin and NEVER the spool; the prompt file is gone", async () => {
    const fix = await fixture();
    const dir = await tempDir();
    const stdinDump = join(dir, "stdin.txt");
    const fake = await makeFakeModel({ output: SENTENCE, stdinDump });

    await run(fix, fake);

    expect(await Bun.file(stdinDump).text()).toBe(PROMPT);
    const spool = (await readSpoolLines(fix.home, fix.key)).join("\n");
    expect(spool).not.toContain(PROMPT_SENTINEL);
    expect(await fileExists(fix.promptFile)).toBe(false);
  });

  test("NONE spools nothing and is booked as a NONE, not a failure", async () => {
    const fix = await fixture();
    const fake = await makeFakeModel({ output: "NONE" });

    await run(fix, fake);

    expect(await spooledIntents(fix)).toHaveLength(0);
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.intentNoneCount).toBe(1);
    expect(state?.intentFailCount).toBe(0);
    expect(await fileExists(fix.promptFile)).toBe(false);
  });

  test("a secret-like sentence is dropped, never redacted, and booked with its reason", async () => {
    const fix = await fixture();
    const fake = await makeFakeModel({
      output: "Rotate the key AKIAABCDEFGHIJKLMNOP in the config loader",
    });

    await run(fix, fake);

    expect(await spooledIntents(fix)).toHaveLength(0);
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.intentFailCount).toBe(1);
    expect(state?.intentLastFailure).toContain("dropped: secret-like");
  });

  test("a sentence that echoes a delivered hint — this session's or an earlier one's — is dropped", async () => {
    const echoed = "The refresh 500s trace back to the rotated signing key";
    const inSession = await fixture({ deliveredHintHashes: [hintBodyHash(echoed)] });
    const fakeEcho = await makeFakeModel({ output: echoed });
    await run(inSession, fakeEcho);
    expect(await spooledIntents(inSession)).toHaveLength(0);
    expect((await readSessionState(inSession.home, SESSION_ID))?.intentLastFailure).toContain(
      "echoes a delivered hint",
    );

    const earlier = await fixture();
    await recordDeliveredHintHash(earlier.home, earlier.key, hintBodyHash(echoed));
    await run(earlier, await makeFakeModel({ output: echoed }));
    expect(await spooledIntents(earlier)).toHaveLength(0);
  });

  test("exit 1 and a deadline are booked as failures with their reason", async () => {
    const failing = await fixture();
    await run(failing, await makeFakeModel({ output: "Not logged in · Please run /login", exitCode: 1 }));
    const failed = await readSessionState(failing.home, SESSION_ID);
    expect(failed?.intentFailCount).toBe(1);
    expect(failed?.intentLastFailure).toBe("exit 1: Not logged in Please run /login");

    const hung = await fixture();
    await run(hung, await makeFakeModel({ output: "late", sleepMs: 5000 }), {
      CROSSCHECK_SUMMARIZER_TIMEOUT_MS: "200",
    });
    const timedOut = await readSessionState(hung.home, SESSION_ID);
    expect(timedOut?.intentFailCount).toBe(1);
    expect(timedOut?.intentLastFailure).toContain("timed out");
    expect(await spooledIntents(hung)).toHaveLength(0);
  });

  test(`a long answer is cut to MAX_INTENT_SUMMARY_CHARS (${String(MAX_INTENT_SUMMARY_CHARS)}); only the first line counts`, async () => {
    const fix = await fixture();
    const fake = await makeFakeModel({ output: `${"s".repeat(500)}\nsecond line ignored` });

    await run(fix, fake);

    const [record] = await spooledIntents(fix);
    expect(record?.body.intent?.summary.length).toBe(MAX_INTENT_SUMMARY_CHARS);
    expect(record?.body.intent?.summary).not.toContain("second line");
  });

  test("the child marker rides into the model process and the hub key does not", async () => {
    const fix = await fixture();
    const dir = await tempDir();
    const envDump = join(dir, "env.json");
    const fake = await makeFakeModel({ output: "NONE", envDump });

    await run(fix, fake, { CROSSCHECK_API_KEY: "hub-key-must-not-leak" });

    const env = JSON.parse(await Bun.file(envDump).text()) as Record<string, string>;
    expect(env["CROSSCHECK_SUMMARIZER_CHILD"]).toBe("1");
    expect(env["CROSSCHECK_API_KEY"]).toBeUndefined();
  });

  test("a pre-intent state file (no title) books a failure and fabricates nothing", async () => {
    const fix = await fixture({ workContextTitle: null, workContextStatus: null });
    const fake = await makeFakeModel({ output: SENTENCE });

    await run(fix, fake);

    expect(await spooledIntents(fix)).toHaveLength(0);
    const state = await readSessionState(fix.home, SESSION_ID);
    expect(state?.intentFailCount).toBe(1);
    expect(state?.intentLastFailure).toContain("predates intent support");
    expect(await fileExists(fix.promptFile)).toBe(false);
  });

  test("an empty prompt file is booked as a drop and removed", async () => {
    const fix = await fixture({}, "   ");
    await run(fix, await makeFakeModel({ output: SENTENCE }));
    expect((await readSessionState(fix.home, SESSION_ID))?.intentLastFailure).toContain("empty prompt");
    expect(await fileExists(fix.promptFile)).toBe(false);
  });

  test("no state file: silence, and the prompt file is still removed", async () => {
    const fix = await fixture();
    await rm(join(fix.home, "sessions", `${sessionSlug(SESSION_ID)}.json`));
    const exitCode = await run(fix, await makeFakeModel({ output: SENTENCE }));
    expect(exitCode).toBe(0);
    expect(await fileExists(fix.promptFile)).toBe(false);
  });
});
