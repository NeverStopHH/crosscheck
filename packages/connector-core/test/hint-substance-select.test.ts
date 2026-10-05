/**
 * A strong, evidence-backed match carries its substance (DESIGN.md §4,
 * revised after the 2026-10 pilot: 95 prompt hints, 0 opened — a pointer
 * whose substance sits behind a get_diagnosis nobody calls is a pointer
 * nobody reads).
 *
 * The rule has TWO halves and both are required. TRUST, as before: declared,
 * a body, evidence (HINT_MIN_EVIDENCE_REFS), not superseded or rejected, code
 * still current — never a draft. RELEVANCE, new: the claim ITSELF shares
 * HINT_MIN_SHARED_TERMS words with what was matched, or the match is content
 * identity (an error fingerprint). Evidence makes a claim trustworthy; the
 * match makes it relevant; asserting one unasked needs both — the rule §4's
 * "Solved before" already states for the briefing. Everything else keeps the
 * pointer, which is never a regression: it is where every claim used to go.
 */
import { describe, expect, test } from "bun:test";

import { HINT_MIN_SHARED_TERMS } from "../src/constants.ts";
import { selectHint } from "../src/hints/select.ts";
import type { HintClaimCandidate, HintContextCandidate } from "../src/http/hub.ts";

const SELF = "dev_self";
const TEAMMATE = "dev_nick";
const ISO = "2026-08-10T08:00:00.000Z";

/** An evidence-backed DECISION the prompt matched on two of its words. */
const decision = (overrides: Partial<HintClaimCandidate> = {}): HintClaimCandidate => ({
  id: "clm_decision",
  workContextId: "wc_1",
  kind: "decision",
  status: "proposed",
  confidence: 0.7,
  provenance: "declared",
  captureMode: "agent",
  evidenceRefCount: 1,
  authorDeveloperId: TEAMMATE,
  authorDeveloperName: "Ken",
  body: "Keep the chunked upload; the single PUT hits the gateway body limit above 2 GB.",
  matchedTerms: HINT_MIN_SHARED_TERMS,
  createdAt: ISO,
  ...overrides,
});

const context = (
  claims: readonly HintClaimCandidate[],
  matchedTargets: HintContextCandidate["matchedTargets"] = [],
  treeTerms?: number,
): HintContextCandidate => ({
  workContext: {
    id: "wc_1",
    title: "NUMLABS PRACTICE",
    status: "implementing",
    tier: "fts",
    developerId: TEAMMATE,
    developerName: "Ken",
    baseCommit: "a1b2c3d4",
    createdAt: ISO,
    updatedAt: null,
    ...(treeTerms === undefined ? {} : { matchedTerms: treeTerms }),
  },
  claims,
  matchedTargets,
  matchedOn: "prompt",
});

const select = (candidates: readonly HintContextCandidate[]) =>
  selectHint({ candidates, seenRefIds: [], deliveredCount: 0, selfDeveloperId: SELF });

const selectedClaimId = (candidates: readonly HintContextCandidate[]): string | null => {
  const selection = select(candidates);
  return selection.kind === "claim" ? selection.claim.id : null;
};

describe("a strong, evidence-backed match is substance", () => {
  test("an evidence-backed decision the prompt matched on two words", () => {
    expect(selectedClaimId([context([decision()])])).toBe("clm_decision");
  });

  test("an evidence-backed root cause, still only proposed", () => {
    const cause = decision({ id: "clm_cause", kind: "root_cause", status: "proposed" });
    expect(selectedClaimId([context([cause])])).toBe("clm_cause");
  });

  test("a tree clearly about the prompt lends its strength to a claim that shares one word", () => {
    // The tree's own statement shares three words; the finding touches one
    // of the prompt's — "pool" in "the pool cap is sized for one worker".
    expect(selectedClaimId([context([decision({ matchedTerms: 1 })], [], 3)])).toBe(
      "clm_decision",
    );
  });

  test("an error-fingerprint match is content identity, strong without a shared word", () => {
    const fingerprint = [{ kind: "error_fingerprint", value: "sha256:9c1e", createdAt: ISO }];
    expect(selectedClaimId([context([decision({ matchedTerms: 0 })], fingerprint)])).toBe(
      "clm_decision",
    );
  });
});

describe("a weak or unbacked match keeps today's pointer", () => {
  test("one shared word is weak: the same decision is a pointer", () => {
    const selection = select([context([decision({ matchedTerms: 1 })])]);
    expect(selection.kind).toBe("pointer");
    expect(selection.kind === "pointer" ? selection.claimCount : 0).toBe(1);
  });

  test("a hub that sends no count buys no substance, even for a settled negative", () => {
    // An older hub: the field is absent. The trust half alone used to be
    // enough; the relevance half is unknown, and unknown fails closed.
    const negative = decision({ kind: "rejected_approach", status: "rejected" });
    const { matchedTerms: _omitted, ...withoutCount } = negative;
    expect(select([context([withoutCount])]).kind).toBe("pointer");
  });

  test("a tree clearly about the prompt lends nothing to a claim that shares no word", () => {
    // A strongly matched tree can hold findings about something else.
    expect(select([context([decision({ matchedTerms: 0 })], [], 5)]).kind).toBe("pointer");
  });

  test("one shared word on the tree and one on the claim is still weak", () => {
    expect(select([context([decision({ matchedTerms: 1 })], [], 1)]).kind).toBe("pointer");
  });

  test("a file the prompt named is not by itself a strong match", () => {
    // A shared FILE says two pieces of work are near each other, not that
    // this claim is about the prompt (§4 Solved before, the same narrowing).
    const file = [{ kind: "file", value: "src/upload.ts", createdAt: ISO }];
    expect(select([context([decision({ matchedTerms: 0 })], file)]).kind).toBe("pointer");
  });

  test("a decision without evidence is a pointer", () => {
    expect(select([context([decision({ evidenceRefCount: 0, matchedTerms: 4 })])]).kind).toBe(
      "pointer",
    );
  });

  test("a derived decision — a draft — is a pointer", () => {
    expect(select([context([decision({ provenance: "derived" })])]).kind).toBe("pointer");
  });

  test("a rejected decision is never substance", () => {
    expect(select([context([decision({ status: "rejected" })])]).kind).toBe("pointer");
  });

  test("a superseded decision is never substance", () => {
    expect(select([context([decision({ status: "superseded" })])]).kind).toBe("pointer");
  });

  test("a decision whose code moved is a pointer", () => {
    const stale = decision({
      validity: {
        state: "stale",
        observedAtCommit: "a1b2c3d",
        commitBinding: "session_base",
        basis: "context_targets",
        refCommit: "a1b2c3d",
        selfReported: false,
        touchingCommits: ["deadbee"],
        touchingTotal: 1,
        lastRevalidatedAt: ISO,
        supersededByClaimId: null,
      },
    });
    expect(select([context([stale])]).kind).toBe("pointer");
  });

  test("a hypothesis stays a pointer however strongly it matched", () => {
    const hypothesis = decision({ kind: "hypothesis", matchedTerms: 6 });
    expect(select([context([hypothesis])]).kind).toBe("pointer");
  });
});

describe("the floor is per candidate, looked at again on this side", () => {
  /** A tree as a current hub sends it: tier, own count, the floor's number. */
  const tree = (
    id: string,
    sharedTerms: number | undefined,
    tier = "fts",
  ): HintContextCandidate => {
    const base = context([decision({ id: `clm_${id}`, workContextId: id, kind: "observation", evidenceRefCount: 0 })]);
    return {
      ...base,
      workContext: { ...base.workContext, id, tier },
      ...(sharedTerms === undefined ? {} : { sharedTerms }),
    };
  };

  test("once the strong tree is seen, the stray-word tree beside it is silence, not a pointer", () => {
    // Probe F of the batch-1006 review, as a hub that forgot the floor sends it
    const selection = selectHint({
      candidates: [tree("wc_upload", 4), tree("wc_rate_limit", 1)],
      seenRefIds: ["wc_upload"],
      deliveredCount: 1,
      selfDeveloperId: SELF,
    });
    expect(selection.kind).toBe("silence");
  });

  test("an exact target clears the floor without a shared word", () => {
    const selection = select([tree("wc_named", 0, "exact")]);
    expect(selection.kind).toBe("pointer");
  });

  test("a hub too old to send the number keeps today's behaviour", () => {
    expect(select([tree("wc_old", undefined)]).kind).toBe("pointer");
  });
});

describe("the ONE most relevant claim, plus the pointer to the rest", () => {
  test("more shared words wins over the hub's order", () => {
    const first = decision({ id: "clm_first", matchedTerms: 2 });
    const closer = decision({ id: "clm_closer", matchedTerms: 4 });
    expect(selectedClaimId([context([first, closer])])).toBe("clm_closer");
  });

  test("on equal relevance a rejected approach still goes first", () => {
    const positive = decision({ id: "clm_positive" });
    const negative = decision({ id: "clm_negative", kind: "rejected_approach", status: "rejected" });
    expect(selectedClaimId([context([positive, negative])])).toBe("clm_negative");
  });

  test("the selection counts the teammate claims it leaves behind", () => {
    const selection = select([
      context([
        decision(),
        decision({ id: "clm_obs", kind: "observation", matchedTerms: 0 }),
        decision({ id: "clm_hyp", kind: "hypothesis", matchedTerms: 0 }),
        decision({ id: "clm_mine", authorDeveloperId: SELF }),
      ]),
    ]);
    expect(selection.kind).toBe("claim");
    // Three foreign claims, one delivered: two left behind. The reader's own
    // claim is knowledge, not a teammate's rest.
    expect(selection.kind === "claim" ? selection.restCount : -1).toBe(2);
  });
});
