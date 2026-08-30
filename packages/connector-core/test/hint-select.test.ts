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
  matchedTargets: HintContextCandidate["matchedTargets"] = [],
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
  matchedTargets,
});

const fileTarget = (
  value = "src/auth/refresh.ts",
  createdAt: string | null = "2026-08-10T08:00:00.000Z",
): HintContextCandidate["matchedTargets"][number] => ({
  kind: "file",
  value,
  createdAt,
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

  test("a derived claim is NEVER substance, whatever its status or evidence", () => {
    // DESIGN.md §3/§4: Tier-1 drafts are machine-derived and appear only as
    // pull-able pointers — even a derived rejected_approach with evidence, or
    // a derived partially_confirmed claim, must not be proactively injected.
    const derivedNegative = claim({
      id: "clm_drv_neg",
      provenance: "derived",
      captureMode: "auto",
    });
    const derivedSettled = claim({
      id: "clm_drv_set",
      kind: "root_cause",
      status: "partially_confirmed",
      provenance: "derived",
      captureMode: "auto",
    });
    expect(select([context({}, [derivedNegative])]).kind).toBe("pointer");
    expect(select([context({}, [derivedSettled])]).kind).toBe("pointer");
  });

  test("an unknown provenance value is never substance — fail closed", () => {
    // The boundary schema admits ANY non-empty provenance string (hub.ts
    // z.string().min(1)), so a value this connector has never heard of can
    // arrive here. Only the positive "declared" — someone vouched — may be
    // injected; everything else degrades to a pointer, not substance.
    const unknownProvenance = claim({ id: "clm_weird", provenance: "weird" });
    expect(select([context({}, [unknownProvenance])]).kind).toBe("pointer");
  });

  test("a claim whose body the hub withheld is a pointer, never «»", () => {
    // The client half of audit row V2-X4. The hub now sends `body: ""` for
    // every claim nobody vouched for, and a hub that withholds MORE than that
    // is exactly the hub this connector must survive: without this rule the
    // reader is handed a fully trust-labelled sentence with empty quotes
    // where the finding should be, which reads as "Nick found nothing".
    const withheld = claim({ id: "clm_withheld", body: "" });
    expect(select([context({}, [withheld])]).kind).toBe("pointer");
    // The control on the same arrangement: the identical claim WITH its body
    // is substance, so this is a rule about the empty body and not about the
    // fixture failing some other gate.
    expect(select([context({}, [claim({ id: "clm_withheld" })])]).kind).toBe(
      "claim",
    );
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

describe("targets-only pointer (trial finding #19)", () => {
  test("an exact-tier context with 0 claims but a matched file → pointer", () => {
    // The prompt named a file this teammate context touched; the exact tier is
    // a fact, so a body-less pointer is precise even with zero claims — the
    // structural death this fix removes (foreignCount > 0 used to be required).
    const selection = select([context({}, [], [fileTarget()])]);
    expect(selection.kind).toBe("pointer");
    if (selection.kind === "pointer") {
      expect(selection.claimCount).toBe(0);
      expect(selection.matchedTarget?.value).toBe("src/auth/refresh.ts");
      // Structural: still no claim on the variant, so no body can leak.
      expect("claim" in selection).toBe(false);
    }
  });

  test("a matched file with an unknown age still points (createdAt null)", () => {
    const selection = select([context({}, [], [fileTarget("src/x.ts", null)])]);
    expect(selection.kind).toBe("pointer");
    if (selection.kind === "pointer") {
      expect(selection.matchedTarget?.createdAt).toBeNull();
    }
  });

  test("the READER's OWN exact-tier context never points (§4 self-exclusion)", () => {
    // The claim pointer gets this free — own claims are never foreign, so
    // foreignCount stays 0. A targets-only pointer has no claim to derive it
    // from, and an exact path match is exactly how the reader's OWN earlier
    // session surfaces. The hub excludes the caller today; §4 makes the
    // selector the second line of defence, and one self-pointer would spend a
    // teammate's slot out of the five a session gets.
    //
    // GREEN ON MAIN too, like the three negatives below — main answers silence
    // to every candidate, so this is not a red-first proof either. What it
    // guards is this branch's own gate: the mutation "the targets-only pointer
    // points at the reader's own work" fails here and nowhere else.
    expect(
      select([context({ developerId: SELF_DEVELOPER }, [], [fileTarget()])]).kind,
    ).toBe("silence");
  });

  // The three negatives below are GREEN ON MAIN as well as on this branch —
  // main answers silence to every candidate, so they cannot be red-first
  // proofs of the new pointer. They are the precision guards around it: each
  // one fails the moment the exact-tier gate, the file-kind gate or the
  // seen-set check is widened.
  test("an FTS-tier context with 0 claims and a matched file stays silent", () => {
    // FTS is too loose to point on without a claim behind it (keep precision).
    expect(
      select([context({ tier: "fts" }, [], [fileTarget()])]).kind,
    ).toBe("silence");
  });

  test("a non-file matched target does not make a targets-only pointer", () => {
    const symbolTarget = { kind: "symbol", value: "verifyToken", createdAt: null };
    expect(select([context({}, [], [symbolTarget])]).kind).toBe("silence");
  });

  test("a seen context is not re-pointed on its matched target", () => {
    expect(
      select([context({}, [], [fileTarget()])], { seenRefIds: ["wc_1"] }).kind,
    ).toBe("silence");
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

describe("intent-only contexts pointer (trial finding #16: same topic, different files)", () => {
  const INTENT = {
    summary: "Stop the refresh 500s by refetching the JWKS on an unknown kid",
    provenance: "derived",
    confidence: 0.4,
    capturedAt: "2026-08-10T08:00:00.000Z",
  } as const;

  test("a context with an intent and NO claims is a pointer with claimCount 0", () => {
    const selection = select([context({ intent: INTENT }, [])]);

    expect(selection.kind).toBe("pointer");
    if (selection.kind === "pointer") {
      expect(selection.claimCount).toBe(0);
      expect(selection.context.workContext.id).toBe("wc_1");
    }
    // Structural: no body can leak through an intent-only pointer either
    expect("claim" in selection).toBe(false);
  });

  test("a context with neither claims nor intent stays silent — the intent is the difference", () => {
    // The control FIRST: the identical claimless context becomes a pointer
    // only because it carries an intent. Without this line the three
    // silences below pass on any tree that never points at a claimless
    // context at all, which is what the tree before this feature did.
    expect(select([context({ intent: INTENT }, [])]).kind).toBe("pointer");

    expect(select([context({}, [])]).kind).toBe("silence");
    expect(select([context({ intent: null }, [])]).kind).toBe("silence");
    expect(select([context({ intent: { ...INTENT, summary: "" } }, [])]).kind).toBe("silence");
  });

  test("an intent-only context already pointed at this session is not re-pointed", () => {
    const candidates = [context({ intent: INTENT }, [])];

    // Control: unseen, it IS a pointer — so the silence below is the
    // seen-set doing its job, not the selector ignoring intents.
    expect(select(candidates).kind).toBe("pointer");
    expect(select(candidates, { seenRefIds: ["wc_1"] }).kind).toBe("silence");
  });

  test("substance in another context still beats an intent-only pointer", () => {
    const intentOnly = context({ id: "wc_intent", intent: INTENT }, []);

    // Control: alone, the intent-only context is a pointer
    expect(select([intentOnly]).kind).toBe("pointer");

    const selection = select([
      intentOnly,
      context({ id: "wc_claims" }, [claim({ workContextId: "wc_claims" })]),
    ]);

    expect(selection.kind).toBe("claim");
  });

  test("the tier floor applies to intent-only contexts as well", () => {
    // Control: in the exact tier the same context is a pointer
    expect(select([context({ tier: "exact", intent: INTENT }, [])]).kind).toBe("pointer");
    expect(select([context({ tier: "recency", intent: INTENT }, [])]).kind).toBe("silence");
  });

  /**
   * Self-exclusion, client side. Before intents, the pointer pass could only
   * fire on a context with a FOREIGN claim, so a candidate list that leaked
   * the reader's own context could not produce a pointer. `hasIntent` removed
   * that accident, and the hub's own exclusion (services/hints.ts) became the
   * single point of failure — so the selector states the rule itself.
   */
  test("my own intent-only context is never pointed back at me", () => {
    const mine = context({ id: "wc_mine", developerId: SELF_DEVELOPER, intent: INTENT }, []);

    expect(select([mine]).kind).toBe("silence");
    // The same context owned by a teammate IS a pointer — the developer id
    // is what decides, not the shape of the context.
    expect(select([{ ...mine, workContext: { ...mine.workContext, developerId: TEAMMATE } }]).kind).toBe(
      "pointer",
    );
  });
});
