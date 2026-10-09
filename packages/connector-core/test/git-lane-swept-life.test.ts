/**
 * THE LIFE THE GIT LANE LAST SWEPT UNDER (batch-2 integration review, L10):
 * what the state records, what carries across a re-fire, and what a heal
 * leaves behind — the rule connector-claude's hooks pay (git-lane.ts
 * sweepIfLifeMoved; its end-to-end case is test/e2e/heal-sweeps-again).
 */
import { describe, expect, test } from "bun:test";

import {
  deriveSessionState,
  owesSweepToLife,
  withCarriedCapture,
  withGitTouches,
} from "../src/state/session-state.ts";
import type { SessionState } from "../src/state/session-state.ts";

const NOW = "2026-10-09T12:00:00.000Z";

const life = (): SessionState =>
  deriveSessionState({
    hostSessionKey: "swept-life",
    repoId: "github.com/acme/api",
    repoRoot: "/tmp/acme-api",
    hubUrl: "http://127.0.0.1:9",
    developerId: "dev_nick",
    startedAt: NOW,
  });

describe("the life the git lane last swept under", () => {
  test("a fresh life owes no sweep: it is recorded as swept at register", () => {
    const state = life();

    expect(state.gitLaneSweptLife).toBe(state.crosscheckSessionId);
    expect(owesSweepToLife(state)).toBe(false);
  });

  test("a heal that moved the life leaves the record behind, so a sweep is owed until a lane runs under the new life", () => {
    // Arrange: swapLife writes the next life and keeps the rest of the state
    const healed: SessionState = { ...life(), crosscheckSessionId: `${life().crosscheckSessionId}~r1` };

    // Act
    const swept = withGitTouches(healed, { captured: ["src/a.ts"], skipped: false, sweptLife: healed.crosscheckSessionId });
    const skipped = withGitTouches(healed, { captured: [], skipped: true });

    // Assert
    expect(owesSweepToLife(healed)).toBe(true);
    expect(owesSweepToLife(swept)).toBe(false);
    expect(swept.gitLaneSweptLife).toBe(healed.crosscheckSessionId);
    expect(owesSweepToLife(skipped)).toBe(true);
  });

  test("a sweep the life moved under records nothing: the next life still owes its own", () => {
    const healed: SessionState = { ...life(), crosscheckSessionId: `${life().crosscheckSessionId}~r1` };

    const unchanged = withGitTouches(healed, { captured: [], skipped: false });

    expect(unchanged.gitLaneSweptLife).toBe(life().crosscheckSessionId);
    expect(owesSweepToLife(unchanged)).toBe(true);
  });

  test("a re-fire of the same life carries the record: it neither owes a sweep nor forgives one", () => {
    // Arrange: the previous state owes a sweep; the re-fire's input says a fresh life would not
    const owing: SessionState = { ...life(), crosscheckSessionId: `${life().crosscheckSessionId}~r1` };
    const refire = { ...life(), crosscheckSessionId: owing.crosscheckSessionId, gitLaneSweptLife: owing.crosscheckSessionId };

    // Act
    const carried = withCarriedCapture(refire, owing);

    // Assert
    expect(carried.gitLaneSweptLife).toBe(life().crosscheckSessionId);
  });

  test("an older state that recorded no life owes nothing", () => {
    expect(owesSweepToLife({ ...life(), gitLaneSweptLife: null })).toBe(false);
    const { gitLaneSweptLife: _absent, ...older } = life();
    expect(owesSweepToLife(older)).toBe(false);
  });
});
