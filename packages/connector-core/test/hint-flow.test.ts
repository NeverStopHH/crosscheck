/**
 * The Block-5 `selectAndRenderHint` flow (src/flows/hint.ts): the
 * UserPromptSubmit recipe as one extracted function, driven against the
 * canned hint hub. The Claude hook's own suite (connector-claude
 * test/hint-hook.test.ts) covers the same code through `runHook` — this file
 * pins the flow's contract where the ACP proxy consumes it directly.
 *
 * The composite registration in src/render-surfaces.ts names this file as
 * the flow's corpus coverage: the flow emits `renderClaimHint`/
 * `renderPointerHint` output VERBATIM, proven below against every corpus
 * payload with the shared character invariants.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { selectAndRenderHint } from "../src/flows/hint.ts";
import { MAX_HINTS_PER_SESSION } from "../src/constants.ts";
import { QUOTED_DATA_NOTICE } from "../src/briefing/render.ts";
import { repoKey, sessionSlug } from "../src/config/paths.ts";
import type { HubContext } from "../src/http/client.ts";
import { readDeliveredHintHashes } from "../src/hints/delivered-store.ts";
import { readSessionSpool } from "../src/spool/files.ts";
import {
  readSessionState,
  writeSessionState,
} from "../src/state/session-state.ts";
import type { SessionState } from "../src/state/session-state.ts";
import {
  CANDIDATE_BODY,
  CANDIDATE_CLAIM_ID,
  CANDIDATE_CONTEXT_ID,
  SELF_DEVELOPER_ID,
  proposedOnlyCandidate,
  rejectedApproachCandidate,
  startHintHub,
} from "./fixtures/hint-hub.ts";
import type { HintHub } from "./fixtures/hint-hub.ts";
import { INJECTION_CORPUS } from "./fixtures/injection-corpus.ts";
import { assertUntrustedCharacters } from "./fixtures/untrusted-invariants.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
const HOST_KEY = "hint-flow-uuid";
const NOW = new Date("2026-08-19T12:00:00.000Z");
/** The full-corpus loop measures ~5 s under ambient load — right at bun's
 * default; an explicit ceiling keeps a loaded runner honest. */
const CORPUS_TIMEOUT_MS = 20_000;
const PROMPT = "why does src/auth/refresh.ts still 500 after the key rotation";

const paths: string[] = [];
const hubs: HintHub[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
  for (const hub of hubs) {
    hub.stop();
  }
  hubs.length = 0;
});

interface Fixture {
  readonly home: string;
  readonly repo: string;
  readonly hub: HintHub;
  readonly ctx: HubContext;
  readonly key: string;
}

const freshState = (
  fixture: { repo: string; hubUrl: string },
  overrides: Partial<SessionState> = {},
): SessionState => ({
  hostSessionKey: HOST_KEY,
  crosscheckSessionId: `cc_${HOST_KEY}`,
  workContextId: `wc_cc_${HOST_KEY}`,
  repoId: REPO_ID,
  repoRoot: fixture.repo,
  hubUrl: fixture.hubUrl,
  developerId: SELF_DEVELOPER_ID,
  startedAt: NOW.toISOString(),
  lastHeartbeatAt: null,
  seenTargets: [],
  deliveredHintRefs: [],
  deliveredHintHashes: [],
  tripwireAskedFiles: [],
  briefingSolvedRefs: [],
  foreignRepoDrops: 0,
  briefingPending: false,
  stopTurnCount: 0,
  summarizerFireCount: 0,
  summarizerLastFireTurn: null,
  summarizerEstimatedTokens: 0,
  summarizerNoneCount: 0,
  summarizerDraftCount: 0,
  summarizerFailCount: 0,
  summarizerLastFailure: null,
  workContextTitle: null,
  workContextStatus: null,
  intentFireCount: 0,
  intentNoneCount: 0,
  intentSetCount: 0,
  intentFailCount: 0,
  intentLastFailure: null,
  ...overrides,
});

const fixture = async (
  label: string,
  stateOverrides: Partial<SessionState> = {},
): Promise<Fixture> => {
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  paths.push(home, repo);
  const hub = startHintHub();
  hubs.push(hub);
  const key = repoKey(hub.url, REPO_ID);
  await writeSessionState(home, freshState({ repo, hubUrl: hub.url }, stateOverrides));
  return {
    home,
    repo,
    hub,
    key,
    ctx: {
      hubUrl: hub.url,
      apiKey: "test-key",
      timeoutMs: 2000,
      home,
      repoKey: key,
      now: () => NOW,
    },
  };
};

const flowInput = (f: Fixture, prompt: string = PROMPT) => ({
  home: f.home,
  repoKey: f.key,
  hub: f.ctx,
  hostSessionKey: HOST_KEY,
  repoId: REPO_ID,
  repoRoot: f.repo,
  agentKind: "acp:fake-agent",
  prompt,
  now: NOW,
});

describe("selectAndRenderHint (the extracted UserPromptSubmit recipe)", () => {
  test("delivers one framed substance hint and records before returning", async () => {
    // Arrange
    const f = await fixture("hf-happy");

    // Act
    const text = await selectAndRenderHint(flowInput(f));

    // Assert: renderClaimHint output verbatim.
    expect(text).toContain(QUOTED_DATA_NOTICE);
    expect(text).toContain(CANDIDATE_BODY);
    expect(text).toContain("Nick");

    // Telemetry spooled…
    const spool = await readSessionSpool(f.home, f.key, sessionSlug(HOST_KEY));
    const kinds = spool.lines.map(
      (line) => (JSON.parse(line) as { kind: string }).kind,
    );
    expect(kinds).toEqual(["hint_delivery"]);
    // …seen-set + echo hash in state…
    const state = await readSessionState(f.home, HOST_KEY);
    expect(state?.deliveredHintRefs).toEqual([CANDIDATE_CLAIM_ID]);
    expect(state?.deliveredHintHashes.length).toBe(1);
    // …and the repo-wide echo-exclusion store.
    expect(await readDeliveredHintHashes(f.home, f.key)).toHaveLength(1);
  });

  test("the seen-set silences a repeat of the same ref on the next prompt", async () => {
    const f = await fixture("hf-repeat");

    const first = await selectAndRenderHint(flowInput(f));
    const second = await selectAndRenderHint(flowInput(f));

    expect(first.length).toBeGreaterThan(0);
    expect(second).toBe("");
  });

  test("CONCURRENT duplicate attempts deliver exactly once — the seen-set claim is a locked check-and-set, not luck", async () => {
    // Arrange: the cursor connector's open-q4 dual-signal case lands here as
    // two racing flow calls for ONE failure — both pass the lockless
    // pre-checks before either records, so only a first-writer-wins decision
    // inside the state lock can keep the guarantee.
    const f = await fixture("hf-concurrent");

    // Act
    const [first, second] = await Promise.all([
      selectAndRenderHint(flowInput(f)),
      selectAndRenderHint(flowInput(f)),
    ]);

    // Assert: one winner, one silent loser, ONE cap slot spent.
    const delivered = [first, second].filter((text) => text.length > 0);
    expect(delivered.length).toBe(1);
    const state = await readSessionState(f.home, HOST_KEY);
    expect(state?.deliveredHintRefs).toEqual([CANDIDATE_CLAIM_ID]);
  });

  test("no state file means silence and zero candidate calls", async () => {
    const f = await fixture("hf-nostate");
    await rm(`${f.home}/sessions`, { recursive: true, force: true });

    const text = await selectAndRenderHint(flowInput(f));

    expect(text).toBe("");
    expect(f.hub.calls.candidates).toBe(0);
  });

  test("a prompt with no searchable word costs zero HTTP", async () => {
    const f = await fixture("hf-meaning");

    const text = await selectAndRenderHint(flowInput(f, "ok ?? !!"));

    expect(text).toBe("");
    expect(f.hub.calls.candidates).toBe(0);
  });

  test("SECRET GATE: a credential-bearing prompt buys zero HTTP — the query never leaves the machine", async () => {
    // Arrange: on the Cursor connector the prompt IS captured tool output
    // (the failure text), exactly the text class capture/secret-scan.ts
    // refuses to spool. The same scan must gate the QUERY, which would
    // otherwise leave as a GET string — into the hub's access logs.
    const f = await fixture("hf-secret");

    // Act
    const text = await selectAndRenderHint(
      flowInput(
        f,
        "deploy failed: credential AKIAIOSFODNN7EXAMPLE rejected by endpoint",
      ),
    );

    // Assert: dropped, never redacted-and-sent (the scan's own rule).
    expect(text).toBe("");
    expect(f.hub.calls.candidates).toBe(0);
  });

  test("the session cap holds before any hub call", async () => {
    const f = await fixture("hf-cap", {
      deliveredHintRefs: Array.from(
        { length: MAX_HINTS_PER_SESSION },
        (_, index) => `clm_prior_${index}`,
      ),
    });

    const text = await selectAndRenderHint(flowInput(f));

    expect(text).toBe("");
    expect(f.hub.calls.candidates).toBe(0);
  });

  test("a bare hypothesis reaches the reader as a pointer, never a body", async () => {
    const f = await fixture("hf-pointer");
    f.hub.setCandidates([proposedOnlyCandidate()]);

    const text = await selectAndRenderHint(flowInput(f));

    expect(text).toContain("crosscheck pointer");
    expect(text).toContain(CANDIDATE_CONTEXT_ID);
    expect(text).not.toContain(CANDIDATE_BODY);
  });

  test("PRIVACY: the prompt text lands in no file the flow writes", async () => {
    const f = await fixture("hf-privacy");
    const secretPrompt = "SECRET-PROMPT-MARKER why does refresh rotation fail";

    const text = await selectAndRenderHint(flowInput(f, secretPrompt));
    expect(text.length).toBeGreaterThan(0);

    const spool = await readSessionSpool(f.home, f.key, sessionSlug(HOST_KEY));
    expect(spool.lines.join("\n")).not.toContain("SECRET-PROMPT-MARKER");
    const state = await readSessionState(f.home, HOST_KEY);
    expect(JSON.stringify(state)).not.toContain("SECRET-PROMPT-MARKER");
  });

  test("flow output holds the hint invariants against every corpus payload", async () => {
    const f = await fixture("hf-corpus");

    for (const { id, payload } of INJECTION_CORPUS) {
      // Fresh state per payload: the cap and seen-set must not mute later
      // payloads of the loop.
      await writeSessionState(f.home, freshState({ repo: f.repo, hubUrl: f.hub.url }));
      const base = rejectedApproachCandidate();
      const workContext = base["workContext"] as Record<string, unknown>;
      const claims = base["claims"] as readonly Record<string, unknown>[];
      f.hub.setCandidates([
        {
          ...base,
          workContext: { ...workContext, title: payload, developerName: payload },
          claims: [
            { ...claims[0], body: payload, authorDeveloperName: payload },
          ],
        },
      ]);

      // Act
      const text = await selectAndRenderHint(flowInput(f));

      // Assert: verbatim renderClaimHint discipline — the shared invariants.
      for (const line of text.split("\n")) {
        assertUntrustedCharacters(line, `hint-flow/${id}`);
      }
      if (text.length > 0) {
        expect(text, `hint-flow/${id}`).toContain(QUOTED_DATA_NOTICE);
      }
    }
  }, CORPUS_TIMEOUT_MS);
});
