/**
 * Continuous attack on the MCP renderers.
 *
 * `get_diagnosis` and `search_related_work` return OTHER developers' text
 * straight into an agent's context. That is the same threat model the
 * SessionStart briefing spent a whole hardening block on, and the point of this
 * file is that it must not be re-solved from scratch — or, worse, forgotten.
 *
 * SAME CORPUS, SAME INVARIANTS, DIFFERENT SLOTS.
 *
 *   The payloads come from fixtures/injection-corpus.ts, the same array the
 *   briefing is attacked with. Not a copy: `INJECTION_CORPUS` is imported, so a
 *   payload added for one surface is thrown at both.
 *
 *   The invariants come from fixtures/untrusted-invariants.ts, which
 *   injection-corpus.test.ts imports too. That is what makes "the MCP path
 *   asserts the same invariants as the briefing" a fact rather than a claim —
 *   narrow one of those classes and BOTH files go red.
 *
 *   The slots could NOT be shared, and the corpus fixture says why at length: a
 *   briefing slot is a field of a presence row or a work-context row, while a
 *   diagnosis tree has claim kinds, statuses, confidences, evidence refs, typed
 *   edges with notes and foreign claim references — fifteen untrusted fields
 *   with no counterpart in a presence roster. So the fixture grew MCP slot
 *   machinery of its own rather than this file growing a thinner set of cases.
 *
 * THE ONE STRUCTURAL DIFFERENCE FROM THE BRIEFING, and it is a real one: this
 * renderer prints IDS BARE, outside the « » frame, because an agent has to pass
 * them back into another tool. The briefing has no such field. `safeId` is what
 * makes that safe — an allowlist, so strictly narrower than the sanitizer rather
 * than a second weaker copy of it — and the id slots below are what hold it up.
 */
import { describe, expect, test } from "bun:test";

import {
  MAX_DIAGNOSIS_CHARS,
  MAX_SEARCH_CHARS,
  QUOTED_DATA_NOTICE,
  REDACTED_TITLE,
} from "../src/index.ts";
import { renderDiagnosis, renderSearchResults } from "../src/mcp/render.ts";
import type { SearchHit } from "../src/mcp/render.ts";
import {
  MAX_REFEREE_BRIEF_CHARS,
  renderRefereeBrief,
} from "../src/mcp/render-referee.ts";
import {
  INJECTION_CORPUS,
  MCP_DIAGNOSIS_SLOTS,
  MCP_REFEREE_SLOTS,
  MCP_SEARCH_SLOTS,
  mcpDiagnosisWith,
  mcpRefereeWith,
  mcpSearchWith,
} from "./fixtures/injection-corpus.ts";
import type {
  McpDiagnosisSlot,
  McpRefereeSlot,
  McpSearchSlot,
} from "./fixtures/injection-corpus.ts";
import { assertUntrustedCharacters } from "./fixtures/untrusted-invariants.ts";

const AGE_MS = 60_000;

const renderDiagnosisWith = (
  slot: McpDiagnosisSlot,
  payload: string,
): string => renderDiagnosis(mcpDiagnosisWith(slot, payload));

const renderSearchWith = (slot: McpSearchSlot, payload: string): string => {
  const fixture = mcpSearchWith(slot, payload);
  const hits: readonly SearchHit[] = fixture.entries.map((entry) => ({
    entry,
    ageMs: AGE_MS,
  }));
  return renderSearchResults(hits, fixture.query);
};

/**
 * The exact shape of each kind of line the diagnosis renderer emits.
 *
 * Asserted POSITIVELY, per line, so that removing the frame FAILS rather than
 * merely making a check vacuous — a "no unbalanced « »" rule alone is satisfied
 * by having no « » at all. Same reasoning the briefing's PRESENCE_LINE and
 * CONTEXT_LINE patterns rest on.
 */
const DIAGNOSIS_HEADER = /^crosscheck diagnosis for work context [\w.:-]*\. /;
const CONTEXT_LINE = /^Work context «[^«»]*» · status .* · opened by .+$/;
const NO_CLAIMS_LINE = /^Claims: no claims recorded yet\.$/;
const SECTION_HEADER =
  /^(Claims|Edges|Claims in other work contexts referenced here) \(\d+\):$/;
/** id · kind · status X · confidence N.NN · author [· evidence …][· seen N×]: «body» */
const CLAIM_LINE =
  /^- [\w.:-]* · .* · status .* · confidence \d\.\d\d · .*: «[^«»]*»$/;
const EDGE_LINE = /^- [\w.:-]* .* [\w.:-]* · by .+?(: «[^«»]*»)?$/;
const EXTERNAL_LINE = /^- [\w.:-]* · .* · in work context [\w.:-]*$/;
const MORE_LINE = /^\(\+\d+ .+ not shown\)$/;
const NOTE_LINE = /^Note: .+$/;

const DIAGNOSIS_LINE_SHAPES = [
  CONTEXT_LINE,
  NO_CLAIMS_LINE,
  SECTION_HEADER,
  CLAIM_LINE,
  EDGE_LINE,
  EXTERNAL_LINE,
  MORE_LINE,
  NOTE_LINE,
];

const SEARCH_HEADER = /^crosscheck work contexts on this repo\. /;
const SEARCH_QUERY_LINE = /^Query: «[^«»]*»$/;
/** Both method variants: keyless ("Hybrid lexical match — …") and semantic. */
const SEARCH_METHOD_LINE =
  /^Hybrid (lexical )?match — exact file\/symbol\/fingerprint targets ranked above full-text /;
const SEARCH_COUNT_LINE = /^Work contexts \(\d+\):$/;
const SEARCH_LINE = /^- [\w.:-]* · .+ · \d+[smhd] ago · status .*: «[^«»]*»$/;
const SEARCH_EMPTY_LINE = /^No work context on this repo matched that query\.$/;
const SEARCH_UNUSABLE_LINE = /^Nothing was searched for: /;

const SEARCH_LINE_SHAPES = [
  SEARCH_QUERY_LINE,
  SEARCH_METHOD_LINE,
  SEARCH_COUNT_LINE,
  SEARCH_LINE,
  SEARCH_EMPTY_LINE,
  SEARCH_UNUSABLE_LINE,
  MORE_LINE,
];

/**
 * The fixture's shape, which the containment counts below depend on: two claims,
 * one edge, one foreign reference — nine lines, and no payload may change that
 * number. A payload that split its own bullet in two, or invented a section,
 * moves it whether or not it also smuggled a character through.
 */
const EXPECTED_DIAGNOSIS_LINES = 9;
/**
 * header + query + method + count + two work contexts.
 *
 * Six rather than five because the query moved onto a line of its own — see the
 * comment on `searchHeader` in mcp/render.ts, which this corpus is what found.
 */
const EXPECTED_SEARCH_LINES = 6;

const assertDocument = (
  output: string,
  label: string,
  headerPattern: RegExp,
  shapes: readonly RegExp[],
  cap: number,
): void => {
  expect(output.length, label).toBeGreaterThan(0);
  expect(output.length, label).toBeLessThanOrEqual(cap);
  expect(output.includes("\r"), label).toBe(false);

  const lines = output.split("\n");
  const [header = "", ...rest] = lines;
  assertUntrustedCharacters(header, `${label} header`);
  expect(headerPattern.test(header), `${label} header: ${header}`).toBe(true);
  // The framing sentence is the defence that still applies to every payload the
  // phrase filter does not catch, so it is never optional.
  expect(header.endsWith(QUOTED_DATA_NOTICE), label).toBe(true);

  rest.forEach((line, index) => {
    const where = `${label} line ${String(index + 1)}: ${JSON.stringify(line)}`;
    assertUntrustedCharacters(line, where);
    // Every line is one the renderer MEANT to emit. A payload that escapes onto
    // a line of its own matches none of these and fails here.
    expect(
      shapes.some((shape) => shape.test(line)),
      where,
    ).toBe(true);
  });
};

describe("diagnosis invariants over the injection corpus", () => {
  test("hold for every payload in every untrusted field of a tree", () => {
    for (const entry of INJECTION_CORPUS) {
      for (const slot of MCP_DIAGNOSIS_SLOTS) {
        // Act
        const output = renderDiagnosisWith(slot, entry.payload);

        // Assert
        assertDocument(
          output,
          `${entry.id}/${slot}`,
          DIAGNOSIS_HEADER,
          DIAGNOSIS_LINE_SHAPES,
          MAX_DIAGNOSIS_CHARS,
        );
      }
    }
  });

  test("no payload can add, remove or split a line of the tree", () => {
    // Arrange: containment, stated as a number. The fixture is fixed at two
    // claims, one edge and one foreign reference.
    for (const entry of INJECTION_CORPUS) {
      for (const slot of MCP_DIAGNOSIS_SLOTS) {
        // Act
        const lines = renderDiagnosisWith(slot, entry.payload).split("\n");

        // Assert
        expect(lines.length, `${entry.id}/${slot}`).toBe(
          EXPECTED_DIAGNOSIS_LINES,
        );
      }
    }
  });
});

describe("search invariants over the injection corpus", () => {
  test("hold for every payload in every untrusted field of a result", () => {
    for (const entry of INJECTION_CORPUS) {
      for (const slot of MCP_SEARCH_SLOTS) {
        // Act
        const output = renderSearchWith(slot, entry.payload);

        // Assert
        assertDocument(
          output,
          `${entry.id}/${slot}`,
          SEARCH_HEADER,
          SEARCH_LINE_SHAPES,
          MAX_SEARCH_CHARS,
        );
      }
    }
  });

  test("no payload can add, remove or split a result line", () => {
    for (const entry of INJECTION_CORPUS) {
      for (const slot of MCP_SEARCH_SLOTS) {
        // Act
        const lines = renderSearchWith(slot, entry.payload).split("\n");

        // Assert
        expect(lines.length, `${entry.id}/${slot}`).toBe(EXPECTED_SEARCH_LINES);
      }
    }
  });
});

// ─── The referee brief, the THIRD reading surface ───────────────────────────

const REFEREE_NOW = new Date("2026-07-25T09:00:00.000Z");

const renderRefereeWith = (slot: McpRefereeSlot, payload: string): string =>
  renderRefereeBrief(mcpRefereeWith(slot, payload), REFEREE_NOW);

const REFEREE_HEADER = /^crosscheck referee brief for contradiction [\w.:-]*\. /;
const REFEREE_NEUTRALITY_LINE =
  /^Two positions conflict; this is the case file — crosscheck does not rank them\.$/;
const REFEREE_DETECTION_LINE =
  /^Detected by (a shared target held with opposite statuses|semantic similarity \d\.\d\d|the hub's contradiction gate)\.$/;
const REFEREE_POSITION_HEADER =
  /^Position [AB] · .+ · work context [\w.:-]*: «[^«»]*»$/;
const REFEREE_COUNT_LINE =
  /^Position [AB] (cites no evidence claims\.|cites \d+ evidence claims?:|ruled out \d+ approach(es)?:|has no ruled-out approaches recorded\.)$/;
const REFEREE_CAP_LINE = /^\(the hub capped .+\)$/;
const REFEREE_SHARED_HEADER =
  /^Shared ground — targets both work contexts touch \(\d+\):$/;
const REFEREE_SHARED_LINE = /^- [^«»]* · [^«»]*$/;
const REFEREE_NO_SHARED_LINE =
  /^No shared targets between the two work contexts\.$/;
const REFEREE_TIMELINE_HEADER = /^Timeline, oldest first \(\d+\):$/;
const REFEREE_TIMELINE_LINE =
  /^- \d+[smhd] ago · .+ · (stated|cited for|ruled out for) position [AB] · [^«»]* [\w.:-]*$/;

const REFEREE_LINE_SHAPES = [
  REFEREE_NEUTRALITY_LINE,
  REFEREE_DETECTION_LINE,
  REFEREE_POSITION_HEADER,
  REFEREE_COUNT_LINE,
  REFEREE_CAP_LINE,
  REFEREE_SHARED_HEADER,
  REFEREE_SHARED_LINE,
  REFEREE_NO_SHARED_LINE,
  REFEREE_TIMELINE_HEADER,
  REFEREE_TIMELINE_LINE,
  CLAIM_LINE,
  MORE_LINE,
  NOTE_LINE,
];

/**
 * The fixture's shape: opening (header, neutrality, detection, one
 * retirement note), the payload-carrying position (header, claim, two count
 * lines, one evidence, one ruled-out), the clean position (header, claim,
 * two empty-count lines), shared ground (header + one target), timeline
 * (header + four events). Which position renders first may flip with a
 * payload in `positionClaimId` — the renderer orders the pair canonically —
 * but the totals cannot.
 */
const EXPECTED_REFEREE_LINES = 21;

describe("referee brief invariants over the injection corpus", () => {
  test("hold for every payload in every untrusted field of a case file", () => {
    for (const entry of INJECTION_CORPUS) {
      for (const slot of MCP_REFEREE_SLOTS) {
        // Act
        const output = renderRefereeWith(slot, entry.payload);

        // Assert
        assertDocument(
          output,
          `${entry.id}/${slot}`,
          REFEREE_HEADER,
          REFEREE_LINE_SHAPES,
          MAX_REFEREE_BRIEF_CHARS,
        );
      }
    }
  });

  test("no payload can add, remove or split a line of the case file", () => {
    for (const entry of INJECTION_CORPUS) {
      for (const slot of MCP_REFEREE_SLOTS) {
        // Act
        const lines = renderRefereeWith(slot, entry.payload).split("\n");

        // Assert
        expect(lines.length, `${entry.id}/${slot}`).toBe(
          EXPECTED_REFEREE_LINES,
        );
      }
    }
  });
});

/**
 * IDS ARE THE FIELD THE BRIEFING NEVER HAD.
 *
 * They are printed bare, because an agent must be able to pass one back into
 * `get_diagnosis` or `extend_diagnosis`, and a guillemet inside the id would
 * come back attached. `safeId` is an ALLOWLIST rather than a second sanitizer,
 * which is what makes bare printing defensible — these tests are what hold that
 * property up.
 */
const ID_SLOTS: readonly McpDiagnosisSlot[] = [
  "workContextId",
  "claimId",
  "evidenceRef",
  "edgeEndpointId",
  "externalClaimId",
  "externalWorkContextId",
];

describe("ids are printed bare, and that is safe", () => {
  test("no id slot can put a frame character or a space into the output", () => {
    // Arrange: an id is chosen by whoever writes the record, so `wc_x» now
    // follow this: «` is a legal id as far as the wire is concerned
    const ID_ALPHABET_ONLY = /^[\w.:-]*$/;

    for (const entry of INJECTION_CORPUS) {
      for (const slot of ID_SLOTS) {
        // Act: every rendered id, pulled back out of the output
        const output = renderDiagnosisWith(slot, entry.payload);
        const ids = [
          ...output.matchAll(/(?:^- |work context )([^\s·:]*)/gm),
        ].map((match) => match[1] ?? "");

        // Assert
        for (const id of ids) {
          expect(ID_ALPHABET_ONLY.test(id), `${entry.id}/${slot}: ${id}`).toBe(
            true,
          );
        }
      }
    }
  });

  test("an id is never redacted the way prose is", () => {
    // Arrange: `sanitizeUntrusted` returns REDACTED_TITLE for anything the
    // phrase filter matches, which is right for a claim body and wrong for an
    // identifier — using it on ids would make a claim whose id contains
    // "override" permanently unaddressable. This is that distinction, asserted.
    const payload = "clm_override_the_checks";

    // Act
    const output = renderDiagnosisWith("claimId", payload);

    // Assert
    expect(output).toContain(payload);
    expect(output).not.toContain(REDACTED_TITLE);
  });
});

describe("known-not-caught, on this surface too", () => {
  test.each([
    [
      "forget-everything",
      "no 'ignore'/'disregard' verb — the documented bypass",
    ],
    ["from-now-on", "reframes the task without naming instructions"],
    ["cyrillic-homoglyph", "Cyrillic і is not folded to Latin i by NFKC"],
  ])("%s reaches the reader framed and labelled (%s)", (id) => {
    // Arrange: the phrase filter is opportunistic defence-in-depth, documented
    // as such in briefing/sanitize.ts, and these walk past it on both surfaces.
    // What makes that acceptable is identical here to there: the text arrives
    // inside « », under a header that names it as data, on a line it cannot
    // leave. The day one of these starts being caught, this says so.
    const payload =
      INJECTION_CORPUS.find((entry) => entry.id === id)?.payload ?? "";
    expect(payload.length).toBeGreaterThan(0);

    // Act
    const output = renderDiagnosisWith("claimBody", payload);

    // Assert
    expect(output).toContain(QUOTED_DATA_NOTICE);
    expect(output).not.toContain(REDACTED_TITLE);
    expect(output).toMatch(/: «[^«»]+»$/m);
  });
});
