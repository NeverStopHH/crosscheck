/**
 * EVERY WORKER A TRIGGER STARTS RUNS ISOLATED FROM THE REPO, AS A REAL
 * PROCESS (connector-core config/runtime-isolation.ts; review round 2, N4/R1).
 *
 * The ten detached workers are:
 * - Claude's summarizer, intent, ghost and landing fetch;
 * - ACP's and Cursor's summarizer, intent and ghost.
 *
 * Each starts with the hook's cwd, which is the project. Until this test they
 * were pinned only by a grep, and a `String(process.execPath)` spawn walked
 * past it.
 *
 * Here each REAL trigger runs in-process with `Bun.spawn` watched. A start of
 * a bun runtime is recorded instead of launched; git and everything else pass
 * through untouched. Then every recorded argv, with the env it was given, is
 * started for real in a bait repo whose bunfig preload drops a marker:
 * - with its flags, the preload must not run;
 * - without them (the control arm), it must, which proves the bait live for
 *   each argv.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

import { ISOLATED_BUNFIG_PATH, RUNTIME_ISOLATION_FLAGS } from "@crosscheck/connector-core/config/runtime-isolation.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import { updateSessionState, writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import {
  maybeSpawnAcpGhostWorker,
  maybeSpawnAcpIntentWorker,
  runAcpSummarizerGate,
} from "../../../connector-acp/src/derive/triggers.ts";
import { runHook } from "../../../connector-claude/src/index.ts";
import { makeHome, makeRepo } from "../../../connector-core/test/helpers.ts";
import { makeLandingRepos } from "../../../connector-core/test/fixtures/landing-repos.ts";
import { runCursorHook } from "../../../connector-cursor/src/index.ts";

const PACKAGES_DIR = resolve(import.meta.dir, "..", "..", "..");
const DEAD_HUB_URL = "http://127.0.0.1:1";
const HERMETIC_PATH = [dirname(process.execPath), "/usr/bin", "/bin"].join(":");
const PROMPT = "work out why the refresh call 500s after the key rotation";
const SLICE =
  "assistant: ran bun test src/auth — 3 tests failed with TypeError\n" +
  "assistant: Root cause: the refresh path reads the retired key.\n";
const CLAUDE_SESSION = "wsi-claude-uuid";
const CURSOR_CONV = "wsi-cursor-conv";
const ACP_KEY = "acp-fake-agent--wsi";
const SPAWN_WAIT_MS = 10_000;
const POLL_MS = 50;
const PROCESS_TIMEOUT_MS = 20_000;

/** The ten workers, by entry, relative to packages/. */
const WORKER_ENTRIES = [
  "connector-acp/src/derive/ghost-worker-entry.ts",
  "connector-acp/src/derive/intent-worker-entry.ts",
  "connector-acp/src/derive/summarizer-worker-entry.ts",
  "connector-claude/src/ghost/worker-entry.ts",
  "connector-claude/src/intent/worker-entry.ts",
  "connector-claude/src/landing-fetch/worker-entry.ts",
  "connector-claude/src/summarizer/worker-entry.ts",
  "connector-cursor/src/derive/ghost-worker-entry.ts",
  "connector-cursor/src/derive/intent-worker-entry.ts",
  "connector-cursor/src/derive/summarizer-worker-entry.ts",
];

interface SelfSpawn {
  readonly cmd: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}

const paths: string[] = [];

afterAll(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

/** What a launched worker gives back to a trigger that never waits on it. */
const INERT_CHILD = {
  stdin: { write: () => 0, end: () => undefined },
  unref: () => undefined,
  exited: Promise.resolve(0),
  pid: -1,
};

const startsBun = (cmd: readonly string[]): boolean => {
  const program = cmd[0] ?? "";
  return program === process.execPath || basename(program) === "bun";
};

type SpawnArgs = [options: { cmd?: string[]; env?: Record<string, string | undefined> } | string[], ...rest: unknown[]];

/** Runs `act` with Bun.spawn watched, and returns every start of a bun runtime it asked for. */
const selfSpawnsDuring = async (act: () => Promise<unknown>, expected: number): Promise<readonly SelfSpawn[]> => {
  const original = Bun.spawn as unknown as (...args: SpawnArgs) => unknown;
  const seen: SelfSpawn[] = [];
  const spy = spyOn(Bun, "spawn").mockImplementation(((...args: SpawnArgs) => {
    const [options, extra] = args;
    const cmd = Array.isArray(options) ? options : (options.cmd ?? []);
    if (!startsBun(cmd)) {
      return original(...args);
    }
    const env = Array.isArray(options) ? (extra as { env?: Record<string, string | undefined> } | undefined)?.env : options.env;
    seen.push({ cmd: [...cmd], env: { ...env } });
    return INERT_CHILD;
  }) as never);
  try {
    await act();
    const deadline = Date.now() + SPAWN_WAIT_MS;
    while (seen.length < expected && Date.now() < deadline) {
      await Bun.sleep(POLL_MS);
    }
  } finally {
    spy.mockRestore();
  }
  return seen;
};

const sessionState = (hostSessionKey: string, repoId: string, repoRoot: string) => ({
  hostSessionKey,
  crosscheckSessionId: `cc_${hostSessionKey}`,
  workContextId: `wc_cc_${hostSessionKey}`,
  repoId,
  repoRoot,
  hubUrl: DEAD_HUB_URL,
  developerId: "dev_self",
  startedAt: new Date().toISOString(),
});

const owesGhost = (home: string, key: string): Promise<boolean> =>
  updateSessionState(home, key, (fresh) => ({ ...fresh, ghostPending: true }));

const baseEnv = (home: string): Record<string, string> => ({
  CROSSCHECK_HOME: home,
  CROSSCHECK_HUB_URL: DEAD_HUB_URL,
  CROSSCHECK_API_KEY: "test-key",
  CROSSCHECK_SUMMARIZER_CMD: "/nonexistent/model",
  PATH: HERMETIC_PATH,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
});

const transcriptLine = (type: string, blocks: unknown[]): string =>
  `${JSON.stringify({ type, message: { role: type, content: blocks } })}\n`;

/** Claude: a prompt (intent, ghost, landing fetch) and a Stop on a diagnosis turn (summarizer). */
const claudeSpawns = async (): Promise<readonly SelfSpawn[]> => {
  const repos = await makeLandingRepos("wsi-claude");
  const home = await makeHome("wsi-claude");
  paths.push(repos.base, home);
  const identity = await resolveRepoIdentity(repos.reader);
  if (identity === null) {
    throw new Error("the reader clone has no repo identity");
  }
  await writeSessionState(home, sessionState(CLAUDE_SESSION, identity.repoId, repos.reader));
  await owesGhost(home, CLAUDE_SESSION);
  const transcript = join(home, "transcript.jsonl");
  await writeFile(
    transcript,
    transcriptLine("user", [{ type: "text", text: "why is bun test red" }]) +
      transcriptLine("assistant", [{ type: "tool_use", name: "Bash", input: { command: "bun test packages/api" } }]) +
      transcriptLine("user", [{ type: "tool_result", content: "1 fail — TypeError: cursor is undefined" }]) +
      transcriptLine("assistant", [{ type: "text", text: "The root cause is the stale cursor id" }]),
    "utf8",
  );
  const env = baseEnv(home);
  return selfSpawnsDuring(async () => {
    const at = { session_id: CLAUDE_SESSION, cwd: repos.reader };
    await runHook("user-prompt-submit", JSON.stringify({ ...at, hook_event_name: "UserPromptSubmit", prompt: PROMPT }), env);
    await runHook(
      "stop",
      JSON.stringify({ ...at, hook_event_name: "Stop", transcript_path: transcript, stop_hook_active: false }),
      env,
    );
  }, 4);
};

/** Cursor: beforeSubmitPrompt (intent), then stop on a conclusion turn (summarizer, ghost). */
const cursorSpawns = async (): Promise<readonly SelfSpawn[]> => {
  const repo = await makeRepo("wsi-cursor", { remote: "git@github.com:acme/api.git" });
  const home = await makeHome("wsi-cursor");
  paths.push(repo, home);
  const key = `cur-${CURSOR_CONV}`;
  await writeSessionState(home, sessionState(key, "github.com/acme/api", repo));
  await owesGhost(home, key);
  const transcript = join(home, "transcript.jsonl");
  await writeFile(
    transcript,
    [
      JSON.stringify({ role: "user", text: "the refresh endpoint 500s after we rotate the key" }),
      JSON.stringify({ role: "assistant", text: "ran bun test src/auth — 3 tests failed with TypeError: cannot read token" }),
      JSON.stringify({ role: "assistant", text: "Root cause: the refresh path reads the retired key. All tests passing now." }),
      "",
    ].join("\n"),
    "utf8",
  );
  const env = { ...baseEnv(home), CURSOR_PROJECT_DIR: repo };
  const at = { conversation_id: CURSOR_CONV, workspace_roots: [repo], cursor_version: "1.7.2" };
  return selfSpawnsDuring(async () => {
    await runCursorHook("beforeSubmitPrompt", JSON.stringify({ ...at, hook_event_name: "beforeSubmitPrompt", prompt: PROMPT }), env);
    await runCursorHook(
      "stop",
      JSON.stringify({ ...at, hook_event_name: "stop", status: "completed", transcript_path: transcript }),
      env,
    );
  }, 3);
};

/** ACP: the three triggers the capture engine calls, each on its own condition. */
const acpSpawns = async (): Promise<readonly SelfSpawn[]> => {
  const home = await makeHome("wsi-acp");
  paths.push(home);
  await writeSessionState(home, sessionState(ACP_KEY, "github.com/acme/api", home));
  await owesGhost(home, ACP_KEY);
  const ctx = { env: baseEnv(home), home, hostSessionKey: ACP_KEY, agentKind: "acp:fake-agent" };
  return selfSpawnsDuring(async () => {
    const fired = [
      await maybeSpawnAcpIntentWorker(ctx, PROMPT),
      await maybeSpawnAcpGhostWorker(ctx),
      await runAcpSummarizerGate(ctx, SLICE),
    ];
    if (fired.includes(false)) {
      throw new Error(`an ACP trigger declined to fire: ${JSON.stringify(fired)}`);
    }
  }, 3);
};

const entryOf = (spawn: SelfSpawn): string => relative(PACKAGES_DIR, spawn.cmd.find((arg) => arg.endsWith(".ts")) ?? "");

interface BaitRun {
  readonly isolatedRan: boolean;
  readonly unflaggedRan: boolean;
}

/** Starts `cmd` in the bait repo, as the trigger would have, and says whether the repo's preload ran. */
const preloadRanFor = async (bait: string, marker: string, cmd: readonly string[], env: SelfSpawn["env"]): Promise<boolean> => {
  await rm(marker, { force: true });
  const child = Bun.spawn({
    cmd: [...cmd],
    cwd: bait,
    // A scratch home: the worker's own work is not under test, only what
    // bun loads before the first line of it.
    env: { ...env, CROSSCHECK_HOME: bait, HOME: bait },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    timeout: PROCESS_TIMEOUT_MS,
  });
  await child.exited;
  return Bun.file(marker).exists();
};

let spawns: readonly SelfSpawn[] = [];

beforeAll(async () => {
  spawns = [...(await claudeSpawns()), ...(await cursorSpawns()), ...(await acpSpawns())];
}, 120_000);

describe("the ten worker spawns", () => {
  test("each trigger starts its worker as the running bun, the isolation flags, then the entry", () => {
    // Act
    const shapes = spawns.map((spawn) => ({ entry: entryOf(spawn), head: spawn.cmd.slice(0, 3) }));

    // Assert — all ten fired, each exactly once, each isolated
    expect(shapes.map((shape) => shape.entry).sort()).toEqual(WORKER_ENTRIES);
    expect(RUNTIME_ISOLATION_FLAGS).toEqual(["--no-env-file", `--config=${ISOLATED_BUNFIG_PATH}`]);
    for (const shape of shapes) {
      expect(shape).toEqual({ entry: shape.entry, head: [process.execPath, ...RUNTIME_ISOLATION_FLAGS] });
    }
  });

  test(
    "none of them runs a bait repo's preload as a process; without the flags every one does",
    async () => {
      // Arrange — a repo whose bunfig preload drops a marker, synchronously first
      const bait = await mkdtemp(join(tmpdir(), "cx-wsi-bait-"));
      paths.push(bait);
      const marker = join(bait, "preload-ran");
      await writeFile(join(bait, "bunfig.toml"), 'preload = ["./preload.ts"]\n', "utf8");
      await writeFile(join(bait, "preload.ts"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`, "utf8");

      // Act — every recorded argv for real, then the same argv with the flags removed
      const runs: Record<string, BaitRun> = {};
      for (const spawn of spawns) {
        const unflagged = spawn.cmd.filter((arg) => !RUNTIME_ISOLATION_FLAGS.includes(arg));
        runs[entryOf(spawn)] = {
          isolatedRan: await preloadRanFor(bait, marker, spawn.cmd, spawn.env),
          unflaggedRan: await preloadRanFor(bait, marker, unflagged, spawn.env),
        };
      }

      // Assert
      expect(Object.keys(runs).sort()).toEqual(WORKER_ENTRIES);
      for (const [entry, run] of Object.entries(runs)) {
        expect({ entry, ...run }).toEqual({ entry, isolatedRan: false, unflaggedRan: true });
      }
    },
    PROCESS_TIMEOUT_MS * 4,
  );
});
