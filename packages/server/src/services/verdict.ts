/**
 * THE VERDICT: five dimensions that do not collapse into one (1.0 spec 04).
 *
 * What ships today is `SuspectOutcome` — `ranked | no_separation | no_touch |
 * withheld` — an enum about ONE QUERY'S ROWS, not a verdict about a behaviour.
 * Four modules already carry comments referring to `ATTRIBUTED`, `UNATTRIBUTED`
 * and `INDETERMINATE` (suspect-render, routes/suspect, intent-ledger, coverage)
 * against a vocabulary that did not exist anywhere in the code. This is it.
 *
 * THE DIMENSIONS ARE SEPARATE ON PURPOSE, and the spec is that sentence
 * repeated:
 *
 *   ATTRIBUTION  — can anybody be named. Never says "nobody" out of a blind
 *                  spot (principle 1).
 *   PROTECTION   — was a human-verified invariant broken. Computed from an
 *                  input with NO SESSION AND NO INTENT IN IT (principle 4), so
 *                  an agent cannot widen its own scope into permission.
 *   BEHAVIOUR    — what CI or a human re-check established (05's lanes).
 *   TIMING       — whether the explanation predates the change (06's), CARRIED
 *                  and never weighed (principle 3).
 *   EVIDENCE     — whether anything was actually run (08's two axes).
 *
 * `ATTRIBUTED` + `PROTECTED_CONFLICT` is legal and every renderer must show it:
 * attribution is not permission. So is `ATTRIBUTED` + `support: unsupported` —
 * somebody is named and nothing was run.
 *
 * NO CONFIDENCE IS READ HERE. 08 §3.6 keeps that number out of every predicate,
 * and EV-4's operation directive turns a comparison, a cap or a sort on it into
 * a red build — including one written in this file.
 */
import type { EvidenceAxes } from "@crosscheck/schema";

import type { CiBehaviorDelta } from "./ci-delta.ts";
import { isJudgeable } from "./coverage.ts";
import type { CoverageRecord } from "./coverage.ts";
import type { ExplanationTiming, TimingReason } from "./intent-ledger.ts";
import type {
  SuspectCandidate,
  SuspectFalsifierKind,
  SuspectView,
} from "./suspect.ts";

/** 03 §3.1: a coverage record is five rows, always, in order. */
const COVERAGE_ROWS = 5;

export const ATTRIBUTIONS = [
  "ATTRIBUTED",
  "UNATTRIBUTED",
  "INDETERMINATE",
] as const;

export const PROTECTIONS = [
  "unprotected",
  "protected_ok",
  "PROTECTED_CONFLICT",
] as const;

export const BEHAVIOR_DELTAS = ["confirmed", "unconfirmed", "flaky"] as const;

/**
 * SUSPECT'S FOUR, MAPPED 1:1, PLUS THE ONE THE CI LANE NEEDS.
 *
 * `SuspectFalsifierKind` is left untouched — it is #50's closed ground, and this
 * is a VERDICT-level type that maps the four in rather than widening theirs.
 * The fifth answers the question 05 §9.3 handed here: a confirmed CI delta is a
 * shape suspect's enum has no word for.
 */
export const VERDICT_FALSIFIERS = [
  "recorded_break",
  "not_recorded_broken",
  "no_check_recipe",
  "reader_named_files",
  "ci_confirmed_regression",
] as const;

/**
 * WHY the attribution is what it is — an ENUM, never prose.
 *
 * The rule `CoverageReason` follows, for its reason: a verdict line then carries
 * NO author-written string except the pin surface and the waiver reason, which
 * are the only two untrusted slots a renderer of this type must cover.
 */
export const VERDICT_BASES = [
  "separated",
  "no_separation",
  "no_touch_complete",
  "coverage_gap",
  "pin_paths_missing",
  "falsifier_absent",
  "no_check_recipe",
  "attribution_withheld_by_team",
  "delta_flaky",
  "delta_unconfirmed",
  "ci_no_surface",
  "reader_named",
  "legality_violation",
] as const;

export type Attribution = (typeof ATTRIBUTIONS)[number];
export type Protection = (typeof PROTECTIONS)[number];
export type BehaviorDelta = (typeof BEHAVIOR_DELTAS)[number];
export type VerdictFalsifier = (typeof VERDICT_FALSIFIERS)[number];
export type VerdictBasis = (typeof VERDICT_BASES)[number];

/** Which pinned invariant, at which version, this verdict is about (§3.5). */
export interface InvariantRef {
  readonly pinId: string;
  readonly version: number;
}

/**
 * A live waiver lifting a protected conflict (§3.6).
 *
 * CARRIES THE REASON AND THE GRANTER, so §5's block can say who opened the
 * fence and why. `reason` is the one author-written string this type admits —
 * the header above names it and the pin surface as the only two untrusted
 * slots a renderer of a verdict must cover.
 */
export interface WaiverRef {
  readonly id: string;
  readonly pinVersion: number;
  readonly expiresAt: string;
  readonly reason: string;
  readonly grantedByName: string;
}

export interface Verdict {
  readonly repo: string;
  readonly invariant: InvariantRef | null;
  readonly behaviorDelta: BehaviorDelta;
  /** NEVER MERGED — 05 §3.1 keeps the two lanes apart end to end. */
  readonly deltaLane: "ci" | "pin";
  readonly deltaReason: string;
  /** EXACTLY five rows (03 §3.1); the legality check enforces it. */
  readonly coverage: CoverageRecord;
  readonly explanationTiming: ExplanationTiming;
  readonly timingReason: TimingReason;
  readonly attribution: Attribution;
  readonly protection: Protection;
  readonly waiver: WaiverRef | null;
  readonly falsifier: VerdictFalsifier;
  readonly evidence: EvidenceAxes;
  readonly basis: VerdictBasis;
  readonly candidates: readonly SuspectCandidate[];
  readonly computedAt: string;
}

/**
 * PROTECTION, FROM AN INPUT WITH NO SESSION AND NO INTENT IN IT.
 *
 * Principle 4 made mechanical: an agent may call `set_intent` as often as it
 * likes — it writes `work_contexts.intent` and touches no pin, no version and
 * no waiver — and there is no `amend_intent` tool. Reading a session or an
 * intent HERE would be a type error, which is the point: the shape 00 §8.5 bans
 * — a session widening its own scope and something downstream reading that as
 * permission — has nowhere to land.
 *
 * `PROTECTED_CONFLICT` is reachable ONLY on `recorded_break`. A pin nobody
 * falsified protects a behaviour nobody says is broken, which keeps this axis
 * off the edit path entirely.
 */
export interface ProtectionInput {
  readonly repo: string;
  readonly pinId: string | null;
  readonly pinVersion: number | null;
  readonly falsifierKind: SuspectFalsifierKind;
  readonly liveWaiver: WaiverRef | null;
}

export const computeProtection = (input: ProtectionInput): Protection => {
  if (input.falsifierKind !== "recorded_break") {
    return "unprotected";
  }
  return input.liveWaiver === null ? "PROTECTED_CONFLICT" : "protected_ok";
};

/** The five falsifier values, mapped from suspect's four. */
const verdictFalsifierOf = (
  kind: SuspectFalsifierKind,
  lane: "ci" | "pin",
  delta: BehaviorDelta,
): VerdictFalsifier =>
  lane === "ci" && delta === "confirmed" ? "ci_confirmed_regression" : kind;

interface AttributionOutcome {
  readonly attribution: Attribution;
  readonly basis: VerdictBasis;
}

/**
 * THE MAPPING, WITH AT-5 INSIDE IT.
 *
 * Read top to bottom; the order is load-bearing three times, and each time is
 * called out where it happens.
 */
const attributionFor = (
  suspect: SuspectView,
  coverage: CoverageRecord,
  lane: "ci" | "pin",
  delta: BehaviorDelta,
): AttributionOutcome => {
  // FLAKY IS CHECKED FIRST, on both lanes. It drops the candidate list,
  // attributes nothing and renders no row (05 CI-3): a test that cannot make up
  // its mind is not evidence that anybody did anything.
  if (delta === "flaky") {
    return { attribution: "INDETERMINATE", basis: "delta_flaky" };
  }

  if (lane === "ci") {
    if (delta === "unconfirmed") {
      // `unconfirmed` and INDETERMINATE are DIFFERENT DIMENSIONS and both are
      // emitted — 05 §9.6's question, answered: nothing "wins". The delta says
      // what CI established; the basis says why nobody is named.
      return { attribution: "INDETERMINATE", basis: "delta_unconfirmed" };
    }
    // THE HONEST REFUSAL (§8.12): 1.0 has NO join from a failing test to a
    // pinned surface, so a CI-confirmed regression attributes only where a
    // human or the reader has already named the code.
    const named = suspect.scope.pinId !== null || suspect.scope.files.length > 0;
    if (!named) {
      return { attribution: "INDETERMINATE", basis: "ci_no_surface" };
    }
  }

  if (suspect.outcome === "withheld") {
    if (suspect.falsifier.kind === "not_recorded_broken") {
      return { attribution: "INDETERMINATE", basis: "falsifier_absent" };
    }
    if (suspect.falsifier.kind === "no_check_recipe") {
      return { attribution: "INDETERMINATE", basis: "no_check_recipe" };
    }
    // DERIVED, NOT PASSED IN: the withhold gate fires only on those two
    // falsifiers, so a `withheld` carrying any other one can only have come
    // from this team's attribution setting. Taking the setting as a separate
    // input would be a second authority over one fact.
    return {
      attribution: "INDETERMINATE",
      basis: "attribution_withheld_by_team",
    };
  }

  if (suspect.outcome === "no_touch") {
    // PIN_PATHS_MISSING OUTRANKS COVERAGE_GAP. Both are honest, but the
    // missing-path one has a remedy the renderer already knows — re-pin the
    // surface at its new path, rather than go looking for a session.
    //
    // ANY missing path, not all: a half-dead file set narrows the intersection
    // without emptying it, which is the same lie in smaller print.
    if (suspect.scope.missingFiles.length > 0) {
      return { attribution: "INDETERMINATE", basis: "pin_paths_missing" };
    }
    // AT-5, THE WHOLE POINT OF THIS SPEC. "Nothing touched this surface" may
    // become "nobody in the record did it" only where the record was COMPLETE.
    // Under a gap the honest answer names the gap.
    return isJudgeable(coverage)
      ? { attribution: "UNATTRIBUTED", basis: "no_touch_complete" }
      : { attribution: "INDETERMINATE", basis: "coverage_gap" };
  }

  // ATTRIBUTED IS LEGAL UNDER INCOMPLETE COVERAGE AND UNATTRIBUTED IS NOT.
  // Naming a session that IS in the record is a true positive with a short
  // list; saying NOBODY did it out of a blind spot is the false accusation
  // principle 1 exists to stop. The coverage clause rides either way, and
  // `ranked` is not demoted under a gap — separation describes the rows that
  // exist and already prints its own arithmetic.
  if (suspect.outcome === "ranked") {
    return suspect.falsifier.kind === "reader_named_files"
      ? // THE READER IS THE FALSIFIER, which is what the enum value means. The
        // basis states that premise out loud — a ranking whose premise is
        // unstated is an accusation with the evidence left off.
        { attribution: "ATTRIBUTED", basis: "reader_named" }
      : { attribution: "ATTRIBUTED", basis: "separated" };
  }
  return { attribution: "ATTRIBUTED", basis: "no_separation" };
};

/**
 * WHAT THE TYPE FORBIDS (§3.7).
 *
 * Returns the rule that was broken, or null. A violation FAILS CLOSED to
 * `INDETERMINATE` / `legality_violation` AND is reported — both halves, because
 * non-negotiable #4 is *fail, never silently*, and a silent downgrade would
 * hide the bug that caused it.
 */
/**
 * EVERY WAY A VERDICT CAN BE ILLEGAL, as data rather than only as branches.
 *
 * §3.7 lists the rules in prose and §7's VER-8 asks for a fixture per rule.
 * Written as nine `if`s alone, "one fixture per rule" is a claim a reader has
 * to re-count by hand — and VER-8 counted TEN where §3.7 lists nine, which is
 * exactly the drift a hand-kept number produces. So the sentences are a list,
 * the function returns members of it, and the test derives its expected set
 * from here. A tenth rule added without a fixture is then a red build rather
 * than a paragraph somebody has to notice.
 *
 * ORDER IS THE CHECKING ORDER, because the first violation found is the one
 * reported and a reader tracing a downgrade needs to know which rule won.
 */
/**
 * ATTRIBUTION AND PROTECTION ARE ORTHOGONAL, and this is the directive that
 * keeps them so.
 *
 * §3.7 names three combinations as explicitly legal — `ATTRIBUTED` +
 * `PROTECTED_CONFLICT`, `UNATTRIBUTED` + `PROTECTED_CONFLICT`, `ATTRIBUTED`
 * with unsupported evidence — because each reads like a contradiction and is
 * not. Attribution answers "may anybody be named"; protection answers "is a
 * human-verified invariant broken". Neither constrains the other, so ALL NINE
 * cells of the grid are legal, and a rule added later that forbids one is a
 * change to the model rather than a tightening of a check.
 *
 * *§7 asked for `ATTRIBUTIONS.length × PROTECTIONS.length` printed beside the
 * count of combinations the legality table covers. Both are 9 — and they are
 * not the same nine: one is the grid, the other is the rule list, and printing
 * them side by side would invite exactly the reading that the nine rules are
 * the nine cells. This prints the fact the spec was reaching for instead.*
 *
 * VERIFY: bun -e 'const v=await import("./packages/server/src/services/verdict.ts");const s=await import("./packages/server/src/services/coverage.ts");const cov={repo:"r",computedAt:"2026-09-23T12:00:00.000Z",scope:{sinceIso:"2026-09-09T12:00:00.000Z"},sources:s.COVERAGE_SOURCES.map(source=>({source,state:"complete",reason:"sessions_reported",gapSince:null,observedAt:"2026-09-23T12:00:00.000Z"}))};const base={repo:"r",invariant:{pinId:"p",version:1},behaviorDelta:"unconfirmed",deltaLane:"pin",deltaReason:"human_recheck_unrepeated",coverage:cov,explanationTiming:"absent",timingReason:"no_intent",falsifier:"recorded_break",evidence:{who:"agent_derived",support:"unsupported",supportReason:"no_verification_ref",observedAt:null,verifiedAtCommit:null},basis:"separated",computedAt:"2026-09-23T12:00:00.000Z"};let n=0;for(const attribution of v.ATTRIBUTIONS)for(const protection of v.PROTECTIONS){const waiver=protection==="protected_ok"?{id:"w",pinVersion:1,expiresAt:"2026-09-24T12:00:00.000Z",reason:"r",grantedByName:"n"}:null;const candidates=attribution==="ATTRIBUTED"?[{sessionId:"s"}]:[];if(v.verdictLegalityViolation({...base,attribution,protection,waiver,candidates})===null)n++;}console.log(n,"of",v.ATTRIBUTIONS.length*v.PROTECTIONS.length)'
 * PRINTS: 9 of 9
 */
export const VERDICT_LEGALITY_VIOLATIONS = [
  "UNATTRIBUTED under incomplete coverage",
  "ATTRIBUTED with no candidates",
  "candidates listed without ATTRIBUTED",
  "a flaky delta attributed anyway",
  "protected_ok without a waiver",
  "PROTECTED_CONFLICT without a recorded break",
  "a pinned invariant attributed without a recorded break",
  "coverage did not carry its five rows",
  "protection asserted where no pin exists",
] as const;

export type VerdictLegalityViolation =
  (typeof VERDICT_LEGALITY_VIOLATIONS)[number];

export const verdictLegalityViolation = (
  verdict: Verdict,
): VerdictLegalityViolation | null => {
  if (verdict.attribution === "UNATTRIBUTED" && !isJudgeable(verdict.coverage)) {
    // AT-5 as a type rule, not only as a mapping.
    return "UNATTRIBUTED under incomplete coverage";
  }
  if (verdict.attribution === "ATTRIBUTED" && verdict.candidates.length === 0) {
    return "ATTRIBUTED with no candidates";
  }
  if (verdict.attribution !== "ATTRIBUTED" && verdict.candidates.length > 0) {
    return "candidates listed without ATTRIBUTED";
  }
  if (
    verdict.behaviorDelta === "flaky" &&
    verdict.attribution !== "INDETERMINATE"
  ) {
    return "a flaky delta attributed anyway";
  }
  if (verdict.protection === "protected_ok" && verdict.waiver === null) {
    return "protected_ok without a waiver";
  }
  // RULE 6, NARROWED THE SAME WAY RULE 7 IS, and the reason was found by
  // building it. `computeProtection` reads the SUSPECT's falsifier kind, while
  // this field carries the VERDICT-level one — and on the `ci` lane those
  // differ by construction: a confirmed regression maps to
  // `ci_confirmed_regression` while the suspect still says `recorded_break`.
  // Written as the spec has it, rule 6 therefore made EVERY CI-confirmed
  // regression on a protected pin illegal, which contradicts §3.3's own third
  // CI row — it maps exactly that case onto the pin-lane rows. The rule's
  // subject is "a conflict needs a recorded break behind it", and on this lane
  // the confirmed regression IS that break.
  if (
    verdict.protection === "PROTECTED_CONFLICT" &&
    verdict.falsifier !== "recorded_break" &&
    verdict.falsifier !== "ci_confirmed_regression"
  ) {
    return "PROTECTED_CONFLICT without a recorded break";
  }
  // RULE 7, NARROWED TO PIN-SCOPED VERDICTS, and the narrowing is a correction
  // rather than a softening. Unscoped it made every reader-named answer illegal
  // — a doctor FAIL on #50's documented day-one path. Its actual subject is a
  // verdict ABOUT A PINNED INVARIANT: that may attribute only where somebody
  // recorded the invariant broken. Where the reader named the files there is no
  // invariant to be wrong about, and on the `ci` lane the confirmed regression
  // IS the recorded break.
  if (
    verdict.attribution === "ATTRIBUTED" &&
    verdict.invariant !== null &&
    verdict.falsifier !== "recorded_break" &&
    verdict.falsifier !== "ci_confirmed_regression"
  ) {
    return "a pinned invariant attributed without a recorded break";
  }
  if (verdict.coverage.sources.length !== COVERAGE_ROWS) {
    return "coverage did not carry its five rows";
  }
  if (verdict.protection !== "unprotected" && verdict.invariant === null) {
    return "protection asserted where no pin exists";
  }
  return null;
};

export interface VerdictInput {
  readonly repo: string;
  readonly suspect: SuspectView;
  readonly coverage: CoverageRecord;
  readonly delta: CiBehaviorDelta | null;
  readonly deltaLane: "ci" | "pin";
  readonly timing: ExplanationTiming;
  readonly timingReason: TimingReason;
  readonly evidence: EvidenceAxes;
  readonly invariant: InvariantRef | null;
  readonly liveWaiver: WaiverRef | null;
  readonly now: Date;
}

/**
 * The verdict for one surface.
 *
 * READS NO CONFIDENCE — see the module header. It reads a suspect view it does
 * not modify, a coverage record it does not recompute, a delta it does not
 * merge across lanes, a timing it carries without weighing, and 08's axes.
 */
export const computeVerdict = (input: VerdictInput): Verdict => {
  const delta: BehaviorDelta = input.delta?.delta ?? "unconfirmed";
  const deltaReason =
    input.deltaLane === "pin"
      ? // The pin lane has exactly one reason, because a human re-check nobody
        // repeated is the only thing it can establish (§8.10).
        "human_recheck_unrepeated"
      : (input.delta?.reason ?? "insufficient_base");
  const falsifier = verdictFalsifierOf(
    input.suspect.falsifier.kind,
    input.deltaLane,
    delta,
  );
  const { attribution, basis } = attributionFor(
    input.suspect,
    input.coverage,
    input.deltaLane,
    delta,
  );
  const protection = computeProtection({
    repo: input.repo,
    pinId: input.invariant?.pinId ?? null,
    pinVersion: input.invariant?.version ?? null,
    falsifierKind: input.suspect.falsifier.kind,
    liveWaiver: input.liveWaiver,
  });
  // A verdict that names nobody carries no candidate rows. Legality rule (3)
  // forbids it; doing it HERE is what makes that rule satisfiable rather than a
  // trap every caller has to know about.
  const candidates =
    attribution === "ATTRIBUTED" ? input.suspect.candidates : [];

  const verdict: Verdict = {
    repo: input.repo,
    invariant: input.invariant,
    behaviorDelta: delta,
    deltaLane: input.deltaLane,
    deltaReason,
    coverage: input.coverage,
    explanationTiming: input.timing,
    timingReason: input.timingReason,
    attribution,
    protection,
    waiver: input.liveWaiver,
    falsifier,
    evidence: input.evidence,
    basis,
    candidates,
    computedAt: input.now.toISOString(),
  };

  // FAILS CLOSED. A verdict that breaks its own type is a bug in this function,
  // and the one thing it must not do is present the broken answer as an
  // ordinary one. The route reports the violation; this returns the safe shape.
  return verdictLegalityViolation(verdict) === null
    ? verdict
    : {
        ...verdict,
        attribution: "INDETERMINATE",
        basis: "legality_violation",
        candidates: [],
      };
};
