import { describe, expect, test } from "bun:test";

import { MAX_HINTS_PER_SESSION } from "../src/constants.ts";
import { selectHint } from "../src/hints/select.ts";
import type {
  HintClaimCandidate,
  HintContextCandidate,
} from "../src/http/hub.ts";

const SELF_DEVELOPER = "dev_self";
const TEAMMATE = "dev_nick";

const claim = (
  overrides: Partial<HintClaimCandidate> = {},
): HintClaimCandidate => ({
  id: "clm_1",
  workContextId: "wc_1",
  kind: "rejected_approach",
  status: "rejected",
  confidence: 0.8,
  provenance: "declared",
  captureMode: "agent",
  evidenceRefCount: 1,
  authorDeveloperId: TEAMMATE,
  authorDeveloperName: "Nick",
  body: "Retrying the refresh call does not help; the key is gone",
  createdAt: "2026-08-10T08:00:00.000Z",
  ...overrides,
});

const context = (
  overrides: Partial<HintContextCandidate["workContext"]> = {},
  claims: readonly HintClaimCandidate[] = [claim()],
): HintContextCandidate => ({
  workContext: {
    id: "wc_1",
    title: "Refresh 500s after key rotation",
    status: "analyzing",
    tier: "exact",
    developerId: TEAMMATE,
    developerName: "Nick",
    baseCommit: "a1b2c3d4",
    createdAt: "2026-08-10T08:00:00.000Z",
    updatedAt: null,
    ...overrides,
  },
  claims,
});

interface SelectOverrides {
  readonly seenRefIds?: readonly string[];
  readonly deliveredCount?: number;
  readonly selfDeveloperId?: string | null;
}

const select = (
  candidates: readonly HintContextCandidate[],
  overrides: SelectOverrides = {},
) =>
  selectHint({
    candidates,
    seenRefIds: overrides.seenRefIds ?? [],
    deliveredCount: overrides.deliveredCount ?? 0,
    // Not `??` — an EXPLICIT null must reach the selector (unknown identity).
    selfDeveloperId:
      overrides.selfDeveloperId === undefined
        ? SELF_DEVELOPER
        : overrides.selfDeveloperId,
  });

describe("anchoring asymmetry (DESIGN.md §4, structural)", () => {
  test("injects an evidence-backed rejected_approach as substance", () => {
    const selection = select([context()]);
    expect(selection.kind).toBe("claim");
    if (selection.kind === "claim") {
      expect(selection.claim.id).toBe("clm_1");
    }
  });

  test("injects an evidence-backed likely_root_cause", () => {
    const settled = claim({
      id: "clm_root",
      kind: "root_cause",
      status: "likely_root_cause",
    });
    const selection = select([context({}, [settled])]);
    expect(selection.kind).toBe("claim");
  });

  test("a bare proposed hypothesis is NEVER substance — pointer only", () => {
    const proposed = claim({
      id: "clm_hypo",
      kind: "hypothesis",
      status: "proposed",
      evidenceRefCount: 0,
    });
    const selection = select([context({}, [proposed])]);
    expect(selection.kind).toBe("pointer");
    // Structural: the pointer variant carries no claim, so no body can leak.
    expect("claim" in selection).toBe(false);
  });

  test("a proposed claim stays a pointer even with evidence attached", () => {
    // (b) of the asymmetry names STATUSES, not evidence alone: proposed is
    // bare by definition, however many refs it carries.
    const proposedWithEvidence = claim({
      id: "clm_hopeful",
      kind: "hypothesis",
      status: "proposed",
      evidenceRefCount: 2,
    });
    expect(select([context({}, [proposedWithEvidence])]).kind).toBe("pointer");
  });

  test("an evidence-free settled claim is not substance either", () => {
    const noEvidence = claim({
      id: "clm_conf",
      kind: "root_cause",
      status: "partially_confirmed",
      evidenceRefCount: 0,
    });
    expect(select([context({}, [noEvidence])]).kind).toBe("pointer");
  });

  test("a superseded claim is never injected", () => {
    const superseded = claim({ id: "clm_old", status: "superseded" });
    expect(select([context({}, [superseded])]).kind).toBe("pointer");
  });

  test("substance in a lower-ranked context beats a pointer in a higher one", () => {
    const weak = context(
      { id: "wc_weak" },
      [claim({ id: "clm_weak", kind: "hypothesis", status: "proposed", evidenceRefCount: 0, workContextId: "wc_weak" })],
    );
    const strong = context({ id: "wc_strong" }, [
      claim({ id: "clm_strong", workContextId: "wc_strong" }),
    ]);
    const selection = select([weak, strong]);
    expect(selection.kind).toBe("claim");
    if (selection.kind === "claim") {
      expect(selection.claim.id).toBe("clm_strong");
    }
  });
});

describe("self-session exclusion", () => {
  test("a context carrying only the reader's own claims is silence", () => {
    // Not merely "not substance": pointing the reader at their own words
    // would be self-noise (§10 risk 1), so the whole context is skipped.
    const own = claim({ id: "clm_mine", authorDeveloperId: SELF_DEVELOPER });
    const selection = select([context({}, [own])]);
    expect(selection.kind).toBe("silence");
  });

  test("an unknown reader identity is silence, never all-foreign", () => {
    // With selfDeveloperId null the selector cannot prove ANY claim is
    // foreign — including one the reader authored into a teammate's tree via
    // extend_diagnosis in an earlier session. Fail closed (§4 self-exclusion).
    const selection = select([context()], { selfDeveloperId: null });
    expect(selection.kind).toBe("silence");
  });
});

describe("precision floor", () => {
  test("a context without a proven lexical tier is silence, not filler", () => {
    expect(select([context({ tier: "recency" })]).kind).toBe("silence");
    expect(select([context({ tier: undefined })]).kind).toBe("silence");
  });

  test("no candidates is silence", () => {
    expect(select([]).kind).toBe("silence");
  });
});

describe("seen-set dedup and session cap", () => {
  test("a delivered claim ref is never selected twice", () => {
    const selection = select([context()], { seenRefIds: ["clm_1"] });
    expect(selection.kind).not.toBe("claim");
  });

  test("a context whose claim was already delivered is not re-surfaced as a pointer", () => {
    // The claim hint said everything the pointer would; surfacing the same
    // context again is noise, not news.
    const selection = select([context()], { seenRefIds: ["clm_1"], deliveredCount: 1 });
    expect(selection.kind).toBe("silence");
  });

  test("a pointered context is never pointered twice", () => {
    const proposed = claim({
      id: "clm_hypo",
      kind: "hypothesis",
      status: "proposed",
      evidenceRefCount: 0,
    });
    const selection = select([context({}, [proposed])], {
      seenRefIds: ["wc_1"],
    });
    expect(selection.kind).toBe("silence");
  });

  test("the session cap forces silence past MAX_HINTS_PER_SESSION", () => {
    const selection = select([context()], {
      deliveredCount: MAX_HINTS_PER_SESSION,
    });
    expect(selection.kind).toBe("silence");
  });

  test("one prompt yields at most one hint even with many candidates", () => {
    const many = [
      context({ id: "wc_a" }, [claim({ id: "clm_a", workContextId: "wc_a" })]),
      context({ id: "wc_b" }, [claim({ id: "clm_b", workContextId: "wc_b" })]),
      context({ id: "wc_c" }, [claim({ id: "clm_c", workContextId: "wc_c" })]),
    ];
    const selection = select(many);
    // Structural: selectHint returns ONE selection object, never a list — the
    // first-ranked injectable wins and the rest wait for later prompts.
    expect(Array.isArray(selection)).toBe(false);
    expect(selection.kind).toBe("claim");
    if (selection.kind === "claim") {
      expect(selection.claim.id).toBe("clm_a");
    }
  });
});

describe("solved trees compose with the anchoring rules (VISION.md §1)", () => {
  // Pins, deliberately green before the solved block existed: the task is
  // that solved-tree delivery COMPOSES with §4's existing allowance —
  // confirmed root cause with evidence — rather than adding a new one. These
  // hold that door shut in both directions.
  test("a solved tree's evidenced root cause is substance through the existing rule", () => {
    const selection = select([
      context({ resultKind: "solved", solvedAt: "2026-03-10T08:00:00.000Z" }, [
        claim({
          id: "clm_rc",
          kind: "root_cause",
          status: "likely_root_cause",
          evidenceRefCount: 1,
        }),
      ]),
    ]);
    expect(selection.kind).toBe("claim");
    if (selection.kind === "claim") {
      expect(selection.claim.id).toBe("clm_rc");
    }
  });

  test("the solved label alone cannot push a bare proposed hypothesis", () => {
    const selection = select([
      context({ resultKind: "solved", solvedAt: "2026-03-10T08:00:00.000Z" }, [
        claim({
          id: "clm_hypo",
          kind: "hypothesis",
          status: "proposed",
          evidenceRefCount: 0,
        }),
      ]),
    ]);
    expect(selection.kind).toBe("pointer");
  });
});
