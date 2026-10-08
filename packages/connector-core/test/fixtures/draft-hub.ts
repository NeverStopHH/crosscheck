/**
 * A REAL in-process hub (createServer over PGlite) holding one developer's
 * own Tier-1 drafts at chosen ages — the draft review nudge's suites in all
 * four packages read the same `GET /api/drafts` the briefing does, so the
 * owner filter, the supersedes filter and the listing order are the hub's,
 * never a stub's. Port 0, loopback only; one hub per test file.
 */
import { serveLoopback } from "./loopback-serve.ts";
import { createDb, createServer } from "@crosscheck/server";

export interface SeedDraft {
  readonly kind: string;
  readonly body: string;
  /** How long ago the draft was captured. */
  readonly ageMs: number;
}

export interface DraftHub {
  readonly hubUrl: string;
  readonly apiKey: string;
  readonly developerId: string;
  /** The crosscheck session id the drafts are authored under. */
  readonly sessionId: string;
  readonly workContextId: string;
  readonly seedDraft: (draft: SeedDraft) => Promise<string>;
  readonly close: () => Promise<void>;
}

const authed = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

const postJson = async (url: string, token: string, body: unknown): Promise<Response> => {
  const response = await fetch(url, {
    method: "POST",
    headers: authed(token),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`draft hub POST ${url} failed: ${String(response.status)} ${await response.text()}`);
  }
  return response;
};

export interface BootDraftHubInput {
  readonly label: string;
  readonly repoId: string;
  /** The crosscheck session id (`cc_<host key>`) the session state will carry. */
  readonly sessionId: string;
  readonly workContextId: string;
}

export const bootDraftHub = async (input: BootDraftHubInput): Promise<DraftHub> => {
  const db = await createDb();
  const adminToken = `${input.label}-admin`;
  const app = createServer({ db, adminToken });
  const server = serveLoopback({ port: 0, fetch: app.fetch });
  const hubUrl = `http://127.0.0.1:${String(server.port)}`;
  const created = await postJson(`${hubUrl}/api/developers`, adminToken, {
    name: "Draft Dev",
    email: `${input.label}@example.com`,
  });
  const account = (await created.json()) as {
    data: { developer: { id: string }; apiKey: string };
  };
  const apiKey = account.data.apiKey;
  const developerId = account.data.developer.id;
  const post = (kind: string, body: unknown): Promise<Response> =>
    postJson(`${hubUrl}/api/records`, apiKey, {
      records: [
        {
          cx: "0.1",
          id: `env_${crypto.randomUUID()}`,
          ts: new Date().toISOString(),
          producer: { developerId, agentKind: "claude-code", sessionId: input.sessionId },
          kind,
          body,
        },
      ],
    });
  await postJson(`${hubUrl}/api/sessions`, apiKey, {
    id: input.sessionId,
    agentKind: "claude-code",
    repo: input.repoId,
    branch: "main",
    baseCommit: "a1b2c3d4",
    status: "analyzing",
  });
  await post("work_context", {
    id: input.workContextId,
    sessionId: input.sessionId,
    title: "Draft Dev's investigation",
    status: "analyzing",
    createdAt: new Date().toISOString(),
  });
  let seeded = 0;
  const seedDraft = async (draft: SeedDraft): Promise<string> => {
    seeded += 1;
    const id = `clm_${input.label.replace(/[^a-z0-9]/gi, "")}_${String(seeded)}`;
    await post("claim", {
      id,
      workContextId: input.workContextId,
      authorSessionId: input.sessionId,
      kind: draft.kind,
      body: draft.body,
      status: "proposed",
      confidence: 0.3,
      captureMode: "auto",
      provenance: "derived",
      evidenceRefs: [],
      createdAt: new Date(Date.now() - draft.ageMs).toISOString(),
    });
    return id;
  };
  return {
    hubUrl,
    apiKey,
    developerId,
    sessionId: input.sessionId,
    workContextId: input.workContextId,
    seedDraft,
    close: async () => {
      server.stop(true);
      await (db as unknown as { $client: { close: () => Promise<void> } }).$client
        .close()
        .catch(() => undefined);
    },
  };
};
