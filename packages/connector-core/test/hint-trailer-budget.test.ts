/**
 * The lines a flow appends AFTER a teammate hint — the coverage note and one
 * closing line — are budgeted for, never squeezed out by long labels (review
 * 1006b, LOW-b). A long author, a capped title, a solved label, a drift label
 * and a derived intent used to fill a substance hint to ~1095 characters, and
 * `withCoverageNote` then dropped the note without a word.
 *
 * What gives way, in order: the teammate's intent line, then the title on the
 * pointer line (the id and get_diagnosis stay). The finding itself is never
 * cut below the sentence the hub scored — when even that cannot fit beside the
 * trailers, the claim form yields to the pointer (flows/hint.ts).
 */
import { describe, expect, test } from "bun:test";

import { MAX_HINT_TEXT_LENGTH } from "@crosscheck/schema";
import { HINT_CLOSING_LINE_RESERVE_CHARS, MAX_ID_CHARS } from "../src/constants.ts";
import { coverageNote } from "../src/coverage/render.ts";
import {
  hintTrailerReserve,
  renderClaimHint,
  renderPointerHint,
  withCoverageNote,
} from "../src/hints/render.ts";
import { UNKNOWN_COVERAGE } from "../src/http/coverage.ts";
import type { CoverageRecord } from "../src/http/coverage.ts";
import type { HintClaimCandidate, HintContextCandidate } from "../src/http/hub.ts";

const NOW = new Date("2026-09-15T10:00:00.000Z");
const GAP_ISO = "2026-09-05T08:13:00.000Z";
const UUID = "11111111-2222-4333-8444-555555555555";
const CONTEXT_ID = `wc_cc_${UUID}`;
const SENTENCE =
  "Die Ursache liegt im Token-Refresh der Session, weil der Schlüssel nach der Rotation " +
  "nicht neu geladen wird und der Cache die alte kid bis zum Neustart des Gateways festhält.";

/** Both rungs reaped — the coverage note at its two-line length. */
const reaped: CoverageRecord = {
  repo: "github.com/acme/api",
  computedAt: NOW.toISOString(),
  scope: { sinceIso: GAP_ISO },
  order: { state: "undeclared", reason: "hub_did_not_report" },
  sources: [
    { source: "agent_event", state: "incomplete", reason: "session_reaped", gapSince: GAP_ISO, observedAt: GAP_ISO },
    { source: "git", state: "incomplete", reason: "commits_reported", gapSince: GAP_ISO, observedAt: GAP_ISO },
    { source: "ci", state: "unavailable", reason: "no_emitter", gapSince: null, observedAt: null },
    { source: "runtime", state: "unavailable", reason: "out_of_scope_1_0", gapSince: null, observedAt: null },
    { source: "human_edit", state: "unavailable", reason: "no_platform_rung", gapSince: null, observedAt: null },
  ],
};

/** The longest closing line the pilot's outcome recording appends: its sentence at the longest id. */
const CLOSING_LINE =
  `mark_hint_outcome ${"c".repeat(MAX_ID_CHARS)} records whether you followed it or deliberately went another way.`;

const claim: HintClaimCandidate = {
  id: `clm_${UUID}`,
  workContextId: CONTEXT_ID,
  kind: "decision",
  status: "proposed",
  confidence: 0.7,
  provenance: "declared",
  captureMode: "agent",
  evidenceRefCount: 3,
  authorDeveloperId: "dev_ken",
  authorDeveloperName: "Konstantin Alexander Weißenberger-Lindqvist",
  body: `${SENTENCE} Zweiter Satz mit mehr Inhalt.`,
  matchedTerms: 3,
  createdAt: "2026-09-10T08:00:00.000Z",
};

const context: HintContextCandidate["workContext"] = {
  id: CONTEXT_ID,
  title: "x".repeat(200),
  status: "implementing",
  tier: "fts",
  developerId: "dev_ken",
  developerName: "Konstantin Alexander Weißenberger-Lindqvist",
  baseCommit: "a1b2c3d4",
  resultKind: "solved",
  solvedAt: "2026-09-12T08:00:00.000Z",
  createdAt: "2026-09-10T08:00:00.000Z",
  updatedAt: null,
  intent: { summary: "y".repeat(300), provenance: "derived", confidence: 0.5 },
};

const DRIFT = { behind: 140, ahead: 3, state: "behind" } as const;

/** What the flow emits after the hint: the note, then the closing line. */
const withTrailers = (hint: string): string => `${withCoverageNote(hint, reaped, NOW)}\n${CLOSING_LINE}`;

describe("the reserve is what the trailers need", () => {
  test("no gap reserves the closing line alone", () => {
    expect(hintTrailerReserve(UNKNOWN_COVERAGE, NOW)).toBe(HINT_CLOSING_LINE_RESERVE_CHARS);
  });

  test("a gap reserves the note on its own line besides", () => {
    const note = coverageNote(reaped, NOW) ?? "";
    expect(note.length).toBeGreaterThan(0);
    expect(hintTrailerReserve(reaped, NOW)).toBe(note.length + 1 + HINT_CLOSING_LINE_RESERVE_CHARS);
  });

  test("the closing line's room holds the longest outcome clause", () => {
    expect(CLOSING_LINE.length + 1).toBeLessThanOrEqual(HINT_CLOSING_LINE_RESERVE_CHARS);
  });
});

describe("a long-labelled substance hint keeps room for what follows it", () => {
  const reserveChars = hintTrailerReserve(reaped, NOW);
  const render = (overrides: Partial<HintContextCandidate["workContext"]> = {}): string =>
    renderClaimHint({
      claim,
      context: { ...context, ...overrides },
      drift: DRIFT,
      now: NOW,
      matchedOn: "intent",
      intentProvenance: "derived",
      restCount: 12,
      reserveChars,
    });

  test("the coverage note and the closing line both fit after it", () => {
    const hint = render();
    expect(hint.length).toBeGreaterThan(0);
    expect(withCoverageNote(hint, reaped, NOW)).not.toBe(hint);
    expect(withTrailers(hint).length).toBeLessThanOrEqual(MAX_HINT_TEXT_LENGTH);
  });

  test("the finding is shown whole — the labels give way, not the sentence the hub scored", () => {
    expect(render()).toContain(`«${SENTENCE}»`);
  });

  test("the intent line goes first, and the pointer line keeps its id without the title", () => {
    const hint = render();
    expect(hint).not.toContain("Their intent");
    expect(hint).toContain(`Recorded on work context ${CONTEXT_ID} beside 12 more claims`);
    expect(hint).toContain(`get_diagnosis ${CONTEXT_ID}.`);
    expect(hint).not.toContain("xxxx");
  });

  test("a title that fits keeps its place on the pointer line", () => {
    // No gap: only the closing line is reserved, and the title has room
    const hint = renderClaimHint({
      claim,
      context: { ...context, title: "Token refresh after key rotation" },
      drift: DRIFT,
      now: NOW,
      restCount: 12,
      reserveChars: hintTrailerReserve(UNKNOWN_COVERAGE, NOW),
    });
    expect(hint).toContain("«Token refresh after key rotation» beside 12 more claims");
  });

  test("a finding that cannot fit beside its trailers is not cut: the claim form renders nothing", () => {
    const hint = renderClaimHint({
      claim,
      context,
      drift: DRIFT,
      now: NOW,
      restCount: 12,
      reserveChars: MAX_HINT_TEXT_LENGTH - 400,
    });
    expect(hint).toBe("");
  });
});

describe("a long-labelled pointer keeps room for what follows it", () => {
  test("the coverage note and the closing line both fit after it", () => {
    const pointer = renderPointerHint({
      context,
      claimCount: 7,
      drift: DRIFT,
      now: NOW,
      matchedOn: "intent",
      intentProvenance: "derived",
      reserveChars: hintTrailerReserve(reaped, NOW),
    });
    expect(pointer).toContain(`work context ${CONTEXT_ID}`);
    expect(withCoverageNote(pointer, reaped, NOW)).not.toBe(pointer);
    expect(withTrailers(pointer).length).toBeLessThanOrEqual(MAX_HINT_TEXT_LENGTH);
  });

  test("a pointer whose own two lines leave no room still renders — the trailers never cost the hint", () => {
    const pointer = renderPointerHint({
      context,
      claimCount: 7,
      drift: DRIFT,
      now: NOW,
      reserveChars: MAX_HINT_TEXT_LENGTH - 200,
    });
    expect(pointer).toContain(`work context ${CONTEXT_ID}`);
    expect(pointer.length).toBeLessThanOrEqual(MAX_HINT_TEXT_LENGTH);
  });
});
