/**
 * §5.1's HARD rule — AT-1. No surface may emit an empty-result phrasing while
 * `agent_event` or `git` is anything but `complete`, `unknown` included.
 *
 * The defect is one line: `mcp/render.ts` already knows that "nothing
 * matched" is the expensive direction to be wrong in — `renderUnusableQuery`'s
 * header says so, and it draws the distinction for a query it could not
 * tokenise and for a filter it could not resolve. It did not draw it for an
 * ARCHIVE IT COULD NOT SEE. A model told "no work context matched" concludes
 * its question was ASKED, so nobody has worked on the problem, and goes off to
 * redo the work.
 *
 * Nick's decision 5: the rule fires against an old hub reporting no coverage
 * at all. Every empty search on an un-upgraded hub carries the sentence until
 * it is upgraded, and accepting that noise is the point.
 */
import { describe, expect, test } from "bun:test";

import { renderDiagnosis, renderSearchResults } from "../src/mcp/render.ts";
import { UNKNOWN_COVERAGE } from "../src/http/coverage.ts";
import type { CoverageRecord } from "../src/http/coverage.ts";
import type { Diagnosis } from "../src/http/hub.ts";

const NOW = new Date("2026-09-15T10:00:00.000Z");
const GAP_ISO = "2026-09-05T08:13:00.000Z";
const GAP_SHOWN = "2026-09-05T08:13Z";
const BARE_NO_MATCH = "No work context on this repo matched that query.";

const reaped = (): CoverageRecord => ({
  repo: "github.com/acme/api",
  computedAt: NOW.toISOString(),
  scope: { sinceIso: "2026-09-01T10:00:00.000Z" },
  sources: [
    {
      source: "agent_event",
      state: "incomplete",
      reason: "session_reaped",
      gapSince: GAP_ISO,
      observedAt: GAP_ISO,
    },
    { source: "git", state: "complete", reason: "commits_reported", gapSince: null, observedAt: GAP_ISO },
    { source: "ci", state: "unavailable", reason: "no_emitter", gapSince: null, observedAt: null },
    { source: "runtime", state: "unavailable", reason: "out_of_scope_1_0", gapSince: null, observedAt: null },
    { source: "human_edit", state: "unavailable", reason: "no_platform_rung", gapSince: null, observedAt: null },
  ],
});

const watched = (): CoverageRecord => ({
  ...reaped(),
  sources: reaped().sources.map((row) =>
    row.source === "agent_event"
      ? { ...row, state: "complete" as const, reason: "sessions_reported" as const, gapSince: null }
      : row,
  ),
});

describe("COV-1: an empty search may not stand alone over a gap", () => {
  test("one reaped session and a query matching nothing names the instant", () => {
    // Arrange: AT-1's own scenario, at AT-1's own timestamp
    // Act
    const output = renderSearchResults([], "token refresh", {
      coverage: { record: reaped(), now: NOW },
    });

    // Assert
    expect(output).not.toContain(BARE_NO_MATCH);
    expect(output).toContain(GAP_SHOWN);
  });

  test("an un-upgraded hub still qualifies the empty answer — decision 5", () => {
    // Act
    const output = renderSearchResults([], "token refresh", {
      coverage: { record: UNKNOWN_COVERAGE, now: NOW },
    });

    // Assert
    expect(output).not.toContain(BARE_NO_MATCH);
    expect(output).toContain("Coverage unknown");
  });

  test("a watched repo gets the bare sentence and NO caveat", () => {
    // Act
    const output = renderSearchResults([], "token refresh", {
      coverage: { record: watched(), now: NOW },
    });

    // Assert: §5.1's hard rule binds "while `agent_event` or `git` is
    // anything but `complete`". It does not ask for a sentence here, and the
    // sentence it does not ask for is the expensive one: zero-hit searches
    // are the ordinary case on any repo whose archive has not covered the
    // topic yet, so on a healthy install EVERY coverage line a person ever
    // read said `complete` — which is how the one that says `incomplete`
    // gets skipped with the rest. The unqualified sentence IS the strong
    // answer here: "no work context matched" is a claim about the
    // repository, and this is the state in which the repository and the
    // archive are the same thing.
    expect(output).toContain(BARE_NO_MATCH);
    expect(output).not.toContain("Coverage");
  });

  test("an options object with NO coverage still qualifies the empty answer", () => {
    // Arrange: a caller that forgot the field, which is the one way this rule
    // could be skipped by accident. There is no silent path: absent reads as
    // "this client holds no record", which is the hub-silent sentence.
    // Act
    const output = renderSearchResults([], "token refresh", {});

    // Assert
    expect(output).not.toContain(BARE_NO_MATCH);
    expect(output).toContain("Coverage unknown");
  });

  test("a NON-empty search is not qualified by the hard rule", () => {
    // Arrange: the soft rule governs non-empty answers, and it does not fire
    // on this surface — §5.1 binds the empty branch only.
    const output = renderSearchResults(
      [
        {
          entry: {
            id: "wc_cc_11111111-2222-4333-8444-555555555555",
            developerId: "dev_other",
            developerName: "Robin",
            title: "Token refresh 500s",
            status: "implementing",
            createdAt: "2026-09-14T10:00:00.000Z",
          },
          ageMs: 60_000,
        },
      ],
      "token refresh",
      { coverage: { record: reaped(), now: NOW } },
    );

    // Assert
    expect(output).toContain("Token refresh 500s");
  });
});

const CLAIMS_EMPTY = "Claims: no claims recorded yet.";
const TARGETS_EMPTY = "No targets were captured for this work context.";

const tree = (
  coverage: CoverageRecord,
  overrides: Partial<Diagnosis> = {},
): Diagnosis => ({
  // 06 makes the intent chain required on a Diagnosis. This fixture measured
  // none, and `chainReported: false` is the honest value — "this hub does not
  // report it", never the exonerating "nobody amended it".
  intentChain: [],
  chainReported: false,
  workContext: {
    id: "wc_01",
    sessionId: "cc_a-uuid",
    title: "Login 500s on staging",
    description: null,
    status: "analyzing",
    createdAt: "2026-09-14T10:00:00.000Z",
    updatedAt: null,
  },
  claims: [],
  edges: [],
  externalClaims: [],
  targets: [],
  targetsReported: true,
  droppedTargets: 0,
  truncated: false,
  droppedRows: 0,
  coverage,
  ...overrides,
});

/**
 * The diagnosis carries TWO empty-result phrasings §5.1 names — the claims
 * branch and NO_TARGETS — and both are claims a reader acts on. "No targets
 * were captured" sends somebody away believing there is no overlap with the
 * file they are about to edit.
 */
describe("the diagnosis empty branches may not stand alone over a gap", () => {
  test("no claims over a gap names the gap and drops the bare sentence", () => {
    // Act
    const output = renderDiagnosis(tree(reaped()), NOW);

    // Assert
    expect(output).not.toContain(CLAIMS_EMPTY);
    expect(output).toContain(GAP_SHOWN);
  });

  test("no targets over a gap names the gap and drops the bare sentence", () => {
    // Act
    const output = renderDiagnosis(
      tree(reaped(), { claims: [], targets: [], targetsReported: true }),
      NOW,
    );

    // Assert
    expect(output).not.toContain(TARGETS_EMPTY);
    expect(output).toContain("Coverage incomplete");
  });

  test("a watched tree keeps both sentences and adds no caveat", () => {
    // Act
    const output = renderDiagnosis(tree(watched()), NOW);

    // Assert: same rule as the search branch above. A claim-less tree is the
    // ordinary state of a work context nobody has published to yet, so a
    // clause here would print on a healthy repo more often than anywhere
    // else in the product.
    expect(output).toContain(CLAIMS_EMPTY);
    expect(output).toContain(TARGETS_EMPTY);
    expect(output).not.toContain("Coverage");
  });

  test("a tree WITH claims and targets carries no clause — the hard rule is about empties", () => {
    // Act
    const output = renderDiagnosis(
      tree(reaped(), {
        claims: [
          {
            id: "cl_01",
            workContextId: "wc_01",
            authorSessionId: "cc_a-uuid",
            authorDeveloperId: "dev_other",
            authorDeveloperName: "Robin",
            kind: "finding",
            body: "JWT validation fails after refresh",
            status: "open",
            confidence: 0.8,
            provenance: "declared",
            captureMode: "agent",
            evidenceRefs: [],
            dedupCount: 1,
            createdAt: "2026-09-14T10:00:00.000Z",
          },
        ],
        targets: [{ kind: "file", value: "src/auth.ts" }],
      }),
      NOW,
    );

    // Assert
    expect(output).not.toContain("Coverage incomplete");
  });
});
