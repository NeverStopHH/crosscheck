/**
 * THE GAP THIS STEP CLOSES, asserted in a file that RUNS ON THE BASE COMMIT.
 *
 * Every other new test here imports a module that did not exist before, so
 * its red is "Cannot find module" — an honest red for a new file and a weak
 * one for a behaviour. This file imports only the capture engine and core
 * session state, both unchanged since long before this step, so it compiles
 * and runs on 77eea1c and FAILS there on the three facts that were true:
 *
 *   1. a substantive session/prompt derived no intent  (intentFireCount 0);
 *   2. a ghost debt opened by set_intent was paid by nothing, ever
 *      (ghostPending stays true across any number of prompts);
 *   3. a turn whose wire carried a verdict beside failing tests fired no
 *      Tier-1 summarizer (summarizerFireCount 0).
 *
 * All three ride the parse COPY. Nothing in this file touches the forward
 * path, and nothing in this step does either — transparency.test.ts is the
 * authority on that and stays untouched.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readSessionState,
  updateSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";

import {
  SHUTDOWN_BUDGET_MS,
  bootCaptureHub,
  createHarness,
  handshake,
  wireLine,
} from "./fixtures/capture-harness.ts";
import type { CaptureHub, Harness } from "./fixtures/capture-harness.ts";

const SESSION = "sess_gap";
const HOST_KEY = `acp-fake-agent--${SESSION}`;
const PROMPT =
  "work out why the refresh call started returning 500 after the key rotation";

/** A verdict beside failing tests: both wings' conjunction, one slice. */
const VERDICT = "Verdict: the retry loop never resets the backoff window.";
const FAILURE = "AssertionError: expected 3 to equal 4 — 2 tests failed";

let hub: CaptureHub;
const cleanups: string[] = [];

beforeAll(async () => {
  hub = await bootCaptureHub("acp-derive-gap");
});

afterAll(async () => {
  hub.server.stop(true);
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

/**
 * A model that reads its stdin and prints one line. Present so that a HEAD
 * run can never reach a real `claude` binary; on the base commit nothing
 * spawns at all and it is simply unused.
 */
const fakeModel = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-acp-gap-model-"));
  cleanups.push(dir);
  const script = join(dir, "fake.ts");
  await writeFile(
    script,
    'await Bun.stdin.text();\nprocess.stdout.write("NONE\\n");\n',
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

const registered = async (label: string): Promise<Harness> => {
  const h = await createHarness(hub, cleanups, label, {
    env: { CROSSCHECK_SUMMARIZER_CMD: await fakeModel() },
  });
  handshake(h, SESSION, h.repo);
  await h.capture.settle();
  return h;
};

const promptLine = (id: number): ReturnType<typeof wireLine> =>
  wireLine({
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: { sessionId: SESSION, prompt: [{ type: "text", text: PROMPT }] },
  });

const promptAnswer = (id: number): ReturnType<typeof wireLine> =>
  wireLine({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });

describe("what the ACP proxy could not infer", () => {
  test("a substantive prompt on the wire derives an intent", async () => {
    // Arrange
    const h = await registered("gap-intent");

    // Act
    h.capture.offer("c2a", promptLine(10));
    await h.capture.settle();

    // Assert
    const state = await readSessionState(h.home, HOST_KEY);
    expect(state?.intentFireCount).toBe(1);
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);
  }, 30_000);

  test("a ghost debt is paid on the next prompt instead of rotting", async () => {
    // Arrange
    const h = await registered("gap-ghost");
    await updateSessionState(h.home, HOST_KEY, (fresh) => ({
      ...fresh,
      ghostPending: true,
    }));

    // Act
    h.capture.offer("c2a", promptLine(20));
    await h.capture.settle();

    // Assert
    const state = await readSessionState(h.home, HOST_KEY);
    expect(state?.ghostPending).toBe(false);
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);
  }, 30_000);

  test("a turn carrying a verdict beside failing tests fires the summarizer", async () => {
    // Arrange
    const h = await registered("gap-summarizer");

    // Act: prompt, the agent's own prose, a failed tool call, then the answer
    h.capture.offer("c2a", promptLine(30));
    h.capture.offer(
      "a2c",
      wireLine({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: SESSION,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: VERDICT },
          },
        },
      }),
    );
    h.capture.offer(
      "a2c",
      wireLine({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: SESSION,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_1",
            status: "failed",
            rawOutput: { stderr: FAILURE },
          },
        },
      }),
    );
    h.capture.offer("a2c", promptAnswer(30));
    await h.capture.settle();

    // Assert
    const state = await readSessionState(h.home, HOST_KEY);
    expect(state?.summarizerFireCount).toBe(1);
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);
  }, 30_000);
});
