/**
 * THE STATUS THE HUB LAST ACKNOWLEDGED (spool/work-context-ack.ts, review-2
 * round 8, L7), pinned where the round-8 review's own mutations survived every
 * guard (review-2 round 9, M6): a duplicate is an envelope the hub held
 * before, not the status it holds now, and an acknowledgement of another work
 * context says nothing about this one's.
 */
import { describe, expect, test } from "bun:test";

import { sessionSlug } from "../src/config/paths.ts";
import { ackedIn, isHubBehindState, lastWorkContextRecords, noteWorkContextAcked } from "../src/spool/work-context-ack.ts";
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

describe("an acknowledgement a set_intent post left uncertain (L7, an unanswered post)", () => {
  test("puts the hub behind the state even on the same status", () => {
    // Arrange: blocked acknowledged; a later post went unanswered, and the state is on blocked again
    const own = state().workContextId;
    const held = state({ workContextStatus: "blocked", workContextAcked: { id: own, status: "blocked", uncertain: true } });

    // Act
    const isBehind = isHubBehindState(held);

    // Assert: SessionEnd sends the work context once more
    expect(isBehind).toBe(true);
  });

  test("is settled by the next acceptance of the same status", async () => {
    // Arrange
    const home = await makeHome("ack-uncertain");
    const own = state().workContextId;
    const written = state({ workContextStatus: "blocked", workContextAcked: { id: own, status: "blocked", uncertain: true } });
    await writeSessionState(home, written);

    // Act: a flush hears the work context accepted at blocked
    await noteWorkContextAcked(home, sessionSlug(HOST), written.crosscheckSessionId, [{ id: own, status: "blocked" }]);

    // Assert
    const after = await readSessionState(home, HOST);
    expect(after?.workContextAcked).toEqual({ id: own, status: "blocked" });
    expect(after === null ? null : isHubBehindState(after)).toBe(false);
  });
});

describe("the life's last word (SessionEnd's, and session-reap's for a host that died)", () => {
  test("covers each topic the hub is behind on, with the topic's own status", () => {
    // Arrange: the session's own context in step, one topic acknowledged at implementing and moved to testing
    const base = state({ agentKind: "claude-code", workContextTitle: "main @ api", workContextStatus: "implementing" });
    const topic = {
      key: "0a1b2c3d4e5f.1",
      sessionId: base.crosscheckSessionId,
      workContextId: `${base.workContextId}~t0a1b2c3d4e5f.1`,
      branch: "feat/x",
      branches: ["feat/x"],
      head: null,
      title: "feat/x @ api",
      status: "testing",
      baseCommit: null,
      root: "/repos/api-x",
      registeredAt: "2026-10-07T10:00:00.000Z",
      lastTouchedAt: "2026-10-07T10:00:00.000Z",
      ackedStatus: "implementing",
    };
    const held = {
      ...base,
      workContextAcked: { id: base.workContextId, status: "implementing" },
      topicContexts: [topic],
    };

    // Act
    const records = lastWorkContextRecords(held, new Date("2026-10-07T11:00:00.000Z"));

    // Assert: only the topic, as the topic says
    const bodies = records.map((record) => record.body as { id?: string; status?: string; branch?: string });
    expect(bodies.map((body) => [body.id, body.status, body.branch])).toEqual([
      [topic.workContextId, "testing", "feat/x"],
    ]);
  });
});
