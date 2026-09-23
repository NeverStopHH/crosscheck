/**
 * THE VERDICT MAPPING, ROW BY ROW (1.0 spec 04 §3.3, §3.7).
 *
 * AT-5 IS THE ONE THAT MATTERS and it is one line in the middle: "nothing
 * touched this surface" may become "nobody in the record did it" ONLY where the
 * record was complete. Under a gap the answer names the gap. Today the shipped
 * code prints *"whatever broke it is not in crosscheck's record"* with no
 * knowledge of whether anything was being recorded — that sentence is the false
 * accusation principle 1 exists to stop, and the `coverage_gap` row here is
 * what replaces it.
 *
 * THE ORDER OF THE MAPPING IS LOAD-BEARING three times, and each ordering is
 * tested against the row it would otherwise swallow:
 *
 *   - `flaky` first, so a test that cannot make up its mind never attributes;
 *   - `pin_paths_missing` above `coverage_gap`, because the missing-path answer
 *     has a remedy the renderer already knows;
 *   - `ATTRIBUTED` legal under a gap while `UNATTRIBUTED` is not.
 */
import { describe, expect, test } from "bun:test";

import { COVERAGE_SOURCES } from "../src/services/coverage.ts";
import type { CoverageRecord } from "../src/services/coverage.ts";
import type { SuspectCandidate, SuspectView } from "../src/services/suspect.ts";
import {
  computeProtection,
  computeVerdict,
  verdictLegalityViolation,
} from "../src/services/verdict.ts";
import type { VerdictInput } from "../src/services/verdict.ts";

const REPO = "github.com/acme/api";
const NOW = new Date("2026-09-23T14:00:00.000Z");

/** All five rows complete — the only state in which UNATTRIBUTED is legal. */
const completeCoverage = (): CoverageRecord => ({
  repo: REPO,
  computedAt: NOW.toISOString(),
  scope: { sinceIso: "2026-08-25T14:00:00.000Z" },
  sources: COVERAGE_SOURCES.map((source) => ({
    source,
    state: "complete" as const,
    reason: "sessions_reported" as const,
    gapSince: null,
    observedAt: NOW.toISOString(),
  })),
});

/** One rung blind. Still five rows — the legality check insists on that. */
const gappedCoverage = (): CoverageRecord => ({
  ...completeCoverage(),
  sources: completeCoverage().sources.map((row) =>
    row.source === "git"
      ? {
          ...row,
          state: "incomplete" as const,
          reason: "evidence_stale" as const,
          gapSince: "2026-09-20T09:00:00.000Z",
        }
      : row,
  ),
});

const candidate = {
  sessionId: "ses_a",
  agentKind: "claude-code",
} as SuspectCandidate;

const suspectView = (overrides: Partial<SuspectView> = {}): SuspectView =>
  ({
    outcome: "no_touch",
    falsifier: {
      kind: "recorded_break",
      at: NOW.toISOString(),
      check: "bun test",
    },
    scope: {
      kind: "pin",
      pinId: "pin_1",
      pinVersion: 1,
      surface: "the refresh path",
      files: ["src/auth/refresh.ts"],
      missingFiles: [],
      rewrittenPaths: 0,
      rewrittenAt: null,
    },
    candidates: [],
    ...overrides,
  }) as SuspectView;

const input = (overrides: Partial<VerdictInput> = {}): VerdictInput => ({
  repo: REPO,
  suspect: suspectView(),
  coverage: completeCoverage(),
  delta: null,
  deltaLane: "pin",
  timing: "unknown" as VerdictInput["timing"],
  timingReason: "no_intent" as VerdictInput["timingReason"],
  evidence: {
    who: "agent_derived",
    support: "unsupported",
    supportReason: "no_verification_ref",
    observedAt: null,
    verifiedAtCommit: null,
  },
  invariant: { pinId: "pin_1", version: 1 },
  liveWaiver: null,
  now: NOW,
  ...overrides,
});

describe("AT-5 — nobody is named out of a blind spot", () => {
  test("no_touch under COMPLETE coverage is UNATTRIBUTED", () => {
    // Arrange & Act — the record was whole, so "nothing touched it" is a fact
    // about the world rather than about our instruments.
    const verdict = computeVerdict(input());

    // Assert
    expect(verdict.attribution).toBe("UNATTRIBUTED");
    expect(verdict.basis).toBe("no_touch_complete");
  });

  test("no_touch under a GAP names the gap instead", () => {
    // Arrange & Act — one rung blind. This is the shipped sentence's exact
    // case: "whatever broke it is not in crosscheck's record", said while a
    // lane was not recording.
    const verdict = computeVerdict(input({ coverage: gappedCoverage() }));

    // Assert
    expect(verdict.attribution).toBe("INDETERMINATE");
    expect(verdict.basis).toBe("coverage_gap");
  });

  test("UNATTRIBUTED under a gap is ILLEGAL, not merely unreachable", () => {
    // Arrange — the mapping cannot produce it, and the type forbids it too.
    // Two locks, because a future caller assembling a Verdict by hand is
    // exactly how the first lock gets bypassed.
    const handBuilt = {
      ...computeVerdict(input()),
      coverage: gappedCoverage(),
      attribution: "UNATTRIBUTED" as const,
    };

    // Assert
    expect(verdictLegalityViolation(handBuilt)).toBe(
      "UNATTRIBUTED under incomplete coverage",
    );
  });

  test("ATTRIBUTED under a gap is LEGAL — the asymmetry is the point", () => {
    // Arrange & Act — naming a session that IS in the record is a true positive
    // with a short list. Saying NOBODY did it out of a blind spot is the false
    // accusation. The two are not symmetric and the type says so.
    const verdict = computeVerdict(
      input({
        coverage: gappedCoverage(),
        suspect: suspectView({ outcome: "ranked", candidates: [candidate] }),
      }),
    );

    // Assert
    expect(verdict.attribution).toBe("ATTRIBUTED");
    expect(verdict.basis).toBe("separated");
    expect(verdictLegalityViolation(verdict)).toBeNull();
  });
});

describe("the order of the mapping", () => {
  test("flaky is checked FIRST and attributes nothing", () => {
    // Arrange & Act — a ranked list with a flaky delta. If the ranked row were
    // checked first, a test that cannot make up its mind would name somebody.
    const verdict = computeVerdict(
      input({
        deltaLane: "ci",
        delta: { delta: "flaky", reason: "flaky_in_base" } as never,
        suspect: suspectView({ outcome: "ranked", candidates: [candidate] }),
      }),
    );

    // Assert — and the candidate list is dropped with it.
    expect(verdict.attribution).toBe("INDETERMINATE");
    expect(verdict.basis).toBe("delta_flaky");
    expect(verdict.candidates).toEqual([]);
  });

  test("pin_paths_missing outranks coverage_gap", () => {
    // Arrange & Act — both are true. The missing-path answer wins because it
    // has a remedy the renderer already knows: re-pin the surface at its new
    // path, rather than go looking for a session that does not exist.
    const verdict = computeVerdict(
      input({
        coverage: gappedCoverage(),
        suspect: suspectView({
          scope: {
            ...suspectView().scope,
            missingFiles: ["src/auth/refresh.ts"],
          },
        }),
      }),
    );

    // Assert
    expect(verdict.basis).toBe("pin_paths_missing");
  });

  test("ANY missing path is enough, not all of them", () => {
    // Arrange & Act — a half-dead file set narrows the intersection without
    // emptying it, which is the same lie in smaller print.
    const verdict = computeVerdict(
      input({
        suspect: suspectView({
          scope: {
            ...suspectView().scope,
            files: ["a.ts", "b.ts"],
            missingFiles: ["a.ts"],
          },
        }),
      }),
    );

    // Assert
    expect(verdict.basis).toBe("pin_paths_missing");
  });
});

describe("the CI lane has reachable outcomes", () => {
  test("an unconfirmed delta is INDETERMINATE, and BOTH are emitted", () => {
    // Arrange & Act — 05 §9.6's question: does the delta win or the
    // attribution? Neither. They are different dimensions, and the verdict
    // carries both.
    const verdict = computeVerdict(
      input({
        deltaLane: "ci",
        delta: { delta: "unconfirmed", reason: "insufficient_base" } as never,
      }),
    );

    // Assert
    expect(verdict.behaviorDelta).toBe("unconfirmed");
    expect(verdict.attribution).toBe("INDETERMINATE");
    expect(verdict.basis).toBe("delta_unconfirmed");
  });

  test("a confirmed regression with NO named surface names nobody", () => {
    // Arrange & Act — the honest refusal: 1.0 has no join from a failing test
    // to a pinned surface, so a confirmed regression attributes only where a
    // human or the reader already named the code.
    const verdict = computeVerdict(
      input({
        deltaLane: "ci",
        delta: { delta: "confirmed", reason: "new_failure" } as never,
        invariant: null,
        suspect: suspectView({
          outcome: "ranked",
          candidates: [candidate],
          falsifier: { kind: "reader_named_files", at: null, check: null },
          scope: {
            kind: "paths",
            pinId: null,
            pinVersion: null,
            surface: null,
            files: [],
            missingFiles: [],
            rewrittenPaths: 0,
      rewrittenAt: null,
          },
        }),
      }),
    );

    // Assert
    expect(verdict.attribution).toBe("INDETERMINATE");
    expect(verdict.basis).toBe("ci_no_surface");
  });

  test("a confirmed regression on a named surface carries the fifth falsifier", () => {
    // Arrange & Act
    const verdict = computeVerdict(
      input({
        deltaLane: "ci",
        delta: { delta: "confirmed", reason: "new_failure" } as never,
        suspect: suspectView({ outcome: "ranked", candidates: [candidate] }),
      }),
    );

    // Assert — suspect's enum is untouched; this is the verdict-level value.
    expect(verdict.falsifier).toBe("ci_confirmed_regression");
    expect(verdict.attribution).toBe("ATTRIBUTED");
  });
});

describe("the reader-named scope — #50's day-one path", () => {
  test("a reader-named ranking is ATTRIBUTED and says so in the basis", () => {
    // Arrange & Act — no pin exists yet. #50's route header calls this "how
    // this works on day one, before anybody has pinned anything".
    const verdict = computeVerdict(
      input({
        invariant: null,
        suspect: suspectView({
          outcome: "ranked",
          candidates: [candidate],
          falsifier: { kind: "reader_named_files", at: null, check: null },
        }),
      }),
    );

    // Assert — and it is LEGAL: rule (7) is about a pinned invariant, and where
    // the reader named the files there is no invariant to be wrong about.
    // Unscoped, that rule made every day-one answer a doctor FAIL.
    expect(verdict.attribution).toBe("ATTRIBUTED");
    expect(verdict.basis).toBe("reader_named");
    expect(verdictLegalityViolation(verdict)).toBeNull();
  });

  test("a PINNED invariant attributed without a recorded break is illegal", () => {
    // Arrange & Act — the same falsifier, but a pin exists. Now rule (7)
    // applies, and the verdict fails closed.
    const verdict = computeVerdict(
      input({
        suspect: suspectView({
          outcome: "ranked",
          candidates: [candidate],
          falsifier: { kind: "reader_named_files", at: null, check: null },
        }),
      }),
    );

    // Assert
    expect(verdict.attribution).toBe("INDETERMINATE");
    expect(verdict.basis).toBe("legality_violation");
    expect(verdict.candidates).toEqual([]);
  });
});

describe("protection is orthogonal, and its input has no intent in it", () => {
  test("a pin nobody falsified protects nothing", () => {
    expect(
      computeProtection({
        repo: REPO,
        pinId: "pin_1",
        pinVersion: 1,
        falsifierKind: "not_recorded_broken",
        liveWaiver: null,
      }),
    ).toBe("unprotected");
  });

  test("a recorded break with no waiver is a PROTECTED_CONFLICT", () => {
    expect(
      computeProtection({
        repo: REPO,
        pinId: "pin_1",
        pinVersion: 1,
        falsifierKind: "recorded_break",
        liveWaiver: null,
      }),
    ).toBe("PROTECTED_CONFLICT");
  });

  test("a live waiver lifts it to protected_ok", () => {
    expect(
      computeProtection({
        repo: REPO,
        pinId: "pin_1",
        pinVersion: 1,
        falsifierKind: "recorded_break",
        liveWaiver: {
          id: "wv_1",
          pinVersion: 1,
          expiresAt: "2026-10-01T00:00:00.000Z",
          reason: "Rollout is blocked; the fix lands Monday",
          grantedByName: "Nick",
        },
      }),
    ).toBe("protected_ok");
  });

  test("ATTRIBUTED + PROTECTED_CONFLICT is LEGAL — attribution is not permission", () => {
    // Arrange & Act — somebody is named AND a human-verified invariant is
    // broken. Both true at once, and every renderer must show both.
    const verdict = computeVerdict(
      input({
        suspect: suspectView({ outcome: "ranked", candidates: [candidate] }),
      }),
    );

    // Assert
    expect(verdict.attribution).toBe("ATTRIBUTED");
    expect(verdict.protection).toBe("PROTECTED_CONFLICT");
    expect(verdictLegalityViolation(verdict)).toBeNull();
  });

  test("protection cannot be asserted where no pin exists", () => {
    // Arrange — rule (9). Nothing is protected where there is no invariant.
    const handBuilt = {
      ...computeVerdict(input()),
      invariant: null,
      protection: "protected_ok" as const,
      waiver: {
        id: "wv_1",
        pinVersion: 1,
        expiresAt: "2026-10-01T00:00:00.000Z",
        reason: "Rollout is blocked; the fix lands Monday",
        grantedByName: "Nick",
      },
    };

    // Assert
    expect(verdictLegalityViolation(handBuilt)).toBe(
      "protection asserted where no pin exists",
    );
  });
});

describe("what the type refuses to let through", () => {
  test("a coverage record without its five rows is illegal", () => {
    // Arrange — 03 §3.1 promises exactly five, and a verdict built on four is
    // a verdict about a question nobody asked in full.
    const handBuilt = {
      ...computeVerdict(input()),
      coverage: {
        ...completeCoverage(),
        sources: completeCoverage().sources.slice(0, 4),
      },
    };

    // Assert
    expect(verdictLegalityViolation(handBuilt)).toBe(
      "coverage did not carry its five rows",
    );
  });

  test("candidates without ATTRIBUTED cannot survive computeVerdict", () => {
    // Arrange & Act — a withheld answer that still carries rows. The function
    // drops them rather than emitting an illegal verdict.
    const verdict = computeVerdict(
      input({
        suspect: suspectView({
          outcome: "withheld",
          candidates: [candidate],
          falsifier: { kind: "not_recorded_broken", at: null, check: null },
        }),
      }),
    );

    // Assert
    expect(verdict.attribution).toBe("INDETERMINATE");
    expect(verdict.candidates).toEqual([]);
    expect(verdictLegalityViolation(verdict)).toBeNull();
  });

  test("a withheld answer names WHICH refusal it was", () => {
    // Arrange & Act — three different withholds, three different bases,
    // because the remedies differ: run the check, write a recipe, change a
    // team setting.
    const absent = computeVerdict(
      input({
        suspect: suspectView({
          outcome: "withheld",
          falsifier: { kind: "not_recorded_broken", at: null, check: null },
        }),
      }),
    );
    const noRecipe = computeVerdict(
      input({
        suspect: suspectView({
          outcome: "withheld",
          falsifier: { kind: "no_check_recipe", at: null, check: null },
        }),
      }),
    );
    const byTeam = computeVerdict(
      input({
        suspect: suspectView({
          outcome: "withheld",
          falsifier: { kind: "recorded_break", at: null, check: null },
        }),
      }),
    );

    // Assert — the third is DERIVED: the gate fires only on the first two, so a
    // withhold carrying any other falsifier can only be the team setting.
    expect(absent.basis).toBe("falsifier_absent");
    expect(noRecipe.basis).toBe("no_check_recipe");
    expect(byTeam.basis).toBe("attribution_withheld_by_team");
  });
});
