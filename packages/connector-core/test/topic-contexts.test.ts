/**
 * ONE SESSION, MANY TOPICS — the core flow's own rules (DESIGN.md; flows/
 * topic-contexts.ts, flows/capture-touched-files.ts).
 *
 * The hook-level proof is connector-claude/test/worktree-capture.test.ts
 * (real hooks, real worktrees). This file drives the flow through its seams:
 * which context a path files under, the cap and its counted overflow, the
 * seen-set per topic, the registry per life — a heal clears it so every
 * topic's context is owed again — and set_intent's choice of topic.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import { MAX_TOPICS_PER_SESSION } from "../src/constants.ts";
import { repoKey } from "../src/config/paths.ts";
import type { Producer } from "../src/capture/records.ts";
import type { RootHead, TouchedRootsResolution } from "../src/capture/touched-root.ts";
import { captureTouchedFiles } from "../src/flows/capture-touched-files.ts";
import { fallbackWorkContextTitle, registerSessionFlow } from "../src/flows/register-session.ts";
import { sessionHealer } from "../src/flows/heal-session.ts";
import {
  intentTargetOf,
  topicKeyOf,
  topicLifeOf,
  topicSeenKey,
  topicWorkContextIdFor,
  withTopicCapture,
} from "../src/flows/topic-contexts.ts";
import { ACP_CONNECTOR, guaranteeDeclarationFor } from "../src/guarantees/declarations.ts";
import { prepareMcp } from "../src/mcp/context.ts";
import { findTool } from "../src/mcp/tools/index.ts";
import { readSpoolLines } from "../src/spool/files.ts";
import { flushSpool } from "../src/spool/flush.ts";
import { withLifeState } from "../src/spool/owed-work-context.ts";
import { readCaptureLosses } from "../src/state/loss-ledger.ts";
import { deriveSessionState, readSessionState, updateSessionState, writeSessionState } from "../src/state/session-state.ts";
import type { SessionState, TopicContext } from "../src/state/session-state.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
const ROOT = "/cx-topics/start";
const HUB = "http://hub.invalid";
const NOW = new Date("2026-10-07T10:00:00.000Z");
const cleanups: string[] = [];

afterAll(async () => {
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

const stateAt = (overrides: Partial<SessionState> = {}): SessionState => ({
  ...deriveSessionState({
    hostSessionKey: "topics",
    repoId: REPO_ID,
    repoRoot: ROOT,
    hubUrl: HUB,
    developerId: "dev_1",
    startedAt: NOW.toISOString(),
  }),
  startBranch: "detached@0123456789",
  workContextStatus: "implementing",
  ...overrides,
});

const headOf = (root: string, branch: string | null): RootHead => ({
  root,
  repoId: REPO_ID,
  branch,
  headStamp: branch === null ? null : `ref: refs/heads/${branch}`,
  firstHead: "a".repeat(40),
  head: null,
  touchedAt: NOW.toISOString(),
});

/** Each path `/cx-topics/<root>/<file>` resolves against its root, which is on `branchOf(root)`. */
const resolutionFor = (paths: readonly string[], branchOf: (root: string) => string | null): TouchedRootsResolution => {
  const rootOf = (path: string): string => path.split("/").slice(0, 3).join("/");
  const roots = [...new Set(paths.map(rootOf))];
  return {
    rootByPath: new Map(paths.map((path) => [path, rootOf(path)])),
    foreignDrops: 0,
    outsideDrops: 0,
    newlyResolved: [],
    firstResolvedRoot: null,
    headByRoot: new Map(roots.map((root) => [root, headOf(root, branchOf(root))])),
  };
};

const producer: Producer = { developerId: "dev_1", agentKind: "claude-code", sessionId: "cc_topics" };

/** One capture through the real flow, with the pre-pass stood in for. */
const capture = async (
  home: string,
  state: SessionState,
  paths: readonly string[],
  branchOf: (root: string) => string | null,
) =>
  captureTouchedFiles({
    home,
    repoKey: repoKey(state.hubUrl, REPO_ID),
    hostSessionKey: state.hostSessionKey,
    repoRoot: state.repoRoot,
    cwd: state.repoRoot,
    paths,
    denylist: null,
    seenTargets: state.seenTargets,
    workContextId: state.workContextId,
    producer: { ...producer, sessionId: state.crosscheckSessionId },
    now: NOW,
    sessionRepoId: state.repoId,
    identityRoot: state.repoRoot,
    identityRepoId: state.repoId,
    knownWorktreeRoots: state.knownWorktreeRoots,
    topics: topicLifeOf(state),
    resolveRoots: async (input) => resolutionFor(input.paths, branchOf),
  });

const spooledOf = async (home: string, hubUrl: string = HUB): Promise<readonly { kind: string; body: Record<string, unknown> }[]> =>
  (await readSpoolLines(home, repoKey(hubUrl, REPO_ID))).map((line) => JSON.parse(line) as { kind: string; body: Record<string, unknown> });

const topicEntry = (
  sessionId: string,
  sessionWorkContextId: string,
  branch: string,
  at: string = NOW.toISOString(),
): TopicContext => ({
  key: topicKeyOf(REPO_ID, branch),
  sessionId,
  workContextId: topicWorkContextIdFor(sessionWorkContextId, topicKeyOf(REPO_ID, branch)),
  branch,
  title: `${branch} @ api`,
  status: "implementing",
  baseCommit: "b".repeat(40),
  root: `/cx-topics/${branch}`,
  registeredAt: at,
  lastTouchedAt: at,
  ackedStatus: null,
});

describe("where a touch files", () => {
  test("the start topic files under the session's own context; another branch opens its own", async () => {
    // Arrange
    const home = await makeHome("topic-files");
    cleanups.push(home);
    const state = stateAt();

    // Act
    const result = await capture(home, state, ["/cx-topics/start/src/a.ts", "/cx-topics/wt1/src/a.ts"], (root) =>
      root.endsWith("start") ? "detached@0123456789" : "feat/one",
    );

    // Assert: the topic's context first, then each target under its own context
    const records = await spooledOf(home);
    const topicId = topicWorkContextIdFor(state.workContextId, topicKeyOf(REPO_ID, "feat/one"));
    expect(records.map((record) => [record.kind, record.body["workContextId"] ?? record.body["id"]])).toEqual([
      ["work_context", topicId],
      ["target", state.workContextId],
      ["target", topicId],
    ]);
    expect(records[0]?.body).toMatchObject({ title: "feat/one @ api", branch: "feat/one", baseCommit: "a".repeat(40) });
    expect(result.captured).toEqual(["src/a.ts", topicSeenKey(topicKeyOf(REPO_ID, "feat/one"), "src/a.ts")]);
    expect(result.topics?.opened.map((topic) => topic.branch)).toEqual(["feat/one"]);
  });

  test("a root whose HEAD cannot be read files under the session's own context", async () => {
    const home = await makeHome("topic-nohead");
    cleanups.push(home);
    await capture(home, stateAt(), ["/cx-topics/wt1/src/a.ts"], () => null);
    expect((await spooledOf(home)).map((record) => record.kind)).toEqual(["target"]);
  });

  test("the same path in two topics is two touches, never deduplicated across them", async () => {
    // Arrange: the first topic has already seen src/a.ts
    const home = await makeHome("topic-seen");
    cleanups.push(home);
    const state = stateAt({ seenTargets: [topicSeenKey(topicKeyOf(REPO_ID, "feat/one"), "src/a.ts")] });

    // Act
    const result = await capture(home, state, ["/cx-topics/wt1/src/a.ts", "/cx-topics/wt2/src/a.ts"], (root) =>
      root.endsWith("wt1") ? "feat/one" : "feat/two",
    );

    // Assert: wt1's already seen, wt2's captured
    expect(result.captured).toEqual([topicSeenKey(topicKeyOf(REPO_ID, "feat/two"), "src/a.ts")]);
  });

  test("past the cap a touch files under the session's own context and is counted", async () => {
    // Arrange: a life that has opened every topic it may
    const home = await makeHome("topic-cap");
    cleanups.push(home);
    const full = Array.from({ length: MAX_TOPICS_PER_SESSION }, (_, index) =>
      topicEntry("cc_topics", "wc_cc_topics", `feat/${String(index)}`),
    );
    const state = stateAt({ topicContexts: full });

    // Act
    const result = await capture(home, state, ["/cx-topics/wt9/src/a.ts"], () => "feat/one-too-many");

    // Assert: no context opened, the target is the session's, the overflow booked
    const records = await spooledOf(home);
    expect(records.map((record) => [record.kind, record.body["workContextId"]])).toEqual([["target", state.workContextId]]);
    expect(result.topics?.overflowed).toBe(1);
    const losses = await readCaptureLosses(home, repoKey(HUB, REPO_ID));
    expect(losses.byKind["topic_overflow"]).toBe(1);
    expect(withTopicCapture(state, result.topics).topicOverflowCount).toBe(1);
  });
});

describe("the registry is per life", () => {
  test("a capture folded into the life that opened it registers its topics; into another, none", () => {
    // Arrange
    const state = stateAt();
    const outcome = {
      sessionId: state.crosscheckSessionId,
      opened: [topicEntry(state.crosscheckSessionId, state.workContextId, "feat/one")],
      touched: new Map([[topicKeyOf(REPO_ID, "feat/one"), "/cx-topics/wt1"]]),
      sessionTouched: false,
      overflowed: 0,
      at: NOW.toISOString(),
    };

    // Act
    const same = withTopicCapture(state, outcome);
    const healedAway = withTopicCapture({ ...state, crosscheckSessionId: `${state.crosscheckSessionId}~r1` }, outcome);

    // Assert
    expect(same.topicContexts.map((entry) => entry.branch)).toEqual(["feat/one"]);
    expect(healedAway.topicContexts).toEqual([]);
  });

  test("another life's entries are never a registration: the next life opens its topic again", async () => {
    // Arrange: the registry still holds the PREVIOUS life's topic
    const home = await makeHome("topic-life");
    cleanups.push(home);
    const stale = stateAt({
      crosscheckSessionId: "cc_topics~r1",
      workContextId: "wc_cc_topics~r1",
      topicContexts: [topicEntry("cc_topics", "wc_cc_topics", "feat/one")],
    });

    // Act
    await capture(home, stale, ["/cx-topics/wt1/src/a.ts"], () => "feat/one");

    // Assert: the new life's context goes first, and the target names it
    const ownId = topicWorkContextIdFor("wc_cc_topics~r1", topicKeyOf(REPO_ID, "feat/one"));
    expect((await spooledOf(home)).map((record) => [record.kind, record.body["id"] ?? record.body["workContextId"]])).toEqual([
      ["work_context", ownId],
      ["target", ownId],
    ]);
  });
});

describe("a spooled topic context goes with its own title and status", () => {
  test("the session's title never rides a topic's context", () => {
    // Arrange
    const topic = { ...topicEntry("cc_topics", "wc_cc_topics", "feat/one"), status: "testing" };
    const state = stateAt({ workContextTitle: "detached@0123456 · initial @ api", topicContexts: [topic] });
    const record = (id: string): Record<string, unknown> => ({
      kind: "work_context",
      body: { id, sessionId: "cc_topics", title: "as spooled", status: "analyzing" },
    });

    // Act
    const asTopic = withLifeState(record(topic.workContextId), state);
    const asOwn = withLifeState(record("wc_cc_topics"), state);

    // Assert
    expect(asTopic["body"]).toMatchObject({ title: "feat/one @ api", status: "testing" });
    expect(asOwn["body"]).toMatchObject({ title: "detached@0123456 · initial @ api", status: "implementing" });
  });
});

describe("set_intent's topic", () => {
  const one = topicEntry("cc_topics", "wc_cc_topics", "feat/one", "2026-10-07T10:01:00.000Z");
  const two = topicEntry("cc_topics", "wc_cc_topics", "feat/two", "2026-10-07T10:02:00.000Z");

  test("is the one touched most recently, the session's own when that was its checkout", () => {
    expect(intentTargetOf(stateAt({ topicContexts: [one, two] }))).toMatchObject({ kind: "topic", topic: { branch: "feat/two" } });
    expect(intentTargetOf(stateAt({ topicContexts: [one, two], sessionTouchedAt: "2026-10-07T10:03:00.000Z" }))).toEqual({
      kind: "session",
    });
    expect(intentTargetOf(stateAt())).toEqual({ kind: "session" });
  });

  test("is the named one; the start branch names the session's own; an unknown name names none", () => {
    const state = stateAt({ topicContexts: [one] });
    expect(intentTargetOf(state, "feat/one")).toMatchObject({ kind: "topic", topic: { branch: "feat/one" } });
    expect(intentTargetOf(state, "detached@0123456789")).toEqual({ kind: "session" });
    expect(intentTargetOf(state, "feat/nope")).toEqual({ kind: "unknown", branches: ["feat/one"] });
  });
});

describe("against a hub", () => {
  const ADMIN_TOKEN = "topic-admin";
  let db: Db;
  let server: ReturnType<typeof Bun.serve>;
  let hubUrl: string;
  let apiKey: string;
  let developerId: string;

  beforeAll(async () => {
    db = await createDb();
    server = Bun.serve({ port: 0, fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch });
    hubUrl = `http://127.0.0.1:${String(server.port)}`;
    const response = await fetch(`${hubUrl}/api/developers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Topics", email: "topics@example.com" }),
    });
    const body = (await response.json()) as { data: { developer: { id: string }; apiKey: string } };
    apiKey = body.data.apiKey;
    developerId = body.data.developer.id;
  });

  afterAll(async () => {
    server.stop(true);
    await (db as unknown as { $client: { close: () => Promise<void> } }).$client.close().catch(() => undefined);
  });

  const raw = async <T>(text: string, params: readonly unknown[] = []): Promise<readonly T[]> =>
    (await (db as unknown as { $client: { query: (q: string, p: readonly unknown[]) => Promise<{ rows: T[] }> } }).$client.query(text, params)).rows;

  const registered = async (label: string) => {
    const home = await makeHome(label);
    const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
    cleanups.push(home, repo);
    const key = repoKey(hubUrl, REPO_ID);
    const hub = { hubUrl, apiKey, timeoutMs: 4000, home, repoKey: key, now: () => new Date() };
    const hostSessionKey = `topics-${label}`;
    const life = await registerSessionFlow({
      home,
      repoKey: key,
      hub,
      agentKind: "acp:test",
      hostSessionKey,
      repoId: REPO_ID,
      repoRoot: repo,
      branch: "main",
      baseCommit: "0".repeat(40),
      hubUrl,
      fallbackDeveloperId: developerId,
      title: fallbackWorkContextTitle("main", REPO_ID),
      status: "analyzing",
      now: new Date(),
      guarantees: guaranteeDeclarationFor(ACP_CONNECTOR),
    });
    const healer = sessionHealer({
      home,
      repoKey: key,
      hub,
      agentKind: "acp:test",
      hostSessionKey,
      repoId: REPO_ID,
      branch: "main",
      baseCommit: "0".repeat(40),
      guarantees: guaranteeDeclarationFor(ACP_CONNECTOR),
      now: () => new Date(),
    });
    const flush = async (): Promise<void> => {
      const state = await readSessionState(home, hostSessionKey);
      await flushSpool(hub, { sessionId: state?.crosscheckSessionId ?? "", developerId, heal: healer }, 3000);
    };
    return { home, repo, hostSessionKey, life, flush };
  };

  test("the registry starts empty on a heal, and the next touch spools its topic's context again", async () => {
    // Arrange: a live life with a topic registered, then ended by another process
    const fx = await registered("heal");
    await fx.flush();
    await updateSessionState(fx.home, fx.hostSessionKey, (fresh) => ({
      ...fresh,
      topicContexts: [topicEntry(fx.life.crosscheckSessionId, fx.life.workContextId, "feat/one")],
    }));
    await fetch(`${hubUrl}/api/sessions/${encodeURIComponent(fx.life.crosscheckSessionId)}/end`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: "{}",
    });
    const ended = await readSessionState(fx.home, fx.hostSessionKey);
    if (ended === null) throw new Error("no state");
    await capture(fx.home, ended, ["/cx-topics/wt1/src/before.ts"], () => "feat/one");

    // Act: the flush meets the ended life and heals onto the next; then a touch in the topic
    await fx.flush();
    const healed = await readSessionState(fx.home, fx.hostSessionKey);
    if (healed === null) throw new Error("no state");
    await capture(fx.home, healed, ["/cx-topics/wt1/src/after.ts"], () => "feat/one");
    await fx.flush();

    // Assert: the next life's topic context reached the hub ahead of its target
    const nextId = topicWorkContextIdFor(`wc_${fx.life.crosscheckSessionId}~r1`, topicKeyOf(REPO_ID, "feat/one"));
    expect(healed.crosscheckSessionId).toBe(`${fx.life.crosscheckSessionId}~r1`);
    expect(healed.topicContexts).toEqual([]);
    const targets = await raw<{ value: string }>("select value from work_context_targets where work_context_id = $1", [nextId]);
    expect(targets.map((row) => row.value)).toEqual(["src/after.ts"]);
  });

  test("set_intent lands on the most recent topic or the named one, creating its context whole", async () => {
    // Arrange: a registered life with two topics, the second touched last
    const fx = await registered("intent");
    await fx.flush();
    const one = topicEntry(fx.life.crosscheckSessionId, fx.life.workContextId, "feat/one", "2026-10-07T10:01:00.000Z");
    const two = topicEntry(fx.life.crosscheckSessionId, fx.life.workContextId, "feat/two", "2026-10-07T10:02:00.000Z");
    await updateSessionState(fx.home, fx.hostSessionKey, (fresh) => ({ ...fresh, topicContexts: [one, two] }));
    const setup = await prepareMcp({ CROSSCHECK_HOME: fx.home, CROSSCHECK_HUB_URL: hubUrl, CROSSCHECK_API_KEY: apiKey }, fx.repo);
    if (!setup.ok) throw new Error(setup.message);
    const tool = findTool("set_intent");
    if (tool === undefined) throw new Error("no set_intent");

    // Act
    const latest = await tool.run(setup.ctx, { summary: "Teach the importer to skip empty rows.", status: "testing" });
    const named = await tool.run(setup.ctx, { summary: "Rename the importer flags.", topic: "feat/one" });
    const unknown = await tool.run(setup.ctx, { summary: "Nothing here at all.", topic: "feat/nope" });

    // Assert: each landed where it was aimed, created with its branch and commit
    const rows = await raw<{ branch: string | null; intent: { summary: string } | null; base_commit: string | null; status: string }>(
      "select branch, intent, base_commit, status from work_contexts where id = any($1) order by branch",
      [[one.workContextId, two.workContextId]],
    );
    expect(latest.isError === true).toBe(false);
    expect(named.isError === true).toBe(false);
    expect(rows.map((row) => [row.branch, row.intent?.summary, row.base_commit, row.status])).toEqual([
      ["feat/one", "Rename the importer flags.", "b".repeat(40), "implementing"],
      ["feat/two", "Teach the importer to skip empty rows.", "b".repeat(40), "testing"],
    ]);
    expect(unknown.isError).toBe(true);
    expect(unknown.content.map((part) => part.text).join("\n")).toContain("feat/one");
    // ...and the topic's own status moved, never the session's
    const state = await readSessionState(fx.home, fx.hostSessionKey);
    expect(state?.workContextStatus).toBe("analyzing");
    expect(state?.topicContexts.find((topic) => topic.key === two.key)?.status).toBe("testing");
    expect(state?.topicContexts.find((topic) => topic.key === two.key)?.ackedStatus).toBe("testing");
  });
});

describe("a session state written before topics", () => {
  test("still reads, with no topics, no start branch and no overflow", async () => {
    // Arrange: a state file as an older connector wrote it
    const home = await makeHome("topic-old-state");
    cleanups.push(home);
    const { topicContexts: _topics, startBranch: _start, sessionTouchedAt: _at, topicOverflowCount: _over, ...older } = stateAt();
    await writeSessionState(home, older);

    // Act
    const read = await readSessionState(home, older.hostSessionKey);

    // Assert
    expect(read?.topicContexts).toEqual([]);
    expect(read?.startBranch).toBeNull();
    expect(read?.topicOverflowCount).toBe(0);
  });
});
