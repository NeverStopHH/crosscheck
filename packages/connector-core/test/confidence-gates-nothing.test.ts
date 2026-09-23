/**
 * EV-4 — `confidence` gates nothing, on purpose (1.0 spec 08 §3.6).
 *
 * The rule is broad: the number *"may appear in no predicate — not a filter,
 * sort key, floor, gate, selector or threshold"*. Today that is true, and 08
 * §1.2 measured it — but it is true BY ACCIDENT, and the whole point of this
 * file is to make the moment somebody changes it a red build.
 *
 * WHY 0.80 THAT IS RIGHT 55 % OF THE TIME IS WORSE THAN NO NUMBER. A reader
 * discounts prose correctly — "I think it is the cache" is heard as a guess —
 * but two decimals read as a MEASUREMENT, and the reader cannot know that
 * nothing measured it. The number transfers a model's uncertainty in a form
 * that suppresses the reader's own discounting. It is kept because it becomes
 * worth printing once calibration says what it means; until then it may be
 * PRINTED and it may not DECIDE anything.
 *
 * TWO DIRECTIVES, NOT ONE, and that is the finding this file exists for. The
 * first draft's whole guard was the comparison grep. A sort comparator
 * (`b.confidence - a.confidence`), a `Math.min`/`Math.max` cap, a
 * `filter(c => c.confidence)` and a ternary ALL PASS IT UNTOUCHED — and the
 * mutation most likely to happen in practice, ranking hints by confidence, is
 * exactly the one it cannot see. Proved rather than asserted below.
 */
import { describe, expect, test } from "bun:test";

/**
 * (a) THE COMPARISON DIRECTIVE. Both hits are the `DERIVED_CONFIDENCE_CAP`
 * wire check — the one place the number legitimately decides something, and it
 * decides whether a RECORD IS WELL FORMED, never which claim a reader sees.
 *
 * The directive sits in LINE comments below rather than in this block, and
 * that is not style: the source glob it greps ends in a star followed by a
 * slash before `src`, and that pair CLOSES a JSDoc comment mid-word. A
 * directive written here would terminate its own comment and take the rest of
 * the module's parse with it — which is how four unrelated claim directives
 * once failed together over a `sed` expression in one comment.
 */
// VERIFY: grep -raEn 'confidence\s*(>|<|>=|<=)' packages/*/src | wc -l | tr -d ' '
// PRINTS: 2
const COMPARISON_SITES = [
  "packages/schema/src/claim.ts",
  "packages/schema/src/session.ts",
] as const;

/**
 * (b) THE OPERATION DIRECTIVE — everything (a) is blind to: caps, sort
 * comparators, array predicates and SQL ordering.
 *
 * ONE HIT, and it is the same cap arriving by a different route:
 * `confidence: Math.min(draft.confidence, DERIVED_CONFIDENCE_CAP)` in
 * `mcp/tools/review-draft.ts`. It clamps a value on the way in; it selects
 * nothing.
 *
 * (08 §7 cites this at `review-draft.ts:132`. It is at :148 — the line moved
 * after the spec was written, which is why this file names the FILE and lets
 * the directive find the line.)
 *
 */
// VERIFY: grep -raEn 'Math\.(min|max)\([^;\n]*[Cc]onfidence|[Cc]onfidence\s*-\s*[a-zA-Z_$]|\.(filter|find|some|every|sort|reduce)\([^;\n]*[Cc]onfidence|(orderBy|where)\([^;\n]*[Cc]onfidence' packages/*/src | wc -l | tr -d ' '
// PRINTS: 1
const OPERATION_SITES = [
  "packages/connector-core/src/mcp/tools/review-draft.ts",
] as const;

/**
 * WHERE A CONFIDENCE IS PRINTED — and the census that was short.
 *
 * 08 §1.2 enumerates SIX render sites plus the author echo, seven in all.
 * There are EIGHT, and the census was short by two: `conference/report.ts` and
 * `mcp/render-referee.ts`. That matters beyond bookkeeping — EV-5 asserts that
 * *every* surface printing a confidence prints both evidence labels beside it,
 * so a printer missing from the enumeration emits a bare `confidence 0.80`
 * while the acceptance test still passes.
 *
 * THE SECOND OMISSION IS THE INSTRUCTIVE ONE. `render-referee.ts` held a
 * literal NUL byte — `join("\x00")` as a sort key — which made the whole
 * module grep as BINARY. Every recursive `grep` over the source packages in this repository
 * silently skipped it: not an error, not a warning, just a file that was never
 * in any answer. A census taken with grep therefore could not see it, and the
 * guard would have reported clean forever. The byte is gone (a `JSON.stringify`
 * key replaces it) and both directives below now pass `-a`, so a stray control
 * character can never again remove a file from the guard's field of view.
 *
 * That is this project's own defect pattern, found in its own guards: an
 * absence that nothing reports, because the thing that would report it is what
 * went missing.
 *
 * Listed apart from the two directives above because PRINTING is permitted and
 * DECIDING is not. The point of the list is that the next printer is visible.
 */
const PRINTING_SITES = [
  "packages/connector-core/src/mcp/render.ts",
  "packages/connector-core/src/mcp/render-referee.ts",
  "packages/connector-core/src/hints/render.ts",
  "packages/connector-core/src/briefing/render.ts",
  "packages/connector-core/src/conference/report.ts",
  "packages/connector-core/src/mcp/tools/publish-claim.ts",
  "packages/server/src/ui/pages/work-context.tsx",
  "packages/server/src/ui/pages/referee.tsx",
] as const;

const COMPARISON_PATTERN = String.raw`confidence\s*(>|<|>=|<=)`;
const OPERATION_PATTERN = [
  String.raw`Math\.(min|max)\([^;\n]*[Cc]onfidence`,
  String.raw`[Cc]onfidence\s*-\s*[a-zA-Z_$]`,
  String.raw`\.(filter|find|some|every|sort|reduce)\([^;\n]*[Cc]onfidence`,
  String.raw`(orderBy|where)\([^;\n]*[Cc]onfidence`,
].join("|");

const ROOT = new URL("../../..", import.meta.url).pathname;

const grepSrc = async (pattern: string): Promise<readonly string[]> => {
  const proc = Bun.spawn(
    ["bash", "-lc", `grep -raEn '${pattern}' packages/*/src || true`],
    { cwd: ROOT, stdout: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

const filesOf = (hits: readonly string[]): readonly string[] =>
  [...new Set(hits.map((hit) => hit.split(":")[0] ?? ""))].sort();

describe("EV-4 — confidence appears in no predicate", () => {
  test("(a) every comparison on a confidence is the wire cap", async () => {
    // Act
    const hits = await grepSrc(COMPARISON_PATTERN);

    // Assert — the FILES, not just the count. A count alone is satisfied by
    // adding a comparison in one file while deleting one in another, which is
    // precisely the edit this guard exists to notice.
    expect(filesOf(hits)).toEqual([...COMPARISON_SITES].sort());
  });

  test("(b) the only non-comparison operation is the same cap, on the way in", async () => {
    // Act
    const hits = await grepSrc(OPERATION_PATTERN);

    // Assert
    expect(filesOf(hits)).toEqual([...OPERATION_SITES].sort());
  });

  test("(b) SEES what (a) cannot — a sort comparator on confidence", () => {
    // Arrange — the mutation 08 §7 names as the likely one in practice:
    // ranking hints by the invented number. This is the whole reason EV-4
    // needs two directives, so it is demonstrated rather than claimed.
    const planted = "candidates.sort((a, b) => b.confidence - a.confidence)";

    // Act
    const seenByComparison = new RegExp(COMPARISON_PATTERN).test(planted);
    const seenByOperation = new RegExp(OPERATION_PATTERN).test(planted);

    // Assert — invisible to the comparison grep, caught by the operation one.
    expect(seenByComparison).toBe(false);
    expect(seenByOperation).toBe(true);
  });

  test("(b) also sees a floor, a cap and a truthiness filter", () => {
    // Arrange — the other shapes §3.6 forbids and a comparison grep misses.
    const shapes = [
      "confidence: Math.max(claim.confidence, FLOOR)",
      "rows.filter((row) => row.confidence)",
      "claims.sort((a, b) => a.confidence - b.confidence)",
    ];

    // Assert
    for (const shape of shapes) {
      expect(new RegExp(OPERATION_PATTERN).test(shape), shape).toBe(true);
    }
  });
});

describe("EV-5 — the census of printers, corrected", () => {
  test("every file printing a confidence is on the census", async () => {
    // Act — a print is the number reaching a template or a JSX child.
    // A PRINT is the number read off a RECORD and formatted for a reader.
    // Narrower than "the token appears in a template" on purpose: the two
    // schema files interpolate DERIVED_CONFIDENCE_CAP into a validation error
    // message, which names the constant and never a claim's number, and
    // counting those as printers would put the wire schema on a census about
    // what a reader sees.
    const hits = await grepSrc(
      String.raw`[Cc]onfidence\.toFixed|String\([a-zA-Z_$.]*[Cc]onfidence\)`,
    );

    // Assert — a printer NOT on this list is the defect: EV-5 claims every one
    // of them carries both evidence labels, and it can only claim that about
    // printers somebody enumerated.
    for (const file of filesOf(hits)) {
      expect(PRINTING_SITES as readonly string[], file).toContain(file);
    }
  });

  test("the conference report is a printer, which 08 §1.2 did not list", async () => {
    // Arrange — §1.2 names six render sites plus the author echo. This is the
    // eighth, recorded here rather than quietly folded into a count, so the
    // omission stays visible to whoever builds EV-5 next.
    const source = await Bun.file(
      `${ROOT}packages/connector-core/src/conference/report.ts`,
    ).text();

    // Assert
    expect(source).toContain("confidence ${String(claim.confidence)}");
  });
});
