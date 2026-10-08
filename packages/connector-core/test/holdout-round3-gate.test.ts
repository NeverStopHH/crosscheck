/**
 * THE ROUND-3 HOLD-OUT, NOW TRAINING DATA (DESIGN.md §4; hold-out review
 * round 3, decision 12). 186 content-free and 135 task prompts and 35 trees
 * the round-3 author never saw (fixtures/holdout-round3/), through the whole
 * hint pipeline — the connector's `selectAndRenderHint` against a real
 * in-memory hub seeded the way the reviewer seeded it: seven developers, each
 * tree in its owner's session, intents, targets, drafts, a refuted
 * hypothesis, a retraction, a self-cite, an intent-only tree and one tree of
 * the reader's own. Every row runs in a fresh session that HAS an intent.
 *
 * It holds the protocol's hard rates (fixtures/holdout-protocol.ts) at their
 * training value — no content-free row hinted, no task row floored — and the
 * new one, WRONG-TREE SUBSTANCE: a task row shown a finding from a tree other
 * than its own, only the residual named below. A task row with a tree reaches
 * it except the misses named below. Content-free rows that still reach the
 * hub are reported against the soft target, never failed on.
 *
 * Every rate is printed, so CI shows them on every run.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";

import { selectAndRenderHint } from "../src/flows/hint.ts";
import { repoKey } from "../src/config/paths.ts";
import type { HubContext } from "../src/http/client.ts";
import { writeSessionState } from "../src/state/session-state.ts";
import {
  HOLDOUT_CONTENT_FREE_HINT_MAX_RATE,
  HOLDOUT_REACHED_HUB_SOFT_TARGET,
  HOLDOUT_TASK_FLOOR_MAX_RATE,
  HOLDOUT_WRONG_TREE_SUBSTANCE_MAX_RATE,
} from "./fixtures/holdout-protocol.ts";
import { ROWS } from "./fixtures/holdout-round3/rows.ts";
import type { Row } from "./fixtures/holdout-round3/rows.ts";
import { DEVELOPERS, READER, TREES } from "./fixtures/holdout-round3/trees.ts";
import type { HTree } from "./fixtures/holdout-round3/trees.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ADMIN_TOKEN = "holdout-round3-admin";
const REPO_ID = "github.com/acme/platform";
const NOW = new Date("2026-10-01T12:00:00.000Z");
/** The reviewer's clock: tree i opens at this instant plus i hours, its records a minute apart. */
const FIRST_TREE_AT_MS = Date.parse("2026-09-20T08:00:00.000Z");
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
/** The minute a tree's revision edges are written, after its claims. */
const EDGE_MINUTE = 20;
const HOST_KEY = "holdout-round3-reader";
const SESSION_INTENT = "Refactor the player search export for the scouting team";
/** How a hint that carries a teammate's finding opens (hints/render.ts); a pointer opens otherwise. */
const SUBSTANCE_HEAD = "crosscheck hint:";

/**
 * Wrong-tree substance this training set still shows, each with why. Nothing
 * else may appear. Empty since round 4 (C2): t095, "add pagination to
 * /api/players", agreed with the rate-limit tree's intent on add and api, and
 * a finding now needs two words of its own claim.
 */
const ACCEPTED_WRONG_TREE_SUBSTANCE: ReadonlyMap<string, string> = new Map();

/**
 * TASKS WHOSE TREE TIES ANOTHER AT THE TOP (round 4, C2): a tie says nothing,
 * finding or pointer — the hub's order between equals is search rank, not
 * relevance. Named, so the decision's cost stays visible.
 */
const TIED_TASKS: ReadonlyMap<string, string> = new Map<string, string>([
  // t077 and t126 untied when M1 counted a task's meta words; t100, "review the
  // rate limiting middleware PR", when "review" and "PR" became weak words.
]);

/**
 * TASKS WRITTEN IN THE SAME BREATH AS A CONTINUATION (round 4, C1; round 5,
 * C1): floored by decision — a continuation that trails a clause with content
 * hands the session back, and the prompt gets no hint. Named, so a new one
 * shows; their rate is printed, never excused. A continuation that only
 * LEADS asks about what follows it since round 5, and t056, t058, t059, t060
 * and t062 ("mach weiter, und danach …", "ok thanks, next: …", "passt,
 * weiter. …", "continue, but first …", "jo weida, und dann …") left this list
 * and reach their trees.
 */
const CONTINUATION_TASKS: ReadonlyMap<string, string> = new Map([
  ["t070", "\"… before you continue with the list from earlier: …\""],
]);

/** Task rows with a tree that do not reach it, each with why. Nothing else may miss. */
const KNOWN_TREE_MISSES: ReadonlyMap<string, string> = new Map([
  ...CONTINUATION_TASKS,
  ...TIED_TASKS,
  ["t040", "\"quota reset job runs at midnight twice\": job, runs and twice are closed or absent on the cron tree; the token-usage tree ranks first"],
  ["t050", "Austrian dialect, a documented residual"],
  ["t102", "\"deploy the session timeout fix to staging\": the PGlite tree's \"timeouts\" outranks"],
  ["t107", "every topic word misspelt"],
  ["t130", "\"session resume after limit reset loses context\": all machinery words; the intent-only tree ranks first, as a pointer"],
  ["t134", "\"usage window for the bot\": the quota cron tree ranks first, as a pointer"],
]);

type HintKind = "silence" | "substance" | "pointer";

interface RowOutcome {
  readonly row: Row;
  readonly calledHub: boolean;
  readonly kind: HintKind;
  /** The tree the hint names, or null. */
  readonly treeHit: string | null;
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
    throw new Error(`round-3 seed failed: ${JSON.stringify(parsed)}`);
  }
  return parsed;
};

const registerDeveloper = async (base: string, name: string): Promise<Developer> => {
  const body = await post(`${base}/api/developers`, ADMIN_TOKEN, { name, email: `${name.toLowerCase()}@round3.test` });
  const data = body["data"] as { developer: { id: string }; apiKey: string };
  return { id: data.developer.id, apiKey: data.apiKey };
};

const createdAt = (treeIndex: number, minute: number): string =>
  new Date(FIRST_TREE_AT_MS + treeIndex * HOUR_MS + minute * MINUTE_MS).toISOString();

/** One tree's records in its owner's session, in the reviewer's order: context, targets, claims, revisions. */
const treeRecords = (tree: HTree, treeIndex: number, sessionId: string): readonly { kind: string; body: Record<string, unknown> }[] => [
  {
    kind: "work_context",
    body: {
      id: tree.id,
      sessionId,
      title: tree.title,
      ...(tree.description === undefined ? {} : { description: tree.description }),
      ...(tree.intent === undefined
        ? {}
        : { intent: { summary: tree.intent, provenance: "declared", confidence: 0.9, capturedAt: createdAt(treeIndex, 0) } }),
      status: "analyzing",
      createdAt: createdAt(treeIndex, 0),
      updatedAt: createdAt(treeIndex, 30),
    },
  },
  ...(tree.targets ?? []).map((target) => ({ kind: "target", body: { workContextId: tree.id, kind: target.kind, value: target.value } })),
  ...tree.claims.map((claim, claimIndex) => ({
    kind: "claim",
    body: {
      id: claim.id,
      workContextId: tree.id,
      authorSessionId: sessionId,
      kind: claim.kind,
      body: claim.body,
      status: claim.status,
      confidence: claim.provenance === "derived" ? 0.4 : 0.8,
      captureMode: claim.provenance === "derived" ? "auto" : "agent",
      provenance: claim.provenance,
      evidenceRefs: claim.evidenceRefs ?? [],
      createdAt: createdAt(treeIndex, 1 + claimIndex),
    },
  })),
  ...tree.claims.flatMap((claim) =>
    claim.supersedes === undefined
      ? []
      : [{
          kind: "claim_edge",
          body: { id: `edge_${claim.id}`, fromClaimId: claim.id, toClaimId: claim.supersedes, kind: "supersedes", authorSessionId: sessionId, createdAt: createdAt(treeIndex, EDGE_MINUTE) },
        }],
  ),
];

const seedTree = async (base: string, owner: Developer, tree: HTree, treeIndex: number): Promise<void> => {
  const sessionId = `s_${tree.id}`;
  await post(`${base}/api/sessions`, owner.apiKey, { id: sessionId, agentKind: "claude-code", repo: REPO_ID, branch: `fix/${tree.id}`, baseCommit: "c0ffee01", status: "analyzing" });
  const records = treeRecords(tree, treeIndex, sessionId);
  const body = await post(`${base}/api/records`, owner.apiKey, {
    records: records.map((record, index) => ({
      cx: "0.1",
      id: `env_r3_${tree.id}_${String(index)}`,
      ts: (record.body["createdAt"] as string | undefined) ?? NOW.toISOString(),
      producer: { developerId: owner.id, agentKind: "claude-code", sessionId },
      kind: record.kind,
      body: record.body,
    })),
  });
  const data = body["data"] as { accepted: number };
  if (data.accepted !== records.length) {
    throw new Error(`round-3 seed ${tree.id}: ${String(data.accepted)} of ${String(records.length)} records accepted`);
  }
};

const startSeededHub = async (): Promise<Seeded> => {
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
  const developers = new Map<string, Developer>();
  for (const name of DEVELOPERS) {
    developers.set(name, await registerDeveloper(base, name));
  }
  for (const [treeIndex, tree] of TREES.entries()) {
    const owner = developers.get(tree.developer);
    if (owner === undefined) {
      throw new Error(`round-3 seed: no developer ${tree.developer}`);
    }
    await seedTree(base, owner, tree, treeIndex);
  }
  const reader = developers.get(READER);
  if (reader === undefined) {
    throw new Error(`round-3 seed: no reader ${READER}`);
  }
  return { hubUrl: base, reader, candidateCalls: () => calls, stop: () => server.stop(true) };
};

const kindOf = (hint: string): HintKind => (hint.length === 0 ? "silence" : hint.startsWith(SUBSTANCE_HEAD) ? "substance" : "pointer");

/** One row in a FRESH session — nothing delivered yet, the intent set. */
const runRow = async (row: Row): Promise<RowOutcome> => {
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
    workContextIntent: SESSION_INTENT,
    workContextIntentProvenance: "derived",
  });
  const key = repoKey(seeded.hubUrl, REPO_ID);
  const hub: HubContext = { hubUrl: seeded.hubUrl, apiKey: seeded.reader.apiKey, timeoutMs: 20_000, home, repoKey: key, now: () => NOW };
  const before = seeded.candidateCalls();
  const hint = await selectAndRenderHint({
    home,
    repoKey: key,
    hub,
    hostSessionKey: HOST_KEY,
    repoId: REPO_ID,
    repoRoot: repo,
    agentKind: "acp:holdout-round3",
    prompt: row.prompt,
    now: NOW,
  });
  return {
    row,
    calledHub: seeded.candidateCalls() > before,
    kind: kindOf(hint),
    treeHit: TREES.map((tree) => tree.id).find((id) => hint.includes(id)) ?? null,
  };
};

const rate = (part: number, whole: number): string =>
  `${String(part)}/${String(whole)} (${whole === 0 ? "0.0" : ((100 * part) / whole).toFixed(1)}%)`;

const contentFreeRows = (): readonly RowOutcome[] => outcomes.filter((outcome) => outcome.row.label === "cf");
const taskRows = (): readonly RowOutcome[] => outcomes.filter((outcome) => outcome.row.label === "task");
/** Task rows that name a tree to reach — not "no tree", not the single-word trade-off. */
const treeRows = (): readonly RowOutcome[] =>
  taskRows().filter((outcome) => typeof outcome.row.tree === "string" && outcome.row.tree !== "tradeoff");
const wrongTreeSubstance = (): readonly RowOutcome[] =>
  taskRows().filter((outcome) => outcome.kind === "substance" && outcome.treeHit !== outcome.row.tree);
const ids = (rows: readonly RowOutcome[]): readonly string[] => rows.map((outcome) => outcome.row.id);

beforeAll(async () => {
  seeded = await startSeededHub();
  home = await makeHome("holdout-round3");
  repo = await makeRepo("holdout-round3", { remote: "git@github.com:acme/platform.git" });
  const collected: RowOutcome[] = [];
  for (const row of ROWS) {
    collected.push(await runRow(row));
  }
  outcomes = collected;
  const contentFree = contentFreeRows();
  const tasks = taskRows();
  const withTree = treeRows();
  console.log(
    [
      `round-3 hold-out (training): ${String(ROWS.length)} rows, ${String(TREES.length)} trees`,
      `  content-free rows hinted:        ${rate(contentFree.filter((outcome) => outcome.kind !== "silence").length, contentFree.length)}`,
      `  content-free rows reached hub:   ${rate(contentFree.filter((outcome) => outcome.calledHub).length, contentFree.length)} (soft target ${String(100 * HOLDOUT_REACHED_HUB_SOFT_TARGET)}%)`,
      `  task rows floored:               ${rate(tasks.filter((outcome) => !outcome.calledHub).length, tasks.length)}`,
      `  task rows with a tree, reached:  ${rate(withTree.filter((outcome) => outcome.treeHit === outcome.row.tree).length, withTree.length)}`,
      `  ... of them with substance:      ${rate(withTree.filter((outcome) => outcome.kind === "substance" && outcome.treeHit === outcome.row.tree).length, withTree.length)}`,
      `  wrong-tree substance:            ${rate(wrongTreeSubstance().length, tasks.length)}`,
    ].join("\n"),
  );
}, 300_000);

afterAll(async () => {
  seeded.stop();
  await Promise.all([home, repo].map((path) => rm(path, { recursive: true, force: true })));
});

describe("the round-3 hold-out, as training data, through the whole hint pipeline", () => {
  test("is the reviewer's whole set: 186 content-free rows, 135 task rows, 35 trees", () => {
    expect(contentFreeRows()).toHaveLength(186);
    expect(taskRows()).toHaveLength(135);
    expect(TREES).toHaveLength(35);
  });

  test("(a) no content-free row is hinted, by any path", () => {
    const hinted = contentFreeRows().filter((outcome) => outcome.kind !== "silence");
    expect(ids(hinted)).toEqual([]);
    expect(hinted.length / contentFreeRows().length).toBeLessThanOrEqual(HOLDOUT_CONTENT_FREE_HINT_MAX_RATE);
  });

  test("(b) no task row is floored, but the continuation tasks (C1)", () => {
    const floored = taskRows().filter((outcome) => !outcome.calledHub && !CONTINUATION_TASKS.has(outcome.row.id));
    expect(ids(floored)).toEqual([]);
    expect(floored.length / taskRows().length).toBeLessThanOrEqual(HOLDOUT_TASK_FLOOR_MAX_RATE);
    // and every named continuation task is floored, so the list stays the decision's true cost
    expect([...CONTINUATION_TASKS.keys()].filter((id) => outcomes.find((outcome) => outcome.row.id === id)?.calledHub !== false)).toEqual([]);
  });

  test("(c) no task row is shown substance from another tree, but the named residual", () => {
    const wrong = wrongTreeSubstance();
    expect(ids(wrong).filter((id) => !ACCEPTED_WRONG_TREE_SUBSTANCE.has(id))).toEqual([]);
    expect(wrong.length / taskRows().length).toBeLessThanOrEqual(HOLDOUT_WRONG_TREE_SUBSTANCE_MAX_RATE);
  });

  test("(d) a task row with a tree reaches that tree, but the named misses", () => {
    const missed = treeRows().filter((outcome) => outcome.treeHit !== outcome.row.tree);
    expect(ids(missed).filter((id) => !KNOWN_TREE_MISSES.has(id))).toEqual([]);
    // and every named tie is silent, so the list stays the decision's true cost (C2)
    expect([...TIED_TASKS.keys()].filter((id) => outcomes.find((outcome) => outcome.row.id === id)?.kind !== "silence")).toEqual([]);
  });
});
