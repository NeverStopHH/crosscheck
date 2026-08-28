/**
 * The pure session-state transforms: every remembered list is bounded and
 * duplicate-free where its consumer assumes so. briefingSolvedRefs seeds the
 * prompt path's seen-set (hooks/user-prompt-submit.ts); the list is per-fire
 * — a SessionStart re-fire re-creates the state file fresh — so the
 * transform, not the caller, owns dedup and the FIFO cap as defensive
 * bounds (the withSeenTargets shape).
 */
import { describe, expect, test } from "bun:test";

import {
  MAX_BRIEFING_SOLVED_REFS,
  MAX_PROBED_FINGERPRINTS,
} from "../src/constants.ts";
import {
  withBriefingSolvedRefs,
  withProbedFingerprint,
} from "../src/state/session-state.ts";
import type { SessionState } from "../src/state/session-state.ts";

const baseState = (): SessionState => ({
  hostSessionKey: "s1",
  crosscheckSessionId: "cc_s1",
  workContextId: "wc_cc_s1",
  repoId: "github.com/acme/api",
  repoRoot: "/tmp/repo",
  hubUrl: "http://127.0.0.1:1",
  developerId: "dev_1",
  startedAt: "2026-08-11T09:00:00.000Z",
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
  summarizerLastRejection: null,
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
});

describe("withBriefingSolvedRefs", () => {
  test("appending the same tree twice does not duplicate its ref", () => {
    // Arrange
    const once = withBriefingSolvedRefs(baseState(), ["wc_prev", "wc_other"]);

    // Act: the same pointers appended again — the transform owns dedup
    // whatever its caller does (a re-pointed tree is one fact).
    const twice = withBriefingSolvedRefs(once, ["wc_prev", "wc_other"]);

    // Assert
    expect(twice.briefingSolvedRefs).toEqual(["wc_prev", "wc_other"]);
  });

  test("the list is FIFO-capped like its sibling state lists", () => {
    // Arrange: one more distinct ref than the cap admits.
    const refs = Array.from(
      { length: MAX_BRIEFING_SOLVED_REFS + 1 },
      (_, i) => `wc_${String(i)}`,
    );

    // Act
    const state = refs.reduce(
      (accumulated, ref) => withBriefingSolvedRefs(accumulated, [ref]),
      baseState(),
    );

    // Assert: the oldest ref fell out, the newest survives.
    expect(state.briefingSolvedRefs).toHaveLength(MAX_BRIEFING_SOLVED_REFS);
    expect(state.briefingSolvedRefs[0]).toBe("wc_1");
    expect(state.briefingSolvedRefs.at(-1)).toBe(`wc_${String(refs.length - 1)}`);
  });

  test("does not mutate the state it was given", () => {
    // Arrange
    const original = baseState();

    // Act
    withBriefingSolvedRefs(original, ["wc_prev"]);

    // Assert
    expect(original.briefingSolvedRefs).toEqual([]);
  });
});

describe("withProbedFingerprint", () => {
  test("asking about one fingerprint twice records it once", () => {
    // Arrange / Act: the shape a racing hook produces — two processes past
    // the lockless read, both re-entering the transform with one value.
    const once = withProbedFingerprint(baseState(), "sha256:aaaa");
    const twice = withProbedFingerprint(once, "sha256:aaaa");

    // Assert
    expect(twice.probedFingerprints).toEqual(["sha256:aaaa"]);
  });

  test("the list is FIFO-capped like its sibling state lists", () => {
    // Arrange
    const values = Array.from(
      { length: MAX_PROBED_FINGERPRINTS + 1 },
      (_, i) => `sha256:${String(i)}`,
    );

    // Act
    const state = values.reduce(
      (accumulated, value) => withProbedFingerprint(accumulated, value),
      baseState(),
    );

    // Assert: the oldest question fell out, the newest survives.
    expect(state.probedFingerprints).toHaveLength(MAX_PROBED_FINGERPRINTS);
    expect(state.probedFingerprints[0]).toBe("sha256:1");
    expect(state.probedFingerprints.at(-1)).toBe(
      `sha256:${String(values.length - 1)}`,
    );
  });
});
