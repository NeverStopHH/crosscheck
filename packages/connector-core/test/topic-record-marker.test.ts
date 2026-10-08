/**
 * THE MARKER A TOPIC'S RECORD CARRIES (topic review H4).
 *
 * A topic's title is always the connector's own `<branch> @ <repo>` — on a
 * `local:` repo the bare branch (flows/topic-contexts.ts) — so every record of
 * a topic says `titleSource: "fallback"`, and the hub withholds it from
 * colleagues of a developer who opted out of presence. Never the session's
 * marker: a session titled by its host carries `host`, and that marker on a
 * topic would keep the topic's branch from being withheld. Four senders
 * write a topic's record — its opening (and a rename's retitle), SessionEnd's
 * last word, the flush-time rewrite of a spooled copy, set_intent — and each
 * is pinned here, beside the session's own records, which keep their own
 * marker: SessionEnd's, the flush-time rewrite's, and a heal's for the next
 * life.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { PROTOCOL_VERSION } from "@crosscheck/schema";

import { plannedTopicRecords, topicLifeOf } from "../src/flows/topic-contexts.ts";
import { writeIntent } from "../src/mcp/tools/intent-write.ts";
import type { TitledWorkContext } from "../src/mcp/tools/intent-write.ts";
import { owedRecordNow, withLifeState } from "../src/spool/owed-work-context.ts";
import { lastWorkContextRecords } from "../src/spool/work-context-ack.ts";
import { deriveSessionState, writeSessionState } from "../src/state/session-state.ts";
import type { SessionState, TopicContext } from "../src/state/session-state.ts";
import { sessionSlug } from "../src/config/paths.ts";
import { makeHome } from "./helpers.ts";

const HOST = "topic-marker-conv";
const NOW = new Date("2026-10-08T10:00:00.000Z");
const BASE = "a".repeat(40);
const HOST_TITLE = "Fix the 500 on POST /login";
const cleanups: string[] = [];

afterAll(async () => {
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

/** A life titled by its HOST — the marker no topic of it may borrow. */
const hostTitled = (overrides: Partial<SessionState> = {}): SessionState => ({
  ...deriveSessionState({
    hostSessionKey: HOST,
    repoId: "github.com/acme/api",
    repoRoot: "/repos/api",
    hubUrl: "http://127.0.0.1:9",
    developerId: "dev_self",
    startedAt: "2026-10-08T09:00:00.000Z",
  }),
  agentKind: "claude-code",
  workContextTitle: HOST_TITLE,
  workContextTitleSource: "host",
  workContextStatus: "implementing",
  ...overrides,
});

const topicOf = (state: SessionState, overrides: Partial<TopicContext> = {}): TopicContext => ({
  key: "0a1b2c3d4e5f.1",
  sessionId: state.crosscheckSessionId,
  workContextId: `${state.workContextId}~t0a1b2c3d4e5f.1`,
  branch: "feat/topic-a",
  branches: ["feat/topic-a"],
  head: BASE,
  title: "feat/topic-a @ api",
  status: "implementing",
  baseCommit: BASE,
  root: "/repos/api-wt1",
  registeredAt: NOW.toISOString(),
  lastTouchedAt: NOW.toISOString(),
  ackedStatus: null,
  ...overrides,
});

const bodyOf = (record: unknown): Record<string, unknown> =>
  ((record as { body?: Record<string, unknown> } | undefined)?.body ?? {});

const producerOf = (state: SessionState) => ({
  developerId: "dev_self",
  agentKind: "claude-code",
  sessionId: state.crosscheckSessionId,
});

describe("a topic's opening record", () => {
  test("says its title is the connector's own, though the session's says host", () => {
    // Arrange
    const state = hostTitled();
    const topic = topicOf(state);

    // Act
    const [record] = plannedTopicRecords({ opened: [topic], relabeled: [] }, topicLifeOf(state), producerOf(state), NOW);

    // Assert
    expect(bodyOf(record)).toMatchObject({ id: topic.workContextId, title: "feat/topic-a @ api", titleSource: "fallback" });
  });

  test("a rename's retitle says it too", () => {
    // Arrange: the topic is known to the life, and the rules renamed its branch
    const topic = topicOf(hostTitled());
    const state = hostTitled({ topicContexts: [topic] });
    const relabel = { id: topic.key, label: "feat/topic-a-renamed", head: BASE, title: "feat/topic-a-renamed @ api" };

    // Act
    const [record] = plannedTopicRecords({ opened: [], relabeled: [relabel] }, topicLifeOf(state), producerOf(state), NOW);

    // Assert
    expect(bodyOf(record)).toMatchObject({ title: "feat/topic-a-renamed @ api", titleSource: "fallback" });
  });
});

describe("SessionEnd's last word", () => {
  test("sends each topic as the connector's own, and the session's context with its own marker", () => {
    // Arrange: the hub is behind the state on both contexts
    const topic = topicOf(hostTitled(), { status: "done", ackedStatus: "implementing" });
    const state = hostTitled({
      workContextStatus: "done",
      workContextAcked: { id: hostTitled().workContextId, status: "implementing" },
      topicContexts: [topic],
    });

    // Act
    const records = lastWorkContextRecords(state, NOW);

    // Assert
    const byId = new Map(records.map((record) => [bodyOf(record)["id"], bodyOf(record)]));
    expect(byId.get(state.workContextId)).toMatchObject({ title: HOST_TITLE, titleSource: "host" });
    expect(byId.get(topic.workContextId)).toMatchObject({ title: topic.title, titleSource: "fallback" });
  });
});

describe("a spooled copy rewritten at flush", () => {
  test("of a topic says fallback, though the copy was spooled without a marker", () => {
    // Arrange: a copy an earlier build spooled, and the life's state now
    const topic = topicOf(hostTitled(), { status: "testing" });
    const state = hostTitled({ topicContexts: [topic] });
    const spooled = { kind: "work_context", body: { id: topic.workContextId, sessionId: state.crosscheckSessionId, title: topic.title, status: "implementing" } };

    // Act
    const sent = withLifeState(spooled, state);

    // Assert
    expect(bodyOf(sent)).toMatchObject({ title: topic.title, status: "testing", titleSource: "fallback" });
  });

  test("of the session's own context goes with the marker of the title it now carries", () => {
    // Arrange: spooled under the host title; the state's title is now the connector's fallback
    const state = hostTitled({ workContextTitle: "feat/start @ api", workContextTitleSource: "fallback" });
    const spooled = { kind: "work_context", body: { id: state.workContextId, sessionId: state.crosscheckSessionId, title: HOST_TITLE, titleSource: "host", status: "implementing" } };

    // Act
    const sent = withLifeState(spooled, state);

    // Assert
    expect(bodyOf(sent)).toMatchObject({ title: "feat/start @ api", titleSource: "fallback" });
  });

  test("of the session's own context drops a marker nobody vouches for under a new title", () => {
    // Arrange: a state from before the marker, whose title moved since the copy was spooled
    const state = hostTitled({ workContextTitle: "feat/start @ api", workContextTitleSource: null });
    const spooled = { kind: "work_context", body: { id: state.workContextId, sessionId: state.crosscheckSessionId, title: HOST_TITLE, titleSource: "host", status: "implementing" } };

    // Act
    const sent = withLifeState(spooled, state);

    // Assert: the hub judges the new title by its shape, never as the host's
    expect(bodyOf(sent)).toMatchObject({ title: "feat/start @ api" });
    expect(bodyOf(sent)).not.toHaveProperty("titleSource");
  });
});

describe("a heal's owed work context", () => {
  test("goes with the marker of the title the life's state holds when it is sent", async () => {
    // Arrange: the heal owed the next life's context; the state now names that life, host-titled
    const home = await makeHome("topic-marker-owed");
    cleanups.push(home);
    const state = hostTitled();
    await writeSessionState(home, state);
    const owed = {
      sessionId: state.crosscheckSessionId,
      record: {
        kind: "work_context",
        producer: producerOf(state),
        body: { id: state.workContextId, sessionId: state.crosscheckSessionId, title: "feat/start @ api", titleSource: "fallback", status: "analyzing" },
      },
    };

    // Act
    const sent = await owedRecordNow(home, "topic-marker", sessionSlug(HOST), owed as never, NOW);

    // Assert
    expect(bodyOf(sent)).toMatchObject({ title: HOST_TITLE, titleSource: "host" });
  });
});

describe("set_intent on a topic", () => {
  const posted: Record<string, unknown>[] = [];
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as { records?: Record<string, unknown>[] };
      posted.push(...(body.records ?? []));
      return Response.json({ ok: true, data: { accepted: 1, duplicates: 0, ignored: 0, rejected: 0, results: [{ index: 0, status: "accepted" }] } });
    },
  });
  afterAll(() => {
    gateway.stop(true);
  });

  test("posts the topic's title as the connector's own, never the session's host marker", async () => {
    // Arrange
    const home = await makeHome("topic-marker-intent");
    cleanups.push(home);
    const state = hostTitled();
    const topic = topicOf(state);
    const url = `http://127.0.0.1:${String(gateway.port)}`;
    const own: TitledWorkContext = {
      hostSessionKey: HOST,
      crosscheckSessionId: state.crosscheckSessionId,
      workContextId: topic.workContextId,
      developerId: "dev_self",
      workContextTitle: topic.title,
      workContextTitleSource: "host",
      workContextStatus: topic.status,
      startedAt: state.startedAt,
      sessionAmbiguous: true,
      topicKey: topic.key,
      branch: topic.branch,
      baseCommit: topic.baseCommit,
    };

    // Act
    const outcome = await writeIntent(
      {
        home,
        repoKey: "topic-marker",
        hub: { hubUrl: url, apiKey: "test-key", timeoutMs: 2000, home, repoKey: "topic-marker", now: () => NOW },
        now: () => NOW,
        envelope: (producer, body, seq) => ({
          cx: PROTOCOL_VERSION,
          id: `env_${crypto.randomUUID()}`,
          ts: NOW.toISOString(),
          producer: { developerId: producer.developerId, agentKind: "claude-code", sessionId: producer.sessionId },
          kind: "work_context",
          body,
          seq,
        }),
      },
      own,
      { summary: "Keep the key id", status: "testing", intent: { summary: "Keep the key id", provenance: "declared", confidence: 1, capturedAt: NOW.toISOString() } },
    );

    // Assert
    expect(outcome.outcome).toBe("taken");
    expect(bodyOf(posted.at(-1))).toMatchObject({ id: topic.workContextId, titleSource: "fallback", branch: "feat/topic-a" });
  });
});
