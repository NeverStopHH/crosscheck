/**
 * THE ROUND-4 HOLD-OUT, NOW TRAINING DATA (DESIGN.md §4; hold-out review
 * round 5). The reviewer's sealed set, byte for byte
 * (fixtures/holdout-round4/holdout.json, sha256 84135c91…0f08): 250
 * content-free and 183 task prompts, 36 teammate trees and 20 session
 * intents; the 36 exact duplicates of earlier corpora the reviewer dropped
 * are dropped here, leaving 215 and 182. Through the whole hint pipeline —
 * the connector's `selectAndRenderHint` against a real in-memory hub seeded
 * the way the reviewer's harness seeded it: one developer per tree, its
 * session implementing, a context whose intent is declared on even trees and
 * derived on odd ones, a file target per file, an evidence claim and the
 * tree's claims, those of a root cause, a decision or a rejected approach
 * citing the evidence.
 *
 * ISOLATED, the acceptance: every row in a fresh session whose intent is the
 * row's own — a content-free row's the reviewer's intent for it, a task
 * row's the prompt. The protocol's hard rates (fixtures/holdout-protocol.ts)
 * hold, with the residuals named below.
 *
 * SESSION-BASED, reported (round 5, decision 11): the row as the SECOND turn
 * of a scripted session whose first turn is a task on its topic — a
 * content-free row's session intent typed as a prompt, a task row's sibling
 * task about the same tree. Its rates are printed, never failed on, but one:
 * no tree is hinted twice in one session.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";

import { selectAndRenderHint } from "../src/flows/hint.ts";
import { repoKey } from "../src/config/paths.ts";
import type { HubContext } from "../src/http/client.ts";
import { readSessionState, writeSessionState } from "../src/state/session-state.ts";
import {
  HOLDOUT_CONTENT_FREE_HINT_MAX_RATE,
  HOLDOUT_REACHED_HUB_SOFT_TARGET,
  HOLDOUT_TASK_FLOOR_MAX_RATE,
  HOLDOUT_WRONG_TREE_SUBSTANCE_MAX_RATE,
} from "./fixtures/holdout-protocol.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ADMIN_TOKEN = "holdout-round4-admin";
const REPO_ID = "github.com/acme/api";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const HOST_KEY = "holdout-round4-reader";
/** A session's derived intent is its prompt's first 200 characters, as the reviewer's harness set it. */
const INTENT_MAX_CHARS = 200;
const RUN_TIMEOUT_MS = 900_000;

/** The reviewer's exact duplicates of earlier corpora, dropped from every rate (review-hints4/analyze.ts). */
const DUPLICATES: ReadonlySet<string> = new Set(
  "C001 C004 C005 C007 C008 C013 C014 C016 C021 C025 C033 C034 C035 C036 C077 C078 C093 C096 C097 C099 C100 C104 C108 C109 C118 C120 C129 C138 C144 C156 C157 C158 C160 C161 C250 K044".split(" "),
);

/**
 * Content-free rows this training set still hints, each with why — all four
 * flagged ambiguous by the reviewer. Nothing else may be hinted.
 */
const ACCEPTED_CONTENT_FREE_HINTS: ReadonlyMap<string, string> = new Map([
  ["C140", "\"lieber variante b mit dem lua script\": an option pick naming the option's content, the rate-limit tree's Lua script"],
  ["C152", "\"nimm die mit dem unique constraint\": an option pick naming the webhook tree's unique constraint"],
  ["C153", "\"yes, the batched query version\": an option pick naming the orders tree's batched query"],
  ["C216", "an inline quote of the agent's proposal (\"… den Index concurrently anlegen\"), no \"> \" line to strip"],
]);

/** Task rows with a tree that reach it: the floor this set holds, measured when it became training data. */
const RIGHT_TREE_MIN = 119;
/** Task rows pointed at a tree they are not about: the ceiling, measured with it. */
const WRONG_TREE_POINTER_MAX = 7;

interface Claim {
  readonly kind: string;
  readonly status: string;
  readonly body: string;
}

interface Tree {
  readonly id: string;
  readonly owner: string;
  readonly title: string;
  readonly intent: string;
  readonly files: readonly string[];
  readonly claims: readonly Claim[];
}

interface Row {
  readonly id: string;
  readonly l: "cf" | "task";
  readonly cat: string;
  readonly p?: string;
  readonly lines?: readonly string[];
  readonly t?: readonly string[];
  readonly amb?: string;
  readonly i?: number;
}

interface Holdout {
  readonly intents: readonly string[];
  readonly trees: readonly Tree[];
  readonly rows: readonly Row[];
}

type HintKind = "silence" | "substance" | "pointer";

/** One prompt's answer: whether it reached the hub, and what it delivered. */
interface Turn {
  readonly calledHub: boolean;
  readonly kind: HintKind;
  readonly tree: string | null;
}

interface RowOutcome extends Turn {
  readonly row: Row;
}

interface SessionOutcome extends RowOutcome {
  readonly opener: Turn;
}

interface Developer {
  readonly id: string;
  readonly apiKey: string;
}

interface Seeded {
  readonly hubUrl: string;
  readonly reader: Developer;
  readonly candidateCalls: () => number;
  readonly stop: () => void;
}

let holdout: Holdout;
let seeded: Seeded;
let home: string;
let repo: string;
let isolated: readonly RowOutcome[];
let sessions: readonly SessionOutcome[];

const loadHoldout = async (): Promise<Holdout> =>
  JSON.parse(await readFile(new URL("./fixtures/holdout-round4/holdout.json", import.meta.url), "utf8")) as Holdout;

const textOf = (row: Row): string => row.p ?? (row.lines ?? []).join("\n");
const intentOf = (text: string): string => text.replace(/\s+/gu, " ").slice(0, INTENT_MAX_CHARS);
const iso = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();

const post = async (url: string, token: string, body: unknown): Promise<Record<string, unknown>> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as Record<string, unknown>;
  if (response.status !== 200) {
    throw new Error(`round-4 seed failed: ${JSON.stringify(parsed)}`);
  }
  return parsed;
};

const registerDeveloper = async (base: string, name: string): Promise<Developer> => {
  const body = await post(`${base}/api/developers`, ADMIN_TOKEN, { name, email: `${name.toLowerCase()}@round4.test` });
  const data = body["data"] as { developer: { id: string }; apiKey: string };
  return { id: data.developer.id, apiKey: data.apiKey };
};

/** A tree's records, as the reviewer's harness wrote them (review-hints4/run-holdout.ts seedTree). */
const treeRecords = (tree: Tree, index: number, sessionId: string): readonly { kind: string; body: Record<string, unknown> }[] => {
  const contextId = `wc_${tree.id}`;
  const isDeclared = index % 2 === 0;
  const evidenceId = `clm_${tree.id}_e`;
  const claimBase = { workContextId: contextId, authorSessionId: sessionId, confidence: 0.8, captureMode: "agent", provenance: "declared" };
  const citesEvidence = (kind: string): boolean => kind === "root_cause" || kind === "decision" || kind === "rejected_approach";
  return [
    {
      kind: "work_context",
      body: {
        id: contextId,
        sessionId,
        title: tree.title,
        intent: { summary: tree.intent.slice(0, INTENT_MAX_CHARS), provenance: isDeclared ? "declared" : "derived", confidence: isDeclared ? 1 : 0.5, capturedAt: iso(-3 * HOUR_MS) },
        status: "implementing",
        createdAt: iso(-3 * HOUR_MS),
      },
    },
    ...tree.files.map((file) => ({ kind: "target", body: { workContextId: contextId, kind: "file", value: file, source: "tool_edit" } })),
    {
      kind: "claim",
      body: { ...claimBase, id: evidenceId, kind: "evidence", status: "proposed", body: `Reproduced on staging: ${tree.title}.`, evidenceRefs: [], createdAt: iso(-2 * HOUR_MS) },
    },
    ...tree.claims.map((claim, claimIndex) => ({
      kind: "claim",
      body: {
        ...claimBase,
        id: `clm_${tree.id}_${String(claimIndex)}`,
        kind: claim.kind,
        status: claim.status,
        body: claim.body,
        evidenceRefs: citesEvidence(claim.kind) ? [evidenceId] : [],
        createdAt: iso(-HOUR_MS),
      },
    })),
  ];
};

const seedTree = async (base: string, tree: Tree, index: number): Promise<void> => {
  const owner = await registerDeveloper(base, `${tree.owner.slice(0, 1).toUpperCase()}${tree.owner.slice(1)}${tree.id}`);
  const sessionId = `ses_${tree.id}`;
  await post(`${base}/api/sessions`, owner.apiKey, { id: sessionId, agentKind: "claude-code", repo: REPO_ID, branch: `feat/${tree.id.toLowerCase()}`, baseCommit: "c0ffee01", status: "implementing" });
  const records = treeRecords(tree, index, sessionId);
  const body = await post(`${base}/api/records`, owner.apiKey, {
    records: records.map((record, recordIndex) => ({
      cx: "0.1",
      id: `env_r4_${tree.id}_${String(recordIndex)}`,
      ts: iso(-HOUR_MS),
      producer: { developerId: owner.id, agentKind: "claude-code", sessionId },
      kind: record.kind,
      body: record.body,
    })),
  });
  const data = body["data"] as { accepted: number };
  if (data.accepted !== records.length) {
    throw new Error(`round-4 seed ${tree.id}: ${String(data.accepted)} of ${String(records.length)} records accepted`);
  }
};

const startSeededHub = async (trees: readonly Tree[]): Promise<Seeded> => {
  const db = await createDb();
  const app = createServer({ db, now: () => NOW, adminToken: ADMIN_TOKEN, embedder: null });
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      if (new URL(request.url).pathname === "/api/hints/candidates") {
        calls += 1;
      }
      return app.fetch(request);
    },
  });
  const base = `http://127.0.0.1:${String(server.port)}`;
  for (const [index, tree] of trees.entries()) {
    await seedTree(base, tree, index);
  }
  const reader = await registerDeveloper(base, "Reader");
  return { hubUrl: base, reader, candidateCalls: () => calls, stop: () => server.stop(true) };
};

/** A fresh session for one row: nothing delivered yet, the intent set. */
const freshSession = async (intent: string): Promise<void> => {
  await writeSessionState(home, {
    hostSessionKey: HOST_KEY,
    crosscheckSessionId: `cc_${HOST_KEY}`,
    workContextId: `wc_cc_${HOST_KEY}`,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl: seeded.hubUrl,
    developerId: seeded.reader.id,
    startedAt: NOW.toISOString(),
    lastHeartbeatAt: null,
    seenTargets: [],
    deliveredHintRefs: [],
    deliveredHintHashes: [],
    tripwireAskedFiles: [],
    landedAskedFiles: [],
    landedCleanKeys: [],
    workContextIntent: intent,
    workContextIntentProvenance: "derived",
  });
};

const deliveredRefs = async (): Promise<readonly string[]> => (await readSessionState(home, HOST_KEY))?.deliveredHintRefs ?? [];

/** One prompt in the current session: the ref it delivered names its kind and its tree. */
const turn = async (prompt: string): Promise<Turn> => {
  const before = new Set(await deliveredRefs());
  const calls = seeded.candidateCalls();
  const key = repoKey(seeded.hubUrl, REPO_ID);
  const hub: HubContext = { hubUrl: seeded.hubUrl, keyOrigin: seeded.hubUrl, apiKey: seeded.reader.apiKey, timeoutMs: 20_000, home, repoKey: key, now: () => NOW };
  await selectAndRenderHint({ home, repoKey: key, hub, hostSessionKey: HOST_KEY, repoId: REPO_ID, repoRoot: repo, agentKind: "acp:holdout-round4", prompt, now: NOW });
  const ref = (await deliveredRefs()).find((candidate) => !before.has(candidate)) ?? null;
  return {
    calledHub: seeded.candidateCalls() > calls,
    kind: ref === null ? "silence" : ref.startsWith("clm_") ? "substance" : "pointer",
    tree: ref === null ? null : (/^(?:clm|wc)_(T\d\d)/u.exec(ref)?.[1] ?? null),
  };
};

/** Each row with the intent the reviewer gave its session: a cf row's in turn, unless it names one. */
const rowsWithIntents = (data: Holdout): readonly { row: Row; intent: string }[] => {
  const cfRows = data.rows.filter((row) => row.l === "cf");
  return data.rows.map((row) => {
    const cfIndex = cfRows.indexOf(row);
    const intent = row.l === "cf" ? (data.intents[row.i ?? cfIndex % data.intents.length] ?? "") : intentOf(textOf(row));
    return { row, intent };
  });
};

/** A task row's opener: another task row about one of its trees, as the reviewer's session harness picked it. */
const siblingOf = (data: Holdout, row: Row): Row | undefined =>
  data.rows.find((other) => other.l === "task" && other.id !== row.id && (other.t ?? []).some((tree) => (row.t ?? []).includes(tree)));

const runIsolated = async (data: Holdout): Promise<readonly RowOutcome[]> => {
  const collected: RowOutcome[] = [];
  for (const { row, intent } of rowsWithIntents(data).filter(({ row }) => !DUPLICATES.has(row.id))) {
    await freshSession(intent);
    collected.push({ row, ...(await turn(textOf(row))) });
  }
  return collected;
};

const runSessions = async (data: Holdout): Promise<readonly SessionOutcome[]> => {
  const collected: SessionOutcome[] = [];
  for (const { row, intent } of rowsWithIntents(data).filter(({ row }) => !DUPLICATES.has(row.id))) {
    const sibling = row.l === "cf" ? undefined : siblingOf(data, row);
    const opener = row.l === "cf" ? intent : sibling === undefined ? null : textOf(sibling);
    if (opener === null) {
      continue;
    }
    await freshSession(intentOf(opener));
    const first = await turn(opener);
    collected.push({ row, opener: first, ...(await turn(textOf(row))) });
  }
  return collected;
};

const rate = (part: number, whole: number): string =>
  `${String(part)}/${String(whole)} (${whole === 0 ? "0.0" : ((100 * part) / whole).toFixed(1)}%)`;
const ids = (rows: readonly RowOutcome[]): readonly string[] => rows.map((outcome) => outcome.row.id);
const contentFree = <T extends RowOutcome>(rows: readonly T[]): readonly T[] => rows.filter((outcome) => outcome.row.l === "cf");
const tasks = <T extends RowOutcome>(rows: readonly T[]): readonly T[] => rows.filter((outcome) => outcome.row.l === "task");
const isOwnTree = (outcome: RowOutcome): boolean => outcome.tree !== null && (outcome.row.t ?? []).includes(outcome.tree);
const hinted = <T extends RowOutcome>(rows: readonly T[]): readonly T[] => rows.filter((outcome) => outcome.kind !== "silence");
const floored = <T extends RowOutcome>(rows: readonly T[]): readonly T[] => tasks(rows).filter((outcome) => !outcome.calledHub);
const wrongTree = <T extends RowOutcome>(rows: readonly T[], kind: HintKind): readonly T[] =>
  tasks(rows).filter((outcome) => outcome.kind === kind && !isOwnTree(outcome));
const withTree = <T extends RowOutcome>(rows: readonly T[]): readonly T[] => tasks(rows).filter((outcome) => (outcome.row.t ?? []).length > 0);
const repeated = (rows: readonly SessionOutcome[]): readonly SessionOutcome[] =>
  rows.filter((outcome) => outcome.tree !== null && outcome.tree === outcome.opener.tree);

const report = (): string => {
  const cf = contentFree(isolated);
  const task = tasks(isolated);
  const reach = withTree(isolated);
  const missed = reach.filter((outcome) => !isOwnTree(outcome));
  return [
    `round-4 hold-out (training): ${String(isolated.length)} rows, ${String(holdout.trees.length)} trees`,
    `ISOLATED (acceptance)`,
    `  content-free rows hinted:        ${rate(hinted(cf).length, cf.length)} ${ids(hinted(cf)).join(" ")}`,
    `  content-free rows reached hub:   ${rate(cf.filter((outcome) => outcome.calledHub).length, cf.length)} (soft target ${String(100 * HOLDOUT_REACHED_HUB_SOFT_TARGET)}%)`,
    `  task rows floored:               ${rate(floored(isolated).length, task.length)}`,
    `  wrong-tree substance:            ${rate(wrongTree(isolated, "substance").length, task.length)}`,
    `  wrong-tree pointers:             ${rate(wrongTree(isolated, "pointer").length, task.length)} ${ids(wrongTree(isolated, "pointer")).join(" ")}`,
    `  task rows with a tree, reached:  ${rate(reach.length - missed.length, reach.length)}`,
    `  ... of them with substance:      ${rate(reach.filter((outcome) => outcome.kind === "substance" && isOwnTree(outcome)).length, reach.length)}`,
    `  missed: ${ids(missed).join(" ")}`,
    `SESSION-BASED (reported; the row is the second turn)`,
    `  content-free rows hinted:        ${rate(hinted(contentFree(sessions)).length, contentFree(sessions).length)} ${ids(hinted(contentFree(sessions))).join(" ")}`,
    `  task rows floored:               ${rate(floored(sessions).length, tasks(sessions).length)}`,
    `  wrong-tree substance:            ${rate(wrongTree(sessions, "substance").length, tasks(sessions).length)}`,
    `  task rows hinted their tree:     ${rate(tasks(sessions).filter(isOwnTree).length, tasks(sessions).length)}`,
    `  a tree hinted twice in a session: ${String(repeated(sessions).length)}`,
  ].join("\n");
};

beforeAll(async () => {
  holdout = await loadHoldout();
  seeded = await startSeededHub(holdout.trees);
  home = await makeHome("holdout-round4");
  repo = await makeRepo("holdout-round4", { remote: "git@github.com:acme/api.git" });
  isolated = await runIsolated(holdout);
  sessions = await runSessions(holdout);
  console.log(report());
}, RUN_TIMEOUT_MS);

afterAll(async () => {
  seeded.stop();
  await Promise.all([home, repo].map((path) => rm(path, { recursive: true, force: true })));
});

describe("the round-4 hold-out, as training data, through the whole hint pipeline", () => {
  test("is the reviewer's set less its duplicates: 215 content-free rows, 182 task rows, 36 trees", () => {
    expect(holdout.rows).toHaveLength(433);
    expect(contentFree(isolated)).toHaveLength(215);
    expect(tasks(isolated)).toHaveLength(182);
    expect(holdout.trees).toHaveLength(36);
  });

  test("ISOLATED (a): no content-free row is hinted, but the named residuals", () => {
    const shown = hinted(contentFree(isolated));
    expect(ids(shown).filter((id) => !ACCEPTED_CONTENT_FREE_HINTS.has(id))).toEqual([]);
    expect(shown.length / contentFree(isolated).length).toBeLessThanOrEqual(HOLDOUT_CONTENT_FREE_HINT_MAX_RATE);
  });

  test("ISOLATED (b): no task row is floored", () => {
    expect(ids(floored(isolated))).toEqual([]);
    expect(floored(isolated).length / tasks(isolated).length).toBeLessThanOrEqual(HOLDOUT_TASK_FLOOR_MAX_RATE);
  });

  test("ISOLATED (c): no task row is shown substance from a tree it is not about", () => {
    const wrong = wrongTree(isolated, "substance");
    expect(ids(wrong)).toEqual([]);
    expect(wrong.length / tasks(isolated).length).toBeLessThanOrEqual(HOLDOUT_WRONG_TREE_SUBSTANCE_MAX_RATE);
  });

  test(`ISOLATED (d): at least ${String(RIGHT_TREE_MIN)} task rows reach their tree, at most ${String(WRONG_TREE_POINTER_MAX)} are pointed elsewhere`, () => {
    expect(withTree(isolated).filter(isOwnTree).length).toBeGreaterThanOrEqual(RIGHT_TREE_MIN);
    expect(wrongTree(isolated, "pointer").length).toBeLessThanOrEqual(WRONG_TREE_POINTER_MAX);
  });

  test("SESSION-BASED: the same tree is never hinted twice in one session (decision 11)", () => {
    expect(sessions.length).toBeGreaterThan(contentFree(isolated).length);
    expect(ids(repeated(sessions))).toEqual([]);
  });
});
