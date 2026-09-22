/**
 * WHERE AT-2 BECOMES VISIBLE.
 *
 * "A root cause recorded at commit X, after the affected surface has been
 * substantially rewritten, STAYS READABLE but is no longer presented as a
 * current cause — and the downgrade NAMES the commits that caused it."
 *
 * A downgrade that lives only in a column is not a downgrade: nobody runs
 * `doctor` to find out a diagnosis went stale. So the clause renders on the
 * PULLED surfaces at full length, and the state WORD alone on the unsolicited
 * claim hint — where `fitHint` drops lines from the END, so anything appended
 * after the facts line is the first thing to disappear.
 */
import { describe, expect, test } from "bun:test";
import type { ClaimValidity } from "@crosscheck/schema";

import { MAX_CLAIM_VALIDITY_LINE_CHARS } from "../src/constants.ts";
import { renderClaimHint } from "../src/hints/render.ts";
import { UNKNOWN_COVERAGE } from "../src/http/coverage.ts";
import { claimValidityClause, renderDiagnosis } from "../src/mcp/render.ts";
import type { Diagnosis } from "../src/http/hub.ts";

const NOW = new Date("2026-09-15T12:00:00.000Z");
const ISO = "2026-09-15T09:00:00.000Z";

const validity = (overrides: Partial<ClaimValidity> = {}): ClaimValidity => ({
  state: "stale",
  observedAtCommit: "a1b2c3d",
  commitBinding: "reported",
  basis: "declared",
  refCommit: null,
  selfReported: false,
  touchingCommits: ["def5678", "9a1b2c3"],
  touchingTotal: 2,
  lastRevalidatedAt: ISO,
  supersededByClaimId: null,
  ...overrides,
});

const diagnosisWith = (claimValidity: ClaimValidity | undefined): Diagnosis => ({
  workContext: {
    id: "wc_01",
    sessionId: "cc_01",
    title: "Login 500s on staging",
    status: "analyzing",
    intent: null,
    createdAt: ISO,
  },
  claims: [
    {
      id: "clm_01",
      workContextId: "wc_01",
      authorSessionId: "cc_01",
      authorDeveloperName: "Mara",
      kind: "root_cause",
      body: "The refresh path never reloads the rotated key",
      status: "likely_root_cause",
      confidence: 0.8,
      captureMode: "agent",
      provenance: "declared",
      dedupCount: 1,
      evidenceRefs: [],
      createdAt: ISO,
      ...(claimValidity === undefined ? {} : { validity: claimValidity }),
    },
  ],
  edges: [],
  externalClaims: [],
  targets: [],
  targetsReported: true,
  droppedTargets: 0,
  coverage: UNKNOWN_COVERAGE,
  truncated: false,
  droppedRows: 0,
});

const hintWith = (claimValidity: ClaimValidity | undefined): string =>
  renderClaimHint({
    claim: {
      id: "clm_01",
      workContextId: "wc_01",
      kind: "root_cause",
      status: "likely_root_cause",
      confidence: 0.8,
      provenance: "declared",
      evidenceRefCount: 1,
      authorDeveloperId: "dev_mara",
      authorDeveloperName: "Mara",
      body: "The refresh path never reloads the rotated key",
      createdAt: ISO,
      ...(claimValidity === undefined ? {} : { validity: claimValidity }),
    },
    context: {
      id: "wc_01",
      title: "Login 500s on staging",
      status: "analyzing",
      intent: null,
      developerId: "dev_mara",
      developerName: "Mara",
      resultKind: "open",
      solvedAt: null,
      createdAt: ISO,
      updatedAt: null,
    },
    drift: null,
    now: NOW,
  });

const claimLineOf = (rendered: string): string =>
  rendered.split("\n").find((line) => line.startsWith("- clm_01")) ?? "";

describe("the validity clause on pulled surfaces", () => {
  test("a stale claim stays readable and names the commits", async () => {
    // Act
    const rendered = renderDiagnosis(diagnosisWith(validity()), NOW);

    // Assert: the body survives — nothing is hidden — and the downgrade names
    // both short shas beside the commit it was recorded at.
    expect(rendered).toContain("The refresh path never reloads the rotated key");
    const line = claimLineOf(rendered);
    expect(line).toContain("a1b2c3d");
    expect(line).toContain("def5678");
    expect(line).toContain("9a1b2c3");
    expect(line).toContain("no longer current");
  });

  test("the clause says how many more commits it did not name", async () => {
    // Act
    const rendered = renderDiagnosis(
      diagnosisWith(validity({ touchingTotal: 14 })),
      NOW,
    );

    // Assert
    expect(claimLineOf(rendered)).toContain("12 more");
  });

  test("a clause that cannot be counted says so rather than inventing a number", async () => {
    // Act
    const rendered = renderDiagnosis(
      diagnosisWith(validity({ touchingTotal: null })),
      NOW,
    );

    // Assert
    expect(claimLineOf(rendered)).toContain("more");
    expect(claimLineOf(rendered)).not.toMatch(/\d+ more/);
  });

  test("an unbound claim says it is bound to no commit", async () => {
    // Act
    const rendered = renderDiagnosis(
      diagnosisWith(
        validity({
          state: "unknown",
          commitBinding: "none",
          observedAtCommit: null,
          touchingCommits: [],
          touchingTotal: null,
          basis: null,
          lastRevalidatedAt: null,
        }),
      ),
      NOW,
    );

    // Assert
    expect(claimLineOf(rendered)).toContain("no commit");
  });

  test("a hub that sends no validity gets no clause, not a guessed one", async () => {
    // Arrange: absence means "the hub did not answer", which is a different
    // statement from "unknown" — the targetsReported rule, one field over.
    const rendered = renderDiagnosis(diagnosisWith(undefined), NOW);

    // Assert
    expect(rendered).toContain("The refresh path never reloads the rotated key");
    expect(claimLineOf(rendered)).not.toContain("no longer current");
    expect(claimLineOf(rendered)).not.toContain("unknown");
  });

  test("the clause is bounded, and the bound is spent on the opener first", async () => {
    // Arrange: five 40-character hashes and a large total — the worst case a
    // busy file produces.
    const worst = validity({
      touchingCommits: [
        "0123456789abcdef0123456789abcdef01234567",
        "123456789abcdef0123456789abcdef012345678",
        "23456789abcdef0123456789abcdef0123456789",
        "3456789abcdef0123456789abcdef0123456789a",
        "456789abcdef0123456789abcdef0123456789ab",
      ],
      touchingTotal: 99,
    });

    // Act
    const clause = claimValidityClause(worst) ?? "";

    // Assert: a truncated sentence that still says "no longer current" is
    // worth more than a complete one nobody sees.
    expect(clause.length).toBeLessThanOrEqual(MAX_CLAIM_VALIDITY_LINE_CHARS);
    expect(clause.startsWith("no longer current")).toBe(true);
    expect(claimLineOf(renderDiagnosis(diagnosisWith(worst), NOW))).toContain(
      "no longer current",
    );
  });
});

describe("the state word on the unsolicited claim hint", () => {
  test("the word rides the facts line, which fitHint can never drop", async () => {
    // Arrange: fitHint drops from the END and returns "" below two lines, so
    // an appended validity line is the first thing to disappear — and a
    // downgrade nobody sees is not a downgrade.
    const rendered = hintWith(validity({ state: "current" }));

    // Assert
    const factsLine = rendered.split("\n")[1] ?? "";
    expect(factsLine).toContain("validity current");
  });

  test("the hint never spends its characters on commit hashes", async () => {
    // Arrange: a hint is unsolicited. Spending its budget on three hashes
    // anchors a session on a file history nobody asked about, and the hashes
    // are one get_diagnosis away.
    const rendered = hintWith(validity());

    // Assert
    expect(rendered).toContain("validity stale");
    expect(rendered).not.toContain("def5678");
    expect(rendered).not.toContain("9a1b2c3");
  });

  test("a hub that sends no validity gets no word", async () => {
    // Assert
    expect(hintWith(undefined)).not.toContain("validity ");
  });
});

/**
 * NON-NEGOTIABLE #2 ON THIS CHANGE: every visible surface registered AND
 * planted in the injection corpus of connector-core, connector-cursor AND
 * connector-acp.
 *
 * The claim hint is rendered by ONE core function that all three packages
 * wrap, so the registrations were already in place and nothing new had to be
 * registered. That made it easy to believe the corpus covered the new line —
 * and it did not: each package's corpus adapter builds its own
 * HintClaimCandidate, all three omitted `validity`, so `claimValidityWord`
 * returned null on every payload and the corpus rendered the surface exactly
 * as it did before this spec. A surface the corpus cannot see is a surface
 * the corpus does not guard.
 */
describe("the claim-hint corpus sees the state word, in every package", () => {
  test("all three registered claim-hint surfaces render it", async () => {
    // Arrange: the registries as the meta-test discovers them — this one, the
    // Cursor mirror and the ACP mirror.
    const { ALL_REGISTERED_SURFACES } = await import(
      "./fixtures/registry-packages.ts"
    );
    const hints = ALL_REGISTERED_SURFACES.filter(
      (surface) => surface.kind === "corpus" && surface.name.includes("claim-hint"),
    );

    // Assert: three of them, and each renders a state word under the corpus's
    // own payload rather than skipping the line.
    expect(hints.length).toBe(3);
    for (const surface of hints) {
      expect(
        surface.kind === "corpus" ? surface.render("rate limit fix") : "",
        `${surface.name} renders no validity state word`,
      ).toContain("validity ");
    }
  });
});

/**
 * THE SAME OBLIGATION, ON THE BRIEFING'S SOLVED ROOT CAUSE.
 *
 * The lesson of the block above, applied before it could be repeated: a new
 * label the corpus cannot see is a new label the corpus does not guard. This
 * surface is registered in connector-core ALONE — the briefing's solved
 * section has no Cursor or ACP mirror, because those adapters register their
 * own `*-briefing` surfaces rather than wrapping this one — so one entry is
 * the whole obligation here, and the count is asserted rather than assumed.
 */
describe("the briefing-solved corpus sees the state word", () => {
  test("the registered surface renders it under the corpus payload", async () => {
    // Arrange
    const { ALL_REGISTERED_SURFACES } = await import(
      "./fixtures/registry-packages.ts"
    );
    const solved = ALL_REGISTERED_SURFACES.filter(
      (surface) => surface.kind === "corpus" && surface.name === "briefing-solved",
    );

    // Assert: one, and it carries both the framed body it exists to attack
    // and the new label beside it.
    expect(solved.length).toBe(1);
    const rendered =
      solved[0]?.kind === "corpus" ? solved[0].render("rate limit fix") : "";
    expect(rendered).toContain("validity ");
    expect(rendered).toContain("root cause · ");
  });
});

describe("a binding nobody stated does not read like one somebody did", () => {
  test("the session-base fallback is named in the sentence", () => {
    // THE ANCHOR. `reported` is the commit the agent said it was looking at;
    // `session_base` is the hub reading the session's base commit because the
    // claim named none — and that is an UPPER BOUND. A session that checks
    // out a newer commit re-registers, `sessions.ts` overwrites base_commit
    // by design, and a claim observed before the checkout is filed against
    // the commit after it. The walk then starts too late and the commits in
    // between — the ones most likely to have moved this code — are never
    // looked at, so the claim reads `current` on a measurement that skipped
    // them. Render both alike and a reader cannot tell which they hold.
    const stated = claimValidityClause(
      validity({ state: "current", commitBinding: "reported" }),
    );
    const inferred = claimValidityClause(
      validity({ state: "current", commitBinding: "session_base" }),
    );

    expect(stated).toContain("recorded at a1b2c3d");
    expect(stated).not.toContain("session's commit");
    expect(inferred).toContain("its session's commit rather than a stated one");
    expect(inferred).not.toBe(stated);
  });

  test("the longest current sentence keeps its qualifiers", () => {
    // THE BOUND IS SPENT ON THE OPENER FIRST, so what a long sentence loses
    // is its TAIL — and the tail is where both weakening qualifiers live: who
    // measured it, and what the commit actually is. At 160 this exact
    // sentence measured 160, fitting by one character; the next word anyone
    // added would have dropped ", by its own author" and left the shorter,
    // more confident reading standing.
    const clause = claimValidityClause(
      validity({
        state: "current",
        commitBinding: "session_base",
        refCommit: "9876543",
        selfReported: true,
        touchingCommits: [],
        touchingTotal: 0,
      }),
    );

    expect(clause?.endsWith("…")).toBe(false);
    expect(clause).toContain("its session's commit rather than a stated one");
    expect(clause).toContain("by its own author");
    expect(clause).toContain("9876543");
    expect((clause ?? "").length).toBeLessThanOrEqual(
      MAX_CLAIM_VALIDITY_LINE_CHARS,
    );
  });
});
