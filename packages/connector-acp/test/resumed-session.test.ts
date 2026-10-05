/**
 * A LOADED ACP SESSION IS CAPTURED AGAIN — the ACP half of the pilot's
 * resumed-session loss (connector-claude/test/resumed-session.test.ts holds
 * the evidence). The proxy ends every live session when its child exits, and
 * a later `session/load` names the same ACP session id, so the next proxy
 * registers the same host key: every life after the third — the old ladder's
 * last rung — was refused by the hub as a late write.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { readDropDetail } from "@crosscheck/connector-core/spool/drops.ts";
// By path, the wire-loss suite's arrangement: this package has no drizzle edge.
import { workContextTargets } from "../../server/src/db/schema.ts";

import {
  SHUTDOWN_BUDGET_MS,
  bootCaptureHub,
  createHarness,
  handshake,
  toolCallUpdate,
  wireLine,
} from "./fixtures/capture-harness.ts";
import type { CaptureHub, Harness } from "./fixtures/capture-harness.ts";
import { writeRepoFile } from "../../connector-core/test/helpers.ts";

/** More lives than the old three-rung ladder could give one session. */
const LIVES = 5;
const SESSION_ID = "sess_resumed";

let hub: CaptureHub;
const cleanups: string[] = [];

beforeAll(async () => {
  hub = await bootCaptureHub("acp-resumed");
});

afterAll(async () => {
  hub.server.stop(true);
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

/** A proxy life that first sees the session through `session/load`. */
const loadSession = (h: Harness, id: number): void => {
  h.capture.offer(
    "c2a",
    wireLine({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }),
  );
  h.capture.offer(
    "a2c",
    wireLine({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: 1, agentInfo: { name: "fake-agent", version: "1.0.0" } },
    }),
  );
  h.capture.offer(
    "c2a",
    wireLine({
      jsonrpc: "2.0",
      id,
      method: "session/load",
      params: { sessionId: SESSION_ID, cwd: h.repo, mcpServers: [] },
    }),
  );
  h.capture.offer("a2c", wireLine({ jsonrpc: "2.0", id, result: {} }));
};

const editIn = async (h: Harness, file: string): Promise<void> => {
  await writeRepoFile(h.repo, file, "export const a = 1;\n");
  h.capture.offer(
    "a2c",
    toolCallUpdate(SESSION_ID, {
      sessionUpdate: "tool_call",
      toolCallId: `call_${file}`,
      kind: "edit",
      status: "completed",
      locations: [{ path: join(h.repo, file) }],
    }),
  );
  await h.capture.settle();
};

describe("an ACP session loaded again after its proxy ended it", () => {
  test(`is captured in every one of ${String(LIVES)} proxy lives, nothing refused`, async () => {
    // Arrange: proxy life 0 births the session
    const first = await createHarness(hub, cleanups, "acp-resumed");
    const expected: string[] = [];

    // Act: every life edits, then its proxy exits and ends the session
    for (let life = 0; life < LIVES; life += 1) {
      const h =
        life === 0
          ? first
          : await createHarness(hub, cleanups, `acp-resumed-${String(life)}`, {
              home: first.home,
              repo: first.repo,
            });
      if (life === 0) {
        handshake(h, SESSION_ID, h.repo);
      } else {
        loadSession(h, 10 + life);
      }
      const file = `src/life-${String(life)}.ts`;
      expected.push(file);
      await editIn(h, file);
      await h.capture.shutdown(SHUTDOWN_BUDGET_MS);
    }

    // Assert
    const rows = await hub.db.select({ value: workContextTargets.value }).from(workContextTargets);
    expect(
      rows.map((row) => row.value).filter((value) => value.startsWith("src/life-")).sort(),
    ).toEqual(expected);
    expect((await readDropDetail(first.home, first.hub.repoKey)).byReason["rejected"] ?? 0).toBe(0);
  });
});
