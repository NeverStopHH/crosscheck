/**
 * WHERE THE ACP ENGINE POSITIONS AN EDIT — pinned as it is, because the
 * manifest said otherwise.
 *
 * `event_seq`'s sentence said the engine "positions an edit only from the
 * tool_call UPDATE that reports it, never from the pending row that announces
 * it". It does the opposite: the first wire row that names a file — usually the
 * `tool_call` that announces the edit, while the tool is still pending — is
 * where the target is captured and its position taken, BEFORE the edit exists.
 *
 * So that position is not the upper bound spec 01 gives `observed` ("no later
 * than that point"): an intent published between the announcement and the edit
 * holds a HIGHER number than the edit that followed it. What keeps the hub
 * from answering wrongly is that it stores the row `observed` and refuses every
 * happens-before question against it, in both directions. This file pins both
 * halves, and the sentence now says what the engine does. Moving the position
 * to the row that REPORTS the edit is an engine change of its own: it moves
 * every capture on this host from the announcement to the completion.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { causalComparisonOf, readSessionCausalOrder, sessionEvents } from "@crosscheck/server";
import type { OrderedEvent } from "@crosscheck/server";
import { allocateSeq } from "@crosscheck/connector-core/state/session-state.ts";

import { ACP_CAPABILITY_MANIFEST } from "../src/capabilities.ts";
import {
  bootCaptureHub,
  createHarness,
  handshake,
  toolCallUpdate,
} from "./fixtures/capture-harness.ts";
import type { CaptureHub } from "./fixtures/capture-harness.ts";
import { writeRepoFile } from "../../connector-core/test/helpers.ts";

let hub: CaptureHub;
const cleanups: string[] = [];

beforeAll(async () => {
  hub = await bootCaptureHub("acp-announce");
});

afterAll(async () => {
  hub.server.stop(true);
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("an ACP edit's position", () => {
  test("is taken on the row that announces the edit, and the hub refuses to order it", async () => {
    // Arrange
    const h = await createHarness(hub, cleanups, "announce");
    const sessionId = "sess_announce";
    const hostKey = `acp-fake-agent--${sessionId}`;
    const crosscheckSessionId = `cc_${hostKey}`;
    const file = join(h.repo, "src/limiter.ts");
    await writeRepoFile(h.repo, "src/limiter.ts", "export const a = 1;\n");
    handshake(h, sessionId, h.repo);
    await h.capture.settle();

    // Act: the agent announces the edit; an intent is published while the
    // tool is still pending; only then does the edit happen and get reported.
    h.capture.offer(
      "a2c",
      toolCallUpdate(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "Edit limiter",
        kind: "edit",
        status: "pending",
        locations: [{ path: file }],
      }),
    );
    await h.capture.settle();
    const intent = await allocateSeq(h.home, hostKey, 1);
    await writeRepoFile(h.repo, "src/limiter.ts", "export const a = 2;\n");
    h.capture.offer(
      "a2c",
      toolCallUpdate(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        locations: [{ path: file }],
      }),
    );
    await h.capture.settle();

    // Assert: the edit's row sits BELOW an intent written before the edit —
    // so it bounds nothing — and the hub stores it `observed`...
    const rows = (await hub.db.select().from(sessionEvents)).filter(
      (row) => row.sessionId === crosscheckSessionId,
    );
    const edit = rows.find((row) => row.kind === "file.modified");
    if (edit === undefined || intent === null) {
      throw new Error("the edit or the intent was not positioned at all");
    }
    expect(edit.seqN).not.toBeNull();
    expect(edit.seqN!).toBeLessThan(intent.from);
    expect(edit.seqKind).toBe("observed");
    // ...and refuses the question, asked of the rows exactly as stored.
    const asStored: OrderedEvent = {
      sessionId: edit.sessionId,
      seqEpoch: edit.seqEpoch,
      seqN: edit.seqN,
      seqAfter: edit.seqAfter,
      seqKind: edit.seqKind,
      seqReason: edit.seqReason,
      observedAt: edit.observedAt,
    };
    const intentRow: OrderedEvent = {
      sessionId: crosscheckSessionId,
      seqEpoch: intent.epoch,
      seqN: intent.from,
      seqAfter: null,
      seqKind: "emitted",
      seqReason: "sequenced",
      observedAt: new Date(),
    };
    const order = await readSessionCausalOrder(hub.db, crosscheckSessionId);
    expect(causalComparisonOf(order, intentRow, asStored)).toEqual({
      outcome: "indeterminate",
      reason: "upper_bound_only",
    });
    expect(causalComparisonOf(order, asStored, intentRow)).toEqual({
      outcome: "indeterminate",
      reason: "upper_bound_only",
    });
    // The manifest says what the engine does, and no longer that the
    // position is an upper bound.
    const sentence =
      ACP_CAPABILITY_MANIFEST.capabilities.find(
        (capability) => capability.name === "event_seq",
      )?.sentence ?? "";
    expect(sentence).toContain("the tool_call row that announces it");
    expect(sentence).not.toContain("never from the pending row");
    expect(sentence).not.toContain("an edit's position is an upper bound");
  });
});
