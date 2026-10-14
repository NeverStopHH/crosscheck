/**
 * Honest presentation of solved trees at pull time (VISION.md §1): the age
 * stated plainly, drift where available, staleness in three honest states —
 * and the lead-not-answer framing, factual, no imperatives. Solvedness is
 * derived from the very tree being rendered, so the label can never disagree
 * with the claims the reader sees below it.
 */
import { describe, expect, test } from "bun:test";

import {
  renderDiagnosis,
  renderSearchResults,
  solvedAtFromTree,
} from "../src/mcp/render.ts";
import type { Diagnosis, DiagnosisClaim, DiagnosisEdge } from "../src/http/hub.ts";
import { UNKNOWN_COVERAGE } from "../src/http/coverage.ts";
import type { SearchHit } from "../src/mcp/render.ts";

const NOW = new Date("2026-08-10T10:00:00.000Z");
/** 153 days before NOW — months territory. */
const SOLVED_ISO = "2026-03-10T08:00:00.000Z";

const rootCauseClaim = (
  overrides: Partial<DiagnosisClaim> = {},
): DiagnosisClaim => ({
  id: "clm_rc",
  workContextId: "wc_1",
  authorSessionId: "cc_nick",
  authorDeveloperName: "Nick",
  kind: "root_cause",
  body: "The ingestion mapping drops the key id on rotation",
  status: "likely_root_cause",
  confidence: 0.9,
  captureMode: "agent",
  provenance: "declared",
  dedupCount: 1,
  evidenceRefs: ["clm_ev"],
  createdAt: SOLVED_ISO,
  ...overrides,
});

const supersedesEdge = (): DiagnosisEdge => ({
  id: "edge_1",
  fromClaimId: "clm_rc2",
  toClaimId: "clm_rc",
  kind: "supersedes",
  authorSessionId: "cc_nick",
  note: null,
  createdAt: SOLVED_ISO,
});

/** A second evidence-backed root cause, another author's standing answer. */
const rivalRootCauseClaim = (
  overrides: Partial<DiagnosisClaim> = {},
): DiagnosisClaim =>
  rootCauseClaim({
    id: "clm_rc2",
    authorSessionId: "cc_maya",
    authorDeveloperName: "Maya",
    body: "The session cache, not the mapping, serves the stale key",
    evidenceRefs: ["clm_ev2"],
    ...overrides,
  });

const contradictsEdge = (): DiagnosisEdge => ({
  id: "edge_dl",
  fromClaimId: "clm_rc2",
  toClaimId: "clm_rc",
  kind: "contradicts",
  authorSessionId: "cc_maya",
  note: null,
  createdAt: SOLVED_ISO,
});

/** The observations the two root causes cite: evidence that resolves inside the tree (hold-out review, H5 + M2). */
const EVIDENCE_IN_TREE: readonly DiagnosisClaim[] = [
  rootCauseClaim({ id: "clm_ev", kind: "observation", status: "proposed", evidenceRefs: [], body: "The importer retries with the old key id after every rotation" }),
  rootCauseClaim({ id: "clm_ev2", kind: "observation", status: "proposed", evidenceRefs: [], body: "The session cache answers before the mapping is ever read" }),
];

const diagnosis = (
  claims: readonly DiagnosisClaim[],
  edges: readonly DiagnosisEdge[] = [],
  landedAt: string | null = null,
  evidence: readonly DiagnosisClaim[] = EVIDENCE_IN_TREE,
): Diagnosis => ({
  workContext: {
    id: "wc_1",
    sessionId: "cc_nick",
    title: "Refresh 500s after key rotation",
    description: null,
    status: "done",
    baseCommit: "a1b2c3d4",
    landedAt,
    createdAt: SOLVED_ISO,
    updatedAt: null,
  },
  claims: [...claims, ...evidence],
  edges,
  externalClaims: [],
  targets: [{ kind: "file", value: "src/auth/refresh.ts" }],
  targetsReported: true,
  intentChain: [],
  chainReported: true,
  droppedTargets: 0,
  truncated: false,
  droppedRows: 0,
  coverage: UNKNOWN_COVERAGE,
});

describe("solvedAtFromTree", () => {
  test("an evidenced, non-superseded likely_root_cause marks the tree solved", () => {
    // Act
    const solvedAtMs = solvedAtFromTree(diagnosis([rootCauseClaim()]));

    // Assert
    expect(solvedAtMs).toBe(Date.parse(SOLVED_ISO));
  });

  test.each([
    ["itself", [rootCauseClaim({ evidenceRefs: ["clm_rc"] })], []],
    ["a claim outside this tree — not resolvable here, so not solved here", [rootCauseClaim({ evidenceRefs: ["clm_elsewhere"] })], []],
    [
      "a refuted observation",
      [rootCauseClaim({ evidenceRefs: ["clm_no"] }), rootCauseClaim({ id: "clm_no", kind: "observation", status: "rejected", evidenceRefs: [], body: "The cache entry survives the rotation, refuted" })],
      [],
    ],
    [
      "a decision that cites it back",
      [rootCauseClaim({ evidenceRefs: ["clm_dec"] }), rootCauseClaim({ id: "clm_dec", kind: "decision", status: "proposed", evidenceRefs: ["clm_rc"], body: "Invalidate the kid cache on every rotation" })],
      [],
    ],
    ["an observation of one letter", [rootCauseClaim({ evidenceRefs: ["clm_x"] }), rootCauseClaim({ id: "clm_x", kind: "observation", status: "proposed", evidenceRefs: [], body: "x" })], []],
  ])("a root cause citing %s does not mark the tree solved (hold-out review, H5 + M2)", (_, claims, edges) => {
    // Act
    const solvedAtMs = solvedAtFromTree(diagnosis(claims, edges, null, []));

    // Assert
    expect(solvedAtMs).toBeNull();
  });

  test("a cited observation that was revised resolves to its standing revision", () => {
    // Arrange — clm_ev was revised into clm_ev_v2, which stands
    const revised = [
      rootCauseClaim({ id: "clm_ev", kind: "observation", status: "proposed", evidenceRefs: [], body: "Old note." }),
      rootCauseClaim({ id: "clm_ev_v2", kind: "observation", status: "proposed", evidenceRefs: [], body: "The importer retries with the old key id after every rotation" }),
    ];
    const revision: DiagnosisEdge = { ...supersedesEdge(), id: "edge_rev", fromClaimId: "clm_ev_v2", toClaimId: "clm_ev" };

    // Act
    const solvedAtMs = solvedAtFromTree(diagnosis([rootCauseClaim()], [revision], null, revised));

    // Assert
    expect(solvedAtMs).toBe(Date.parse(SOLVED_ISO));
  });

  test("a cited observation revised AFTER the root cause backs it no longer (round 3, M2)", () => {
    // Arrange — the revision says something, but it was written after the cause
    const revised = [
      rootCauseClaim({ id: "clm_ev", kind: "observation", status: "proposed", evidenceRefs: [], body: "The importer retries with the old key id after every rotation" }),
      rootCauseClaim({
        id: "clm_ev_v2",
        kind: "observation",
        status: "proposed",
        evidenceRefs: [],
        body: "Retracted: the importer reads the new key id, the stale reads come from the CDN",
        createdAt: "2026-03-11T08:00:00.000Z",
      }),
    ];
    const revision: DiagnosisEdge = { ...supersedesEdge(), id: "edge_rev", fromClaimId: "clm_ev_v2", toClaimId: "clm_ev" };

    // Act + Assert
    expect(solvedAtFromTree(diagnosis([rootCauseClaim()], [revision], null, revised))).toBeNull();
  });

  test("a cited observation a teammate contradicts backs it no longer (round 3, M2)", () => {
    // Arrange
    const refutation = rootCauseClaim({ id: "clm_refute", kind: "observation", status: "proposed", evidenceRefs: [], body: "The importer reads the new key id within a second" });
    const contradiction: DiagnosisEdge = { ...contradictsEdge(), id: "edge_refute", fromClaimId: "clm_refute", toClaimId: "clm_ev" };

    // Act + Assert
    expect(solvedAtFromTree(diagnosis([rootCauseClaim(), refutation], [contradiction]))).toBeNull();
  });

  test("a diamond ladder of revisions, cited by a thousand causes, resolves inside a named bound (round 3, M4)", () => {
    // Arrange — 3 revisions per level, each superseding all 3 below, 16 levels;
    // a thousand root causes all cite the bottom of it. Resolved once per
    // ref the tree takes ~4 ms; rebuilding the maps per claim took ~94 ms.
    const WIDTH = 3;
    const DEPTH = 16;
    const CAUSES = 1000;
    const MIRROR_BUDGET_MS = 30;
    const node = (index: number, level: number) =>
      rootCauseClaim({ id: `n${String(index)}_${String(level)}`, kind: "observation", status: "proposed", evidenceRefs: [], body: "The importer retries with the old key id after every rotation" });
    const ladder = [node(0, 0), ...Array.from({ length: DEPTH }, (_, level) => Array.from({ length: WIDTH }, (_, index) => node(index, level + 1))).flat()];
    const edges = Array.from({ length: DEPTH }, (_, level) =>
      Array.from({ length: WIDTH }, (_, index) =>
        Array.from({ length: level === 0 ? 1 : WIDTH }, (_, below): DiagnosisEdge => ({
          ...supersedesEdge(),
          id: `e_${String(index)}_${String(level + 1)}_${String(below)}`,
          fromClaimId: `n${String(index)}_${String(level + 1)}`,
          toClaimId: `n${String(below)}_${String(level)}`,
        })),
      ).flat(),
    ).flat();
    const causes = Array.from({ length: CAUSES }, (_, index) => rootCauseClaim({ id: `clm_rc_${String(index)}`, evidenceRefs: ["n0_0"] }));

    // Act
    const started = performance.now();
    const solvedAtMs = solvedAtFromTree(diagnosis(causes, edges, null, ladder));
    const elapsed = performance.now() - started;

    // Assert
    expect(solvedAtMs).toBe(Date.parse(SOLVED_ISO));
    expect(elapsed).toBeLessThan(MIRROR_BUDGET_MS);
  });

  test("a superseded root cause does not", () => {
    // Act
    const solvedAtMs = solvedAtFromTree(
      diagnosis([rootCauseClaim()], [supersedesEdge()]),
    );

    // Assert
    expect(solvedAtMs).toBeNull();
  });

  test("an evidence-free root cause does not", () => {
    // Act
    const solvedAtMs = solvedAtFromTree(
      diagnosis([rootCauseClaim({ evidenceRefs: [] })]),
    );

    // Assert
    expect(solvedAtMs).toBeNull();
  });

  test("a derived root cause never marks the tree solved", () => {
    // The provenance gate every sibling trust surface already has
    // (similarity-gate, contradictions, hint selection): a machine-derived
    // likely_root_cause — even evidence-carrying, even at the confidence cap
    // — is nobody's vouched answer, and SOLVED is a trust label.
    const solvedAtMs = solvedAtFromTree(
      diagnosis([rootCauseClaim({ provenance: "derived", confidence: 0.5 })]),
    );

    // Assert
    expect(solvedAtMs).toBeNull();
  });

  test("a derived rival cannot deadlock a declared solved tree", () => {
    // The same gate on the PEER side: a forged or future-writer derived
    // rival is not a standing answer, so its contradicts edge must not
    // censor the solved label off a genuinely vouched diagnosis.
    const solvedAtMs = solvedAtFromTree(
      diagnosis(
        [
          rootCauseClaim(),
          rivalRootCauseClaim({ provenance: "derived", confidence: 0.5 }),
        ],
        [contradictsEdge()],
      ),
    );

    // Assert
    expect(solvedAtMs).toBe(Date.parse(SOLVED_ISO));
  });

  test("two evidenced root causes in open contradiction do not read solved", () => {
    // The referee-mode deadlock (DESIGN.md §4): two standing evidence-backed
    // answers joined by a contradicts edge are a live dispute, not a settled
    // tree — mirror of the hub rule in services/solved.ts.
    const solvedAtMs = solvedAtFromTree(
      diagnosis(
        [rootCauseClaim(), rivalRootCauseClaim()],
        [contradictsEdge()],
      ),
    );

    // Assert
    expect(solvedAtMs).toBeNull();
  });

  test("a contradiction from a non-qualifying peer does not unsolve the tree", () => {
    // An evidence-free rival is a theory, not a standing answer — one
    // drive-by contradicts edge from it must not strip the solved label.
    const solvedAtMs = solvedAtFromTree(
      diagnosis(
        [rootCauseClaim(), rivalRootCauseClaim({ evidenceRefs: [] })],
        [contradictsEdge()],
      ),
    );

    // Assert
    expect(solvedAtMs).toBe(Date.parse(SOLVED_ISO));
  });

  test("a deadlock resolved by superseding one side reads solved again", () => {
    // Pin for the rule's escape hatch: a superseded rival stops qualifying,
    // so the surviving root cause settles the tree once more.
    const rivalRetracted: DiagnosisEdge = {
      id: "edge_2",
      fromClaimId: "clm_rc3",
      toClaimId: "clm_rc2",
      kind: "supersedes",
      authorSessionId: "cc_maya",
      note: null,
      createdAt: SOLVED_ISO,
    };
    const solvedAtMs = solvedAtFromTree(
      diagnosis(
        [rootCauseClaim(), rivalRootCauseClaim()],
        [contradictsEdge(), rivalRetracted],
      ),
    );

    // Assert
    expect(solvedAtMs).toBe(Date.parse(SOLVED_ISO));
  });

  test("a truncated tree never reads solved", () => {
    // The hub's edge cap keeps the OLDEST edges: a late supersedes or
    // contradicts edge that would disqualify the solving claim can be the
    // one that fell off, and a label computed over partial edges would vouch
    // too much. Truncation therefore fails toward not-solved on BOTH caps.
    const solvedAtMs = solvedAtFromTree({
      ...diagnosis([rootCauseClaim()]),
      truncated: true,
    });

    // Assert
    expect(solvedAtMs).toBeNull();
  });
});

describe("renderDiagnosis solved presentation", () => {
  test("states the solved fact, plain age, drift, landed and staleness", () => {
    // Act
    const text = renderDiagnosis(
      diagnosis([rootCauseClaim()], [], "2026-04-01T00:00:00.000Z"),
      NOW,
      { drift: { ahead: 0, behind: 14 }, fileDrift: "changed" },
    );

    // Assert — every sentence factual, none imperative.
    expect(text).toContain("Solved: a root cause claim with recorded evidence");
    expect(text).toContain("5mo ago");
    expect(text).toContain("a recorded lead, not a statement about the current code");
    expect(text).toContain("based on a commit 14 behind your HEAD");
    expect(text).toContain("base commit is on the repo's default branch");
    expect(text).toContain(
      "Files this diagnosis referenced have changed on the default branch",
    );
  });

  test("an unknown staleness says unknown rather than guessing", () => {
    // Act
    const text = renderDiagnosis(diagnosis([rootCauseClaim()]), NOW, {
      drift: null,
      fileDrift: "unknown",
    });

    // Assert
    expect(text).toContain(
      "Whether the files this diagnosis referenced have since changed is unknown",
    );
    // No landed line — landedAt is null — and no drift line.
    expect(text).not.toContain("default branch.");
    expect(text).not.toContain("behind your HEAD");
  });

  test("an unsolved tree renders no solved block at all", () => {
    // Act: a proposed hypothesis only.
    const text = renderDiagnosis(
      diagnosis([
        rootCauseClaim({
          id: "clm_hypo",
          kind: "hypothesis",
          status: "proposed",
          evidenceRefs: [],
        }),
      ]),
      NOW,
      { drift: { ahead: 0, behind: 14 }, fileDrift: "changed" },
    );

    // Assert
    expect(text).not.toContain("Solved:");
    expect(text).not.toContain("Files this diagnosis referenced");
  });

  test("a superseded root cause renders no solved block", () => {
    // Act
    const text = renderDiagnosis(
      diagnosis([rootCauseClaim()], [supersedesEdge()]),
      NOW,
      { drift: null, fileDrift: "changed" },
    );

    // Assert
    expect(text).not.toContain("Solved:");
  });
});

describe("search results mark solved trees", () => {
  const hit = (overrides: Record<string, unknown>): SearchHit => ({
    entry: {
      id: "wc_1",
      developerId: "dev_nick",
      developerName: "Nick",
      title: "Refresh 500s after key rotation",
      status: "done",
      createdAt: SOLVED_ISO,
      updatedAt: null,
      ...overrides,
    },
    ageMs: NOW.getTime() - Date.parse(SOLVED_ISO),
    solvedAgeMs:
      (overrides["resultKind"] as string) === "solved"
        ? NOW.getTime() - Date.parse(SOLVED_ISO)
        : undefined,
  });

  test("a solved result carries the solved marker with its age", () => {
    // Act
    const text = renderSearchResults(
      [hit({ resultKind: "solved", solvedAt: SOLVED_ISO })],
      "refresh",
    );

    // Assert
    expect(text).toContain("solved (diagnosed 5mo ago)");
  });

  test("an open result carries no solved marker", () => {
    // Act
    const text = renderSearchResults([hit({ resultKind: "open" })], "refresh");

    // Assert
    expect(text).not.toContain("solved (");
  });
});
