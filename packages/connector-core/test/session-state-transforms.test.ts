/**
 * The pure session-state transforms: every remembered list is bounded and
 * duplicate-free where its consumer assumes so. briefingSolvedRefs seeds the
 * prompt path's seen-set (hooks/user-prompt-submit.ts); the list is per-fire
 * — a SessionStart re-fire re-creates the state file fresh — so the
 * transform, not the caller, owns dedup and the FIFO cap as defensive
 * bounds (the withSeenTargets shape).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  MAX_BRIEFING_SOLVED_REFS,
  MAX_KNOWN_WORKTREE_ROOTS,
  MAX_PROBED_FINGERPRINTS,
} from "../src/constants.ts";
import {
  withBriefingSolvedRefs,
  withKnownWorktreeRoot,
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
  gitTouchCount: 0,
  gitLaneSkipped: 0,
  ghostNoticeCount: 0,
  ghostFireCount: 0,
  ghostNoOverlapCount: 0,
  ghostNoHubAnswerCount: 0,
  ghostNoneCount: 0,
  ghostDraftCount: 0,
  ghostFailCount: 0,
  ghostLastFailure: null,
  outsideRootDrops: 0,
  knownWorktreeRoots: [],
  editToolFires: 0,
  targetsCapturedCount: 0,
  lastTargetAt: null,
  lastPostToolUseTool: null,
  lastEditedPath: null,
  lastEditedPathResolvedAgainst: null,
  hintCandidatesSeen: 0,
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


describe("withKnownWorktreeRoot (the #17 per-session root cache)", () => {
  test("remembers a root's repoId, positive and negative", () => {
    // Arrange + Act: one same-repo worktree, one foreign/unresolvable root
    const state = withKnownWorktreeRoot(
      withKnownWorktreeRoot(baseState(), "/wt/a", "github.com/acme/api"),
      "/wt/foreign",
      null,
    );

    // Assert: both cached, the negative answer kept as null
    expect(state.knownWorktreeRoots).toEqual([
      { root: "/wt/a", repoId: "github.com/acme/api", attempts: 1, stamp: null },
      { root: "/wt/foreign", repoId: null, attempts: 1, stamp: null },
    ]);
  });

  test("a re-resolution replaces the root, never duplicates it", () => {
    // Arrange: the same root cached negative, then resolved positive later
    const first = withKnownWorktreeRoot(baseState(), "/wt/a", null);

    // Act
    const second = withKnownWorktreeRoot(first, "/wt/a", "github.com/acme/api");

    // Assert: one entry, the newest answer
    expect(second.knownWorktreeRoots).toEqual([
      { root: "/wt/a", repoId: "github.com/acme/api", attempts: 1, stamp: null },
    ]);
  });

  test("the cache is FIFO-capped at MAX_KNOWN_WORKTREE_ROOTS", () => {
    // Arrange: one more distinct root than the cap admits
    const roots = Array.from(
      { length: MAX_KNOWN_WORKTREE_ROOTS + 1 },
      (_, i) => `/wt/${String(i)}`,
    );

    // Act
    const state = roots.reduce(
      (accumulated, root) => withKnownWorktreeRoot(accumulated, root, "repo"),
      baseState(),
    );

    // Assert: the oldest root fell out, the newest survives, size bounded
    expect(state.knownWorktreeRoots).toHaveLength(MAX_KNOWN_WORKTREE_ROOTS);
    expect(state.knownWorktreeRoots[0]?.root).toBe("/wt/1");
    expect(state.knownWorktreeRoots.at(-1)?.root).toBe(
      `/wt/${String(roots.length - 1)}`,
    );
  });

  test("does not mutate the state it was given", () => {
    // Arrange
    const original = baseState();

    // Act
    withKnownWorktreeRoot(original, "/wt/a", "repo");

    // Assert
    expect(original.knownWorktreeRoots).toEqual([]);
  });
});

/**
 * EVERY OUTCOME WRITER HAS A CALLER.
 *
 * A gate transform that nothing in `src` calls is a counter that can never
 * move: the schema declares it, `summarizeSummarizerCost` sums it, the cost
 * line renders it, and it prints a confident 0 forever — so the outcome it
 * names looks like it never happens on any host.
 *
 * This bit the tree once already. Two branches booked the SAME
 * unreadable-answer outcome under two names (`withSummarizerUnparsed` and
 * `withSummarizerUnreadable`); both sides auto-merged, and the loser was
 * left exported, summed and rendered while no host could reach it. Neither
 * `tsc` nor any behavioural test can see that — the dead writer still
 * compiles and still increments when a TEST calls it directly.
 *
 * So the assertion is about PRODUCTION reachability: every exported
 * `withSummarizer*` transform must be named by at least one file under a
 * package's `src/`, and tests do not count.
 */
describe("the summarizer outcome writers", () => {
  test("every exported gate transform is called from production code", async () => {
    // Arrange
    const gate = await import("../src/derive/summarizer/gate.ts");
    const writers = Object.keys(gate).filter((name) =>
      name.startsWith("withSummarizer"),
    );
    const srcRoots = await Array.fromAsync(
      new Bun.Glob("packages/*/src/**/*.ts").scan({
        cwd: join(import.meta.dir, "..", "..", ".."),
        absolute: true,
      }),
    );
    const gatePath = join(import.meta.dir, "..", "src", "derive", "summarizer", "gate.ts");
    const callers = srcRoots.filter((path) => path !== gatePath);
    // Comments are STRIPPED before the search: a module that merely explains
    // a writer in prose does not call it, and the dead writer this test
    // exists for was named in exactly such a comment.
    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    const bodies = await Promise.all(
      callers.map(async (path) => stripComments(await Bun.file(path).text())),
    );
    const haystack = bodies.join("\n");

    // Act
    const unreachable = writers.filter((name) => !haystack.includes(name));

    // Assert
    expect(writers.length).toBeGreaterThan(0);
    expect(callers.length).toBeGreaterThan(0);
    expect(unreachable).toEqual([]);
  });
});
