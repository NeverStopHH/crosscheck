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
import type { CaptureTouchedFilesInput } from "../src/flows/capture-touched-files.ts";
import { fallbackWorkContextTitle, registerSessionFlow } from "../src/flows/register-session.ts";
import { sessionHealer } from "../src/flows/heal-session.ts";
import {
  intentTargetOf,
  mintTopicId,
  relabelsKept,
  topicLifeOf,
  topicSeenKey,
  topicWorkContextIdFor,
  withTopicCapture,
} from "../src/flows/topic-contexts.ts";
import { ACP_CONNECTOR, guaranteeDeclarationFor } from "../src/guarantees/declarations.ts";
import { prepareMcp } from "../src/mcp/context.ts";
import { findTool } from "../src/mcp/tools/index.ts";
import { AMBIGUOUS_TOPIC_REFUSAL } from "../src/mcp/tools/set-intent.ts";
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
  seams: Pick<CaptureTouchedFilesInput, "appendTopicContexts"> = {},
) =>
  captureTouchedFiles({
    ...seams,
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

/** The id the rules mint for a topic opened in `/cx-topics/<worktree>` on `branch` — wt1 is on feat/one, wt2 on feat/two below. */
const topicIn = (worktree: string, branch: string): string => mintTopicId(REPO_ID, `/cx-topics/${worktree}`, branch);
const firstTopicIn = (worktree: string): string =>
  topicIn(worktree, worktree === "wt2" ? "feat/two" : worktree.startsWith("feat/") ? worktree : "feat/one");

const topicEntry = (
  sessionId: string,
  sessionWorkContextId: string,
  branch: string,
  at: string = NOW.toISOString(),
): TopicContext => ({
  key: topicIn(branch, branch),
  sessionId,
  workContextId: topicWorkContextIdFor(sessionWorkContextId, topicIn(branch, branch)),
  branch,
  branches: [branch],
  head: "b".repeat(40),
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
    const topicId = topicWorkContextIdFor(state.workContextId, firstTopicIn("wt1"));
    expect(records.map((record) => [record.kind, record.body["workContextId"] ?? record.body["id"]])).toEqual([
      ["work_context", topicId],
      ["target", state.workContextId],
      ["target", topicId],
    ]);
    expect(records[0]?.body).toMatchObject({ title: "feat/one @ api", branch: "feat/one", baseCommit: "a".repeat(40) });
    expect(result.captured).toEqual(["src/a.ts", topicSeenKey(firstTopicIn("wt1"), "src/a.ts")]);
    expect(result.topics?.opened.map((topic) => topic.branch)).toEqual(["feat/one"]);
  });

  test("a topic whose context the spool did not take files its targets under the session's own context (review mutation #9)", async () => {
    // Arrange: the context append refused, the target appends after it taken
    const home = await makeHome("topic-unpersisted");
    cleanups.push(home);
    const state = stateAt();
    const refused: NonNullable<CaptureTouchedFilesInput["appendTopicContexts"]> = async () => ({ persisted: false, dropped: 1 });

    // Act
    const result = await capture(home, state, ["/cx-topics/wt1/src/a.ts"], () => "feat/one", { appendTopicContexts: refused });

    // Assert: no target names a context the spool does not hold, and nothing registers it
    const records = await spooledOf(home);
    expect(records.map((record) => [record.kind, record.body["workContextId"]])).toEqual([["target", state.workContextId]]);
    expect(result.captured).toEqual(["src/a.ts"]);
    const folded = withTopicCapture(state, result.topics);
    expect(folded.topicContexts).toEqual([]);
    expect(folded.sessionTouchedAt).toBe(NOW.toISOString());
  });

  test("a retitle the spool did not take is not kept as the topic's title (review M4)", () => {
    // Arrange
    const renamed = [{ id: "k.1", label: "feat/new", head: null, title: "feat/new @ api" }];

    // Act + Assert: the branch still joins the affinity; the title waits for a record that went out
    expect(relabelsKept(renamed, true)).toEqual(renamed);
    expect(relabelsKept(renamed, false)).toEqual([{ id: "k.1", label: "feat/new", head: null, title: null }]);
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
    const state = stateAt({ seenTargets: [topicSeenKey(firstTopicIn("wt1"), "src/a.ts")] });

    // Act
    const result = await capture(home, state, ["/cx-topics/wt1/src/a.ts", "/cx-topics/wt2/src/a.ts"], (root) =>
      root.endsWith("wt1") ? "feat/one" : "feat/two",
    );

    // Assert: wt1's already seen, wt2's captured
    expect(result.captured).toEqual([topicSeenKey(firstTopicIn("wt2"), "src/a.ts")]);
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
      relabeled: [],
      touched: new Map([[firstTopicIn("feat/one"), "/cx-topics/wt1"]]),
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

  test("two hooks planning one worktree from one state, on two branches, open two topics (review M1)", async () => {
    // Arrange: one snapshot; hook A sees wt1 on feat/x, hook B — after a switch — on feat/y
    const home = await makeHome("topic-race-two");
    cleanups.push(home);
    const state = stateAt();

    // Act
    const a = await capture(home, state, ["/cx-topics/wt1/src/x.ts"], () => "feat/x");
    const b = await capture(home, state, ["/cx-topics/wt1/src/y.ts"], () => "feat/y");
    const folded = withTopicCapture(withTopicCapture(state, a.topics), b.topics);

    // Assert: two ids, each spooled once under its own title, each registered
    const records = (await spooledOf(home)).filter((record) => record.kind === "work_context");
    expect(new Set(records.map((record) => record.body["id"])).size).toBe(2);
    expect(folded.topicContexts.map((topic) => [topic.branch, topic.key]).sort()).toEqual([
      ["feat/x", topicIn("wt1", "feat/x")],
      ["feat/y", topicIn("wt1", "feat/y")],
    ]);
  });

  test("two hooks opening the same branch from one state converge on one topic (review mutation #7)", async () => {
    // Arrange: both hooks see wt1 on feat/x
    const home = await makeHome("topic-race-one");
    cleanups.push(home);
    const state = stateAt();

    // Act
    const a = await capture(home, state, ["/cx-topics/wt1/src/x.ts"], () => "feat/x");
    const b = await capture(home, state, ["/cx-topics/wt1/src/z.ts"], () => "feat/x");
    const folded = withTopicCapture(withTopicCapture(state, a.topics), b.topics);

    // Assert: one id on the wire, one entry in the registry
    const ids = (await spooledOf(home)).filter((record) => record.kind === "work_context").map((record) => record.body["id"]);
    expect(new Set(ids).size).toBe(1);
    expect(folded.topicContexts.map((topic) => topic.key)).toEqual([topicIn("wt1", "feat/x")]);
  });

  test("another life's entries are never a registration: the next life opens its topic again", async () => {
    // Arrange: the registry still holds the PREVIOUS life's topic, in the very worktree touched next
    const home = await makeHome("topic-life");
    cleanups.push(home);
    const stale = stateAt({
      crosscheckSessionId: "cc_topics~r1",
      workContextId: "wc_cc_topics~r1",
      topicContexts: [{ ...topicEntry("cc_topics", "wc_cc_topics", "feat/one"), root: "/cx-topics/wt1" }],
    });

    // Act
    await capture(home, stale, ["/cx-topics/wt1/src/a.ts"], () => "feat/one");

    // Assert: the new life's context goes first, and the target names it
    const ownId = topicWorkContextIdFor("wc_cc_topics~r1", firstTopicIn("wt1"));
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
  const two = topicEntry("cc_topics", "wc_cc_topics", "feat/two", "2026-10-07T10:05:00.000Z");

  test("is the one touched most recently, the session's own when that was its checkout", () => {
    expect(intentTargetOf(stateAt({ topicContexts: [one, two] }))).toMatchObject({ kind: "topic", topic: { branch: "feat/two" } });
    expect(intentTargetOf(stateAt({ topicContexts: [one, two], sessionTouchedAt: "2026-10-07T10:07:00.000Z" }))).toEqual({
      kind: "session",
    });
    expect(intentTargetOf(stateAt())).toEqual({ kind: "session" });
  });

  test("is no default when two were touched within a minute of each other — it names both (review M2)", () => {
    // Arrange: parallel subagents — feat/a touched, feat/b thirty seconds
    // later; the session's own checkout twenty seconds after that
    const a = topicEntry("cc_topics", "wc_cc_topics", "feat/a", "2026-10-07T10:05:00.000Z");
    const b = topicEntry("cc_topics", "wc_cc_topics", "feat/b", "2026-10-07T10:05:30.000Z");
    const old = topicEntry("cc_topics", "wc_cc_topics", "feat/old", "2026-10-07T10:01:00.000Z");

    // Act
    const topics = intentTargetOf(stateAt({ topicContexts: [old, a, b] }));
    const withSession = intentTargetOf(stateAt({ topicContexts: [old, a, b], sessionTouchedAt: "2026-10-07T10:05:50.000Z" }));
    const apart = intentTargetOf(stateAt({ topicContexts: [old, b], sessionTouchedAt: "2026-10-07T10:07:00.000Z" }));
    const named = intentTargetOf(stateAt({ topicContexts: [old, a, b] }), "feat/a");

    // Assert: newest first, the one touched minutes before left out
    expect(topics).toEqual({ kind: "ambiguous", branches: ["feat/b", "feat/a"] });
    expect(withSession).toEqual({ kind: "ambiguous", branches: ["detached@0123456789", "feat/b", "feat/a"] });
    expect(apart).toEqual({ kind: "session" });
    expect(named).toMatchObject({ kind: "topic", topic: { branch: "feat/a" } });
  });

  test("names a renamed topic and the session by the branch each is on now", () => {
    // Arrange: feat/a renamed to feat/a2, the session's checkout moved on too
    const a = { ...topicEntry("cc_topics", "wc_cc_topics", "feat/a", "2026-10-07T10:05:00.000Z"), branches: ["feat/a", "feat/a2"] };
    const state = stateAt({ topicContexts: [a], startBranches: ["feat/next"], sessionTouchedAt: "2026-10-07T10:05:10.000Z" });

    // Act
    const target = intentTargetOf(state);

    // Assert
    expect(target).toEqual({ kind: "ambiguous", branches: ["feat/next", "feat/a2"] });
  });

  test("leaves a session whose checkout has no branch out of the contest — it cannot be named", () => {
    // Arrange: two topics close together, the unnameable session touched last
    const a = topicEntry("cc_topics", "wc_cc_topics", "feat/a", "2026-10-07T10:05:00.000Z");
    const b = topicEntry("cc_topics", "wc_cc_topics", "feat/b", "2026-10-07T10:05:05.000Z");
    const unnamed = { startBranch: null, topicContexts: [a, b] };

    // Act
    const last = intentTargetOf(stateAt({ ...unnamed, sessionTouchedAt: "2026-10-07T10:05:10.000Z" }));
    const between = intentTargetOf(stateAt({ startBranch: null, topicContexts: [a], sessionTouchedAt: "2026-10-07T10:04:50.000Z" }));

    // Assert: a refusal it could never answer is no refusal at all
    expect(last).toEqual({ kind: "session" });
    expect(between).toMatchObject({ kind: "topic", topic: { branch: "feat/a" } });
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
    const nextId = topicWorkContextIdFor(`wc_${fx.life.crosscheckSessionId}~r1`, firstTopicIn("wt1"));
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
    const two = topicEntry(fx.life.crosscheckSessionId, fx.life.workContextId, "feat/two", "2026-10-07T10:05:00.000Z");
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

  test("set_intent with no topic refuses when two topics were touched within a minute, naming both (review M2)", async () => {
    // Arrange: subagent A on feat/a, subagent B touched feat/b a second later
    const fx = await registered("intent-race");
    await fx.flush();
    const a = topicEntry(fx.life.crosscheckSessionId, fx.life.workContextId, "feat/a", "2026-10-07T10:05:00.000Z");
    const b = topicEntry(fx.life.crosscheckSessionId, fx.life.workContextId, "feat/b", "2026-10-07T10:05:01.000Z");
    await updateSessionState(fx.home, fx.hostSessionKey, (fresh) => ({ ...fresh, topicContexts: [a, b] }));
    const setup = await prepareMcp({ CROSSCHECK_HOME: fx.home, CROSSCHECK_HUB_URL: hubUrl, CROSSCHECK_API_KEY: apiKey }, fx.repo);
    if (!setup.ok) throw new Error(setup.message);
    const tool = findTool("set_intent");
    if (tool === undefined) throw new Error("no set_intent");

    // Act: A's intent, first without and then with its branch
    const guessed = await tool.run(setup.ctx, { summary: "Teach the importer to skip empty rows." });
    const named = await tool.run(setup.ctx, { summary: "Teach the importer to skip empty rows.", topic: "feat/a" });

    // Assert: nothing landed on feat/b; the refusal named both branches
    const text = guessed.content.map((part) => part.text).join("\n");
    expect(guessed.isError).toBe(true);
    expect(text).toContain(AMBIGUOUS_TOPIC_REFUSAL);
    expect(text).toContain("feat/a");
    expect(text).toContain("feat/b");
    expect(named.isError === true).toBe(false);
    const rows = await raw<{ branch: string | null; intent: { summary: string } | null }>(
      "select branch, intent from work_contexts where id = any($1) order by branch",
      [[a.workContextId, b.workContextId]],
    );
    expect(rows.map((row) => [row.branch, row.intent?.summary])).toEqual([["feat/a", "Teach the importer to skip empty rows."]]);
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
