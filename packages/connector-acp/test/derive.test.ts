/**
 * WHAT AN ACP AGENT NOW INFERS — the three rungs driven through the REAL
 * capture engine, a real repo, a real spool, real detached worker processes
 * and a real (in-process) hub. Only the MODEL BINARY is faked, through
 * CROSSCHECK_SUMMARIZER_CMD — the override every worker already honours.
 *
 * derive-gap.test.ts beside this file proves the three facts that were FALSE
 * before this step, in a file that runs on the base commit. This file proves
 * the things that cannot be stated as a base-commit gap: what the records
 * actually say, what the prompt and the slice are allowed to touch, and what
 * the slice contains at a turn boundary.
 *
 * THE ONE THAT IS NOT BORING IS `agentKind`. The workers stamp a record's
 * producer from the environment and default to `claude-code`; a Gemini-CLI
 * session's derived intent filed under Claude Code is a wrong attribution
 * nobody would ever spot on a hub. Every record assertion below reads the
 * stamp, and it must be `acp:fake-agent` — the kind the engine resolved from
 * this agent's own initialize response.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  intentPromptPathForSlug,
  sessionSlug,
} from "@crosscheck/connector-core/config/paths.ts";
import { readSpoolLines } from "@crosscheck/connector-core/spool/files.ts";
import {
  readSessionState,
  updateSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";

import { ACP_TURN_SLICE_MAX_CHARS } from "../src/constants.ts";
import {
  SHUTDOWN_BUDGET_MS,
  bootCaptureHub,
  createHarness,
  handshake,
  wireLine,
} from "./fixtures/capture-harness.ts";
import type { CaptureHub, Harness } from "./fixtures/capture-harness.ts";

const SESSION = "sess_derive";
const HOST_KEY = `acp-fake-agent--${SESSION}`;
/** What the engine resolves from this agent's initialize response. */
const AGENT_KIND = "acp:fake-agent";

/** A string that exists nowhere else, so "did the prompt leak" is decidable. */
const PROMPT_SENTINEL = "ZQX-ACP-PROMPT-8814";
const PROMPT = `work out why the refresh call 500s after the key rotation ${PROMPT_SENTINEL}`;
const INTENT_SENTENCE = "Find why the refresh call 500s after the key rotation";
const CONCLUSION_SENTENCE = "The retry loop never resets its backoff window";
/**
 * What a summarizer model actually answers: the draft JSON its prompt asks
 * for. `confidence` is deliberately ABOVE the derived cap so every ACP draft
 * asserts the clamp too — a host that could talk a model into a higher
 * confidence would break "derived stays derived" for everyone.
 */
const CONCLUSION_ANSWER = JSON.stringify({
  kind: "observation",
  body: CONCLUSION_SENTENCE,
  confidence: 0.95,
});

/** A conclusion signal (verdict) beside a work anchor (error output). */
const VERDICT = "Verdict: the retry loop never resets the backoff window.";
const FAILURE = "AssertionError: expected 3 to equal 4 — 2 tests failed";

let hub: CaptureHub;
const cleanups: string[] = [];

beforeAll(async () => {
  hub = await bootCaptureHub("acp-derive");
});

afterAll(async () => {
  hub.server.stop(true);
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** A fake model: reads stdin (so the real deadline path runs), answers once. */
const makeFakeModel = async (output: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-acp-derive-model-"));
  cleanups.push(dir);
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

/**
 * A fake model that COPIES ITS STDIN into a file the test can read. The only
 * way to prove the Tier-1 slice reached the model at all — and, since nothing
 * else on this host ever writes the slice down, the only artifact of it that
 * ever exists anywhere.
 */
const makeStdinRecordingModel = async (
  output: string,
): Promise<{ readonly cmd: string; readonly seen: () => Promise<string> }> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-acp-derive-stdin-"));
  cleanups.push(dir);
  const script = join(dir, "fake.ts");
  // ONE FILE PER INVOCATION, and the reason is a real trap this fixture fell
  // into first: the intent worker and the summarizer worker are the SAME
  // faked binary, and the intent worker's stdin is the parked PROMPT. A
  // single recording file made the last spawn win, so a test asserting "the
  // slice reached the model" was really asserting "some text did".
  await writeFile(
    script,
    `const body = await Bun.stdin.text();\n` +
      `await Bun.write(${JSON.stringify(join(dir, "stdin-"))} + String(process.pid) + ".txt", body);\n` +
      `process.stdout.write(${JSON.stringify(output)});\n`,
    "utf8",
  );
  const wrapper = join(dir, "fake.sh");
  await writeFile(
    wrapper,
    `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`,
    "utf8",
  );
  await chmod(wrapper, 0o755);
  return {
    cmd: wrapper,
    /** Every recorded stdin body this model saw, newest run included. */
    seen: async () => {
      const names = (await readdir(dir)).filter(
        (name) => name.startsWith("stdin-") && name.endsWith(".txt"),
      );
      const bodies = await Promise.all(
        names.map(async (name) => await Bun.file(join(dir, name)).text()),
      );
      return bodies.join("\n----\n");
    },
  };
};

const registered = async (
  label: string,
  modelCmd: string,
): Promise<Harness> => {
  const h = await createHarness(hub, cleanups, label, {
    env: { CROSSCHECK_SUMMARIZER_CMD: modelCmd },
  });
  handshake(h, SESSION, h.repo);
  await h.capture.settle();
  return h;
};

const promptLine = (id: number, text = PROMPT): ReturnType<typeof wireLine> =>
  wireLine({
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: { sessionId: SESSION, prompt: [{ type: "text", text }] },
  });

const promptAnswer = (id: number): ReturnType<typeof wireLine> =>
  wireLine({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });

const chunk = (
  text: string,
  kind = "agent_message_chunk",
): ReturnType<typeof wireLine> =>
  wireLine({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: SESSION,
      update: { sessionUpdate: kind, content: { type: "text", text } },
    },
  });

const failedToolCall = (text: string): ReturnType<typeof wireLine> =>
  wireLine({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: SESSION,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "failed",
        rawOutput: { stderr: text },
      },
    },
  });

interface SpoolRecord {
  readonly kind: string;
  readonly producer?: { readonly agentKind?: string };
  readonly body: Record<string, unknown>;
}

const spooled = async (h: Harness): Promise<readonly SpoolRecord[]> =>
  (await readSpoolLines(h.home, h.hub.repoKey)).map(
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

const recordOfKind = async (
  h: Harness,
  kind: string,
): Promise<SpoolRecord | null> =>
  waitFor(async () => {
    const records = await spooled(h);
    return records.find((entry) => entry.kind === kind) ?? null;
  });

const fileExists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Every stdin body the faked model recorded, once one of them carries `needle`. */
const stdinContaining = async (
  model: { readonly seen: () => Promise<string> },
  needle: string,
): Promise<string> =>
  (await waitFor(async () => {
    const bodies = await model.seen();
    return bodies.includes(needle) ? bodies : null;
  })) ?? (await model.seen());

describe("intent × acp: the prompt on the wire derives the session's plan", () => {
  test("the first substantive prompt fires once, and the draft is stamped acp", async () => {
    // Arrange
    const h = await registered("acp-intent", await makeFakeModel(INTENT_SENTENCE));

    // Act
    h.capture.offer("c2a", promptLine(10));
    await h.capture.settle();

    // Assert
    expect((await readSessionState(h.home, HOST_KEY))?.intentFireCount).toBe(1);
    expect(h.capture.counters().intentFires).toBe(1);

    const record = await recordOfKind(h, "work_context");
    expect(record).not.toBeNull();
    const intent = record?.body["intent"] as
      | { summary: string; provenance: string; confidence: number }
      | undefined;
    expect(intent?.summary).toBe(INTENT_SENTENCE);
    expect(intent?.provenance).toBe("derived");
    // THE TRAP: without the engine passing its own kind this reads
    // "claude-code" and a Gemini session's plan is filed under Claude.
    expect(record?.producer?.agentKind).toBe(AGENT_KIND);
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);
  }, 40_000);

  test("a second prompt spends no second fire", async () => {
    // Arrange
    const h = await registered("acp-intent-once", await makeFakeModel(INTENT_SENTENCE));

    // Act
    h.capture.offer("c2a", promptLine(11));
    await h.capture.settle();
    h.capture.offer("c2a", promptLine(12));
    await h.capture.settle();

    // Assert
    expect((await readSessionState(h.home, HOST_KEY))?.intentFireCount).toBe(1);
    expect(h.capture.counters().intentFires).toBe(1);
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);
  }, 40_000);

  test("a throwaway prompt derives nothing at all", async () => {
    // Arrange
    const h = await registered("acp-intent-trivial", await makeFakeModel(INTENT_SENTENCE));

    // Act
    h.capture.offer("c2a", promptLine(13, "thanks!"));
    await h.capture.settle();

    // Assert
    expect((await readSessionState(h.home, HOST_KEY))?.intentFireCount).toBe(0);
    expect(h.capture.counters().intentFires).toBe(0);
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);
  }, 40_000);
});

describe("ghost × acp: the debt is paid on the next prompt", () => {
  test("a debt opened by set_intent is claimed and handed to a worker", async () => {
    // Arrange
    const h = await registered("acp-ghost", await makeFakeModel("NONE"));
    await updateSessionState(h.home, HOST_KEY, (fresh) => ({
      ...fresh,
      ghostPending: true,
    }));

    // Act
    h.capture.offer("c2a", promptLine(20));
    await h.capture.settle();

    // Assert
    expect((await readSessionState(h.home, HOST_KEY))?.ghostPending).toBe(false);
    expect(h.capture.counters().ghostPayments).toBe(1);
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);
  }, 40_000);

  test("a session that owes nothing spawns nothing", async () => {
    // Arrange
    const h = await registered("acp-ghost-none", await makeFakeModel("NONE"));

    // Act
    h.capture.offer("c2a", promptLine(21));
    await h.capture.settle();

    // Assert
    expect(h.capture.counters().ghostPayments).toBe(0);
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);
  }, 40_000);
});

describe("summarizer × acp: the turn slice comes off the wire copy", () => {
  test("a conclusion beside a failure fires, and the draft is stamped acp", async () => {
    // Arrange
    const h = await registered("acp-conclusion", await makeFakeModel(CONCLUSION_ANSWER));

    // Act
    h.capture.offer("c2a", promptLine(30));
    h.capture.offer("a2c", chunk(VERDICT));
    h.capture.offer("a2c", failedToolCall(FAILURE));
    h.capture.offer("a2c", promptAnswer(30));
    await h.capture.settle();

    // Assert
    expect((await readSessionState(h.home, HOST_KEY))?.summarizerFireCount).toBe(1);
    expect(h.capture.counters().summarizerFires).toBe(1);

    const record = await recordOfKind(h, "claim");
    expect(record).not.toBeNull();
    expect(record?.body["body"]).toBe(CONCLUSION_SENTENCE);
    expect(record?.producer?.agentKind).toBe(AGENT_KIND);
    // DERIVED STAYS DERIVED, on this host too: the worker forces these three
    // and clamps the 0.95 the model asked for down to the cap.
    expect(record?.body["provenance"]).toBe("derived");
    expect(record?.body["captureMode"]).toBe("auto");
    expect(record?.body["status"]).toBe("proposed");
    expect(record?.body["confidence"]).toBe(0.5);
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);
  }, 40_000);

  test("the slice reaches the model on STDIN, carrying all three wire sources", async () => {
    // Arrange
    const model = await makeStdinRecordingModel(CONCLUSION_ANSWER);
    const h = await registered("acp-slice-stdin", model.cmd);
    const TERMINAL_TAIL = "2 tests failed, 1 passed";

    // Act — prose, a failed tool call, and a terminal that exited non-zero
    h.capture.offer("c2a", promptLine(31));
    h.capture.offer("a2c", chunk(VERDICT));
    h.capture.offer("a2c", failedToolCall(FAILURE));
    // A terminal is the AGENT asking the CLIENT to run something, so the
    // request rides a2c and its answer rides c2a — the other way round from
    // session/prompt, and the engine's pendingAgent map is what says so.
    h.capture.offer(
      "a2c",
      wireLine({
        jsonrpc: "2.0",
        id: 500,
        method: "terminal/create",
        params: { sessionId: SESSION, command: "bun", args: ["test"] },
      }),
    );
    h.capture.offer("c2a", wireLine({ jsonrpc: "2.0", id: 500, result: { terminalId: "term_1" } }));
    h.capture.offer(
      "a2c",
      wireLine({
        jsonrpc: "2.0",
        id: 501,
        method: "terminal/output",
        params: { sessionId: SESSION, terminalId: "term_1" },
      }),
    );
    h.capture.offer(
      "c2a",
      wireLine({
        jsonrpc: "2.0",
        id: 501,
        result: { output: TERMINAL_TAIL, exitStatus: { exitCode: 1 } },
      }),
    );
    h.capture.offer("a2c", promptAnswer(31));
    await h.capture.settle();

    // Assert — the slice the model actually saw
    const slice = await stdinContaining(model, VERDICT);
    expect(slice).toContain(VERDICT);
    expect(slice).toContain(FAILURE);
    expect(slice).toContain(TERMINAL_TAIL);
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);
  }, 40_000);

  test("the agent's private reasoning is not slice material", async () => {
    // Arrange
    const model = await makeStdinRecordingModel(CONCLUSION_ANSWER);
    const h = await registered("acp-slice-thoughts", model.cmd);
    const THOUGHT = "SECRET-THOUGHT-4471 maybe the user is wrong about this";

    // Act
    h.capture.offer("c2a", promptLine(32));
    h.capture.offer("a2c", chunk(THOUGHT, "agent_thought_chunk"));
    h.capture.offer("a2c", chunk(VERDICT));
    h.capture.offer("a2c", failedToolCall(FAILURE));
    h.capture.offer("a2c", promptAnswer(32));
    await h.capture.settle();

    // Assert — across EVERY body this model was handed, including the
    // intent worker's parked prompt: the thought is in none of them.
    const bodies = await stdinContaining(model, VERDICT);
    expect(bodies).toContain(VERDICT);
    expect(bodies).not.toContain("SECRET-THOUGHT-4471");
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);
  }, 40_000);

  test("the slice is a TURN: last turn's conclusion cannot fire this one", async () => {
    // Arrange
    const h = await registered("acp-slice-turn", await makeFakeModel(CONCLUSION_ANSWER));

    // Act — turn 1 carries the whole conjunction; turns 2 and 3 carry nothing.
    //
    // THREE turns, not two, and the reason is worth stating: the gate
    // debounces for SUMMARIZER_DEBOUNCE_TURNS (2), so a second turn is
    // refused on the BUDGET whatever the slice holds — a two-turn version of
    // this test passes even with the reset deleted, which is how it was
    // written first and what the mutation proof caught. Turn 3 is the first
    // one where only the slice can decide.
    h.capture.offer("c2a", promptLine(33));
    h.capture.offer("a2c", chunk(VERDICT));
    h.capture.offer("a2c", failedToolCall(FAILURE));
    h.capture.offer("a2c", promptAnswer(33));
    await h.capture.settle();
    const afterFirst = h.capture.counters().summarizerFires;

    for (const id of [34, 35]) {
      h.capture.offer("c2a", promptLine(id));
      h.capture.offer("a2c", promptAnswer(id));
      await h.capture.settle();
    }

    // Assert — a conversation-tail slice would fire again on turn 3
    expect(afterFirst).toBe(1);
    expect(h.capture.counters().summarizerFires).toBe(1);
    expect((await readSessionState(h.home, HOST_KEY))?.stopTurnCount).toBe(3);
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);
  }, 60_000);

  test("a chatty agent past the byte cap drops slice text and counts it", async () => {
    // Arrange
    const h = await registered("acp-slice-cap", await makeFakeModel("NONE"));
    const FLOOD_CHUNKS = 8;
    const chunkChars = Math.ceil(ACP_TURN_SLICE_MAX_CHARS / 2);

    // Act
    h.capture.offer("c2a", promptLine(35));
    for (let index = 0; index < FLOOD_CHUNKS; index += 1) {
      h.capture.offer("a2c", chunk("x".repeat(chunkChars)));
    }
    h.capture.offer("a2c", promptAnswer(35));
    await h.capture.settle();

    // Assert — memory bounded, the refusal counted rather than silent
    expect(h.capture.counters().sliceDropped).toBeGreaterThan(0);
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);
  }, 40_000);
});

describe("privacy: what the two new texts are allowed to touch", () => {
  test("the prompt reaches one 0600 file the worker unlinks, and nothing else", async () => {
    // Arrange
    const h = await registered("acp-privacy", await makeFakeModel(INTENT_SENTENCE));
    const promptFile = intentPromptPathForSlug(h.home, sessionSlug(HOST_KEY));

    // Act
    h.capture.offer("c2a", promptLine(40));
    await h.capture.settle();
    await recordOfKind(h, "work_context");
    await Bun.sleep(SETTLE_MS);

    // Assert — not on the spool, not in the log, and the parked file is gone
    const spool = (await readSpoolLines(h.home, h.hub.repoKey)).join("\n");
    expect(spool).not.toContain(PROMPT_SENTINEL);
    expect(h.logger.lines.join("\n")).not.toContain(PROMPT_SENTINEL);
    const state = await readSessionState(h.home, HOST_KEY);
    expect(JSON.stringify(state)).not.toContain(PROMPT_SENTINEL);
    expect(await fileExists(promptFile)).toBe(false);
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);
  }, 40_000);

  test("the turn slice becomes no file at all under the crosscheck home", async () => {
    // Arrange
    const model = await makeStdinRecordingModel(CONCLUSION_ANSWER);
    const h = await registered("acp-privacy-slice", model.cmd);

    // Act
    h.capture.offer("c2a", promptLine(41));
    h.capture.offer("a2c", chunk(VERDICT));
    h.capture.offer("a2c", failedToolCall(FAILURE));
    h.capture.offer("a2c", promptAnswer(41));
    await h.capture.settle();
    const bodies = await stdinContaining(model, VERDICT);
    await Bun.sleep(SETTLE_MS);

    // Assert — the slice reached the model, and exists nowhere under the home
    expect(bodies).toContain(VERDICT);
    const names = await readdir(h.home, { recursive: true });
    const onDisk = await Promise.all(
      names.map(async (name) => {
        const path = join(h.home, name);
        try {
          return (await stat(path)).isFile() ? await Bun.file(path).text() : "";
        } catch {
          return "";
        }
      }),
    );
    // The DRAFT legitimately carries the model's ANSWER; the raw slice text
    // (the agent's own prose, verbatim) must be nowhere on this disk.
    expect(onDisk.join("\n")).not.toContain(VERDICT);
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);
  }, 40_000);
});
