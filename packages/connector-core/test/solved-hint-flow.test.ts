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
import { sanitizeUntrusted } from "../src/briefing/sanitize.ts";
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
  probedFingerprints: [],
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
  summarizerRejectCount: 0,
  summarizerNoSliceCount: 0,
  summarizerLastNoSlice: null,
  summarizerLastSliceShape: null,
  summarizerSliceDroppedChars: 0,
  summarizerLastRejection: null,
  summarizerUnreadableCount: 0,
  summarizerLastUnreadable: null,
  workContextTitle: null,
  workContextStatus: null,
  intentFireCount: 0,
  intentNoneCount: 0,
  intentSetCount: 0,
  intentFailCount: 0,
  intentLastFailure: null,
  workContextIntent: null,
  ghostPending: false,
  ghostNoticeCount: 0,
  ghostFireCount: 0,
  ghostNoOverlapCount: 0,
  ghostNoHubAnswerCount: 0,
  ghostNoneCount: 0,
  ghostDraftCount: 0,
  ghostFailCount: 0,
  ghostLastFailure: null,
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
      // 20 s, not the product's 2 s: this deadline is the TEST's patience with a
      // fake hub on localhost, never a bound the product ships (the real ones are
      // measured in connector-claude's hook-budget tests). At 2 s the whole-suite
      // run flaked — 225 files, many spawning processes — and a hint that never
      // arrived read as a delivery defect: `an answer is delivered exactly once`
      // failed on an empty string, once, under load.
      timeoutMs: 20_000,
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
    // The CONTROL is the identical fixture WITHOUT that ref and it runs
    // first: silence is evidence of the seen-set only when the same input
    // without it speaks.
    const control = await fixture("sh-briefed-control");
    expect(
      (await selectAndRenderSolvedHint(flowInput(control))).length,
    ).toBeGreaterThan(0);
    const f = await fixture("sh-briefed", {
      briefingSolvedRefs: [SOLVED_CONTEXT_ID],
    });

    // Act
    const text = await selectAndRenderSolvedHint(flowInput(f));

    // Assert
    expect(text).toBe("");
  });

  test("a spent hint budget costs no hub call at all", async () => {
    // Arrange: the CONTROL keeps ONE slot free and must spend it on a hub
    // call — without it, "no hub call" below is satisfied by a flow that
    // never calls the hub at all.
    const control = await fixture("sh-capped-control", {
      deliveredHintRefs: Array.from(
        { length: MAX_HINTS_PER_SESSION - 1 },
        (_, index) => `clm_${String(index)}`,
      ),
    });
    expect(
      (await selectAndRenderSolvedHint(flowInput(control))).length,
    ).toBeGreaterThan(0);
    expect(control.hub.calls.solvedMatches).toBe(1);
    // …and the session that already delivered its whole allowance.
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

  test("one fingerprint costs one hub round trip, however often it fails", async () => {
    // Arrange: the hub holds NOTHING for this fingerprint — the overwhelmingly
    // common case, and the one the old code paid most for, because the
    // session cap only moves when a hint is actually delivered. A retry loop
    // therefore probed on every single failure, for ever.
    const f = await fixture("sh-storm", {}, []);

    // Act: the same failing command, over and over, inside one agent turn.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(await selectAndRenderSolvedHint(flowInput(f))).toBe("");
    }

    // Assert: asked once. And the CONTROL, so "one call" is not satisfied by
    // a flow that stopped calling the hub at all — a DIFFERENT fingerprint in
    // the same session is a different question and is still asked.
    expect(f.hub.calls.solvedMatches).toBe(1);
    await selectAndRenderSolvedHint(
      flowInput(f, "sha256:99998888777766665555444433332222"),
    );
    expect(f.hub.calls.solvedMatches).toBe(2);
  });

  test("a delivered fingerprint is not re-probed either", async () => {
    // Arrange: the hub DOES hold the answer, so the first failure spends a
    // slot. The seen-set already kept the second failure silent — but only
    // after paying for the round trip that produced the row it then dropped.
    const f = await fixture("sh-storm-hit");

    // Act
    const first = await selectAndRenderSolvedHint(flowInput(f));
    const second = await selectAndRenderSolvedHint(flowInput(f));

    // Assert
    expect(first.length).toBeGreaterThan(0);
    expect(second).toBe("");
    expect(f.hub.calls.solvedMatches).toBe(1);
  });

  test("no session state means silence, not recovery", async () => {
    // Arrange: the SAME home speaks while its state file exists, so the
    // silence after the file is gone is the missing state rather than a flow
    // that never says anything.
    const f = await fixture("sh-nostate");
    expect(
      (await selectAndRenderSolvedHint(flowInput(f))).length,
    ).toBeGreaterThan(0);
    expect(f.hub.calls.solvedMatches).toBe(1);
    await rm(`${f.home}/sessions`, { recursive: true, force: true });

    // Act
    const text = await selectAndRenderSolvedHint(flowInput(f));

    // Assert: no output, and no SECOND probe — the cap and the seen-set both
    // live in that file, so a flow without it must not reach the hub.
    expect(text).toBe("");
    expect(f.hub.calls.solvedMatches).toBe(1);
  });

  test("a hub with nothing solved for this fingerprint stays silent", async () => {
    // Arrange: the CONTROL is the identical fixture whose hub HAS the tree,
    // and it must both speak and claim a slot.
    const control = await fixture("sh-empty-control");
    expect(
      (await selectAndRenderSolvedHint(flowInput(control))).length,
    ).toBeGreaterThan(0);
    expect(
      (await readSessionState(control.home, HOST_KEY))?.deliveredHintRefs,
    ).toEqual([SOLVED_CONTEXT_ID]);
    const f = await fixture("sh-empty", {}, []);

    // Act
    const text = await selectAndRenderSolvedHint(flowInput(f));

    // Assert: silence, and no hint slot spent on it.
    expect(text).toBe("");
    const state = await readSessionState(f.home, HOST_KEY);
    expect(state?.deliveredHintRefs).toEqual([]);
  });

  test("a row that is not a fingerprint match earns no identity claim", async () => {
    // Arrange: the header this flow prepends asserts CONTENT IDENTITY — "the
    // failure just recorded carries the same error fingerprint". A hub too
    // old to know `?fingerprint=` ignores it and answers the ordinary
    // shared-target listing, whose rows matched on a shared FILE or on the
    // reader's session intent; this fixture's hub is exactly that hub,
    // because it answers `setSolvedMatches` regardless of the parameter.
    // The CONTROL is the same fixture with the kind the header names, so the
    // silence below is the kind check and not a flow that says nothing.
    const control = await fixture("sh-kind-control");
    expect(
      (await selectAndRenderSolvedHint(flowInput(control))).length,
    ).toBeGreaterThan(0);

    for (const kind of ["file", "session_intent"]) {
      const f = await fixture(`sh-kind-${kind}`, {}, [
        { ...solvedFingerprintMatch(), matchedTargetKind: kind, rootCause: null },
      ]);

      // Act
      const text = await selectAndRenderSolvedHint(flowInput(f));

      // Assert: silence, and no hint slot spent on a claim of identity the
      // row underneath it contradicts.
      expect(text, kind).toBe("");
      expect(
        (await readSessionState(f.home, HOST_KEY))?.deliveredHintRefs,
        kind,
      ).toEqual([]);
    }
  });

  test("a weaker row does not hide the fingerprint row behind it", async () => {
    // Arrange: an old hub answers the ordinary listing, so the fingerprint
    // row can arrive anywhere in it. A flow that took the first unseen entry
    // and then refused it on kind would go silent while the answer sat one
    // row down.
    const f = await fixture("sh-kind-order", {}, [
      { ...solvedFingerprintMatch(), workContextId: "wc_file_only", matchedTargetKind: "file", rootCause: null },
      solvedFingerprintMatch(),
    ]);

    // Act
    const text = await selectAndRenderSolvedHint(flowInput(f));

    // Assert
    expect(text).toContain(`get_diagnosis ${SOLVED_CONTEXT_ID}`);
    expect(text).not.toContain("wc_file_only");
  });

  test(
    "hostile hub rows stay inside the untrusted classes",
    async () => {
      // ONE fixture for the whole corpus, swapped per payload — not one per
      // payload. A full fixture is a home, a repo (which shells out to git)
      // and a fresh local hub, and building 56 of them was not just slow, it
      // was a broken signal: this file is the named guard for four mutation
      // entries, and mutation-check ABANDONS the whole run when a guard is
      // red unmutated — blaming a container without git, which for a timeout
      // is the wrong lead entirely.
      //
      // MEASURED on macOS 26 arm64, this file whole, before and after
      // hoisting: solo 5.87 s -> 1.40 s. Under 16 concurrent copies (the
      // busy-shared-runner shape) 6 of 16 exceeded the 20 s bound with the
      // slowest at 28.66 s; after, 16 of 16 green with the slowest at
      // 6.15 s. Re-run the load probe rather than only the solo time:
      //
      //   for i in $(seq 16); do bun test <this file> & done; wait
      const f = await fixture("sh-corpus");
      let delivered = 0;
      for (const { id, payload } of INJECTION_CORPUS) {
        // Arrange: the row changes, the fixture does not — and the state
        // file goes back to its fresh shape so each payload starts with an
        // empty seen-set, an unspent budget and no fingerprint probed yet.
        f.hub.setSolvedMatches([
          {
            ...solvedFingerprintMatch(),
            title: payload,
            developerName: payload,
            repo: payload,
            rootCause: payload,
          },
        ]);
        await writeSessionState(f.home, freshState({ repo: f.repo, hubUrl: f.hub.url }));

        // Act
        const text = await selectAndRenderSolvedHint(flowInput(f));

        // Assert — a hostile row MAY be dropped, but only for the one reason
        // this renderer has: a title that sanitizes to nothing, and then the
        // whole entry goes. Any other silence is a payload this loop would
        // have skipped without asserting on it — which is how a corpus test
        // passes against a surface that says nothing at all.
        if (sanitizeUntrusted(payload).length === 0) {
          expect(text, id).toBe("");
          continue;
        }
        delivered += 1;
        expect(text, id).toContain(QUOTED_DATA_NOTICE);
        for (const line of text.split("\n")) {
          assertUntrustedCharacters(line, `${id}: ${line}`);
        }
      }
      // The corpus is not all blanking titles: most payloads DID reach a
      // reader, sanitized, which is what the invariants above were checked on.
      expect(delivered).toBeGreaterThan(0);
    },
    CORPUS_TIMEOUT_MS,
  );
});
