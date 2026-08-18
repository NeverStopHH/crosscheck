/**
 * review_draft against a REAL hub (createServer over PGlite), like
 * mcp-tools.test.ts: the promotion loop's write half (DESIGN.md §3 Tier 1).
 * Confirm and edit mint a DECLARED revision plus a supersedes edge on the
 * draft; discard mints a REJECTED revision the same append-only way. The
 * draft row itself is never mutated — "reviewed" is a graph fact.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import { prepareMcp } from "../src/mcp/context.ts";
import type { McpContext } from "../src/mcp/context.ts";
import { findTool } from "../src/mcp/tools/index.ts";
import { writeSessionState } from "../src/state/session-state.ts";
import type { Env } from "../src/index.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ADMIN_TOKEN = "review-admin-token";
const REPO_ID = "github.com/acme/api";

let db: Db;
let app: ReturnType<typeof createServer>;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
const cleanups: string[] = [];

interface Developer {
  readonly developerId: string;
  readonly apiKey: string;
  readonly home: string;
  readonly repo: string;
  readonly env: Env;
  readonly sessionId: string;
  readonly workContextId: string;
}

let alice: Developer;

const authed = (apiKey: string): Record<string, string> => ({
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
});

const createDeveloper = async (
  name: string,
  email: string,
): Promise<{ developerId: string; apiKey: string }> => {
  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: authed(ADMIN_TOKEN),
    body: JSON.stringify({ name, email }),
  });
  const body = (await response.json()) as {
    data: { developer: { id: string }; apiKey: string };
  };
  return { developerId: body.data.developer.id, apiKey: body.data.apiKey };
};

const postRecord = async (
  apiKey: string,
  sessionId: string,
  developerId: string,
  kind: string,
  body: unknown,
): Promise<void> => {
  await fetch(`${hubUrl}/api/records`, {
    method: "POST",
    headers: authed(apiKey),
    body: JSON.stringify({
      records: [
        {
          cx: "0.1",
          id: `env_${crypto.randomUUID()}`,
          ts: new Date().toISOString(),
          producer: { developerId, agentKind: "claude-code", sessionId },
          kind,
          body,
        },
      ],
    }),
  });
};

const setUpDeveloper = async (
  label: string,
  name: string,
  email: string,
): Promise<Developer> => {
  const account = await createDeveloper(name, email);
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  cleanups.push(home, repo);
  const sessionId = `cc_${label}-uuid`;
  const workContextId = `wc_${sessionId}`;
  const startedAt = new Date().toISOString();
  await fetch(`${hubUrl}/api/sessions`, {
    method: "POST",
    headers: authed(account.apiKey),
    body: JSON.stringify({
      id: sessionId,
      agentKind: "claude-code",
      repo: REPO_ID,
      branch: "main",
      baseCommit: "a1b2c3d4",
      status: "analyzing",
    }),
  });
  await postRecord(account.apiKey, sessionId, account.developerId, "work_context", {
    id: workContextId,
    sessionId,
    title: `${name}'s investigation`,
    status: "analyzing",
    createdAt: startedAt,
  });
  await writeSessionState(home, {
    hostSessionKey: `${label}-uuid`,
    crosscheckSessionId: sessionId,
    workContextId,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl,
    developerId: account.developerId,
    startedAt,
  });
  return {
    ...account,
    home,
    repo,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: account.apiKey,
    },
    sessionId,
    workContextId,
  };
};

let draftCounter = 0;

/** One fresh unreviewed draft on Alice's context; returns its claim id. */
const seedDraft = async (body: string): Promise<string> => {
  draftCounter += 1;
  const id = `clm_draft_${String(draftCounter)}`;
  await postRecord(alice.apiKey, alice.sessionId, alice.developerId, "claim", {
    id,
    workContextId: alice.workContextId,
    authorSessionId: alice.sessionId,
    kind: "hypothesis",
    body,
    status: "proposed",
    confidence: 0.4,
    captureMode: "auto",
    provenance: "derived",
    evidenceRefs: [],
    createdAt: new Date().toISOString(),
  });
  return id;
};

const contextFor = async (developer: Developer): Promise<McpContext> => {
  const setup = await prepareMcp(developer.env, developer.repo);
  if (!setup.ok) {
    throw new Error(`prepareMcp failed: ${setup.message}`);
  }
  return setup.ctx;
};

const review = async (
  args: unknown,
): Promise<{ text: string; isError: boolean }> => {
  const tool = findTool("review_draft");
  if (tool === undefined) {
    throw new Error("no tool review_draft");
  }
  const result = await tool.run(await contextFor(alice), args);
  return {
    text: result.content.map((part) => part.text).join("\n"),
    isError: result.isError === true,
  };
};

const fetchDrafts = async (): Promise<readonly { id: string }[]> => {
  const response = await fetch(
    `${hubUrl}/api/drafts?repo=${encodeURIComponent(REPO_ID)}`,
    { headers: authed(alice.apiKey) },
  );
  const body = (await response.json()) as {
    data: { drafts: { id: string }[] };
  };
  return body.data.drafts;
};

interface DiagnosisClaimRow {
  readonly id: string;
  readonly body: string;
  readonly status: string;
  readonly provenance: string;
  readonly captureMode: string;
}

interface DiagnosisEdgeRow {
  readonly fromClaimId: string;
  readonly toClaimId: string;
  readonly kind: string;
}

const fetchDiagnosis = async (): Promise<{
  claims: readonly DiagnosisClaimRow[];
  edges: readonly DiagnosisEdgeRow[];
}> => {
  const response = await fetch(
    `${hubUrl}/api/work-contexts/${alice.workContextId}/diagnosis`,
    { headers: authed(alice.apiKey) },
  );
  const body = (await response.json()) as {
    data: {
      claims: DiagnosisClaimRow[];
      edges: DiagnosisEdgeRow[];
    };
  };
  return body.data;
};

beforeAll(async () => {
  db = await createDb();
  app = createServer({ db, adminToken: ADMIN_TOKEN });
  server = Bun.serve({ port: 0, fetch: app.fetch });
  hubUrl = `http://127.0.0.1:${server.port}`;
  alice = await setUpDeveloper("review-alice", "Alice", "alice@example.com");
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("review_draft", () => {
  test("confirm mints a declared revision plus a supersedes edge", async () => {
    // Arrange
    const draftId = await seedDraft("The reap grace window is too short");

    // Act
    const { text, isError } = await review({
      draft_claim_id: draftId,
      action: "confirm",
    });

    // Assert
    expect(isError).toBe(false);
    const { claims, edges } = await fetchDiagnosis();
    const promoted = claims.find(
      (claim) =>
        claim.body === "The reap grace window is too short" &&
        claim.provenance === "declared",
    );
    expect(promoted).toBeDefined();
    expect(promoted?.captureMode).toBe("agent");
    expect(text).toContain(promoted?.id ?? "");
    // The edge points AT the draft (append-only review)
    expect(
      edges.some(
        (edge) =>
          edge.kind === "supersedes" &&
          edge.toClaimId === draftId &&
          edge.fromClaimId === promoted?.id,
      ),
    ).toBe(true);
    // The draft row still exists, unmutated
    const draftRow = claims.find((claim) => claim.id === draftId);
    expect(draftRow?.provenance).toBe("derived");
    expect(draftRow?.status).toBe("proposed");
    // And it is no longer an unreviewed draft
    expect((await fetchDrafts()).map((draft) => draft.id)).not.toContain(
      draftId,
    );
  });

  test("discard mints a rejected revision via the same mechanics", async () => {
    const draftId = await seedDraft("A guess that turned out worthless");

    const { isError } = await review({
      draft_claim_id: draftId,
      action: "discard",
    });

    expect(isError).toBe(false);
    const { claims, edges } = await fetchDiagnosis();
    const discard = claims.find(
      (claim) =>
        claim.body === "A guess that turned out worthless" &&
        claim.status === "rejected",
    );
    expect(discard).toBeDefined();
    // The discard revision stays derived — nobody vouched for the content
    expect(discard?.provenance).toBe("derived");
    expect(
      edges.some(
        (edge) => edge.kind === "supersedes" && edge.toClaimId === draftId,
      ),
    ).toBe(true);
    expect((await fetchDrafts()).map((draft) => draft.id)).not.toContain(
      draftId,
    );
  });

  test("edit promotes with the corrected body", async () => {
    const draftId = await seedDraft("The cursor is somehow wrong");

    const { isError, text } = await review({
      draft_claim_id: draftId,
      action: "edit",
      body: "The cursor offset is computed against the pre-reap file",
    });

    expect(isError).toBe(false);
    expect(text).toContain("cursor offset");
    const { claims } = await fetchDiagnosis();
    const edited = claims.find(
      (claim) =>
        claim.body === "The cursor offset is computed against the pre-reap file",
    );
    expect(edited?.provenance).toBe("declared");
  });

  test("edit without a body is refused with a usable sentence", async () => {
    const draftId = await seedDraft("Draft that needs editing");
    const { isError, text } = await review({
      draft_claim_id: draftId,
      action: "edit",
    });
    expect(isError).toBe(true);
    expect(text).toContain("body");
  });

  test("an id that is not among the caller's unreviewed drafts is refused", async () => {
    const { isError, text } = await review({
      draft_claim_id: "clm_never_existed",
      action: "confirm",
    });
    expect(isError).toBe(true);
    expect(text).toContain("unreviewed draft");
  });

  test("a reviewed draft cannot be reviewed twice", async () => {
    const draftId = await seedDraft("Reviewed exactly once");
    await review({ draft_claim_id: draftId, action: "confirm" });

    const { isError, text } = await review({
      draft_claim_id: draftId,
      action: "confirm",
    });

    expect(isError).toBe(true);
    expect(text).toContain("unreviewed draft");
  });

  test("an edit body that trips the secret scan is refused", async () => {
    const draftId = await seedDraft("Innocent draft body");
    const { isError, text } = await review({
      draft_claim_id: draftId,
      action: "edit",
      body: "The loader leaks AKIAABCDEFGHIJKLMNOP into the log",
    });
    expect(isError).toBe(true);
    expect(text.toLowerCase()).toContain("secret");
    // The draft is still unreviewed — nothing was posted
    expect((await fetchDrafts()).map((draft) => draft.id)).toContain(draftId);
  });
});
