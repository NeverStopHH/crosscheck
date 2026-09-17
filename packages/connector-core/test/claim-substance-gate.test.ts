/**
 * AT-2'S TEETH — the unsolicited substance lane (1.0 spec 02 §5, CCB-1/CCB-7).
 *
 * `isInjectable` decides whether a TEAMMATE'S claim enters your prompt as a
 * full body under full trust labels. Before this spec it read provenance,
 * body, evidence and `status !== "superseded"` and never asked about code at
 * all: a root cause recorded in April against a file rewritten in June was
 * injected in July, unqualified.
 *
 * NOTHING IS SILENCED. A claim that fails these terms keeps the POINTER lane
 * and stays readable on every pulled surface — one rung down the
 * SUBSTANCE / POINTER / SILENCE ladder, not out.
 */
import { describe, expect, test } from "bun:test";
import type { ClaimValidity } from "@crosscheck/schema";

import { selectHint } from "../src/hints/select.ts";
import type {
  HintClaimCandidate,
  HintContextCandidate,
} from "../src/http/hub.ts";

const SELF = "dev_self";
const TEAMMATE = "dev_nick";
const ISO = "2026-08-10T08:00:00.000Z";

const validity = (overrides: Partial<ClaimValidity> = {}): ClaimValidity => ({
  state: "current",
  observedAtCommit: "a1b2c3d",
  commitBinding: "session_base",
  basis: "context_targets",
  touchingCommits: [],
  touchingTotal: 0,
  lastRevalidatedAt: ISO,
  supersededByClaimId: null,
  ...overrides,
});

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
  validity: validity(),
  createdAt: ISO,
  ...overrides,
});

const context = (
  claims: readonly HintClaimCandidate[],
): HintContextCandidate => ({
  workContext: {
    id: "wc_1",
    title: "Refresh 500s after key rotation",
    status: "analyzing",
    tier: "exact",
    developerId: TEAMMATE,
    developerName: "Nick",
    baseCommit: "a1b2c3d4",
    createdAt: ISO,
    updatedAt: null,
  },
  claims,
  matchedTargets: [],
});

const select = (claims: readonly HintClaimCandidate[]) =>
  selectHint({
    candidates: [context(claims)],
    seenRefIds: [],
    deliveredCount: 0,
    selfDeveloperId: SELF,
  });

describe("the substance gate asks about code", () => {
  test("a claim bound to no commit is a pointer, never a body", () => {
    // Arrange: CCB-1. The author's session registered with NO_COMMIT_SHA, so
    // ingest stamped `commit_binding = 'none'` — nothing to revalidate
    // against, ever. Unknown fails CLOSED on the code axis.
    const unbound = claim({
      validity: validity({
        state: "unknown",
        commitBinding: "none",
        observedAtCommit: null,
        basis: null,
        lastRevalidatedAt: null,
      }),
    });

    // Act
    const selection = select([unbound]);

    // Assert: still surfaced — a pointer, with a count and no body.
    expect(selection.kind).toBe("pointer");
    expect(selection.kind === "pointer" ? selection.claimCount : 0).toBe(1);
  });

  test("a claim whose surface moved drops to a pointer", () => {
    // Arrange: D3's default. AT-2 says "no longer presented as a current
    // cause", and a full body under full trust labels in a teammate's prompt
    // is the most current presentation there is.
    const stale = claim({
      kind: "root_cause",
      status: "likely_root_cause",
      validity: validity({
        state: "stale",
        touchingCommits: ["deadbee"],
        touchingTotal: 1,
      }),
    });

    // Act + Assert
    expect(select([stale]).kind).toBe("pointer");
  });

  test("an unrevalidated claim is still substance", () => {
    // Arrange: `unknown` stays injectable. Refusing everything unmeasured
    // would silence a whole hub on the day this shipped, and a claim nobody
    // has checked is not a claim somebody checked and found wrong.
    const unchecked = claim({
      validity: validity({
        state: "unknown",
        basis: null,
        lastRevalidatedAt: null,
      }),
    });

    // Act + Assert
    expect(select([unchecked]).kind).toBe("claim");
  });

  test("a hub too old to send validity is still substance", () => {
    // Arrange: absence is "the hub did not answer", which is `unknown` for
    // the purposes of this gate — an old hub must not silence its whole team.
    const { validity: _dropped, ...rest } = claim();

    // Act + Assert
    expect(select([rest as HintClaimCandidate]).kind).toBe("claim");
  });
});

describe("the edge outranks the status, and the status stays as a second lock", () => {
  test("a forging hub that clears the status cannot restore the lane", () => {
    // Arrange: CCB-7, built on the hostile-hub shape. A hub that reports
    // `status: "likely_root_cause"` — no retraction visible — while the EDGE
    // says the claim was superseded is exactly the forgery the connector's
    // own status check cannot see. The validity record carries the edge
    // across the wire, so the gate refuses on it.
    const forged = claim({
      status: "likely_root_cause",
      kind: "root_cause",
      validity: validity({
        state: "superseded",
        supersededByClaimId: "clm_revision",
      }),
    });

    // Act + Assert
    expect(select([forged]).kind).toBe("pointer");
  });

  test("a forging hub that omits the edge still meets the status check", () => {
    // Arrange: the OTHER direction, and the reason the status term stays.
    // A hub that reports `status: "superseded"` beside a `current` validity is
    // asserting two contradictory things; the connector believes neither and
    // keeps the claim out of the substance lane. Deleting the status term in
    // favour of the hub-supplied field would REMOVE a defence rather than
    // retire a second definition — the hub already filters superseded rows
    // out of the candidate list by edge (services/hints.ts notSuperseded), so
    // nothing honest exercises this path at all.
    const forged = claim({
      status: "superseded",
      validity: validity({ state: "current" }),
    });

    // Act + Assert
    expect(select([forged]).kind).toBe("pointer");
  });
});

describe("negative knowledge is judged by its code, like every other claim", () => {
  /**
   * `rejected` IS A REJECTED APPROACH'S NATURAL STATUS, not a retraction.
   * Spec 02 §3.5 derives `invalidated` from `status === "rejected"` for every
   * kind, and read that way the one category DESIGN.md §4 privileges — an
   * evidence-backed `rejected_approach`, "negative knowledge cannot anchor a
   * wrong theory, only save a dead end" — is `invalidated` from the moment it
   * is written. The hub therefore derives `invalidated` only for kinds whose
   * rejected status IS a retraction (server services/claim-validity.ts), and
   * a rejected approach walks the code axis instead: `stale` when its files
   * moved, which is exactly Nick's "raising the timeout does nothing".
   *
   * With that settled, this gate refuses §5's full set — `stale`,
   * `invalidated` and `superseded` — verbatim.
   */
  test("a rejected approach whose code did not move stays substance", () => {
    // Arrange: the corpus's own shape — kind rejected_approach, status
    // rejected, one evidence ref, declared — revalidated and unchanged.
    const negative = claim();

    // Act + Assert
    expect(select([negative]).kind).toBe("claim");
  });

  test("a rejected approach whose code moved drops to a pointer", () => {
    // Arrange: the superstition case. The finding was true of code that has
    // since been rewritten.
    const superstition = claim({
      body: "Raising the timeout does nothing",
      validity: validity({
        state: "stale",
        touchingCommits: ["deadbee"],
        touchingTotal: 1,
      }),
    });

    // Act + Assert
    expect(select([superstition]).kind).toBe("pointer");
  });

  test("a claim the hub calls invalidated is never substance", () => {
    // Arrange: whatever its kind. The hub is the one authority on the state,
    // and §5 refuses `invalidated` outright — a hub that hands this label to
    // a rejected approach (an older derivation, or a forging hub) keeps it
    // out of the substance lane rather than in it.
    const labelled = claim({ validity: validity({ state: "invalidated" }) });

    // Act + Assert
    expect(select([labelled]).kind).toBe("pointer");
  });

  test("no other kind can reach the gate carrying a rejected status", () => {
    // Arrange: the measurement the paragraph above rests on. A root_cause
    // claim the author retracted is already refused by the kind/status
    // asymmetry, with or without a validity record — so the `invalidated`
    // term would be pure redundancy on it.
    const retracted = claim({
      kind: "root_cause",
      status: "rejected",
      validity: validity({ state: "invalidated" }),
    });
    const { validity: _dropped, ...noValidity } = retracted;

    // Act + Assert
    expect(select([retracted]).kind).toBe("pointer");
    expect(select([noValidity as HintClaimCandidate]).kind).toBe("pointer");
  });
});
