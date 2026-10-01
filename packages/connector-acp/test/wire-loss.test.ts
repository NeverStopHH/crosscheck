/**
 * LOSS-13, ACP half (docs/1.0/loss-accounting.md §3 row 18): wire lines the
 * capture engine could not read reach the capture-loss ledger at shutdown.
 *
 * The engine used to count them into two in-memory counters — `ignored`
 * (unparseable, oversized, unclassifiable) and `dropped` (past the pending
 * cap) — that reached one log line at exit and no ledger, so an edit
 * `tool_call` whose diff made its line oversized lost its `locations` while
 * the hub's coverage read complete. They are booked BEFORE the live sessions
 * end, so the end call carries them to the hub; unkeyed, because a line that
 * could not be read cannot say which session, or which repo, it belonged to.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import {
  lossLedgerPath,
  readCaptureLosses,
} from "@crosscheck/connector-core/state/loss-ledger.ts";
import { agentSessions } from "../../server/src/db/schema.ts";

import { ACP_CAPTURE_MAX_PENDING_BYTES, ACP_MAX_PENDING_REQUESTS } from "../src/constants.ts";
import {
  SHUTDOWN_BUDGET_MS,
  bootCaptureHub,
  createHarness,
  handshake,
  wireLine,
} from "./fixtures/capture-harness.ts";
import type { CaptureHub, Harness } from "./fixtures/capture-harness.ts";

let hub: CaptureHub;
const cleanups: string[] = [];

/**
 * Booting the in-process hub (PGlite) took longer than bun's 5 s hook default
 * on a loaded machine (review LOW); the boot is not what this file measures.
 */
const HUB_BOOT_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  hub = await bootCaptureHub("acp-wire-loss");
}, HUB_BOOT_TIMEOUT_MS);

afterAll(async () => {
  hub.server.stop(true);
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

const harness = (label: string): Promise<Harness> => createHarness(hub, cleanups, label);

const OVERSIZED_LINE = {
  kind: "oversized",
  text: "",
  parsedOk: false,
  bytes: 99_999_999,
  atEof: false,
} as const;

const ledgerLines = async (home: string): Promise<readonly Record<string, unknown>[]> => {
  const raw = await Bun.file(lossLedgerPath(home)).text();
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

describe("LOSS-13: wire lines the ACP engine could not read reach the ledger at shutdown", () => {
  test("an engine that skipped an oversized line appends wire_unobserved, unkeyed", async () => {
    // Arrange
    const h = await harness("wire-oversized");
    h.capture.offer("a2c", OVERSIZED_LINE);

    // Act
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);

    // Assert
    const [line] = await ledgerLines(h.home);
    expect(line?.["kind"]).toBe("wire_unobserved");
    expect(line?.["count"]).toBe(1);
    expect(line?.["key"]).toBeNull();
    expect(line?.["detail"]).toBe("unreadable");
  });

  test("a line past the pending cap is the same loss under its own detail", async () => {
    // Arrange: one line larger than the whole queue the engine will hold
    const h = await harness("wire-pending-cap");
    h.capture.offer("a2c", {
      kind: "line",
      text: "x".repeat(ACP_CAPTURE_MAX_PENDING_BYTES + 1),
      parsedOk: true,
      bytes: ACP_CAPTURE_MAX_PENDING_BYTES + 1,
      atEof: false,
    });

    // Act
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);

    // Assert
    const losses = await readCaptureLosses(h.home, "any-repo-key");
    expect(losses.byDetail["wire_unobserved:pending-cap"]).toBe(1);
  });

  test("the live session's end carries the loss to the hub", async () => {
    // Arrange
    const h = await harness("wire-end-carries");
    handshake(h, "sess_wire", h.repo);
    await h.capture.settle();
    h.capture.offer("a2c", OVERSIZED_LINE);

    // Act
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);

    // Assert: the hub's row for the session holds the wire loss
    const row = (await hub.db.select().from(agentSessions)).find(
      (session) => session.id === "cc_acp-fake-agent--sess_wire",
    );
    expect(row?.lossKinds?.wire_unobserved).toBe(1);
  });

  test("review M5: requests the pending map evicted are wire lines whose answer capture never saw", async () => {
    // Arrange: more unanswered requests than the map holds
    const h = await harness("wire-pending-evicted");
    for (let id = 0; id < ACP_MAX_PENDING_REQUESTS + 3; id += 1) {
      h.capture.offer("c2a", wireLine({ jsonrpc: "2.0", id, method: "session/new", params: { cwd: h.repo, mcpServers: [] } }));
    }
    await h.capture.settle();

    // Act
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);

    // Assert
    const losses = await readCaptureLosses(h.home, "any-repo-key");
    expect(losses.byDetail["wire_unobserved:pending-evicted"]).toBe(3);
  });

  test("an engine that read every line books nothing", async () => {
    // Arrange
    const h = await harness("wire-clean");
    h.capture.offer(
      "c2a",
      wireLine({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }),
    );

    // Act
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);

    // Assert
    expect((await readCaptureLosses(h.home, "any-repo-key")).total).toBe(0);
  });
});
