/**
 * WHAT THE DERIVE RUNGS COST THE PROXY — measured on every run and printed,
 * never asserted once and trusted.
 *
 * THE TWO NUMBERS THAT MATTER, AND WHY THEY ARE NOT THE SAME NUMBER.
 *
 * 1. FORWARDING IS NOT MEASURED HERE, because nothing here is on it. The
 *    capture engine receives a COPY through `offer()`, which returns
 *    immediately and enqueues; every await below happens on that queue, off
 *    the wire. transparency.test.ts and inject-e2e.test.ts own the forward
 *    path and stay the authority — this file would be the wrong place to
 *    claim anything about it.
 *
 * 2. WHAT IS MEASURED IS THE DISPATCH COST OF ONE LINE, because that is what
 *    the derive rungs actually added and what the backpressure contract
 *    spends: while a session/prompt dispatch is in flight, later lines sit in
 *    the bounded pending buffer, and past ACP_CAPTURE_MAX_PENDING_BYTES
 *    CAPTURE lines are dropped and counted (forwarding still untouched). So a
 *    slow dispatch does not slow the agent — it costs capture accuracy, and
 *    that is the thing worth watching.
 *
 * THE BOUND is ACP_CAPTURE_FLUSH_BUDGET_MS (1000 ms), the budget this
 * connector already grants one flush of capture work. A single dispatch that
 * approached it would be pathological; the point of printing every sample is
 * that a slow disk shows up as a number here before it shows up as dropped
 * capture in the field.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { updateSessionState } from "@crosscheck/connector-core/state/session-state.ts";

import { ACP_CAPTURE_FLUSH_BUDGET_MS } from "../src/constants.ts";
import {
  SHUTDOWN_BUDGET_MS,
  bootCaptureHub,
  createHarness,
  handshake,
  wireLine,
} from "./fixtures/capture-harness.ts";
import type { CaptureHub, Harness } from "./fixtures/capture-harness.ts";

const SESSION = "sess_budget";
const HOST_KEY = `acp-fake-agent--${SESSION}`;
const PROMPT =
  "work out why the refresh call started returning 500 after the key rotation";
const VERDICT = "Verdict: the retry loop never resets the backoff window.";
const FAILURE = "AssertionError: expected 3 to equal 4 — 2 tests failed";
const SAMPLES = 5;

let hub: CaptureHub;
const cleanups: string[] = [];

beforeAll(async () => {
  hub = await bootCaptureHub("acp-derive-budget");
});

afterAll(async () => {
  hub.server.stop(true);
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** A model that answers instantly: this measures OUR cost, not a model's. */
const fakeModel = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-acp-budget-model-"));
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

/** One line offered and fully dispatched — the queue cost of that line. */
const dispatchMs = async (
  h: Harness,
  offer: () => void,
): Promise<number> => {
  const started = Bun.nanoseconds();
  offer();
  await h.capture.settle();
  return (Bun.nanoseconds() - started) / 1_000_000;
};

const report = (label: string, samples: readonly number[]): void => {
  const worst = Math.max(...samples);
  // eslint-disable-next-line no-console
  console.log(
    `[acp-derive-budget] ${label}: ${samples
      .map((value) => value.toFixed(0))
      .join(",")} ms — worst ${worst.toFixed(0)}, budget ${String(
      ACP_CAPTURE_FLUSH_BUDGET_MS,
    )}`,
  );
  expect(worst).toBeLessThan(ACP_CAPTURE_FLUSH_BUDGET_MS);
};

describe("what one derive-carrying dispatch costs the capture queue", () => {
  test("session/prompt, FIRST (intent fires: state read, lock write, 0600 file, spawn)", async () => {
    // Arrange
    const h = await registered("budget-first");

    // Act
    const first = await dispatchMs(h, () => {
      h.capture.offer("c2a", promptLine(100));
    });

    // Assert — the number is worthless unless the work really happened
    expect(h.capture.counters().intentFires).toBe(1);
    report("session/prompt first (fires)", [first]);
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);
  }, 40_000);

  test("session/prompt, STEADY (already fired: one state read and out)", async () => {
    // Arrange
    const h = await registered("budget-steady");
    h.capture.offer("c2a", promptLine(200));
    await h.capture.settle();

    // Act
    const samples: number[] = [];
    for (let index = 0; index < SAMPLES; index += 1) {
      samples.push(
        await dispatchMs(h, () => {
          h.capture.offer("c2a", promptLine(201 + index));
        }),
      );
    }

    // Assert — still exactly one fire: this is the every-later-prompt cost
    expect(h.capture.counters().intentFires).toBe(1);
    report("session/prompt steady", samples);
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);
  }, 40_000);

  test("session/prompt with a ghost debt owed (claim under the lock, spawn)", async () => {
    // Arrange
    const h = await registered("budget-ghost");
    h.capture.offer("c2a", promptLine(300));
    await h.capture.settle();
    await updateSessionState(h.home, HOST_KEY, (fresh) => ({
      ...fresh,
      ghostPending: true,
    }));

    // Act
    const paid = await dispatchMs(h, () => {
      h.capture.offer("c2a", promptLine(301));
    });

    // Assert
    expect(h.capture.counters().ghostPayments).toBe(1);
    report("session/prompt ghost debt paid", [paid]);
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);
  }, 40_000);

  test("session/prompt RESPONSE (the Tier-1 gate: turn booked, fire, stdin spawn)", async () => {
    // Arrange
    const h = await registered("budget-turn");

    // Act
    const samples: number[] = [];
    for (let index = 0; index < SAMPLES; index += 1) {
      const id = 400 + index;
      h.capture.offer("c2a", promptLine(id));
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
              toolCallId: `c${String(index)}`,
              status: "failed",
              rawOutput: { stderr: FAILURE },
            },
          },
        }),
      );
      await h.capture.settle();
      samples.push(
        await dispatchMs(h, () => {
          h.capture.offer(
            "a2c",
            wireLine({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }),
          );
        }),
      );
    }

    // Assert — at least one turn really fired the gate (the per-session cap
    // stops the rest, which is exactly the steady state worth measuring too)
    expect(h.capture.counters().summarizerFires).toBeGreaterThan(0);
    report("session/prompt response (tier-1 gate)", samples);
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);
  }, 60_000);

  test("session/update chunk (slice append only — the hot line)", async () => {
    // Arrange
    const h = await registered("budget-chunk");
    h.capture.offer("c2a", promptLine(500));
    await h.capture.settle();

    // Act
    const samples: number[] = [];
    for (let index = 0; index < SAMPLES; index += 1) {
      samples.push(
        await dispatchMs(h, () => {
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
        }),
      );
    }

    // Assert — the chunks really reached the slice
    expect(h.capture.counters().sliceDropped).toBe(0);
    report("session/update chunk", samples);
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);
  }, 40_000);
});
