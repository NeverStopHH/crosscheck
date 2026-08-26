/**
 * The detached ghost-check worker (VISION.md §3) end to end: a REAL hub in
 * memory and a FAKED model binary, so what is under test is the gate, the
 * input and the guards — never a network or a token.
 *
 * The three things this file exists to prove:
 *
 *   1. THE GATE. No overlap means no model runs at all. The fake binary
 *      writes a file when it is invoked; on a quiet repo that file must not
 *      exist, and the outcome booked must be `noOverlap` rather than a
 *      failure — a quiet team is the feature working, not the runner dying.
 *   2. WHAT THE MODEL SEES. Two intent sentences and the teammate's DECLARED
 *      claims. Never a transcript, never a prompt, and never their machine
 *      DRAFTS: feeding a guess to a model that produces a guess would launder
 *      provenance one step at a time.
 *   3. WHAT MAY COME BACK. One sentence, as a Tier-1 DRAFT — derived, under
 *      the confidence cap, on the reader's OWN work context — and only after
 *      it has been checked against the very claims it was shown, so a
 *      paraphrase of Ken's finding cannot return as Alice's observation.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";
import { DERIVED_CONFIDENCE_CAP } from "@crosscheck/schema";

import {
  GHOST_DERIVED_CONFIDENCE,
  GHOST_MAX_FIRES_PER_SESSION,
} from "@crosscheck/connector-core/constants.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import { readSpoolLines } from "@crosscheck/connector-core/spool/files.ts";
import {
  readSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";
import { runGhostWorker } from "../src/ghost/worker.ts";

const ADMIN_TOKEN = "ghost-worker-admin";
const REPO_ID = "github.com/acme/api";
const TITLE = "detached@0badc0f · fix: refresh 500s @ api";
const SHARED = ["src/auth/token.ts", "src/auth/session.ts"] as const;
const MY_INTENT = "Make verifyToken refetch the JWKS on an unknown kid";
const THEIR_INTENT = "Move the session store behind an interface";
const THEIR_DECLARED = "verifyToken returns null on an unknown kid today";
const THEIR_DRAFT = "the session store probably caches the old kid";
const COLLISION = "Both change what verifyToken returns for an unknown kid";

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
const paths: string[] = [];

interface Account {
  readonly developerId: string;
  readonly apiKey: string;
  readonly sessionId: string;
  readonly workContextId: string;
}

let alice: Account;
let ken: Account;

const tempDir = async (label: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), `cx-${label}-`));
  paths.push(dir);
  return dir;
};

const post = async (path: string, apiKey: string, body: unknown): Promise<Response> =>
  fetch(`${hubUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const envelopeFor = (
  account: Account,
  kind: string,
  body: Record<string, unknown>,
): Record<string, unknown> => ({
  cx: "0.1",
  id: `env_${crypto.randomUUID()}`,
  ts: new Date().toISOString(),
  producer: {
    developerId: account.developerId,
    agentKind: "claude-code",
    sessionId: account.sessionId,
  },
  kind,
  body,
});

const seed = async (
  account: Account,
  records: readonly Record<string, unknown>[],
): Promise<void> => {
  const response = await post("/api/records", account.apiKey, { records });
  const parsed = (await response.json()) as {
    data: { rejected: number; results?: unknown };
  };
  if (parsed.data.rejected > 0) {
    throw new Error(`seed rejected: ${JSON.stringify(parsed.data.results)}`);
  }
};

const createAccount = async (
  name: string,
  email: string,
  label: string,
): Promise<Account> => {
  const created = await post("/api/developers", ADMIN_TOKEN, { name, email });
  const parsed = (await created.json()) as {
    data: { developer: { id: string }; apiKey: string };
  };
  const sessionId = `cc_${label}-uuid`;
  const account: Account = {
    developerId: parsed.data.developer.id,
    apiKey: parsed.data.apiKey,
    sessionId,
    workContextId: `wc_${sessionId}`,
  };
  await post("/api/sessions", account.apiKey, {
    id: sessionId,
    agentKind: "claude-code",
    repo: REPO_ID,
    branch: "detached@0badc0f",
    baseCommit: "a1b2c3d4",
    status: "analyzing",
  });
  return account;
};

interface FakeOptions {
  readonly output?: string;
  readonly stdinDump?: string;
  readonly invokedMarker?: string;
  readonly exitCode?: number;
}

/** An executable the runner can spawn: a /bin/sh wrapper around a bun script. */
const makeFakeModel = async (options: FakeOptions): Promise<string> => {
  const dir = await tempDir("ghost-model");
  const script = join(dir, "fake-model.ts");
  await writeFile(
    script,
    [
      "const stdin = await Bun.stdin.text();",
      options.invokedMarker === undefined
        ? ""
        : `await Bun.write(${JSON.stringify(options.invokedMarker)}, "yes");`,
      options.stdinDump === undefined
        ? ""
        : `await Bun.write(${JSON.stringify(options.stdinDump)}, stdin);`,
      `process.stdout.write(${JSON.stringify(options.output ?? "NONE")});`,
      options.exitCode === undefined
        ? ""
        : `process.exitCode = ${String(options.exitCode)};`,
    ].join("\n"),
    "utf8",
  );
  const wrapper = join(dir, "fake-model.sh");
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`, "utf8");
  await chmod(wrapper, 0o755);
  return wrapper;
};

interface Fixture {
  readonly home: string;
  readonly repo: string;
  readonly hostSessionKey: string;
  readonly key: string;
  readonly env: Record<string, string>;
}

/** Alice's machine, as the prompt hook leaves it when it claims the debt. */
const aliceFixture = async (
  label: string,
  model: string,
  stateOverrides: Partial<SessionState> = {},
): Promise<Fixture> => {
  const home = await makeHome(`ghost-${label}`);
  const repo = await makeRepo(`ghost-${label}`, {
    remote: "git@github.com:acme/api.git",
  });
  paths.push(home, repo);
  const hostSessionKey = "gw-alice-uuid";
  await writeSessionState(home, {
    hostSessionKey,
    crosscheckSessionId: alice.sessionId,
    workContextId: alice.workContextId,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl,
    developerId: alice.developerId,
    startedAt: new Date().toISOString(),
    workContextTitle: TITLE,
    workContextStatus: "analyzing",
    workContextIntent: MY_INTENT,
    ghostPending: false,
    ...stateOverrides,
  });
  return {
    home,
    repo,
    hostSessionKey,
    key: repoKey(hubUrl, REPO_ID),
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: alice.apiKey,
      CROSSCHECK_SUMMARIZER_CMD: model,
    },
  };
};

const stateOf = async (fix: Fixture): Promise<SessionState> => {
  const state = await readSessionState(fix.home, fix.hostSessionKey);
  if (state === null) {
    throw new Error("no session state");
  }
  return state;
};

interface SpooledClaim {
  readonly kind: string;
  readonly body: {
    readonly workContextId: string;
    readonly kind: string;
    readonly body: string;
    readonly status: string;
    readonly confidence: number;
    readonly captureMode: string;
    readonly provenance: string;
  };
}

const spooledClaims = async (fix: Fixture): Promise<readonly SpooledClaim[]> => {
  const lines = await readSpoolLines(fix.home, fix.key);
  return lines
    .map((line) => JSON.parse(line) as SpooledClaim)
    .filter((record) => record.kind === "claim");
};

beforeAll(async () => {
  db = await createDb();
  server = Bun.serve({
    port: 0,
    fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch,
  });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  alice = await createAccount("Alice", "alice-gw@example.com", "gw-alice");
  ken = await createAccount("Ken", "ken-gw@example.com", "gw-ken");
  // Alice's own live plan: the context, its targets, and the intent the hub
  // holds. Her own state file carries the same sentence.
  await seed(alice, [
    envelopeFor(alice, "work_context", {
      id: alice.workContextId,
      sessionId: alice.sessionId,
      title: TITLE,
      status: "analyzing",
      createdAt: new Date().toISOString(),
      intent: {
        summary: MY_INTENT,
        provenance: "declared",
        confidence: 1,
        capturedAt: new Date().toISOString(),
      },
    }),
    ...SHARED.map((value) =>
      envelopeFor(alice, "target", {
        workContextId: alice.workContextId,
        kind: "file",
        value,
      }),
    ),
  ]);
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

/** Ken's overlapping plan, added only by the tests that need an overlap. */
const seedKensOverlap = async (): Promise<void> => {
  await seed(ken, [
    envelopeFor(ken, "work_context", {
      id: ken.workContextId,
      sessionId: ken.sessionId,
      title: "Session store migration",
      status: "implementing",
      createdAt: new Date().toISOString(),
      intent: {
        summary: THEIR_INTENT,
        provenance: "declared",
        confidence: 1,
        capturedAt: new Date().toISOString(),
      },
    }),
    ...SHARED.map((value) =>
      envelopeFor(ken, "target", {
        workContextId: ken.workContextId,
        kind: "file",
        value,
      }),
    ),
    envelopeFor(ken, "claim", {
      id: "clm_ken_declared",
      workContextId: ken.workContextId,
      authorSessionId: ken.sessionId,
      kind: "observation",
      body: THEIR_DECLARED,
      status: "proposed",
      confidence: 0.8,
      captureMode: "agent",
      provenance: "declared",
      evidenceRefs: [],
      createdAt: new Date().toISOString(),
    }),
    envelopeFor(ken, "claim", {
      id: "clm_ken_draft",
      workContextId: ken.workContextId,
      authorSessionId: ken.sessionId,
      kind: "hypothesis",
      body: THEIR_DRAFT,
      status: "proposed",
      confidence: 0.4,
      captureMode: "auto",
      provenance: "derived",
      evidenceRefs: [],
      createdAt: new Date().toISOString(),
    }),
  ]);
};

describe("the gated ghost check", () => {
  test("nobody to collide with costs no model call at all", async () => {
    const marker = join(await tempDir("ghost-marker"), "invoked");
    const model = await makeFakeModel({ output: COLLISION, invokedMarker: marker });
    const quiet = await aliceFixture("quiet", model);

    // Ken has not been seeded yet: the hub holds nobody in Alice's files.
    expect(await runGhostWorker(["--session", quiet.hostSessionKey], quiet.env)).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(false);
    const state = await stateOf(quiet);
    expect(state.ghostNoOverlapCount).toBe(1);
    expect(state.ghostFireCount).toBe(0);
    expect(state.ghostFailCount).toBe(0);
    expect(await spooledClaims(quiet)).toEqual([]);

    // THE CONTROL: the same worker, the same fixture shape, with a teammate
    // in the same files — the binary IS invoked and the fire IS booked. So
    // the silence above is the gate, not a worker that never runs.
    await seedKensOverlap();
    const busy = await aliceFixture("busy", model);
    expect(await runGhostWorker(["--session", busy.hostSessionKey], busy.env)).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(true);
    const after = await stateOf(busy);
    expect(after.ghostFireCount).toBe(1);
    expect(after.ghostNoOverlapCount).toBe(0);
  });

  test("the model sees two intents and DECLARED claims, never a draft", async () => {
    const dump = join(await tempDir("ghost-dump"), "stdin.txt");
    const model = await makeFakeModel({ output: "NONE", stdinDump: dump });
    const fix = await aliceFixture("input", model);

    await runGhostWorker(["--session", fix.hostSessionKey], fix.env);
    const stdin = await Bun.file(dump).text();
    expect(stdin).toContain(MY_INTENT);
    expect(stdin).toContain(THEIR_INTENT);
    expect(stdin).toContain(THEIR_DECLARED);
    // Ken's machine-derived draft is on the same tree and must not be here:
    // a guess fed to a model that produces a guess is provenance laundering.
    expect(stdin).not.toContain(THEIR_DRAFT);
    // And an explicit NONE is an answer, not a failure.
    const state = await stateOf(fix);
    expect(state.ghostNoneCount).toBe(1);
    expect(state.ghostFailCount).toBe(0);
    expect(await spooledClaims(fix)).toEqual([]);
  });

  test("a collision becomes a derived draft on MY own work context", async () => {
    const model = await makeFakeModel({ output: COLLISION });
    const fix = await aliceFixture("draft", model);

    await runGhostWorker(["--session", fix.hostSessionKey], fix.env);
    const claims = await spooledClaims(fix);
    expect(claims.length).toBe(1);
    const claim = claims[0]?.body;
    expect(claim?.body).toBe(COLLISION);
    expect(claim?.workContextId).toBe(alice.workContextId);
    expect(claim?.kind).toBe("hypothesis");
    expect(claim?.status).toBe("proposed");
    expect(claim?.provenance).toBe("derived");
    expect(claim?.captureMode).toBe("auto");
    expect(claim?.confidence).toBe(GHOST_DERIVED_CONFIDENCE);
    expect(claim?.confidence).toBeLessThanOrEqual(DERIVED_CONFIDENCE_CAP);
    expect((await stateOf(fix)).ghostDraftCount).toBe(1);
  });

  test("a sentence that parrots what it was shown is dropped", async () => {
    // The model returns Ken's own claim line, verbatim, as its "finding".
    const parrot = await makeFakeModel({
      output: `observation (proposed): ${THEIR_DECLARED}`,
    });
    const echoed = await aliceFixture("echo", parrot);
    await runGhostWorker(["--session", echoed.hostSessionKey], echoed.env);
    expect(await spooledClaims(echoed)).toEqual([]);
    const state = await stateOf(echoed);
    expect(state.ghostFailCount).toBe(1);
    expect(state.ghostLastFailure).toContain("repeats a claim it was shown");
    expect(state.ghostDraftCount).toBe(0);

    // THE CONTROL: an ORIGINAL sentence from the identical setup is spooled,
    // so what dropped the draft above is the echo rule and nothing else.
    const original = await makeFakeModel({ output: COLLISION });
    const fresh = await aliceFixture("echo-control", original);
    await runGhostWorker(["--session", fresh.hostSessionKey], fresh.env);
    expect((await spooledClaims(fresh)).length).toBe(1);
  });

  test("a credential-shaped sentence never reaches the spool", async () => {
    const leaky = await makeFakeModel({
      output: "Both plans hardcode AKIAIOSFODNN7EXAMPLE in the client",
    });
    const fix = await aliceFixture("secret", leaky);
    await runGhostWorker(["--session", fix.hostSessionKey], fix.env);
    expect(await spooledClaims(fix)).toEqual([]);
    const state = await stateOf(fix);
    expect(state.ghostFailCount).toBe(1);
    expect(state.ghostLastFailure).toContain("secret-like text");
  });

  test("one check per session, whatever fires again", async () => {
    const marker = join(await tempDir("ghost-cap"), "invoked");
    const model = await makeFakeModel({ output: COLLISION, invokedMarker: marker });
    const spent = await aliceFixture("cap", model, {
      ghostFireCount: GHOST_MAX_FIRES_PER_SESSION,
    });
    await runGhostWorker(["--session", spent.hostSessionKey], spent.env);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect((await stateOf(spent)).ghostFireCount).toBe(GHOST_MAX_FIRES_PER_SESSION);

    // THE CONTROL: the identical fixture with the allowance unspent does run.
    const allowed = await aliceFixture("cap-control", model);
    await runGhostWorker(["--session", allowed.hostSessionKey], allowed.env);
    expect(await Bun.file(marker).exists()).toBe(true);
  });

  test("a runner loss is booked with its reason, and nothing is spooled", async () => {
    const fix = await aliceFixture("loss", "/nonexistent/ghost-model");
    expect(await runGhostWorker(["--session", fix.hostSessionKey], fix.env)).toBe(0);
    expect(await spooledClaims(fix)).toEqual([]);
    const state = await stateOf(fix);
    expect(state.ghostFireCount).toBe(1);
    expect(state.ghostFailCount).toBe(1);
    expect(state.ghostLastFailure).not.toBeNull();
  });

  test("a session with no intent of its own compares nothing", async () => {
    const marker = join(await tempDir("ghost-noplan"), "invoked");
    const model = await makeFakeModel({ output: COLLISION, invokedMarker: marker });
    const fix = await aliceFixture("noplan", model, { workContextIntent: null });
    await runGhostWorker(["--session", fix.hostSessionKey], fix.env);
    expect(await Bun.file(marker).exists()).toBe(false);
    const state = await stateOf(fix);
    expect(state.ghostFireCount).toBe(0);
    expect(state.ghostNoOverlapCount).toBe(0);
    expect(state.ghostFailCount).toBe(0);

    // THE CONTROL: the same fixture WITH a plan runs the check.
    const planned = await aliceFixture("noplan-control", model);
    await runGhostWorker(["--session", planned.hostSessionKey], planned.env);
    expect(await Bun.file(marker).exists()).toBe(true);
  });
});
