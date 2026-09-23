/**
 * A TEST NAME IS SOMEBODY ELSE'S TEXT (spec 05 §5, non-negotiable #2).
 *
 * `test_id` comes out of a repository, and a fork pull request can name a test
 * anything at all — a frame character, a prompt, a thousand combining marks, a
 * newline that forges a line of `crosscheck status`'s own. So the CI block runs
 * the FULL injection corpus under the same invariants every other untrusted
 * slot does.
 *
 * BARE CLASS, NOT FRAMED. The status command prints to a human terminal and
 * carries no QUOTED_DATA_NOTICE (its registration says why), so a « » pair
 * here would be a frame with nothing explaining it — worse than none, because
 * a reader who has learnt that « » means "quoted data" would meet one that
 * says nothing of the kind. No frame characters at all is the invariant.
 */
import { describe, expect, test } from "bun:test";

import { CI_STATUS_MAX_LINES } from "@crosscheck/connector-core/constants.ts";

import { ciLines } from "../src/cli/status.ts";
import { INJECTION_CORPUS } from "../../connector-core/test/fixtures/injection-corpus.ts";
import { assertUntrustedCharacters } from "../../connector-core/test/fixtures/untrusted-invariants.ts";

const coverage = (state: string): Record<string, unknown> => ({
  state,
  lanesExpected: 2,
  lanesReported: 2,
  truncatedLanes: 0,
  awaitingRerun: 1,
  collectedAt: "2026-07-24T08:55:00.000Z",
});

const delta = (testId: string): Record<string, unknown> => ({
  testId,
  delta: "unconfirmed",
  reason: "awaiting_rerun",
  baseRuns: 5,
  baseWindowSource: "same_ref",
  rerunKind: "none",
});

// The renderer is typed against the hub client's inferred shapes; the fixtures
// above are the wire shape those parse to, so the cast sits at the boundary
// and nowhere else.
const render = (verdict: unknown): readonly string[] =>
  ciLines(verdict as Parameters<typeof ciLines>[0]);

describe("§4.4: the CI block holds its class against every payload", () => {
  test("there are payloads to run — the corpus cannot be hollowed out", () => {
    // A corpus that shrank to nothing would leave every assertion below
    // vacuously true while the file still reads as coverage.
    expect(INJECTION_CORPUS.length).toBeGreaterThanOrEqual(60);
  });

  test.each(INJECTION_CORPUS.map((entry) => [entry.id, entry.payload] as const))(
    "a test named %s is printed safely",
    (id, payload) => {
      const lines = render({
        coverage: coverage("incomplete"),
        deltas: [delta(payload)],
      });

      for (const line of lines) {
        assertUntrustedCharacters(line, `ci-status/${id}`);
        // BARE CLASS: the frame belongs to a surface that explains it, and
        // this one does not carry the notice that would.
        expect(line.includes("«"), `ci-status/${id}`).toBe(false);
        expect(line.includes("»"), `ci-status/${id}`).toBe(false);
      }
      // A PAYLOAD MAY NOT BECOME A LINE OF ITS OWN. Every line after the head
      // is one the renderer meant to emit, and each of those is indented.
      for (const line of lines.slice(1)) {
        expect(line.startsWith("  "), `ci-status/${id}`).toBe(true);
      }
    },
  );

  test("a name that sanitizes away is made unprintable, never dropped", () => {
    // A silently shorter list is the absence this project refuses: the entry
    // that disappeared is exactly the test a reader would have looked at.
    const lines = render({
      coverage: coverage("incomplete"),
      deltas: [delta("«"), delta("packages/a.test.ts::real")],
    });

    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("nothing printable");
  });
});

describe("the CI block says what it does not know", () => {
  test("a hub that did not answer is not a passing suite", () => {
    // A missing line reads exactly like a green suite, which is why silence
    // is spelled out rather than skipped.
    const lines = render(null);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("not measured");
    expect(lines[0]).toContain("the hub did not answer");
  });

  test("a repo with no reporter says so, and says nothing about the code", () => {
    const lines = render({ coverage: coverage("unavailable"), deltas: [] });

    expect(lines[0]).toContain("no CI reporter is configured");
    // The lane counts are meaningless for a repo that reports nothing, so the
    // sentence does not carry them — "0/0 lanes" would read as a measurement.
    expect(lines[0]).not.toContain("lanes");
  });

  test("a counted state carries its denominator", () => {
    const lines = render({ coverage: coverage("incomplete"), deltas: [] });

    expect(lines[0]).toContain("2/2 lanes");
  });
});

describe("every reason a reader could act on is spelled out", () => {
  test.each([
    ["insufficient_base", "not seen enough"],
    ["not_stably_green", "already failing before this commit"],
    ["awaiting_rerun", "nobody has re-run it"],
    ["rerun_green", "flaky, not this commit"],
    ["rerun_red", "failed again on a re-run"],
  ])("%s is a sentence, not a token", (reason, fragment) => {
    // A REASON A READER CANNOT ACT ON IS A REASON WASTED. Printing the enum
    // value would be honest and useless; each of these sends somebody
    // somewhere different, which is the whole point of the ladder producing
    // five of them rather than a boolean.
    const lines = render({
      coverage: coverage("incomplete"),
      deltas: [{ ...delta("packages/a.test.ts::x"), reason }],
    });

    expect(lines[1]).toContain(fragment);
    expect(lines[1]).not.toContain(reason);
  });
});

describe("a wire-legal flood is cut, and the cut is said", () => {
  test("more failures than the cap leaves a count behind", () => {
    // A run may carry CI_MAX_TEST_ROWS non-green rows. Two hundred lines
    // ahead of the spool and cost blocks is output nobody reads to the end,
    // and the lines that scroll away are the ones a reader would act on.
    const many = Array.from(
      { length: CI_STATUS_MAX_LINES + 5 },
      (_unused, index) => delta(`packages/a.test.ts::case ${String(index)}`),
    );
    const lines = render({ coverage: coverage("incomplete"), deltas: many });

    expect(lines).toHaveLength(CI_STATUS_MAX_LINES + 2);
    expect(lines[lines.length - 1]).toContain("(+5 more not shown)");
  });

  test("a list that fits says nothing about a cut", () => {
    // The control: a line that prints on every run is a line nobody reads.
    const lines = render({
      coverage: coverage("incomplete"),
      deltas: [delta("packages/a.test.ts::only")],
    });

    expect(lines.join("\n")).not.toContain("not shown");
  });
});
