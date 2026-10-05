/**
 * WHY AN AGENT SHARES NOTHING (derive/sharing.ts): every condition under
 * which a correctly installed connector yields no draft and no derived
 * intent is a finding with its cause and its remedy, read off the same
 * counters the workers book — live sessions plus the ended ones the
 * per-repo history kept — and the developer's own unreviewed drafts.
 * Each rule is pinned by the case that fires it and the nearest case that
 * must not.
 */
import { describe, expect, test } from "bun:test";

import {
  DOCTOR_SHARING_QUIET_TURNS_WARN,
  DRAFT_LISTING_CAP,
} from "../src/constants.ts";
import { digestOf, sharingFindings, sharingSummary } from "../src/derive/sharing.ts";
import type { DeriveDigest, OwnDraftsFact, SharingCause, SharingInput } from "../src/derive/sharing.ts";
import { deriveSessionState } from "../src/state/session-state.ts";
import type { SessionState } from "../src/state/session-state.ts";

const HEALTHY_ENV = { PATH: "/usr/bin" };
/** A PATH with no `claude` on it, so the backend rule has nothing to say only where an override is set. */
const WITH_OVERRIDE = { PATH: "/nonexistent", CROSSCHECK_SUMMARIZER_CMD: "/opt/model/wrapper.sh" };

/** The doctor run's clock; every digest below is placed relative to it. */
const NOW = new Date("2026-10-05T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const MINUTE_MS = 60_000;

const session = (overrides: Partial<SessionState> = {}, endedAt: Date | null = null): DeriveDigest =>
  digestOf(
    {
      ...deriveSessionState({
        hostSessionKey: "sharing-uuid",
        repoId: "github.com/acme/api",
        repoRoot: "/tmp/api",
        hubUrl: "http://hub.test",
        developerId: "dev_self",
        startedAt: "2026-10-05T08:00:00.000Z",
      }),
      ...overrides,
    },
    endedAt,
  );

const DAY_MS = 86_400_000;

/** The doctor's view of the hub's listing: exact unless an older hub cut it at its cap. */
const ownDrafts = (
  size: number,
  due: number,
  options: { floor?: boolean; pastHorizon?: number; oldestDays?: number } = {},
): OwnDraftsFact => {
  const floor = options.floor ?? false;
  return {
    size: { count: size, floor },
    due: { count: due, floor: floor && due > 0 },
    pastHorizon: { count: options.pastHorizon ?? 0, floor: false },
    oldestAgeMs: floor ? null : (options.oldestDays ?? 2) * DAY_MS,
  };
};

const input = (overrides: Partial<SharingInput> = {}): SharingInput => ({
  env: WITH_OVERRIDE,
  now: NOW,
  live: [],
  ended: [],
  drafts: ownDrafts(0, 0, { floor: false, pastHorizon: 0 }),
  ...overrides,
});

const causes = (value: SharingInput): readonly SharingCause[] =>
  sharingFindings(value).map((finding) => finding.cause);

const detailFor = (value: SharingInput, cause: SharingCause): string =>
  sharingFindings(value).find((finding) => finding.cause === cause)?.detail ?? "";

/** A session that drafted and derived: the shape every negative case starts from. */
const productive = session({
  stopTurnCount: 8,
  summarizerFireCount: 2,
  summarizerDraftCount: 1,
  summarizerNoneCount: 1,
  intentFireCount: 1,
  intentSetCount: 1,
});

describe("sharingFindings — the environment", () => {
  test("CROSSCHECK_DISABLED turns every hook off, and the line says so", () => {
    const value = input({ env: { ...WITH_OVERRIDE, CROSSCHECK_DISABLED: "1" } });

    expect(causes(value)).toContain("disabled");
    expect(detailFor(value, "disabled")).toContain("your agent shares nothing because CROSSCHECK_DISABLED is set");
    expect(detailFor(value, "disabled")).toContain("fix: unset it");
  });

  test("a leaked worker marker silences every hook", () => {
    const value = input({ env: { ...WITH_OVERRIDE, CROSSCHECK_SUMMARIZER_CHILD: "1" } });

    expect(causes(value)).toContain("child_marker");
    expect(detailFor(value, "child_marker")).toContain("fix: unset it");
  });

  test("no model backend: nothing can be derived, and capture is said to be fine", () => {
    const value = input({ env: { PATH: "/nonexistent" } });

    expect(causes(value)).toContain("no_backend");
    expect(detailFor(value, "no_backend")).toContain("claude is not on this PATH");
    expect(detailFor(value, "no_backend")).toContain("CROSSCHECK_SUMMARIZER_CMD");
  });

  test("an override is a backend", () => {
    expect(causes(input({ env: WITH_OVERRIDE }))).not.toContain("no_backend");
  });
});

describe("sharingFindings — what the workers booked", () => {
  test("hooks that could not start the binary point at the editor's PATH", () => {
    const value = input({
      ended: [
        session({
          stopTurnCount: 5,
          summarizerFireCount: 1,
          summarizerFailCount: 1,
          summarizerLastFailure: 'could not start: Executable not found in $PATH "claude"',
          intentFireCount: 1,
          intentFailCount: 1,
        }),
      ],
    });

    expect(causes(value)).toContain("cannot_start");
    expect(causes(value)).not.toContain("runner_failing");
    expect(detailFor(value, "cannot_start")).toContain("command -v claude");
  });

  test("with no backend here either, the backend line is the whole story", () => {
    const value = input({
      env: { PATH: "/nonexistent" },
      live: [session({ summarizerFireCount: 1, summarizerFailCount: 1, summarizerLastFailure: "could not start: Executable not found" })],
    });

    expect(causes(value)).toContain("no_backend");
    expect(causes(value)).not.toContain("cannot_start");
  });

  test("a runner that fails on every run names its last error", () => {
    const value = input({
      live: [
        session({
          summarizerFireCount: 2,
          summarizerFailCount: 2,
          summarizerLastFailure: "exit 1: Not logged in Please run /login",
        }),
      ],
    });

    expect(causes(value)).toContain("runner_failing");
    expect(detailFor(value, "runner_failing")).toContain("Not logged in");
  });

  test("intent runs that all failed beside a summarizer that answered are named as such", () => {
    // The review's probe: 5 summarizer answers (refused, but answers), 1
    // intent run that timed out — "every model run failed" would be false.
    const value = input({
      live: [
        session({
          stopTurnCount: 9,
          summarizerFireCount: 6,
          summarizerRejectCount: 5,
          intentFireCount: 1,
          intentFailCount: 1,
          intentLastFailure: "timed out after 60 s",
        }),
      ],
    });

    const detail = detailFor(value, "runner_failing");
    expect(detail).toContain(
      "your agent derives no intent because every intent run that reported back failed (1 of 1; last: timed out after 60 s) — its summarizer runs answered 5 times, so the model is reachable",
    );
    expect(detail).not.toContain("every model run");
  });

  test("when every kind failed, 'every model run' is true and the counts say so", () => {
    const value = input({
      live: [
        session({
          summarizerFireCount: 2,
          summarizerFailCount: 2,
          summarizerLastFailure: "exit 1: Not logged in Please run /login",
          intentFireCount: 1,
          intentFailCount: 1,
          intentLastFailure: "exit 1: Not logged in Please run /login",
        }),
      ],
    });

    expect(detailFor(value, "runner_failing")).toContain(
      "every model run that reported back failed (summarizer: 2 of 2; intent: 1 of 1; last: exit 1: Not logged in Please run /login)",
    );
  });

  test("a runner that answered even once is not 'failing on every run'", () => {
    const value = input({
      live: [
        session({
          summarizerFireCount: 3,
          summarizerFailCount: 2,
          summarizerNoneCount: 1,
          summarizerLastFailure: "timed out after 60 s",
        }),
      ],
    });

    expect(causes(value)).not.toContain("runner_failing");
  });

  test("runs that never reported back, long before their session ended, are a silent worker", () => {
    const value = input({
      ended: [session({ summarizerFireCount: 1, intentFireCount: 1, lastDeriveFireAt: ago(60 * MINUTE_MS) }, new Date(NOW.getTime() - 30 * MINUTE_MS))],
    });

    expect(causes(value)).toContain("workers_silent");
    expect(detailFor(value, "workers_silent")).toContain("2 model runs started more than");
  });

  test("runs started moments ago are in flight, not silent — and the summary says so", () => {
    const value = input({
      live: [session({ summarizerFireCount: 1, intentFireCount: 1, lastDeriveFireAt: ago(10_000) })],
    });

    expect(causes(value)).not.toContain("workers_silent");
    expect(sharingSummary(value)).toContain("2 model runs still in flight");
  });

  test("runs whose session ended moments after they started may have finished after it", () => {
    // SessionEnd deletes the state file a late answer would be booked in.
    const ended = new Date(NOW.getTime() - 5 * MINUTE_MS);
    const value = input({
      ended: [session({ summarizerFireCount: 1, intentFireCount: 1, lastDeriveFireAt: new Date(ended.getTime() - 20_000).toISOString() }, ended)],
    });

    expect(causes(value)).not.toContain("workers_silent");
  });

  test("a live session's runs long past the grace window are silent", () => {
    const value = input({
      live: [session({ summarizerFireCount: 1, intentFireCount: 1, lastDeriveFireAt: ago(20 * MINUTE_MS) })],
    });

    expect(causes(value)).toContain("workers_silent");
  });

  test("runs with no recorded start time are never blamed on the host", () => {
    const value = input({ ended: [session({ summarizerFireCount: 2, intentFireCount: 1 }, new Date(NOW.getTime() - MINUTE_MS))] });

    expect(causes(value)).not.toContain("workers_silent");
  });

  test("one unanswered run is not yet a silent worker", () => {
    expect(causes(input({ live: [session({ intentFireCount: 1 })] }))).not.toContain("workers_silent");
  });

  test("turns with no transcript explain an empty draft list", () => {
    const value = input({
      live: [
        session({
          stopTurnCount: 4,
          summarizerNoSliceCount: 4,
          summarizerLastNoSlice: "this Cursor build sent no transcript path",
        }),
      ],
    });

    expect(causes(value)).toContain("no_transcript");
    expect(detailFor(value, "no_transcript")).toContain("transcripts on in Cursor");
  });

  test("answers that were all refused are named, with where to look", () => {
    const value = input({
      live: [session({ summarizerFireCount: 2, summarizerRejectCount: 1, summarizerUnreadableCount: 1 })],
    });

    expect(causes(value)).toContain("answers_refused");
  });

  test("many finished turns with no fire: the gate never saw a conclusion", () => {
    const value = input({ ended: [session({ stopTurnCount: DOCTOR_SHARING_QUIET_TURNS_WARN, intentFireCount: 1, intentSetCount: 1 })] });

    expect(causes(value)).toContain("gate_quiet");
    expect(detailFor(value, "gate_quiet")).toContain("publish_claim");
  });

  test("a short session is not a quiet gate", () => {
    const value = input({ live: [session({ stopTurnCount: DOCTOR_SHARING_QUIET_TURNS_WARN - 1 })] });

    expect(causes(value)).not.toContain("gate_quiet");
  });

  test("sessions that never opened with a substantive prompt derive no intent", () => {
    const value = input({ ended: [session({ stopTurnCount: 3 }), session({ stopTurnCount: 2 })] });

    expect(causes(value)).toContain("intent_quiet");
    expect(detailFor(value, "intent_quiet")).toContain("set_intent");
  });

  test("a productive history has nothing to say", () => {
    expect(sharingFindings(input({ live: [productive], ended: [productive] }))).toEqual([]);
  });
});

describe("sharingFindings — the drafts nobody reviewed", () => {
  test("due drafts are why teammates see nothing, and the fix is review_draft", () => {
    const value = input({ live: [productive], drafts: ownDrafts(7, 5, { floor: false, pastHorizon: 0 }) });

    expect(causes(value)).toEqual(["drafts_unreviewed"]);
    expect(detailFor(value, "drafts_unreviewed")).toContain("7 of your own drafts");
    expect(detailFor(value, "drafts_unreviewed")).toContain("the oldest captured 2 days ago");
    expect(detailFor(value, "drafts_unreviewed")).toContain("review_draft");
    // True about visibility: never PUSHED, but readable by whoever pulls.
    expect(detailFor(value, "drafts_unreviewed")).toContain(
      "until one is confirmed it is never pushed to a teammate — it shows up, marked derived, only to a teammate who opens or searches your notes",
    );
    expect(detailFor(value, "drafts_unreviewed")).not.toContain("shown to nobody");
    expect(detailFor(value, "drafts_unreviewed")).not.toContain("see none");
    expect(sharingFindings(value)[0]?.short).toBe("7 own drafts await review — none is pushed to teammates until confirmed (review_draft)");
  });

  test("a backlog the hub counted past its listing is told exactly", () => {
    const value = input({ drafts: ownDrafts(35, 35, { pastHorizon: 15, oldestDays: 41 }) });

    expect(detailFor(value, "drafts_unreviewed")).toContain(
      "35 of your own drafts on this repo await review, the oldest captured 41 days ago, 35 of them for over 24h and 15 past 30 days",
    );
    expect(detailFor(value, "drafts_unreviewed")).not.toContain("at least");
  });

  test("a listing at the hub's cap is a floor", () => {
    const value = input({ drafts: ownDrafts(DRAFT_LISTING_CAP, DRAFT_LISTING_CAP, { floor: true, pastHorizon: 0 }) });

    expect(detailFor(value, "drafts_unreviewed")).toContain(`at least ${String(DRAFT_LISTING_CAP)}`);
  });

  test("drafts past the retention horizon are said to be kept, never dropped", () => {
    const value = input({ drafts: ownDrafts(6, 6, { floor: false, pastHorizon: 2 }) });

    expect(detailFor(value, "drafts_unreviewed")).toContain("2 past 30 days");
    expect(detailFor(value, "drafts_unreviewed")).toContain("never deletes");
  });

  test("only young drafts are work in progress, not a backlog", () => {
    expect(causes(input({ drafts: ownDrafts(2, 0, { floor: false, pastHorizon: 0 }) }))).not.toContain("drafts_unreviewed");
  });
});

describe("sharingSummary", () => {
  test("says what was read when nothing stops the agent", () => {
    const summary = sharingSummary(input({ live: [productive], ended: [productive], drafts: ownDrafts(1, 0, { floor: false, pastHorizon: 0 }) }));

    expect(summary).toContain("1 live and 1 recently ended session");
    expect(summary).toContain("2 drafts and 2 intents derived");
  });

  test("a machine with no session yet is told to open one", () => {
    expect(sharingSummary(input({ env: HEALTHY_ENV, drafts: null }))).toContain("no session");
  });
});
