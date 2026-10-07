/**
 * THE STATUS THE HUB LAST ACKNOWLEDGED (spool/work-context-ack.ts, review-2
 * round 8, L7), pinned where the round-8 review's own mutations survived every
 * guard (review-2 round 9, M6): a duplicate is an envelope the hub held
 * before, not the status it holds now, and an acknowledgement of another work
 * context says nothing about this one's.
 */
import { describe, expect, test } from "bun:test";

import { sessionSlug } from "../src/config/paths.ts";
import { ackedIn, isHubBehindState, noteWorkContextAcked } from "../src/spool/work-context-ack.ts";
import { deriveSessionState, readSessionState, writeSessionState } from "../src/state/session-state.ts";
import type { SessionState } from "../src/state/session-state.ts";
import { makeHome } from "./helpers.ts";

const HOST = "ack-conv";
const OTHER = "wc_cc_another-conv";

const state = (overrides: Partial<SessionState> = {}): SessionState => ({
  ...deriveSessionState({
    hostSessionKey: HOST,
    repoId: "github.com/acme/api",
    repoRoot: "/repos/api",
    hubUrl: "http://127.0.0.1:9",
    developerId: "dev_self",
    startedAt: "2026-10-07T10:00:00.000Z",
  }),
  ...overrides,
});

const workContext = (id: string, status: string): Record<string, unknown> => ({
  kind: "work_context",
  body: { id, status },
});

describe("what the hub acknowledged of a work context", () => {
  test("is what it accepted, never what it answered duplicate", () => {
    // Arrange
    const own = state().workContextId;
    const records = [workContext(own, "done"), workContext(own, "blocked")];

    // Act
    const acked = ackedIn(records, [
      { index: 0, status: "accepted" },
      { index: 1, status: "duplicate" },
    ]);

    // Assert
    expect(acked).toEqual([{ id: own, status: "done" }]);
  });

  test("is written down only for the state's own work context", async () => {
    // Arrange: a state whose hub has acknowledged nothing yet
    const home = await makeHome("ack-own-only");
    const written = state({ workContextStatus: "done" });
    await writeSessionState(home, written);

    // Act: a flush hears another work context accepted
    await noteWorkContextAcked(home, sessionSlug(HOST), written.crosscheckSessionId, [{ id: OTHER, status: "done" }]);

    // Assert
    expect((await readSessionState(home, HOST))?.workContextAcked).toBeNull();
  });

  test("of another work context never puts the hub behind the state", () => {
    // Arrange: the state's status, and an acknowledgement that is not of its work context
    const held = state({ workContextStatus: "done", workContextAcked: { id: OTHER, status: "blocked" } });

    // Act
    const isBehind = isHubBehindState(held);

    // Assert
    expect(isBehind).toBe(false);
  });
});
