/**
 * Block-4 fixer round: the hostile-identifier and fail-open gaps the
 * adversarial reviews found (§4.2 layer 2, capture half — same real
 * in-process hub as capture-engine.test.ts). Everything here hardens Tier-0
 * capture only; the forward path is Block 3's untouched proof and stays
 * untouched.
 *
 * Two of these pins are ALSO mutation entries in
 * connector-core/scripts/mutation-check.ts — delete the cold-load
 * registration or the dispatch chain's containment catch and this file must
 * go red. That is what keeps them load-bearing (the Block-4 replay pin ran
 * behind a handshake that had already registered the session, so a deleted
 * load branch left it green — the exact defect class mutation-check exists
 * for).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { MAX_SEEN_TARGETS, MAX_TARGETS_PER_INVOCATION } from "@crosscheck/connector-core/constants.ts";
import { getDiagnosis, getPresence } from "@crosscheck/connector-core/http/hub.ts";
import {
  MAX_ACP_SESSION_ID_CHARS,
  acpHostSessionKey,
  safeAcpSessionId,
} from "@crosscheck/connector-core/state/host-session-key.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";

import {
  ACP_TEST_FAULT_CAPTURE_DISPATCH,
  ACP_TEST_FAULT_ENV_VAR,
} from "../src/constants.ts";
import {
  REPO_ID,
  bootCaptureHub,
  createHarness,
  handshake,
  toolCallUpdate,
  wireLine,
} from "./fixtures/capture-harness.ts";
import type { CaptureHub, Harness, HarnessOptions } from "./fixtures/capture-harness.ts";
import { writeRepoFile } from "../../connector-core/test/helpers.ts";

/** Enough distinct paths to overflow the seen-set cap, in whole batches. */
const SEEN_SET_OVERFLOW = MAX_TARGETS_PER_INVOCATION;

/** Wall-clock room for the 500+ target drive against the real hub. */
const SEEN_SET_TEST_TIMEOUT_MS = 30_000;

/** Any character the shaped identifiers must never carry. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Z}]/u;

let hub: CaptureHub;
const cleanups: string[] = [];

beforeAll(async () => {
  hub = await bootCaptureHub("acp-hardening");
});

afterAll(async () => {
  hub.server.stop(true);
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

const harness = (label: string, options: HarnessOptions = {}): Promise<Harness> =>
  createHarness(hub, cleanups, label, options);

/** initialize exchange only — the session must arrive by load/resume. */
const initializeOnly = (h: Harness): void => {
  h.capture.offer(
    "c2a",
    wireLine({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }),
  );
  h.capture.offer(
    "a2c",
    wireLine({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "fake-agent", version: "1.0.0" },
      },
    }),
  );
};

const sessionLoadRequest = (
  method: "session/load" | "session/resume",
  id: number,
  sessionId: string,
  cwd: string,
) =>
  wireLine({
    jsonrpc: "2.0",
    id,
    method,
    params: { sessionId, cwd, mcpServers: [] },
  });

describe("cold load/resume registration — the pin a warm handshake cannot give", () => {
  test("a cold session/load registers at REQUEST time and hub dedup absorbs the replayed history", async () => {
    // Arrange: proxy life 1 registers the session and captures one target,
    // then dies WITHOUT shutdown (a hard kill) — the hub session stays open.
    const first = await harness("cold-load");
    await writeRepoFile(first.repo, "src/limiter.ts", "export const a = 1;\n");
    const sessionId = "sess_cold";
    const hostKey = `acp-fake-agent--${sessionId}`;
    const replayed = {
      sessionUpdate: "tool_call",
      toolCallId: "call_cold",
      kind: "edit",
      status: "completed",
      locations: [{ path: join(first.repo, "src/limiter.ts") }],
    };
    handshake(first, sessionId, first.repo);
    first.capture.offer("a2c", toolCallUpdate(sessionId, replayed));
    await first.capture.settle();
    const before = await getDiagnosis(first.hub, `wc_cc_${hostKey}`);
    if (!before.ok) throw new Error("diagnosis unavailable");

    // Act: proxy life 2 (same home, same repo) sees the session for the
    // FIRST time via session/load; history replays BEFORE the response.
    const second = await harness("cold-load-b", {
      home: first.home,
      repo: first.repo,
    });
    initializeOnly(second);
    second.capture.offer(
      "c2a",
      sessionLoadRequest("session/load", 10, sessionId, second.repo),
    );
    second.capture.offer("a2c", toolCallUpdate(sessionId, replayed));
    second.capture.offer("a2c", wireLine({ jsonrpc: "2.0", id: 10, result: {} }));
    await second.capture.settle();

    // Assert: registered once, same id (no ~r), replay added no hub rows —
    // the natural-key dedup claim, proven on a re-spooled record this time.
    expect(second.capture.counters().sessions).toBe(1);
    const state = await readSessionState(second.home, hostKey);
    expect(state?.crosscheckSessionId).toBe(`cc_${hostKey}`);
    const after = await getDiagnosis(second.hub, `wc_cc_${hostKey}`);
    if (!after.ok) throw new Error("diagnosis unavailable");
    expect(after.data.targets.length).toBe(before.data.targets.length);
  });

  test("a cold session/resume routes exactly like a cold load", async () => {
    // Arrange
    const h = await harness("cold-resume");
    await writeRepoFile(h.repo, "src/limiter.ts", "export const a = 1;\n");
    const sessionId = "sess_cold_resume";
    const hostKey = `acp-fake-agent--${sessionId}`;

    // Act: no session/new ever — resume is this proxy's first sight of it.
    initializeOnly(h);
    h.capture.offer(
      "c2a",
      sessionLoadRequest("session/resume", 11, sessionId, h.repo),
    );
    h.capture.offer(
      "a2c",
      toolCallUpdate(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "call_res",
        kind: "edit",
        status: "completed",
        locations: [{ path: join(h.repo, "src/limiter.ts") }],
      }),
    );
    h.capture.offer("a2c", wireLine({ jsonrpc: "2.0", id: 11, result: {} }));
    await h.capture.settle();

    // Assert
    expect(h.capture.counters().sessions).toBe(1);
    expect(await readSessionState(h.home, hostKey)).not.toBeNull();
    const diagnosis = await getDiagnosis(h.hub, `wc_cc_${hostKey}`);
    if (!diagnosis.ok) throw new Error("diagnosis unavailable");
    expect(
      diagnosis.data.targets.some(
        (target) => target.kind === "file" && target.value === "src/limiter.ts",
      ),
    ).toBe(true);
  });

  test("a load storm on a live session neither re-registers nor resets capture state", async () => {
    // Arrange
    const h = await harness("load-storm");
    const sessionId = "sess_storm";

    // Act: one birth, three loads of the same live session.
    handshake(h, sessionId, h.repo);
    await h.capture.settle();
    for (const id of [20, 21, 22]) {
      h.capture.offer(
        "c2a",
        sessionLoadRequest("session/load", id, sessionId, h.repo),
      );
      h.capture.offer("a2c", wireLine({ jsonrpc: "2.0", id, result: {} }));
    }
    await h.capture.settle();

    // Assert: the register flow ran exactly once — no counter inflation, no
    // re-appended work_context, no seen-set reset (finding: load storm).
    expect(h.capture.counters().sessions).toBe(1);
  });
});

describe("hostile identifiers and unbounded state", () => {
  test(
    "the in-memory seen-set is FIFO-bounded at MAX_SEEN_TARGETS like the persisted copy",
    async () => {
      // Arrange
      const h = await harness("seen-cap");
      const sessionId = "sess_seen";
      const pathFor = (i: number): string => join(h.repo, `synthetic/f${i}.ts`);
      const total = MAX_SEEN_TARGETS + SEEN_SET_OVERFLOW;

      // Act: stream `total` distinct in-repo paths in whole batches.
      handshake(h, sessionId, h.repo);
      for (let start = 0; start < total; start += MAX_TARGETS_PER_INVOCATION) {
        const locations = Array.from(
          { length: MAX_TARGETS_PER_INVOCATION },
          (_, i) => ({ path: pathFor(start + i) }),
        );
        h.capture.offer(
          "a2c",
          toolCallUpdate(sessionId, {
            sessionUpdate: "tool_call",
            toolCallId: `call_${start}`,
            kind: "edit",
            status: "completed",
            locations,
          }),
        );
      }
      await h.capture.settle();
      expect(h.capture.counters().targets).toBe(total);

      // Assert: the OLDEST path fell out of the FIFO window, so it captures
      // again (the bound's documented cost — the hub dedups it anyway)…
      h.capture.offer(
        "a2c",
        toolCallUpdate(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "call_oldest",
          kind: "edit",
          status: "completed",
          locations: [{ path: pathFor(0) }],
        }),
      );
      await h.capture.settle();
      expect(h.capture.counters().targets).toBe(total + 1);

      // …while the NEWEST is still in the window and stays filtered.
      h.capture.offer(
        "a2c",
        toolCallUpdate(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "call_newest",
          kind: "edit",
          status: "completed",
          locations: [{ path: pathFor(total - 1) }],
        }),
      );
      await h.capture.settle();
      expect(h.capture.counters().targets).toBe(total + 1);
    },
    SEEN_SET_TEST_TIMEOUT_MS,
  );

  test("a hostile session id cannot forge log lines or carry unprintables to the hub", async () => {
    // Arrange: a session id built to mint a fake log entry (newline + a
    // forged `capture registered` line), drive the terminal (ESC) and bloat
    // every key (10k chars).
    const h = await harness("hostile-id");
    await writeRepoFile(h.repo, "src/limiter.ts", "export const a = 1;\n");
    const rawId =
      "sess_evil\n2026-08-19T00:00:00.000Z capture registered session=FORGED " +
      `cc=cc_FORGED registered=true\u001b[31m${"x".repeat(10_000)}`;

    // Act: the agent mints the hostile id at session/new; a later tool call
    // arrives under the SAME raw id.
    initializeOnly(h);
    h.capture.offer(
      "c2a",
      wireLine({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: h.repo, mcpServers: [] } }),
    );
    h.capture.offer("a2c", wireLine({ jsonrpc: "2.0", id: 2, result: { sessionId: rawId } }));
    h.capture.offer(
      "a2c",
      toolCallUpdate(rawId, {
        sessionUpdate: "tool_call",
        toolCallId: "call_h",
        kind: "edit",
        status: "completed",
        locations: [{ path: join(h.repo, "src/limiter.ts") }],
      }),
    );
    await h.capture.settle();

    // Assert: registered once, and no log line carries a control character —
    // the forged text cannot stand alone as a line of its own.
    expect(h.capture.counters().sessions).toBe(1);
    for (const line of h.logger.lines) {
      expect(/[\p{Cc}]/u.test(line), line.slice(0, 80)).toBe(false);
    }

    // The overlong id folded to its sha256 form; the hub id is shaped,
    // bounded, and free of unprintables.
    const shaped = safeAcpSessionId(rawId);
    expect(shaped).not.toBeNull();
    expect(shaped).toMatch(/^sha256-[0-9a-f]{64}$/);
    const hostKey = acpHostSessionKey("fake-agent", shaped ?? "");
    const presence = await getPresence(h.hub, REPO_ID);
    if (!presence.ok) throw new Error("presence unavailable");
    const own = presence.data.find(
      (entry) => entry.sessionId === `cc_${hostKey}`,
    );
    expect(own).toBeDefined();
    expect(UNPRINTABLE.test(own?.sessionId ?? "")).toBe(false);
    expect(own?.sessionId.length ?? 0).toBeLessThanOrEqual(
      "cc_acp-fake-agent--".length + MAX_ACP_SESSION_ID_CHARS,
    );

    // The whole session still WORKS — shaped deterministically, the tool
    // call under the same raw id lands in the same session's work context.
    expect(await readSessionState(h.home, hostKey)).not.toBeNull();
    const diagnosis = await getDiagnosis(h.hub, `wc_cc_${hostKey}`);
    if (!diagnosis.ok) throw new Error("diagnosis unavailable");
    expect(
      diagnosis.data.targets.some(
        (target) => target.kind === "file" && target.value === "src/limiter.ts",
      ),
    ).toBe(true);
  });
});

describe("fail-open containment (prime directive 2)", () => {
  test("a capture-side crash is counted and logged, and the chain stays alive", async () => {
    // Arrange: the deterministic fault seam arms ONE dispatch throw — the
    // only reliable way to prove the chain's catch is load-bearing.
    const h = await harness("containment", {
      env: { [ACP_TEST_FAULT_ENV_VAR]: ACP_TEST_FAULT_CAPTURE_DISPATCH },
    });

    // Act: the first parsed line eats the fault…
    h.capture.offer(
      "c2a",
      wireLine({ jsonrpc: "2.0", id: 99, method: "noop/poke", params: {} }),
    );
    await h.capture.settle();

    // Assert: contained — counted, one log line, no throw out of settle.
    expect(h.capture.counters().errors).toBe(1);
    expect(
      h.logger.lines.some((line) => line.startsWith("capture-error")),
    ).toBe(true);

    // …and the chain is NOT poisoned: a full registration still works.
    handshake(h, "sess_alive", h.repo);
    await h.capture.settle();
    expect(h.capture.counters().sessions).toBe(1);
  });
});
