/**
 * THE QUALITY GATE for "does this prompt carry a task" (DESIGN.md §4, review
 * 1006b decision 1): every row of the labelled prompt corpus
 * (schema/test/fixtures/prompt-corpus.ts) through the WHOLE hint pipeline —
 * the connector's `selectAndRenderHint` against a real in-memory hub seeded
 * with the corpus trees — in a fresh session that HAS an intent, so no
 * stand-in can hide.
 *
 * (a) A `content_free` row makes NO hub call at all (hold-out review, H2):
 *     not "the hub found nothing", which leans on what the trees happen to
 *     say — the classifier decides it at home. Its hint rate is held to
 *     CONTENT_FREE_HINT_MAX_RATE besides: zero.
 * (b) A `task` row is falsely floored when the connector decided it carried
 *     nothing and made no call; at most TASK_FALSE_FLOOR_MAX of them: zero.
 * (c) A `task` row that names a tree shares two content words with it and
 *     arrives as a hint.
 * (d) A `task` row whose words only a teammate's unreviewed DRAFT shares
 *     earns no hint: drafts are invisible to the push path.
 *
 * THIS CORPUS IS TRAINING DATA, AND THE GATE IS NOT THE MEASURE. Each review
 * round evaluates the classifier on a FRESH hold-out — prompts and trees the
 * round's author never saw — through this same pipeline, under the protocol
 * in fixtures/holdout-protocol.ts: at most HOLDOUT_CONTENT_FREE_HINT_MAX_RATE
 * content-free rows hinted, HOLDOUT_TASK_FLOOR_MAX_RATE task rows floored and
 * HOLDOUT_WRONG_TREE_SUBSTANCE_MAX_RATE task rows shown substance from another
 * tree (all hard), with the content-free rows that still reach the hub
 * reported against HOLDOUT_REACHED_HUB_SOFT_TARGET (soft). Every hold-out
 * failure then becomes training data: the first hold-out is rows here
 * (schema/test/fixtures/holdout-corpus.ts), the second, with trees too rich
 * for this gate's shape, runs in holdout-round3-gate.test.ts. So this gate
 * only ever holds the line already won.
 *
 * Every rate is printed, so CI shows them on every run.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";

import { CORPUS_TREES, PROMPT_CORPUS } from "../../schema/test/fixtures/prompt-corpus.ts";
import type { CorpusPrompt } from "../../schema/test/fixtures/prompt-corpus.ts";
import { selectAndRenderHint } from "../src/flows/hint.ts";
import { repoKey } from "../src/config/paths.ts";
import type { HubContext } from "../src/http/client.ts";
import { writeSessionState } from "../src/state/session-state.ts";
import { makeHome, makeRepo } from "./helpers.ts";

/** Content-free rows of the corpus the pipeline may hint. None. */
const CONTENT_FREE_HINT_MAX_RATE = 0;
/** Task rows of the corpus the pipeline may judge content-free. None. */
const TASK_FALSE_FLOOR_MAX = 0;

const ADMIN_TOKEN = "prompt-corpus-admin";
const REPO_ID = "github.com/acme/api";
const NOW = new Date("2026-10-06T10:00:00.000Z");
const CREATED = "2026-10-05T10:00:00.000Z";
const OWNER_SESSION = "ses_ken";
const HOST_KEY = "corpus-reader-uuid";
/** An intent that would match the limit trees on its own — the stand-in, if it existed, would show. */
const SESSION_INTENT = "Make the usage limit reset and the upload limit handling more robust";

interface Seeded {
  readonly hubUrl: string;
  readonly readerKey: string;
  readonly readerId: string;
  readonly candidateCalls: () => number;
  readonly stop: () => void;
}

interface RowOutcome {
  readonly row: CorpusPrompt;
  readonly hint: string;
  readonly calledHub: boolean;
}

let seeded: Seeded;
let home: string;
let repo: string;
let outcomes: readonly RowOutcome[];

const post = async (url: string, token: string, body: unknown): Promise<Record<string, unknown>> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as Record<string, unknown>;
  if (response.status !== 200) {
    throw new Error(`corpus seed failed: ${JSON.stringify(parsed)}`);
  }
  return parsed;
};

const developer = async (base: string, name: string): Promise<{ id: string; apiKey: string }> => {
  const body = await post(`${base}/api/developers`, ADMIN_TOKEN, { name, email: `${name.toLowerCase()}@example.com` });
  const data = body["data"] as { developer: { id: string }; apiKey: string };
  return { id: data.developer.id, apiKey: data.apiKey };
};

const envelope = (developerId: string, kind: string, body: Record<string, unknown>, index: number) => ({
  cx: "0.1",
  id: `env_corpus_${String(index)}`,
  ts: CREATED,
  producer: { developerId, agentKind: "claude-code", sessionId: OWNER_SESSION },
  kind,
  body,
});

/** The corpus trees, owned by Ken: one work context and its declared claims each. */
const seedTrees = async (base: string, ken: { id: string; apiKey: string }): Promise<void> => {
  await post(`${base}/api/sessions`, ken.apiKey, {
    id: OWNER_SESSION,
    agentKind: "claude-code",
    repo: REPO_ID,
    branch: "main",
    baseCommit: "a1b2c3d4",
    status: "analyzing",
  });
  const records = CORPUS_TREES.flatMap((tree) => [
    { kind: "work_context", body: { id: tree.id, sessionId: OWNER_SESSION, title: tree.title, description: tree.description, status: "analyzing", createdAt: CREATED } },
    ...tree.claims.map((claimBody, index) => ({
      kind: "claim",
      body: {
        id: `clm_${tree.id}_${String(index)}`,
        workContextId: tree.id,
        authorSessionId: OWNER_SESSION,
        kind: "observation",
        body: claimBody,
        status: "proposed",
        confidence: 0.6,
        captureMode: "agent",
        provenance: "declared",
        evidenceRefs: [],
        createdAt: CREATED,
      },
    })),
    ...(tree.drafts ?? []).map((draftBody, index) => ({
      kind: "claim",
      body: {
        id: `clm_${tree.id}_draft_${String(index)}`,
        workContextId: tree.id,
        authorSessionId: OWNER_SESSION,
        kind: "observation",
        body: draftBody,
        status: "proposed",
        confidence: 0.4,
        captureMode: "auto",
        provenance: "derived",
        evidenceRefs: [],
        createdAt: CREATED,
      },
    })),
  ]);
  const body = await post(`${base}/api/records`, ken.apiKey, {
    records: records.map((record, index) => envelope(ken.id, record.kind, record.body, index)),
  });
  const data = body["data"] as { accepted: number };
  if (data.accepted !== records.length) {
    throw new Error(`corpus seed: ${String(data.accepted)} of ${String(records.length)} records accepted`);
  }
};

const startSeededHub = async (): Promise<Seeded> => {
  const db = await createDb();
  const app = createServer({ db, now: () => NOW, adminToken: ADMIN_TOKEN, embedder: null });
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      if (new URL(request.url).pathname === "/api/hints/candidates") {
        calls += 1;
      }
      return app.fetch(request);
    },
  });
  const base = `http://127.0.0.1:${String(server.port)}`;
  const ken = await developer(base, "Ken");
  const reader = await developer(base, "Robin");
  await seedTrees(base, ken);
  return { hubUrl: base, readerKey: reader.apiKey, readerId: reader.id, candidateCalls: () => calls, stop: () => server.stop(true) };
};

/** One row in a FRESH session — nothing delivered yet, the intent set. */
const runRow = async (row: CorpusPrompt): Promise<RowOutcome> => {
  await writeSessionState(home, {
    hostSessionKey: HOST_KEY,
    crosscheckSessionId: `cc_${HOST_KEY}`,
    workContextId: `wc_cc_${HOST_KEY}`,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl: seeded.hubUrl,
    developerId: seeded.readerId,
    startedAt: NOW.toISOString(),
    lastHeartbeatAt: null,
    seenTargets: [],
    deliveredHintRefs: [],
    deliveredHintHashes: [],
    tripwireAskedFiles: [],
    landedAskedFiles: [],
    landedCleanKeys: [],
    workContextIntent: SESSION_INTENT,
    workContextIntentProvenance: "declared",
  });
  const key = repoKey(seeded.hubUrl, REPO_ID);
  const hub: HubContext = { hubUrl: seeded.hubUrl, apiKey: seeded.readerKey, timeoutMs: 20_000, home, repoKey: key, now: () => NOW };
  const before = seeded.candidateCalls();
  const hint = await selectAndRenderHint({
    home,
    repoKey: key,
    hub,
    hostSessionKey: HOST_KEY,
    repoId: REPO_ID,
    repoRoot: repo,
    agentKind: "acp:corpus",
    prompt: row.prompt,
    now: NOW,
  });
  return { row, hint, calledHub: seeded.candidateCalls() > before };
};

const rate = (part: number, whole: number): string =>
  `${String(part)}/${String(whole)} (${whole === 0 ? "0.0" : ((100 * part) / whole).toFixed(1)}%)`;

beforeAll(async () => {
  seeded = await startSeededHub();
  home = await makeHome("prompt-corpus");
  repo = await makeRepo("prompt-corpus", { remote: "git@github.com:acme/api.git" });
  const collected: RowOutcome[] = [];
  for (const row of PROMPT_CORPUS) {
    collected.push(await runRow(row));
  }
  outcomes = collected;
  const contentFree = outcomes.filter((outcome) => outcome.row.label === "content_free");
  const tasks = outcomes.filter((outcome) => outcome.row.label === "task");
  const treeTasks = tasks.filter((outcome) => outcome.row.tree !== undefined);
  console.log(
    [
      `prompt corpus: ${String(PROMPT_CORPUS.length)} rows`,
      `  content-free rows with a hint: ${rate(contentFree.filter((outcome) => outcome.hint.length > 0).length, contentFree.length)}`,
      `  content-free rows sent to hub: ${rate(contentFree.filter((outcome) => outcome.calledHub).length, contentFree.length)}`,
      `  task rows falsely floored:     ${rate(tasks.filter((outcome) => !outcome.calledHub).length, tasks.length)}`,
      `  task rows with a tree, hinted: ${rate(treeTasks.filter((outcome) => outcome.hint.length > 0).length, treeTasks.length)}`,
    ].join("\n"),
  );
}, 300_000);

afterAll(async () => {
  seeded.stop();
  await Promise.all([home, repo].map((path) => rm(path, { recursive: true, force: true })));
});

describe("the labelled prompt corpus through the whole hint pipeline", () => {
  test("has at least 120 rows, both labels, every language, every source", () => {
    expect(PROMPT_CORPUS.length).toBeGreaterThanOrEqual(120);
    for (const field of ["label", "language", "source"] as const) {
      expect(new Set(PROMPT_CORPUS.map((row) => row[field])).size).toBeGreaterThan(1);
    }
    expect(new Set(PROMPT_CORPUS.map((row) => row.source))).toEqual(new Set(["review", "pilot", "synthetic"]));
  });

  test("(a) no content-free row reaches the hub at all", () => {
    const sent = outcomes
      .filter((outcome) => outcome.row.label === "content_free" && outcome.calledHub)
      .map((outcome) => outcome.row.prompt);
    expect(sent).toEqual([]);
  });

  test("(a) and none earns a hint, by any path", () => {
    const contentFree = outcomes.filter((outcome) => outcome.row.label === "content_free");
    const hinted = contentFree.filter((outcome) => outcome.hint.length > 0);
    expect(hinted.map((outcome) => outcome.row.prompt)).toEqual([]);
    expect(hinted.length / contentFree.length).toBeLessThanOrEqual(CONTENT_FREE_HINT_MAX_RATE);
  });

  test("(b) task rows falsely floored stay within TASK_FALSE_FLOOR_MAX", () => {
    const floored = outcomes
      .filter((outcome) => outcome.row.label === "task" && !outcome.calledHub)
      .map((outcome) => outcome.row.prompt);
    expect(floored.length).toBeLessThanOrEqual(TASK_FALSE_FLOOR_MAX);
  });

  test("(c) a task row that shares two words with a tree arrives as a hint", () => {
    const missed = outcomes
      .filter((outcome) => outcome.row.tree !== undefined && outcome.hint.length === 0)
      .map((outcome) => outcome.row.prompt);
    expect(missed).toEqual([]);
  });

  test("(d) a task row whose words only an unreviewed draft shares earns no hint", () => {
    const drafted = outcomes.filter((outcome) => outcome.row.draftOnlyTree !== undefined);
    expect(drafted.length).toBeGreaterThan(0);
    expect(drafted.filter((outcome) => outcome.hint.length > 0).map((outcome) => outcome.row.prompt)).toEqual([]);
  });
});
