/**
 * THE SHARED MODEL SEAM (Block 1 of connector parity, the move-first half of
 * DESIGN-agent-agnostic.md §1.1).
 *
 * The machinery that turns "a slice of a turn" into "a derived claim on the
 * spool" lived inside connector-claude, so Cursor and ACP could read and ask
 * but nothing was ever DERIVED for them. This file pins the MOVE half: argv
 * resolution and its wholesale override, the env hygiene, the deadline, the
 * output bound and the NONE parse all answer from connector-core now, and no
 * connector keeps a second copy. The ORDER those pieces are applied in is
 * pinned next door, in model-gates.test.ts.
 *
 * Nothing here talks to a hub: the runner's contract is slice on stdin and
 * answer on stdout. Fake binaries are written into one temp dir and removed
 * with it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { DERIVED_CONFIDENCE_CAP } from "@crosscheck/schema";
import {
  SUMMARIZER_CHILD_ENV,
  SUMMARIZER_CHILD_ON,
  SUMMARIZER_OUTPUT_MAX_BYTES,
} from "../src/constants.ts";
import { isNoneAnswer, parseSummarizerOutput } from "../src/model/parse.ts";
import {
  resolveSummarizerArgv,
  runSummarizer,
  SUMMARIZER_PROMPT,
} from "../src/model/runner.ts";
import { resolveConferenceArgv } from "../src/derive/conference/prompt.ts";
import { GHOST_PROMPT, resolveGhostArgv } from "../src/derive/ghost/prompt.ts";
import { INTENT_PROMPT, resolveIntentArgv } from "../src/derive/intent/prompt.ts";
import {
  PARENT_SESSION_MARKER_PATTERN,
  summarizerWorkerEnv,
} from "../src/model/worker-env.ts";

let fakeRoot: string;

const writeFake = async (name: string, body: string): Promise<string> => {
  const path = join(fakeRoot, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(path, 0o755);
  return path;
};

beforeAll(async () => {
  fakeRoot = await mkdtemp(join(tmpdir(), "cx-model-seam-"));
});

afterAll(async () => {
  await rm(fakeRoot, { recursive: true, force: true });
});

describe("the seam sits under every connector, not inside one", () => {
  test("core owns the model machinery and imports no connector to run it", async () => {
    // Arrange
    const root = join(import.meta.dir, "..", "src", "model");

    // Act
    const files = (await readdir(root)).filter((name) => name.endsWith(".ts"));
    const offenders: string[] = [];
    for (const name of files) {
      const source = await Bun.file(join(root, name)).text();
      if (/@crosscheck\/connector-(?!core)/.test(source)) {
        offenders.push(name);
      }
    }

    // Assert: a seam that imported a connector would not be a seam.
    for (const moved of ["parse.ts", "reject.ts", "runner.ts", "worker-env.ts"]) {
      expect(files, moved).toContain(moved);
    }
    expect(offenders).toEqual([]);
  });

  test("no connector keeps a model runner of its own", async () => {
    // Arrange: the exports a second copy would have to re-declare.
    const owned = [
      "export const runSummarizer",
      "export const resolveSummarizerArgv",
      "export const parseSummarizerOutput",
      "export const summarizerWorkerEnv",
      "export const PARENT_SESSION_MARKER_PATTERN",
    ];
    const packagesRoot = join(import.meta.dir, "..", "..");
    const connectors = (await readdir(packagesRoot, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name.startsWith("connector-") &&
          entry.name !== "connector-core",
      )
      .map((entry) => entry.name);

    // Act
    const offenders: string[] = [];
    for (const connector of connectors) {
      const src = join(packagesRoot, connector, "src");
      const entries = await readdir(src, {
        recursive: true,
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".ts")) {
          continue;
        }
        const path = join(entry.parentPath, entry.name);
        const source = await Bun.file(path).text();
        if (owned.some((marker) => source.includes(marker))) {
          offenders.push(relative(packagesRoot, path));
        }
      }
    }

    // Assert
    expect(connectors.length).toBeGreaterThanOrEqual(3);
    expect(offenders).toEqual([]);
  });
});

describe("argv resolution: the override replaces the binary WHOLESALE", () => {
  test("the default argv is the lean headless model call", () => {
    // Act
    const argv = resolveSummarizerArgv({});

    // Assert
    expect(argv[0]).toBe("claude");
    expect(argv[1]).toBe("-p");
    expect(argv).toContain("--setting-sources");
    expect(argv).toContain("--no-session-persistence");
  });

  test("CROSSCHECK_SUMMARIZER_CMD is the whole argv — no flag is spliced in", () => {
    // Act
    const argv = resolveSummarizerArgv({
      CROSSCHECK_SUMMARIZER_CMD: "/tmp/fake-model",
    });

    // Assert: an operator or a test owns the whole contract.
    expect(argv).toEqual(["/tmp/fake-model"]);
  });

  test("all four tasks hand one override the same argv, and it says nothing", async () => {
    // FOUR TASKS, FOUR DIFFERENT INSTRUCTIONS, ONE VARIABLE. The summarizer
    // wants claim JSON or NONE; intent wants one third-person sentence;
    // ghost wants one conflict sentence; conference wants its own report
    // shape. Each resolver honours CROSSCHECK_SUMMARIZER_CMD and each hands
    // the wrapper an argv of exactly [cmd] — so a wrapper cannot tell which
    // of the four fired, and a single hard-coded instruction inside it is
    // wrong for three of them.
    //
    // That is the headline limitation of today's override, and it is pinned
    // here so docs/FOREIGN-MODELS.md's warning cannot quietly go stale: the
    // day an argv-carrying lane lands, this test is what goes red.
    const cmd = "/opt/ox-wrapper";
    const env = { CROSSCHECK_SUMMARIZER_CMD: cmd };
    const argvs = {
      summarizer: resolveSummarizerArgv(env),
      intent: resolveIntentArgv(env),
      ghost: resolveGhostArgv(env),
      conference: resolveConferenceArgv(env),
    };

    // Assert: identical, argument-free, and carrying none of the four
    // instructions the default backend would have put on argv.
    for (const [task, argv] of Object.entries(argvs)) {
      expect(argv, task).toEqual([cmd]);
    }
    const conferencePrompt = resolveConferenceArgv({})[2] ?? "";
    for (const prompt of [
      SUMMARIZER_PROMPT,
      INTENT_PROMPT,
      GHOST_PROMPT,
      conferencePrompt,
    ]) {
      expect(prompt.length).toBeGreaterThan(80);
      for (const [task, argv] of Object.entries(argvs)) {
        expect(argv.join(" "), task).not.toContain(prompt);
      }
    }
    // And the four instructions really are four, not one reused — otherwise
    // the limitation above would not exist and this test would be theatre.
    expect(
      new Set([SUMMARIZER_PROMPT, INTENT_PROMPT, GHOST_PROMPT, conferencePrompt])
        .size,
    ).toBe(4);
  });
});

describe("env hygiene travels with the seam", () => {
  test("the parent session's markers are stripped and the child marker is set", () => {
    // Arrange: a hook process's env, markers and all.
    const env = {
      USER: "nick",
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "kept-because-it-is-how-the-child-logs-in",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "sess",
      CLAUDE_PLUGIN_ROOT: "/plugins",
      CLAUDE_PID: "42",
    };

    // Act
    const childEnv = summarizerWorkerEnv(env, "/tmp/home");

    // Assert
    expect(childEnv["USER"]).toBe("nick");
    expect(childEnv["ANTHROPIC_API_KEY"]).toBe(
      "kept-because-it-is-how-the-child-logs-in",
    );
    expect(childEnv["CLAUDECODE"]).toBeUndefined();
    expect(childEnv["CLAUDE_CODE_SESSION_ID"]).toBeUndefined();
    expect(childEnv["CLAUDE_PLUGIN_ROOT"]).toBeUndefined();
    expect(childEnv["CLAUDE_PID"]).toBeUndefined();
    expect(childEnv["CROSSCHECK_HOME"]).toBe("/tmp/home");
    expect(childEnv[SUMMARIZER_CHILD_ENV]).toBe(SUMMARIZER_CHILD_ON);
    expect(PARENT_SESSION_MARKER_PATTERN.test("USER")).toBe(false);
  });

  test("the spawned model never sees the hub key and always sees the child marker", async () => {
    // Arrange: a fake that reports the two variables back on stdout.
    const fake = await writeFake(
      "env-report.sh",
      'cat > /dev/null\necho "key=${CROSSCHECK_API_KEY:-absent} child=${CROSSCHECK_SUMMARIZER_CHILD:-absent}"',
    );

    // Act
    const result = await runSummarizer([fake], "slice", 10_000, {
      CROSSCHECK_API_KEY: "cx_secret_value",
    });

    // Assert: the hub key stops at this door; the recursion guard passes it.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stdout.trim()).toBe("key=absent child=1");
    }
  });

  test("a caller that built the env by hand still cannot leak the session", async () => {
    // Arrange: the parent Claude Code session's own binding markers, in an
    // env the CALLER assembled — which is not a hypothetical. The detached
    // derive workers go through deriveWorkerEnv and are clean; `crosscheck
    // conference` (cli/src/cli/conference.ts) hands the runner the raw
    // process.env of the terminal it was typed in, and a developer types it
    // inside a Claude Code session more often than not.
    //
    // Measured before the fix, with all six set: 6 of 6 reached the model.
    // The denylist was CALLER discipline, so the one caller that skipped it
    // handed a nested `claude -p` the session it was summarizing.
    const fake = await writeFake(
      "session-report.sh",
      'cat > /dev/null\necho "code=${CLAUDECODE:-absent} sid=${CLAUDE_CODE_SESSION_ID:-absent} port=${CLAUDE_CODE_SSE_PORT:-absent} dir=${CLAUDE_PROJECT_DIR:-absent} auth=${ANTHROPIC_API_KEY:-absent}"',
    );

    // Act
    const result = await runSummarizer([fake], "slice", 10_000, {
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "parent-session-abc",
      CLAUDE_CODE_SSE_PORT: "51234",
      CLAUDE_PROJECT_DIR: "/Users/dev/repo",
      ANTHROPIC_API_KEY: "kept-because-it-is-how-the-child-logs-in",
    });

    // Assert: stripped at the spawn, whoever built the env — and the AUTH
    // variable survives, because a denylist that swept CLAUDE_ or ANTHROPIC_
    // wholesale would log the nested model out.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stdout.trim()).toBe(
        "code=absent sid=absent port=absent dir=absent auth=kept-because-it-is-how-the-child-logs-in",
      );
    }
  });
});

describe("the timeout and the bounds are the seam's, not the caller's", () => {
  test("a model that never answers comes back as a typed timeout, not a hang", async () => {
    // Arrange
    const fake = await writeFake("hang.sh", "cat > /dev/null\nsleep 30");

    // Act
    const started = Date.now();
    const result = await runSummarizer([fake], "slice", 400, {});
    const elapsedMs = Date.now() - started;

    // Assert: the deadline bounds the CALL, not the child.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("timeout");
    }
    expect(elapsedMs).toBeLessThan(5_000);
  });

  test("a flooding model is cut at the byte cap, never buffered whole", async () => {
    // Arrange: far more than the cap, printed as fast as the shell can.
    const fake = await writeFake(
      "flood.sh",
      `cat > /dev/null\nawk 'BEGIN{for(i=0;i<4000;i++) printf "%s", "0123456789"}'`,
    );

    // Act
    const result = await runSummarizer([fake], "slice", 20_000, {});

    // Assert
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stdout.length).toBe(SUMMARIZER_OUTPUT_MAX_BYTES);
    }
  });
});

describe("the NONE parse and the derived cap", () => {
  test("NONE is recognised past spacing, case and a stray full stop", () => {
    expect(isNoneAnswer("NONE")).toBe(true);
    expect(isNoneAnswer("  none.\n")).toBe(true);
    expect(isNoneAnswer('{"kind":"observation"}')).toBe(false);
  });

  test("a model's own confidence is clamped to the derived cap", () => {
    // Act
    const draft = parseSummarizerOutput(
      '{"kind":"observation","body":"the retry cap is off by one","confidence":0.9}',
    );

    // Assert
    expect(draft?.confidence).toBe(DERIVED_CONFIDENCE_CAP);
  });
});
