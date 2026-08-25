/**
 * `selectAndRenderSolvedHint` (src/flows/solved-hint.ts): collective memory
 * delivered the moment a tool fails, instead of at the next SessionStart.
 *
 * What these tests are really about is the BUDGET and the SEEN-SET. The
 * surface fires inside an agent turn, where nobody is typing and nothing
 * rate-limits it but this flow, so "one failure produced one line, and the
 * same tree is never pointed at twice" is the whole safety story.
 *
 * The composite registration in src/render-surfaces.ts names this file as
 * the flow's corpus coverage: the flow emits `renderSolvedHint` output
 * VERBATIM, proven below against every corpus payload with the shared
 * character invariants.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { MAX_HINTS_PER_SESSION } from "../src/constants.ts";
import { QUOTED_DATA_NOTICE } from "../src/briefing/render.ts";
import { repoKey, sessionSlug } from "../src/config/paths.ts";
import { selectAndRenderSolvedHint } from "../src/flows/solved-hint.ts";
import type { HubContext } from "../src/http/client.ts";
import { readSessionSpool } from "../src/spool/files.ts";
import {
  readSessionState,
  writeSessionState,
} from "../src/state/session-state.ts";
import type { SessionState } from "../src/state/session-state.ts";
import {
  SELF_DEVELOPER_ID,
  SOLVED_CONTEXT_ID,
  SOLVED_ROOT_CAUSE,
  solvedFingerprintMatch,
  startHintHub,
} from "./fixtures/hint-hub.ts";
import type { HintHub } from "./fixtures/hint-hub.ts";
import { INJECTION_CORPUS } from "./fixtures/injection-corpus.ts";
import { assertUntrustedCharacters } from "./fixtures/untrusted-invariants.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
const HOST_KEY = "solved-hint-uuid";
const NOW = new Date("2026-08-19T12:00:00.000Z");
const FINGERPRINT = "sha256:3f7a1c9e2b8d40567a1c9e2b8d405678";
/** The corpus loop drives a real local hub once per payload. */
const CORPUS_TIMEOUT_MS = 20_000;

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
  matches: readonly unknown[] = [solvedFingerprintMatch()],
): Promise<Fixture> => {
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  paths.push(home, repo);
  const hub = startHintHub();
  hub.setSolvedMatches(matches);
  hubs.push(hub);
  const key = repoKey(hub.url, REPO_ID);
  await writeSessionState(
    home,
    freshState({ repo, hubUrl: hub.url }, stateOverrides),
  );
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

const flowInput = (f: Fixture, fingerprint: string = FINGERPRINT) => ({
  home: f.home,
  repoKey: f.key,
  hub: f.ctx,
  hostSessionKey: HOST_KEY,
  repoId: REPO_ID,
  agentKind: "acp:fake-agent",
  fingerprint,
  now: NOW,
});

describe("selectAndRenderSolvedHint (the failure-time recipe)", () => {
  test("a matched fingerprint delivers one hint and records it first", async () => {
    // Arrange
    const f = await fixture("sh-happy");

    // Act
    const text = await selectAndRenderSolvedHint(flowInput(f));

    // Assert: renderSolvedHint output — the notice, the pointer, the repo it
    // was solved in, and the recorded cause (a fingerprint match may quote).
    expect(text).toContain(QUOTED_DATA_NOTICE);
    expect(text).toContain(`get_diagnosis ${SOLVED_CONTEXT_ID}`);
    expect(text).toContain("· in github.com/acme/web ·");
    expect(text).toContain(SOLVED_ROOT_CAUSE);
    // The FINGERPRINT is what went on the wire, never the failure text.
    expect(f.hub.lastSolvedFingerprint()).toBe(FINGERPRINT);
    // Telemetry spooled…
    const spool = await readSessionSpool(f.home, f.key, sessionSlug(HOST_KEY));
    const kinds = spool.lines.map(
      (line) => (JSON.parse(line) as { kind: string }).kind,
    );
    expect(kinds).toEqual(["hint_delivery"]);
    // …and the ref claimed in the seen-set before the text was returned.
    const state = await readSessionState(f.home, HOST_KEY);
    expect(state?.deliveredHintRefs).toEqual([SOLVED_CONTEXT_ID]);
  });

  test("the same failure twice in one session says it once", async () => {
    // Arrange: the identical fingerprint, the identical answer — the shape a
    // retry loop produces, which is the normal case rather than the edge one.
    const f = await fixture("sh-repeat");

    // Act
    const first = await selectAndRenderSolvedHint(flowInput(f));
    const second = await selectAndRenderSolvedHint(flowInput(f));

    // Assert
    expect(first.length).toBeGreaterThan(0);
    expect(second).toBe("");
  });

  test("a tree the briefing already pointed at is not repeated here", async () => {
    // Arrange: SessionStart showed this very tree, so the reader has seen it.
    // The briefing refs are a separate list from the delivered refs, and a
    // flow that consulted only its own list would repeat the pointer.
    const f = await fixture("sh-briefed", {
      briefingSolvedRefs: [SOLVED_CONTEXT_ID],
    });

    // Act
    const text = await selectAndRenderSolvedHint(flowInput(f));

    // Assert
    expect(text).toBe("");
  });

  test("a spent hint budget costs no hub call at all", async () => {
    // Arrange: the session already delivered its allowance.
    const f = await fixture("sh-capped", {
      deliveredHintRefs: Array.from(
        { length: MAX_HINTS_PER_SESSION },
        (_, index) => `clm_${String(index)}`,
      ),
    });

    // Act
    const text = await selectAndRenderSolvedHint(flowInput(f));

    // Assert: silence, and the probe never left the machine.
    expect(text).toBe("");
    expect(f.hub.calls.solvedMatches).toBe(0);
  });

  test("no session state means silence, not recovery", async () => {
    // Arrange: a home with no state file for this host session.
    const f = await fixture("sh-nostate");
    await rm(`${f.home}/sessions`, { recursive: true, force: true });

    // Act
    const text = await selectAndRenderSolvedHint(flowInput(f));

    // Assert
    expect(text).toBe("");
    expect(f.hub.calls.solvedMatches).toBe(0);
  });

  test("a hub with nothing solved for this fingerprint stays silent", async () => {
    // Arrange
    const f = await fixture("sh-empty", {}, []);

    // Act
    const text = await selectAndRenderSolvedHint(flowInput(f));

    // Assert: silence, and no hint slot spent on it.
    expect(text).toBe("");
    const state = await readSessionState(f.home, HOST_KEY);
    expect(state?.deliveredHintRefs).toEqual([]);
  });

  test(
    "hostile hub rows stay inside the untrusted classes",
    async () => {
      for (const { id, payload } of INJECTION_CORPUS) {
        // Arrange
        const f = await fixture(`sh-corpus-${id}`, {}, [
          {
            ...solvedFingerprintMatch(),
            title: payload,
            developerName: payload,
            repo: payload,
            rootCause: payload,
          },
        ]);

        // Act
        const text = await selectAndRenderSolvedHint(flowInput(f));

        // Assert
        if (text.length === 0) {
          continue;
        }
        expect(text, id).toContain(QUOTED_DATA_NOTICE);
        for (const line of text.split("\n")) {
          assertUntrustedCharacters(line, `${id}: ${line}`);
        }
      }
    },
    CORPUS_TIMEOUT_MS,
  );
});
