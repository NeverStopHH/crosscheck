/**
 * WHAT CURSOR NOW INFERS — the three derive rungs through the REAL hooks: a
 * real repo, a real spool, real detached worker processes, a real (tiny) hub
 * on a throwaway port. Only the MODEL BINARY is faked
 * (CROSSCHECK_SUMMARIZER_CMD, the override every worker already honours).
 *
 * The one thing every case here is really about is that a rung EXISTS at all:
 * before this, `beforeSubmitPrompt` was not registered, `ghostPending` was set
 * by `set_intent` in Cursor and paid by nothing, and `stop` counted turns. The
 * assertions therefore look boring on purpose — a fire booked, a record on the
 * spool, a counter moved — because "boring, and it happens" is the whole
 * difference from "Ken gets nothing".
 *
 * AND ONE THING THAT IS NOT BORING: `agentKind`. The workers stamp a record's
 * producer from the environment and default to `claude-code`; a Cursor-spawned
 * draft filed under Claude is a wrong attribution nobody would ever notice on
 * a hub. Every record assertion below reads the stamp.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HTTP_TIMEOUT_MS } from "@crosscheck/connector-core/constants.ts";
import {
  intentPromptPathForSlug,
  sessionSlug,
} from "@crosscheck/connector-core/config/paths.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import { readSpoolLines } from "@crosscheck/connector-core/spool/files.ts";
import { CURSOR_AGENT_KIND } from "@crosscheck/connector-core/state/host-session-key.ts";
import {
  readSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";

import { runCursorHook } from "../src/index.ts";
import { NO_SLICE_NO_TRANSCRIPT } from "../src/derive/transcript.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const CONV = "conv-derive-1";
const HOST_KEY = `cur-${CONV}`;
const PROMPT_SENTINEL = "ZQX-CURSOR-PROMPT-4417";
const PROMPT = `why does the refresh call 500 after the key rotation ${PROMPT_SENTINEL}`;
const INTENT_SENTENCE = "Find why the refresh call 500s after the key rotation";

/**
 * A throwaway hub on a port in the range this task owns (7610-7619), never
 * 7100 and never the real tailnet URL. It answers the ONE route the ghost
 * worker gates on and 404s the rest — the workers under test write to the
 * SPOOL, so nothing else needs a hub at all.
 */
const HUB_PORT = 7610;

interface FakeHub {
  readonly url: string;
  readonly stop: () => void;
  ghostChecks: readonly unknown[];
  ghostCheckCalls: number;
}

const startFakeHub = (): FakeHub => {
  const state = {
    ghostChecks: [] as readonly unknown[],
    ghostCheckCalls: 0,
  };
  const server = Bun.serve({
    port: HUB_PORT,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/ghost-checks") {
        state.ghostCheckCalls += 1;
        // The hub's own envelope shape (http/client.ts OkEnvelopeSchema):
        // {ok, data}, with the route's list under data.
        return Response.json({
          ok: true,
          data: { ghostChecks: state.ghostChecks },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    stop: () => {
      server.stop(true);
    },
    get ghostChecks() {
      return state.ghostChecks;
    },
    set ghostChecks(value: readonly unknown[]) {
      state.ghostChecks = value;
    },
    get ghostCheckCalls() {
      return state.ghostCheckCalls;
    },
  };
};

const hub = startFakeHub();
const paths: string[] = [];

afterEach(async () => {
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
  hub.ghostChecks = [];
});

afterAll(() => {
  hub.stop();
});

/** A fake model: reads stdin (so the deadline path is real), prints one answer. */
const makeFakeModel = async (output: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-cursor-derive-"));
  paths.push(dir);
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

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly key: string;
  readonly env: Env;
  readonly promptFile: string;
}

const fixture = async (
  label: string,
  modelOutput: string,
  overrides: Record<string, unknown> = {},
): Promise<Fixture> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  await writeSessionState(home, {
    hostSessionKey: HOST_KEY,
    crosscheckSessionId: `cc_${HOST_KEY}`,
    workContextId: `wc_cc_${HOST_KEY}`,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl: hub.url,
    developerId: "dev_self",
    startedAt: new Date().toISOString(),
    workContextTitle: "main @ api",
    workContextStatus: "analyzing",
    ...overrides,
  });
  return {
    repo,
    home,
    key: repoKey(hub.url, REPO_ID),
    promptFile: intentPromptPathForSlug(home, sessionSlug(HOST_KEY)),
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_TIMEOUT_MS: String(HTTP_TIMEOUT_MS),
      CROSSCHECK_SUMMARIZER_CMD: await makeFakeModel(modelOutput),
      CURSOR_PROJECT_DIR: repo,
      PATH: process.env["PATH"],
    },
  };
};

const payload = (fix: Fixture, event: string, extra: object): string =>
  JSON.stringify({
    conversation_id: CONV,
    hook_event_name: event,
    workspace_roots: [fix.repo],
    cursor_version: "1.7.2",
    ...extra,
  });

interface SpoolRecord {
  readonly kind: string;
  readonly producer?: { readonly agentKind?: string };
  readonly body: Record<string, unknown>;
}

const spooled = async (fix: Fixture): Promise<readonly SpoolRecord[]> =>
  (await readSpoolLines(fix.home, fix.key)).map(
    (line) => JSON.parse(line) as SpoolRecord,
  );

const POLL_MS = 100;
const POLL_TIMEOUT_MS = 20_000;
/** Long enough for a worker that WAS spawned to have finished writing. */
const SETTLE_MS = 2500;

const waitFor = async <T>(read: () => Promise<T | null>): Promise<T | null> => {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const value = await read();
    if (value !== null || Date.now() > deadline) {
      return value;
    }
    await Bun.sleep(POLL_MS);
  }
};

const fileExists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("intent × cursor: beforeSubmitPrompt derives the session's plan", () => {
  test("the first substantive prompt fires once and spools a DERIVED intent stamped cursor", async () => {
    // Arrange
    const fix = await fixture("cursor-intent", INTENT_SENTENCE);

    // Act
    const out = await runCursorHook(
      "beforeSubmitPrompt",
      payload(fix, "beforeSubmitPrompt", { prompt: PROMPT }),
      fix.env,
    );

    // Assert — the handler never blocks: no `continue`, no `user_message`
    expect(JSON.parse(out)).toEqual({});
    expect((await readSessionState(fix.home, HOST_KEY))?.intentFireCount).toBe(1);

    const record = await waitFor(async () => {
      const records = await spooled(fix);
      return records.find((entry) => entry.kind === "work_context") ?? null;
    });
    expect(record).not.toBeNull();
    const intent = record?.body["intent"] as
      | { summary: string; provenance: string; confidence: number }
      | undefined;
    expect(intent?.summary).toBe(INTENT_SENTENCE);
    expect(intent?.provenance).toBe("derived");
    // THE TRAP: without the trigger passing its own kind this reads
    // "claude-code" and Ken's plan is filed under the wrong host.
    expect(record?.producer?.agentKind).toBe(CURSOR_AGENT_KIND);
    // The prompt itself never leaves: not on the spool, and the parked file
    // is unlinked by the worker.
    expect((await readSpoolLines(fix.home, fix.key)).join("\n")).not.toContain(
      PROMPT_SENTINEL,
    );
    expect(await fileExists(fix.promptFile)).toBe(false);
  }, 40_000);

  test("a slash command, a bare yes and a short prompt fire nothing", async () => {
    const fix = await fixture("cursor-intent-quiet", INTENT_SENTENCE);

    for (const prompt of ["/clear", "yes", "fix the thing"]) {
      await runCursorHook(
        "beforeSubmitPrompt",
        payload(fix, "beforeSubmitPrompt", { prompt }),
        fix.env,
      );
    }
    await Bun.sleep(SETTLE_MS);

    expect((await readSessionState(fix.home, HOST_KEY))?.intentFireCount).toBe(0);
    expect(await fileExists(fix.promptFile)).toBe(false);
    expect(await spooled(fix)).toHaveLength(0);
  }, 20_000);

  test("an unregistered conversation is silence, not a registration", async () => {
    // Arrange: a home with no session state at all.
    const repo = await makeRepo("cursor-intent-cold", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("cursor-intent-cold");
    paths.push(repo, home);
    const env: Env = {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: "test-key",
      CURSOR_PROJECT_DIR: repo,
      PATH: process.env["PATH"],
    };

    // Act
    const out = await runCursorHook(
      "beforeSubmitPrompt",
      JSON.stringify({
        conversation_id: CONV,
        hook_event_name: "beforeSubmitPrompt",
        workspace_roots: [repo],
        prompt: PROMPT,
      }),
      env,
    );

    // Assert: a prompt is never worth registering a session for.
    expect(JSON.parse(out)).toEqual({});
    expect(await readSessionState(home, HOST_KEY)).toBeNull();
  });
});

describe("ghost × cursor: the debt set_intent opens is finally paid", () => {
  const OVERLAP = [
    {
      workContextId: "wc_cc_teammate",
      title: "Rate limiter rewrite",
      developerId: "dev_other",
      developerName: "Nick",
      intent: {
        summary: "Rewrite the token bucket in the rate limiter",
        provenance: "declared",
        confidence: 0.9,
        capturedAt: new Date().toISOString(),
      },
      lastActiveAt: new Date().toISOString(),
      sharedTargets: [],
      sharedTargetCount: 0,
      intentTokenHits: 3,
    },
  ];

  test("stop pays it: the flag clears, the worker runs, the draft is stamped cursor", async () => {
    // Arrange
    hub.ghostChecks = OVERLAP;
    const fix = await fixture(
      "cursor-ghost-stop",
      "Both plans rewrite the same token bucket",
      {
        ghostPending: true,
        workContextIntent: "Fix the refresh 500s after the key rotation",
      },
    );

    // Act
    await runCursorHook("stop", payload(fix, "stop", { status: "completed" }), fix.env);

    // Assert
    const state = await waitFor(async () => {
      const fresh = await readSessionState(fix.home, HOST_KEY);
      return fresh !== null && fresh.ghostDraftCount > 0 ? fresh : null;
    });
    expect(state?.ghostPending).toBe(false);
    expect(state?.ghostFireCount).toBe(1);
    expect(state?.ghostDraftCount).toBe(1);
    const claim = (await spooled(fix)).find((entry) => entry.kind === "claim");
    expect(claim?.producer?.agentKind).toBe(CURSOR_AGENT_KIND);
    expect(claim?.body["provenance"]).toBe("derived");
    expect(claim?.body["captureMode"]).toBe("auto");
    // Derived stays derived: the cap, not the model's own confidence.
    expect(claim?.body["confidence"] as number).toBeLessThanOrEqual(0.5);
  }, 40_000);

  test("postToolUse pays it too — Cursor has no always-runs next-prompt event", async () => {
    hub.ghostChecks = OVERLAP;
    const fix = await fixture(
      "cursor-ghost-ptu",
      "Both plans rewrite the same token bucket",
      {
        ghostPending: true,
        workContextIntent: "Fix the refresh 500s after the key rotation",
      },
    );

    await runCursorHook(
      "postToolUse",
      payload(fix, "postToolUse", {
        tool_name: "Shell",
        tool_output: JSON.stringify({ exitCode: 0, stdout: "ok" }),
      }),
      fix.env,
    );

    const state = await waitFor(async () => {
      const fresh = await readSessionState(fix.home, HOST_KEY);
      return fresh !== null && fresh.ghostFireCount > 0 ? fresh : null;
    });
    expect(state?.ghostPending).toBe(false);
    expect(state?.ghostFireCount).toBe(1);
  }, 40_000);

  test("a session owing nothing spawns nothing and asks the hub nothing", async () => {
    hub.ghostChecks = OVERLAP;
    const before = hub.ghostCheckCalls;
    const fix = await fixture("cursor-ghost-none", "unused");

    await runCursorHook("stop", payload(fix, "stop", { status: "completed" }), fix.env);
    await Bun.sleep(SETTLE_MS);

    expect(hub.ghostCheckCalls).toBe(before);
    expect((await readSessionState(fix.home, HOST_KEY))?.ghostFireCount).toBe(0);
  }, 20_000);
});

describe("summarizer × cursor: the reduced rung, and its honest refusal", () => {
  const CONCLUSION_TURN = [
    JSON.stringify({
      role: "user",
      text: "the refresh endpoint 500s after we rotate the key",
    }),
    JSON.stringify({
      role: "assistant",
      text: "ran bun test src/auth — 3 tests failed with TypeError: cannot read token",
    }),
    JSON.stringify({
      role: "assistant",
      text: "Root cause: the refresh path reads the retired key. The fix is to re-read the key on rotation; all tests passing now.",
    }),
    "",
  ].join("\n");

  const writeTranscript = async (
    fix: Fixture,
    body: string,
  ): Promise<string> => {
    const path = join(fix.home, "cursor-transcript.jsonl");
    await writeFile(path, body, "utf8");
    return path;
  };

  test("a conclusion turn fires, and the draft is derived, capped and stamped cursor", async () => {
    // Arrange
    const fix = await fixture(
      "cursor-summarizer",
      // The model's own confidence is deliberately ABOVE the derived cap:
      // the clamp is what this case reads back.
      JSON.stringify({
        kind: "root_cause",
        body: "The refresh path read the retired key after rotation",
        confidence: 0.95,
      }),
    );
    const transcript = await writeTranscript(fix, CONCLUSION_TURN);

    // Act
    await runCursorHook(
      "stop",
      payload(fix, "stop", { status: "completed", transcript_path: transcript }),
      fix.env,
    );

    // Assert
    const state = await waitFor(async () => {
      const fresh = await readSessionState(fix.home, HOST_KEY);
      return fresh !== null && fresh.summarizerDraftCount > 0 ? fresh : null;
    });
    expect(state?.stopTurnCount).toBe(1);
    expect(state?.summarizerFireCount).toBe(1);
    expect(state?.summarizerNoSliceCount).toBe(0);
    const claim = (await spooled(fix)).find((entry) => entry.kind === "claim");
    expect(claim?.producer?.agentKind).toBe(CURSOR_AGENT_KIND);
    expect(claim?.body["provenance"]).toBe("derived");
    expect(claim?.body["captureMode"]).toBe("auto");
    expect(claim?.body["confidence"]).toBe(0.5);
  }, 40_000);

  test("no transcript is its OWN outcome, never a runner failure", async () => {
    // Arrange: the documented off state — transcript_path absent AND no
    // CURSOR_TRANSCRIPT_PATH in the environment.
    const fix = await fixture("cursor-no-transcript", "unused");

    // Act
    await runCursorHook("stop", payload(fix, "stop", { status: "completed" }), fix.env);
    await Bun.sleep(SETTLE_MS);

    // Assert
    const state = await readSessionState(fix.home, HOST_KEY);
    expect(state?.stopTurnCount).toBe(1);
    expect(state?.summarizerNoSliceCount).toBe(1);
    expect(state?.summarizerLastNoSlice).toBe(NO_SLICE_NO_TRANSCRIPT);
    // The distinction the whole outcome exists for: nothing on this machine
    // is broken, so nothing on this machine is booked as broken.
    expect(state?.summarizerFailCount).toBe(0);
    expect(state?.summarizerFireCount).toBe(0);
  }, 20_000);

  test("the documented CURSOR_TRANSCRIPT_PATH env backstop is honoured", async () => {
    const fix = await fixture(
      "cursor-transcript-env",
      JSON.stringify({
        kind: "root_cause",
        body: "The refresh path read the retired key",
      }),
    );
    const transcript = await writeTranscript(fix, CONCLUSION_TURN);

    await runCursorHook(
      "stop",
      payload(fix, "stop", { status: "completed" }),
      { ...fix.env, CURSOR_TRANSCRIPT_PATH: transcript },
    );

    const state = await waitFor(async () => {
      const fresh = await readSessionState(fix.home, HOST_KEY);
      return fresh !== null && fresh.summarizerFireCount > 0 ? fresh : null;
    });
    expect(state?.summarizerFireCount).toBe(1);
    expect(state?.summarizerNoSliceCount).toBe(0);
  }, 40_000);

  test("an unreadable transcript is booked and named, and the turn is still counted", async () => {
    const fix = await fixture("cursor-bad-transcript", "unused");

    await runCursorHook(
      "stop",
      payload(fix, "stop", {
        status: "completed",
        transcript_path: join(fix.home, "does-not-exist.jsonl"),
      }),
      fix.env,
    );
    await Bun.sleep(SETTLE_MS);

    const state = await readSessionState(fix.home, HOST_KEY);
    expect(state?.stopTurnCount).toBe(1);
    expect(state?.summarizerNoSliceCount).toBe(1);
    expect(state?.summarizerFailCount).toBe(0);
  }, 20_000);

  test("ordinary chatter with a transcript fires nothing and books no missing slice", async () => {
    const fix = await fixture("cursor-quiet-turn", "unused");
    const transcript = await writeTranscript(
      fix,
      `${JSON.stringify({ role: "assistant", text: "I will start by reading the file." })}\n`,
    );

    await runCursorHook(
      "stop",
      payload(fix, "stop", { status: "completed", transcript_path: transcript }),
      fix.env,
    );
    await Bun.sleep(SETTLE_MS);

    const state = await readSessionState(fix.home, HOST_KEY);
    expect(state?.stopTurnCount).toBe(1);
    expect(state?.summarizerFireCount).toBe(0);
    expect(state?.summarizerNoSliceCount).toBe(0);
  }, 20_000);
});
