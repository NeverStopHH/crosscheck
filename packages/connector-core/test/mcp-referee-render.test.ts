/**
 * The referee-brief renderer (VISION.md §4): a case file, not a verdict.
 *
 * NEUTRALITY IS STRUCTURAL, and this file is where that stops being a claim:
 * the renderer assigns the A/B labels itself, by canonical claim order, so
 * the swap test can demand the strongest possible property — exchanging the
 * two positions in the INPUT renders the byte-identical document, fields,
 * framing and truncation included. No edit can quietly give one side a richer
 * rendering than the other without going red here. The verdict-language
 * canary is the weaker, second net: it catches ranking words the structure
 * test cannot see.
 *
 * The adversarial half (injection corpus over every untrusted slot) lives in
 * test/mcp-injection.test.ts with the other two MCP surfaces.
 */
import { describe, expect, test } from "bun:test";

import { MAX_CLAIM_BODY_LENGTH } from "@crosscheck/schema";

import { QUOTED_DATA_NOTICE } from "../src/briefing/render.ts";
import { REDACTED_SPAN, REDACTED_TITLE } from "../src/briefing/sanitize.ts";
import { MAX_REFEREE_POSITION_CHARS } from "../src/constants.ts";
import {
  MAX_REFEREE_BRIEF_CHARS,
  renderRefereeBrief,
} from "../src/mcp/render-referee.ts";
import type { RefereeBrief, RefereeClaim } from "../src/http/hub.ts";
import { assertUntrustedCharacters } from "./fixtures/untrusted-invariants.ts";

const NOW = new Date("2026-08-10T12:00:00.000Z");
const CREATED_AT = "2026-08-07T12:00:00.000Z";
const LATER_AT = "2026-08-08T12:00:00.000Z";

const claim = (
  overrides: Partial<RefereeClaim> & { readonly id: string },
): RefereeClaim => ({
  workContextId: "wc_a",
  kind: "hypothesis",
  status: "proposed",
  confidence: 0.8,
  body: "The rotation job overruns its window and drops the key",
  authorDeveloperName: "Nick",
  createdAt: CREATED_AT,
  provenance: "declared",
  ...overrides,
});

const baseBrief = (): RefereeBrief => ({
  id: "cx_0123456789abcdef0123456789abcdef",
  reason: "shared_target",
  similarity: null,
  positionA: {
    claim: claim({ id: "clm_a" }),
    workContextTitle: "Login 500s on staging",
    evidence: [
      claim({
        id: "clm_ev1",
        kind: "evidence",
        body: "Rotation log shows a 41 s run against a 30 s window",
      }),
      claim({
        id: "clm_ev2",
        kind: "evidence",
        createdAt: LATER_AT,
        body: "Key absent from the store during the failure minute",
      }),
    ],
    evidenceTruncated: false,
    ruledOut: [
      claim({
        id: "clm_ra",
        kind: "rejected_approach",
        body: "Clock skew on the runner ruled out by NTP logs",
      }),
    ],
    ruledOutTruncated: false,
    supersededByClaimId: null,
    droppedRows: 0,
  },
  positionB: {
    claim: claim({
      id: "clm_b",
      workContextId: "wc_b",
      status: "rejected",
      authorDeveloperName: "Robin",
      createdAt: LATER_AT,
      body: "Rotation finished inside its window on every sampled failure",
    }),
    workContextTitle: "Key rotation timing audit",
    evidence: [],
    evidenceTruncated: false,
    ruledOut: [],
    ruledOutTruncated: false,
    supersededByClaimId: null,
    droppedRows: 0,
  },
  sharedTargets: [
    { kind: "error_fingerprint", value: "a1b2c3d4e5f60718293a4b5c6d7e8f90" },
  ],
  sharedTargetsTruncated: false,
  droppedRows: 0,
});

const swapPositions = (brief: RefereeBrief): RefereeBrief => ({
  ...brief,
  positionA: brief.positionB,
  positionB: brief.positionA,
});

describe("renderRefereeBrief", () => {
  test("opens with the quoted-data notice and the no-verdict sentence", () => {
    // Act
    const output = renderRefereeBrief(baseBrief(), NOW);
    const lines = output.split("\n");

    // Assert
    expect(lines[0]).toContain("cx_0123456789abcdef0123456789abcdef");
    expect(lines[0]?.endsWith(QUOTED_DATA_NOTICE)).toBe(true);
    expect(output).toContain("does not rank them");
  });

  test("states both positions' evidence counts as facts, including zero", () => {
    // Act
    const output = renderRefereeBrief(baseBrief(), NOW);

    // Assert: "A cites 2 evidence claims, B cites 0" — stated, never judged
    expect(output).toContain("Position A cites 2 evidence claims");
    expect(output).toContain("Position B cites no evidence claims.");
    expect(output).toContain("Position A ruled out 1 approach");
    expect(output).toContain("Position B has no ruled-out approaches recorded.");
  });

  test("renders claim bodies framed, authors bare, ids id-class — one frame per line", () => {
    // Act
    const output = renderRefereeBrief(baseBrief(), NOW);

    // Assert
    for (const [index, line] of output.split("\n").entries()) {
      assertUntrustedCharacters(line, `line ${String(index)}: ${line}`);
    }
    expect(output).toContain(
      "«The rotation job overruns its window and drops the key»",
    );
    expect(output).toContain("«Login 500s on staging»");
  });

  test("redacts the span, never the whole position, on everyday English", () => {
    // Arrange: this surface is PULLED and its budget was widened so one
    // maximum-length body still fits — and it then destroyed the body it made
    // room for. It used the LABEL class, which blanks the WHOLE value when the
    // phrase filter matches, where get_diagnosis uses the BODY class. Four of
    // the nine branches are ordinary English inside a real finding, so a
    // careful root cause came back as a bare redaction marker.
    //
    // The failure is worse here than anywhere else: a referee brief exists to
    // put two arguments side by side, so blanking one of them makes the page
    // asymmetric in content while still looking even-handed. The A/B swap
    // test cannot see it — both sides get the same mechanism.
    const reasoned =
      "The rotation job overruns its window. To reproduce it you must run " +
      "the worker with the rotation job disabled, then watch the store.";
    const brief = baseBrief();
    const withProse: RefereeBrief = {
      ...brief,
      positionA: {
        ...brief.positionA,
        claim: claim({ id: "clm_a", body: reasoned }),
      },
    };

    // Act
    const rendered = renderRefereeBrief(withProse, NOW);
    const line =
      rendered.split("\n").find((entry) => entry.startsWith("- clm_a ")) ?? "";

    // Assert: the sentences around the branch survive, the branch itself does
    // not, and no whole-value marker appears anywhere on the page.
    expect(line).toContain("The rotation job overruns its window");
    expect(line).toContain("then watch the store");
    expect(line).toContain(REDACTED_SPAN);
    expect(rendered).not.toContain(REDACTED_TITLE);
  });

  test("claim lines carry the provenance trust label, declared and derived alike", () => {
    // Arrange: a case file whose position B claim is a machine draft — the
    // reader must see that nobody vouched for it (DESIGN.md §4 trust labels)
    const brief = baseBrief();
    const withDerived: RefereeBrief = {
      ...brief,
      positionB: {
        ...brief.positionB,
        claim: claim({
          id: "clm_b",
          workContextId: "wc_b",
          status: "rejected",
          authorDeveloperName: "Robin",
          createdAt: LATER_AT,
          provenance: "derived",
          confidence: 0.4,
          body: "Rotation finished inside its window on every sampled failure",
        }),
      },
    };

    // Act
    const output = renderRefereeBrief(withDerived, NOW);

    // Assert: both labels, bare like kind and status
    expect(output).toContain("provenance declared");
    expect(output).toContain("provenance derived");
  });

  test("is A/B swap invariant: exchanged positions render the byte-identical document", () => {
    // Arrange: the renderer assigns the labels canonically, so the hub's
    // pair order cannot influence a single byte of the output
    const brief = baseBrief();

    // Act
    const original = renderRefereeBrief(brief, NOW);
    const swapped = renderRefereeBrief(swapPositions(brief), NOW);

    // Assert
    expect(swapped).toBe(original);
  });

  test("stays swap invariant even when both positions overflow their budgets", () => {
    // Arrange: enough evidence at the WIRE cap to overflow a position budget.
    //
    // BOTH NUMBERS ARE DERIVED, and they were not: this fixture used ten
    // bodies of a literal 380 characters, which overflowed a 4,000-char
    // position and stopped overflowing the moment that budget moved — the
    // truncation assertion below then passed on a document that never
    // truncated, which is the quietest way for a test to stop testing.
    // Rebuilt from the constants, it overflows at any pair of values.
    const longBody = "x".repeat(MAX_CLAIM_BODY_LENGTH);
    const overflowingCount =
      Math.ceil(MAX_REFEREE_POSITION_CHARS / MAX_CLAIM_BODY_LENGTH) + 2;
    const heavyEvidence = Array.from({ length: overflowingCount }, (_, index) =>
      claim({
        id: `clm_heavy_${String(index)}`,
        kind: "evidence",
        body: `${longBody} ${String(index)}`,
      }),
    );
    const brief = baseBrief();
    const heavy: RefereeBrief = {
      ...brief,
      positionA: { ...brief.positionA, evidence: heavyEvidence },
      positionB: { ...brief.positionB, evidence: heavyEvidence },
    };

    // Act
    const original = renderRefereeBrief(heavy, NOW);
    const swapped = renderRefereeBrief(swapPositions(heavy), NOW);

    // Assert: truncation happened, said so, and stayed symmetric
    expect(original).toMatch(/\(\+\d+ lines? not shown\)/);
    expect(swapped).toBe(original);
    expect(original.length).toBeLessThanOrEqual(MAX_REFEREE_BRIEF_CHARS);
  });

  test("never claims two developers hold the pair — the gate flags self-conflicts too", () => {
    // Arrange: a similarity-detected pair can carry ONE developer's own
    // opposite-status claims (the hub's gate deliberately flags a developer
    // against their own history), so an opening that asserts "two
    // developers" would state a fact the wire never carried
    const brief = baseBrief();
    const selfConflict: RefereeBrief = {
      ...brief,
      positionB: {
        ...brief.positionB,
        claim: { ...brief.positionB.claim, authorDeveloperName: "Nick" },
      },
    };

    // Act
    const output = renderRefereeBrief(selfConflict, NOW);

    // Assert
    expect(output).not.toContain("Two developers");
    expect(output).toContain("does not rank them");
  });

  test("funds both positions equally: identical content renders identical blocks", () => {
    // Arrange: both sides carry same-length claims and the SAME heavy
    // evidence, far past the per-position budget — any asymmetry in budget
    // or formatting between the A and B renderings becomes a byte diff once
    // the labels and ids are normalized. The swap test cannot see this:
    // labels are canonical, so a poorer "B" budget hits the same position
    // on both renders and the swap stays byte-exact.
    const longBody = "y".repeat(380);
    const sharedEvidence = Array.from({ length: 10 }, (_, index) =>
      claim({
        id: `clm_shared_${String(index)}`,
        kind: "evidence",
        body: `${longBody} ${String(index)}`,
      }),
    );
    const brief = baseBrief();
    const balanced: RefereeBrief = {
      ...brief,
      sharedTargets: [],
      positionA: {
        ...brief.positionA,
        claim: claim({ id: "clm_a" }),
        evidence: sharedEvidence,
        ruledOut: [],
      },
      positionB: {
        ...brief.positionA,
        claim: claim({ id: "clm_b", workContextId: "wc_b" }),
        evidence: sharedEvidence,
        ruledOut: [],
      },
    };

    // Act
    const lines = renderRefereeBrief(balanced, NOW).split("\n");
    const startA = lines.findIndex((line) => line.startsWith("Position A ·"));
    const startB = lines.findIndex((line) => line.startsWith("Position B ·"));
    const endB = lines.findIndex(
      (line, index) => index > startB && line.startsWith("No shared targets"),
    );

    // Assert
    expect(startA).toBeGreaterThan(-1);
    expect(startB).toBeGreaterThan(startA);
    expect(endB).toBeGreaterThan(startB);
    const blockA = lines.slice(startA, startB).join("\n");
    const blockB = lines
      .slice(startB, endB)
      .join("\n")
      .replaceAll("Position B", "Position A")
      .replaceAll("position B", "position A")
      .replaceAll("clm_b", "clm_a")
      .replaceAll("wc_b", "wc_a");
    expect(blockB).toBe(blockA);
  });

  test("never uses verdict language, whatever the evidence asymmetry", () => {
    // Arrange: the base case file is already lopsided (2 evidence vs 0)
    const output = renderRefereeBrief(baseBrief(), NOW).toLowerCase();

    // Assert: ranking words a case file must not contain
    for (const word of [
      "stronger",
      "weaker",
      "winner",
      " wins",
      "better",
      "worse",
      "more credible",
      "should adopt",
    ]) {
      expect(output.includes(word), word).toBe(false);
    }
  });

  test("says a superseded side prominently, before either position", () => {
    // Arrange
    const brief = baseBrief();
    const retired: RefereeBrief = {
      ...brief,
      positionA: { ...brief.positionA, supersededByClaimId: "clm_revised" },
    };

    // Act
    const output = renderRefereeBrief(retired, NOW);

    // Assert: the note names the revision and lands above the position blocks
    const noteAt = output.indexOf("superseded by its author");
    const positionAt = output.indexOf("Position A");
    expect(noteAt).toBeGreaterThan(-1);
    expect(output).toContain("clm_revised");
    expect(output).toContain("may already be over");
    expect(noteAt).toBeLessThan(positionAt);
  });

  test("shared ground and timeline are rendered from the shipped facts", () => {
    // Act
    const output = renderRefereeBrief(baseBrief(), NOW);

    // Assert
    expect(output).toContain("Shared ground");
    expect(output).toContain("error_fingerprint");
    expect(output).toContain("Timeline");
    // Oldest first: position A's claim (3d) precedes position B's (2d)
    const statedA = output.indexOf("stated position A");
    const statedB = output.indexOf("stated position B");
    expect(statedA).toBeGreaterThan(-1);
    expect(statedB).toBeGreaterThan(statedA);
  });

  test("hub-side caps and client-side dropped rows are said, never silent", () => {
    // Arrange
    const brief = baseBrief();
    const degraded: RefereeBrief = {
      ...brief,
      positionA: { ...brief.positionA, evidenceTruncated: true },
      droppedRows: 3,
    };

    // Act
    const output = renderRefereeBrief(degraded, NOW);

    // Assert
    expect(output).toContain("the hub capped position A's evidence list");
    expect(output).toContain("3 rows the hub sent could not be read");
  });

  test("a position budget always has room for the position claim itself", () => {
    // Arrange: the guard this asserts is arithmetic — a position header plus
    // its claim line is far under the per-position budget, so no case file
    // can render a position header with no claim under it
    const brief = baseBrief();

    // Act
    const output = renderRefereeBrief(brief, NOW);
    const lines = output.split("\n");
    const headerIndex = lines.findIndex((line) => line.startsWith("Position A"));

    // Assert
    expect(headerIndex).toBeGreaterThan(-1);
    expect(lines[headerIndex + 1]).toContain("clm_a");
    expect(MAX_REFEREE_POSITION_CHARS).toBeGreaterThan(1200);
  });
});
