/**
 * THE CORPUS HUB: a real in-memory hub seeded with the labelled corpus's trees
 * (schema/test/fixtures/prompt-corpus.ts) — each one of Ken's work contexts,
 * with its declared claims and its unreviewed drafts — read by Robin. Shared
 * by the corpus gate (prompt-corpus-gate.test.ts) and the floor-parity test
 * (content-floor-parity.test.ts), so both read one seeded world.
 */
import { createDb, createServer } from "@crosscheck/server";

import { CORPUS_TREES } from "../../../schema/test/fixtures/prompt-corpus.ts";

export const CORPUS_REPO_ID = "github.com/acme/api";
export const CORPUS_NOW = new Date("2026-10-06T10:00:00.000Z");
const ADMIN_TOKEN = "prompt-corpus-admin";
const CREATED = "2026-10-05T10:00:00.000Z";
const OWNER_SESSION = "ses_ken";

export interface CorpusHub {
  readonly hubUrl: string;
  readonly readerKey: string;
  readonly readerId: string;
  /** The hub's own database, for a test that asks the hub's services directly. */
  readonly db: Awaited<ReturnType<typeof createDb>>;
  readonly candidateCalls: () => number;
  readonly stop: () => void;
}

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
    repo: CORPUS_REPO_ID,
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

export const startCorpusHub = async (): Promise<CorpusHub> => {
  const db = await createDb();
  const app = createServer({ db, now: () => CORPUS_NOW, adminToken: ADMIN_TOKEN, embedder: null });
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
  return { hubUrl: base, readerKey: reader.apiKey, readerId: reader.id, db, candidateCalls: () => calls, stop: () => server.stop(true) };
};
