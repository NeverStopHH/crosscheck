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

const diagnosis = (
  claims: readonly DiagnosisClaim[],
  edges: readonly DiagnosisEdge[] = [],
  landedAt: string | null = null,
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
  claims,
  edges,
  externalClaims: [],
  targets: [{ kind: "file", value: "src/auth/refresh.ts" }],
  truncated: false,
  droppedRows: 0,
});

describe("solvedAtFromTree", () => {
  test("an evidenced, non-superseded likely_root_cause marks the tree solved", () => {
    // Act
    const solvedAtMs = solvedAtFromTree(diagnosis([rootCauseClaim()]));

    // Assert
    expect(solvedAtMs).toBe(Date.parse(SOLVED_ISO));
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
});

describe("renderDiagnosis solved presentation", () => {
  test("states the solved fact, plain age, drift, landed and staleness", () => {
    // Act
    const text = renderDiagnosis(
      diagnosis([rootCauseClaim()], [], "2026-04-01T00:00:00.000Z"),
      { now: NOW, drift: { ahead: 0, behind: 14 }, fileDrift: "changed" },
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
    const text = renderDiagnosis(diagnosis([rootCauseClaim()]), {
      now: NOW,
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
      { now: NOW, drift: { ahead: 0, behind: 14 }, fileDrift: "changed" },
    );

    // Assert
    expect(text).not.toContain("Solved:");
    expect(text).not.toContain("Files this diagnosis referenced");
  });

  test("a superseded root cause renders no solved block", () => {
    // Act
    const text = renderDiagnosis(
      diagnosis([rootCauseClaim()], [supersedesEdge()]),
      { now: NOW, drift: null, fileDrift: "changed" },
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
