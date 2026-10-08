/**
 * A TOPIC'S OWN WORD ABOUT ITS BASE (topic review C1; flows/topic-base-word.ts).
 *
 * The hub lands a topic by its own base and its own word only (server
 * services/landed.ts): was the commit at the topic's first touch ALREADY on
 * the default branch? A branch freshly cut from main says yes, and a
 * teammate's report of that base must then never take the topic out of the
 * collision checks. Pinned here: the word is asked of git for each topic an
 * event opens — by the edit capture and by the git lane alike — and every
 * sender of a topic's record carries it: its opening, SessionEnd's last word,
 * set_intent.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { PROTOCOL_VERSION } from "@crosscheck/schema";

import { repoKey } from "../src/config/paths.ts";
import type { RootHead } from "../src/capture/touched-root.ts";
import { captureTouchedFiles } from "../src/flows/capture-touched-files.ts";
import { sweepGitRoots } from "../src/flows/git-lane.ts";
import { withTopicBaseWords } from "../src/flows/topic-base-word.ts";
import { plannedTopicRecords, topicLifeOf } from "../src/flows/topic-contexts.ts";
import { runGit } from "../src/git/git.ts";
import { writeIntent } from "../src/mcp/tools/intent-write.ts";
import type { TitledWorkContext } from "../src/mcp/tools/intent-write.ts";
import { readSpoolLines } from "../src/spool/files.ts";
import { lastWorkContextRecords } from "../src/spool/work-context-ack.ts";
import { deriveSessionState } from "../src/state/session-state.ts";
import type { SessionState, TopicContext } from "../src/state/session-state.ts";
import { git, makeHome, makeRepo, writeRepoFile } from "./helpers.ts";
import { loopbackUrl, serveLoopback } from "./fixtures/loopback-serve.ts";

const REPO_ID = "github.com/acme/api";
const HUB = "http://hub.invalid";
const NOW = new Date("2026-10-08T10:00:00.000Z");
const BASE = "a".repeat(40);
/** A deadline any git process meets on a loaded machine. */
const WIDE_GIT_TIMEOUT_MS = 30_000;
const cleanups: string[] = [];

afterAll(async () => {
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

const lifeAt = (label: string, overrides: Partial<SessionState> = {}): SessionState => ({
  ...deriveSessionState({
    hostSessionKey: label,
    repoId: REPO_ID,
    repoRoot: "/cx-base-word/start",
    hubUrl: HUB,
    developerId: "dev_self",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
  }),
  agentKind: "claude-code",
  startBranch: "detached@0123456789",
  workContextTitle: "detached@0123456789 @ api",
  workContextTitleSource: "fallback",
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
  root: "/cx-base-word/wt1",
  registeredAt: NOW.toISOString(),
  lastTouchedAt: NOW.toISOString(),
  ackedStatus: null,
  ...overrides,
});

const bodyOf = (record: unknown): Record<string, unknown> =>
  ((record as { body?: Record<string, unknown> } | undefined)?.body ?? {});

const headOf = async (root: string): Promise<string> => {
  const sha = await runGit(["rev-parse", "HEAD"], root);
  if (sha === null) {
    throw new Error("no HEAD");
  }
  return sha;
};

/** A clone whose origin/main is main's tip, checked out on a branch freshly cut there. */
const freshBranchClone = async (label: string): Promise<{ readonly root: string; readonly mainSha: string }> => {
  const root = await realpath(await makeRepo(label, { remote: "git@github.com:acme/api.git" }));
  cleanups.push(root);
  const mainSha = await headOf(root);
  await git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  await git(root, ["checkout", "-q", "-b", "feat/fresh"]);
  return { root, mainSha };
};

const spooledTopicContexts = async (home: string, key: string): Promise<readonly Record<string, unknown>[]> =>
  (await readSpoolLines(home, key))
    .map((line) => JSON.parse(line) as { kind: string; body: Record<string, unknown> })
    .filter((record) => record.kind === "work_context" && String(record.body["id"]).includes("~t"))
    .map((record) => record.body);

describe("the word is asked of git", () => {
  test("for each topic a plan opens, and only for those", async () => {
    // Arrange
    const state = lifeAt("word-asked");
    const asked: string[] = [];
    const opened = [topicOf(state), topicOf(state, { key: "0a1b2c3d4e5f.2", baseCommit: "b".repeat(40) })];

    // Act
    const plan = await withTopicBaseWords({ opened }, (topic) => {
      asked.push(topic.key);
      return Promise.resolve(topic.baseCommit === BASE);
    });
    const none = await withTopicBaseWords({ opened: [] }, () => {
      throw new Error("asked for a plan that opens nothing");
    });

    // Assert
    expect(asked).toEqual(["0a1b2c3d4e5f.1", "0a1b2c3d4e5f.2"]);
    expect(plan.opened.map((topic) => topic.baseOnDefault)).toEqual([true, false]);
    expect(none.opened).toEqual([]);
  });

  test("against real git: a fresh branch cut from main says true, its own commit false, a detached HEAD nothing", async () => {
    // Arrange
    const { root, mainSha } = await freshBranchClone("word-real");
    await writeFile(join(root, "work.ts"), "export const work = 1;\n", "utf8");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-q", "-m", "own work"]);
    const ownSha = await headOf(root);
    const state = lifeAt("word-real");
    const fresh = topicOf(state, { key: "fresh", branch: "feat/fresh", baseCommit: mainSha, root });
    const own = topicOf(state, { key: "own", branch: "feat/fresh", baseCommit: ownSha, root });
    const detached = topicOf(state, { key: "detached", branch: `detached@${ownSha.slice(0, 9)}`, baseCommit: ownSha, root });

    // Act
    const plan = await withTopicBaseWords({ opened: [fresh, own, detached] });

    // Assert
    expect(plan.opened.map((topic) => [topic.key, topic.baseOnDefault])).toEqual([
      ["fresh", true],
      ["own", false],
      ["detached", null],
    ]);
  });

  test("by the edit capture, for the topic an edit opens", async () => {
    // Arrange: a sibling worktree on a branch freshly cut from main, and one edit in it
    const { root, mainSha } = await freshBranchClone("word-capture");
    await writeRepoFile(root, "src/a.ts", "export const a = 1;\n");
    const home = await makeHome("word-capture");
    cleanups.push(home);
    const state = lifeAt("word-capture");
    const key = repoKey(HUB, REPO_ID);
    const path = join(root, "src/a.ts");
    const head: RootHead = {
      root,
      repoId: REPO_ID,
      branch: "feat/fresh",
      headStamp: "ref: refs/heads/feat/fresh",
      firstHead: mainSha,
      head: null,
      touchedAt: NOW.toISOString(),
    };

    // Act
    await captureTouchedFiles({
      home,
      repoKey: key,
      hostSessionKey: state.hostSessionKey,
      repoRoot: state.repoRoot,
      cwd: root,
      paths: [path],
      denylist: null,
      seenTargets: state.seenTargets,
      workContextId: state.workContextId,
      producer: { developerId: "dev_self", agentKind: "claude-code", sessionId: state.crosscheckSessionId },
      now: NOW,
      sessionRepoId: REPO_ID,
      identityRoot: root,
      identityRepoId: REPO_ID,
      knownWorktreeRoots: state.knownWorktreeRoots,
      topics: topicLifeOf(state),
      resolveRoots: async () => ({
        rootByPath: new Map([[path, root]]),
        foreignDrops: 0,
        outsideDrops: 0,
        newlyResolved: [],
        firstResolvedRoot: null,
        headByRoot: new Map([[root, head]]),
      }),
    });

    // Assert
    expect(await spooledTopicContexts(home, key)).toEqual([
      expect.objectContaining({ branch: "feat/fresh", baseCommit: mainSha, baseOnDefault: true }),
    ]);
  });

  test("by the git lane, for the topic a sibling worktree's change opens", async () => {
    // Arrange: the same shape, the change found by Stop's sweep instead of an edit
    const { root, mainSha } = await freshBranchClone("word-lane");
    await writeRepoFile(root, "src/dirty.ts", "export const d = 1;\n");
    const home = await makeHome("word-lane");
    cleanups.push(home);
    const state = lifeAt("word-lane");
    const key = repoKey(HUB, REPO_ID);

    // Act
    await sweepGitRoots({
      home,
      repoKey: key,
      hostSessionKey: state.hostSessionKey,
      state,
      roots: [{ root, since: new Date(state.startedAt), firstHead: null, isSessionRoot: false }],
      producer: { developerId: "dev_self", agentKind: "claude-code", sessionId: state.crosscheckSessionId },
      denylist: null,
      now: new Date(),
      seq: null,
      gitTimeoutMs: WIDE_GIT_TIMEOUT_MS,
    });

    // Assert
    expect(await spooledTopicContexts(home, key)).toEqual([
      expect.objectContaining({ branch: "feat/fresh", baseCommit: mainSha, baseOnDefault: true }),
    ]);
  });
});

describe("every sender of a topic's record carries the word", () => {
  test("its opening — and none when there is none", () => {
    // Arrange
    const state = lifeAt("word-open");
    const said = topicOf(state, { baseOnDefault: true });
    const unsaid = topicOf(state, { key: "0a1b2c3d4e5f.2", workContextId: `${state.workContextId}~t0a1b2c3d4e5f.2`, baseOnDefault: null });
    const producer = { developerId: "dev_self", agentKind: "claude-code", sessionId: state.crosscheckSessionId };

    // Act
    const [first, second] = plannedTopicRecords({ opened: [said, unsaid], relabeled: [] }, topicLifeOf(state), producer, NOW);

    // Assert
    expect(bodyOf(first)["baseOnDefault"]).toBe(true);
    expect(bodyOf(second)).not.toHaveProperty("baseOnDefault");
  });

  test("SessionEnd's last word", () => {
    // Arrange: the hub is behind the state on the topic
    const topic = topicOf(lifeAt("word-end"), { status: "done", ackedStatus: "implementing", baseOnDefault: false });
    const state = lifeAt("word-end", { topicContexts: [topic] });

    // Act
    const records = lastWorkContextRecords(state, NOW);

    // Assert
    expect(records.map(bodyOf)).toEqual([expect.objectContaining({ id: topic.workContextId, baseOnDefault: false })]);
  });

  describe("set_intent, which can reach the hub before the spool's copy", () => {
    const posted: Record<string, unknown>[] = [];
    const gateway = serveLoopback({
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

    test("creates the topic whole, its word included", async () => {
      // Arrange
      const home = await makeHome("word-intent");
      cleanups.push(home);
      const state = lifeAt("word-intent");
      const topic = topicOf(state, { baseOnDefault: true });
      const url = loopbackUrl(gateway);
      const own: TitledWorkContext = {
        hostSessionKey: state.hostSessionKey,
        crosscheckSessionId: state.crosscheckSessionId,
        workContextId: topic.workContextId,
        developerId: "dev_self",
        workContextTitle: topic.title,
        workContextTitleSource: "fallback",
        workContextStatus: topic.status,
        startedAt: state.startedAt,
        sessionAmbiguous: true,
        topicKey: topic.key,
        branch: topic.branch,
        baseCommit: topic.baseCommit,
        baseOnDefault: true,
      };

      // Act
      const outcome = await writeIntent(
        {
          home,
          repoKey: "word-intent",
          hub: { hubUrl: url, apiKey: "test-key", timeoutMs: 2000, home, repoKey: "word-intent", now: () => NOW },
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
      expect(bodyOf(posted.at(-1))).toMatchObject({ id: topic.workContextId, baseCommit: BASE, baseOnDefault: true });
    });
  });
});
