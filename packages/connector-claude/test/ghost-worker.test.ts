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
import { DERIVED_CONFIDENCE_CAP, MAX_INTENT_SUMMARY_CHARS } from "@crosscheck/schema";

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
import { intentSummaryOf, runGhostWorker } from "@crosscheck/connector-core/derive/ghost/worker.ts";

const ADMIN_TOKEN = "ghost-worker-admin";
const REPO_ID = "github.com/acme/api";
const TITLE = "detached@0badc0f · fix: refresh 500s @ api";
const SHARED = ["src/auth/token.ts", "src/auth/session.ts"] as const;
const MY_INTENT = "Make verifyToken refetch the JWKS on an unknown kid";
const THEIR_INTENT = "Move the session store behind an interface";
const THEIR_DECLARED = "verifyToken returns null on an unknown kid today";
/**
 * A LEGAL declared observation longer than GHOST_SENTENCE_MAX_CHARS, and a
 * legal one carrying a line break. Both are ordinary claim bodies — the hub
 * caps a body at MAX_CLAIM_BODY_LENGTH = 400 — and both survive every
 * reduction the answer takes on its way out, which is what makes them the
 * shapes a hash of the WHOLE body can never match.
 */
const THEIR_LONG =
  "verifyToken returns null on an unknown kid today, and the JWKS cache is " +
  "only refreshed by the hourly timer, so a rotated key rejects every request " +
  "until that timer fires again — which is the failure the retry budget was " +
  "meant to absorb and does not";
const THEIR_MULTILINE =
  "The session store keeps the decoded claims, not the raw token.\n" +
  "Anything that re-reads the kid therefore has to go back to the cache.";
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
  gitTouchCount: 0,
  gitLaneSkipped: 0,
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
      id: "clm_ken_long",
      workContextId: ken.workContextId,
      authorSessionId: ken.sessionId,
      kind: "observation",
      body: THEIR_LONG,
      status: "proposed",
      confidence: 0.8,
      captureMode: "agent",
      provenance: "declared",
      evidenceRefs: [],
      createdAt: new Date().toISOString(),
    }),
    envelopeFor(ken, "claim", {
      id: "clm_ken_multiline",
      workContextId: ken.workContextId,
      authorSessionId: ken.sessionId,
      kind: "observation",
      body: THEIR_MULTILINE,
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
    // The sentence, and then WHOSE plan it collides with — a draft that named
    // nobody would leave the reader a finding with no next action: they could
    // not open the tree and could not tell who to talk to.
    expect(claim?.body).toBe(
      `Ken's live plan collides: ${COLLISION} — get_diagnosis ${ken.workContextId}`,
    );
    expect(claim?.workContextId).toBe(alice.workContextId);
    expect(claim?.kind).toBe("hypothesis");
    expect(claim?.status).toBe("proposed");
    expect(claim?.provenance).toBe("derived");
    expect(claim?.captureMode).toBe("auto");
    expect(claim?.confidence).toBe(GHOST_DERIVED_CONFIDENCE);
    expect(claim?.confidence).toBeLessThanOrEqual(DERIVED_CONFIDENCE_CAP);
    expect((await stateOf(fix)).ghostDraftCount).toBe(1);
  });

  /**
   * The ghost check's half of the same defect. Its answer is a SENTENCE too,
   * and it took the first non-empty line of raw stdout whatever that line
   * was — so a wrapper carrying the summarizer's instruction (the documented
   * foreign-model example does exactly that) turned claim JSON into a
   * `hypothesis` claim body, published to the team under this developer's
   * name with `ghostDraft` booked as a success.
   */
  test("a wrapper answering the summarizer's task never becomes a ghost draft", async () => {
    // Arrange
    const model = await makeFakeModel({
      output: JSON.stringify({
        kind: "root_cause",
        body: "The lease is renewed after it expires, so every worker loses its claim.",
        confidence: 0.9,
      }),
    });
    const fix = await aliceFixture("not-a-sentence", model);

    // Act
    await runGhostWorker(["--session", fix.hostSessionKey], fix.env);

    // Assert
    expect(await spooledClaims(fix)).toEqual([]);
    const state = await stateOf(fix);
    expect(state.ghostDraftCount).toBe(0);
    expect(state.ghostFailCount).toBe(1);
    expect(state.ghostLastFailure).toContain("not a sentence");
  });

  test("a reasoning model's scratchpad is stripped before the sentence is taken", async () => {
    const model = await makeFakeModel({
      output: `<think>\ncomparing the two plans line by line\n</think>\n${COLLISION}\n`,
    });
    const fix = await aliceFixture("ghost-reasoning", model);

    await runGhostWorker(["--session", fix.hostSessionKey], fix.env);

    const claims = await spooledClaims(fix);
    expect(claims.length).toBe(1);
    expect(claims[0]?.body.body).toBe(
      `Ken's live plan collides: ${COLLISION} — get_diagnosis ${ken.workContextId}`,
    );
  }, 20_000);

  // Six worker runs, each spawning a fake model process, in one test. Bun's
  // 5 s default is not enough for that on an idle laptop, and a timeout here
  // reads as "the echo guard broke" rather than as "the machine was busy".
  const PARROT_TIMEOUT_MS = 60_000;

  test("a sentence that parrots what it was shown is dropped", async () => {
    // Ken's own claim, in the five shapes a parroting model returns it: the
    // BODY on its own (what a model told "never repeat the input" actually
    // produces when it does), the body re-cased and re-spaced, and the whole
    // labelled line it was handed. Only the last of those carries the
    // "kind (status): " prefix, so a guard keyed on the line rather than on
    // the claim would catch the shape nobody sends and miss the two real ones.
    const shapes: readonly (readonly [string, string])[] = [
      ["the body verbatim", THEIR_DECLARED],
      ["the body re-cased", `  ${THEIR_DECLARED.toUpperCase()}  `],
      ["the labelled line", `observation (proposed): ${THEIR_DECLARED}`],
      // The two shapes an EQUALITY hash can never match, because the answer
      // is reduced twice on its way out — the first non-empty LINE, then
      // GHOST_SENTENCE_MAX_CHARS — while the hash is taken over the whole
      // body. A teammate can force either deliberately by writing a long or
      // multi-line declared claim whose opening they want republished under
      // somebody else's name.
      ["a body longer than the sentence bound", THEIR_LONG],
      ["a body with a line break", THEIR_MULTILINE],
    ];
    for (const [label, output] of shapes) {
      const parrot = await makeFakeModel({ output });
      const echoed = await aliceFixture(`echo-${label.replace(/\s+/g, "-")}`, parrot);
      await runGhostWorker(["--session", echoed.hostSessionKey], echoed.env);
      expect(await spooledClaims(echoed), label).toEqual([]);
      const state = await stateOf(echoed);
      expect(state.ghostFailCount, label).toBe(1);
      expect(state.ghostLastFailure, label).toContain(
        "repeats a claim it was shown",
      );
      expect(state.ghostDraftCount, label).toBe(0);
    }

    // THE CONTROL: an ORIGINAL sentence from the identical setup is spooled,
    // so what dropped the draft above is the echo rule and nothing else.
    const original = await makeFakeModel({ output: COLLISION });
    const fresh = await aliceFixture("echo-control", original);
    await runGhostWorker(["--session", fresh.hostSessionKey], fresh.env);
    expect((await spooledClaims(fresh)).length).toBe(1);
  }, PARROT_TIMEOUT_MS);

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

  test("a hub that cannot answer is a deployment state, not a loss", async () => {
    const marker = join(await tempDir("ghost-oldhub"), "invoked");
    const model = await makeFakeModel({ output: COLLISION, invokedMarker: marker });
    // A hub URL nothing is listening on: the same shape as a connector rolled
    // out ahead of its hub, or a developer on a plane.
    const fix = await aliceFixture("oldhub", model);
    const offline = { ...fix.env, CROSSCHECK_HUB_URL: "http://127.0.0.1:9" };
    await writeSessionState(fix.home, {
      ...(await stateOf(fix)),
      hubUrl: "http://127.0.0.1:9",
    });

    expect(await runGhostWorker(["--session", fix.hostSessionKey], offline)).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(false);
    const state = await stateOf(fix);
    // Nothing on this machine is broken, so nothing on this machine is
    // booked as broken: `doctor` has one line for "the hub could not answer"
    // and it is `plan overlap`, not a WARN pointing at the local runner.
    expect(state.ghostNoHubAnswerCount).toBe(1);
    expect(state.ghostFailCount).toBe(0);
    expect(state.ghostLastFailure).toBeNull();
    expect(state.ghostFireCount).toBe(0);
    expect(state.ghostNoOverlapCount).toBe(0);
  });

  test("a teammate's intent reaches the model bounded", () => {
    // The hub caps its own writes at MAX_INTENT_SUMMARY_CHARS, so this shape
    // needs a MODIFIED hub — which is the threat model mcp-hostile-hub.test.ts
    // exists for. Every other input to this prompt is bounded by the connector
    // itself (GHOST_CLAIM_BODY_MAX_CHARS, GHOST_MAX_TEAMMATE_CLAIMS); this one
    // went to `claude -p` on the developer's own quota exactly as it arrived.
    const entry = {
      workContextId: ken.workContextId,
      title: "Session store migration",
      developerId: ken.developerId,
      developerName: "Ken",
      intent: {
        summary: "x".repeat(MAX_INTENT_SUMMARY_CHARS * 50),
        provenance: "declared",
      },
      lastActiveAt: new Date().toISOString(),
      sharedTargets: [],
      sharedTargetCount: 2,
      intentTokenHits: 0,
    };
    expect(intentSummaryOf(entry).length).toBe(MAX_INTENT_SUMMARY_CHARS);
    // The control: an ordinary sentence is passed through untouched.
    expect(
      intentSummaryOf({ ...entry, intent: { summary: THEIR_INTENT, provenance: "declared" } }),
    ).toBe(THEIR_INTENT);
    expect(intentSummaryOf({ ...entry, intent: null })).toBe("");
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
