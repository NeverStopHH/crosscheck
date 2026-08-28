/**
 * The golden-fixture precision harness (DESIGN.md §4 telemetry bullet, §10
 * risk 1): the whole corpus through the REAL stack — real hub over HTTP, real
 * ingest, real search + hint candidates + tripwire services, real selector
 * and renderers via the real hook entry points — with every probe labeled
 * SUBSTANCE, POINTER or SILENCE and metrics held to the floors below.
 *
 * THE FLOORS ENCODE TODAY'S INTENT, NOT MEASURED TRUTH. Every threshold this
 * corpus exercises was chosen by reasoning; the real tuning loop is the
 * hint_deliveries telemetry from the trial (see the corpus README's honesty
 * section). The floors sit at 1 because the corpus is hand-labeled to today's
 * defensible behavior — a debatable outcome is labeled with its rationale in
 * the probe (e.g. pr_contra_debatable) rather than tuned away, so any metric
 * below its floor is a REGRESSION against declared intent, not a missed
 * aspiration.
 *
 * Corpus size, derived from the data so this header cannot rot:
 *
 * VERIFY: bun -e 'const {loadCorpus}=await import("./packages/connector-core/test/fixtures/precision-corpus/format.ts");const c=await loadCorpus();const p=c.scenarios.flatMap(s=>s.probes);const by=k=>p.filter(x=>x.expect===k).length;console.log(c.scenarios.length,p.length,by("substance"),by("pointer"),by("silence"))'
 * PRINTS: 11 33 11 4 18
 *
 * THE HARNESS CAN FAIL — proven, not assumed. Continuously:
 * scripts/mutation-check.ts sets SOLVED_DECAY_FLOOR = 0 in
 * services/search.ts and this file must go red on pr_idx_solved_recall — the
 * 70-day solved tree decays below three fresh noise contexts, falls out of
 * HINT_MAX_CONTEXTS, and the answer somebody already found is never
 * delivered. That regression was recorded by hand at build time on
 * 2026-08-11 (the corpus README) and is now checked on every run.
 *
 * IT USED TO BE A DIFFERENT MUTATION, and why it moved is worth knowing:
 * "derived provenance counts as vouched" (hints/select.ts isDeclared → any
 * non-empty provenance) stopped reddening this corpus when audit row V2-X4
 * landed. The hub now withholds the BODY of every claim nobody vouched for
 * (server/src/services/hints.ts), so the corpus's Tier-1 draft arrives
 * body-less and `hasBody` refuses it whatever the provenance rule says. The
 * product gained a second line of defence and this harness lost its view of
 * the first — which is precisely why that entry now names hint-select.test.ts,
 * where a hub that DOES ship such a body can be expressed.
 */
import { describe, expect, test } from "bun:test";

import { formatFailures, runCorpus } from "./fixtures/precision-corpus/drive.ts";
import type { CorpusRun } from "./fixtures/precision-corpus/drive.ts";

/**
 * Minimum acceptable metrics — named floors the CI gauntlet enforces. Lower
 * a floor only with a written rationale in the corpus README; relabel a
 * probe (with rationale) when intent legitimately changes.
 *
 * THE VALUES ARE MACHINE-PINNED, not governance-pinned. Any floor in
 * (2/3, 1] passes every other gate — HISTORICAL, measured 2026-08-11:
 * mutation entry #33's worst mutated metric was 0.667, and every floor at
 * 0.7 plus a genuine ranking regression (SOLVED_DECAY_FLOOR = 0) ran the
 * corpus 6 pass / 0 fail while mutation-check, verify-claims and typecheck
 * all stayed green. The directive below makes a lowered floor travel with
 * this rationale-bearing comment or fail CI.
 *
 * VERIFY: grep -c 'FLOOR_[A-Z_]* = 1;' packages/connector-core/test/precision-corpus.test.ts
 * PRINTS: 5
 */
export const FLOOR_SUBSTANCE_PRECISION = 1;
export const FLOOR_SUBSTANCE_RECALL = 1;
export const FLOOR_SILENCE_CORRECTNESS = 1;
export const FLOOR_POINTER_DISCIPLINE = 1;
export const FLOOR_POINTER_RECALL = 1;

/** Seeding + every probe against cold PGlite — generous, not load-bearing. */
const TEST_TIMEOUT_MS = 240_000;

/** One corpus run shared by every assertion — the run itself is the cost. */
let cached: Promise<CorpusRun> | null = null;
const corpusRun = (): Promise<CorpusRun> => {
  cached = cached ?? runCorpus();
  return cached;
};

const explain = (run: CorpusRun, metric: string, value: number): string =>
  `${metric} ${value.toFixed(3)} below floor.\n${formatFailures(run.results)}`;

describe("golden-fixture precision corpus", () => {
  test(
    "every probe ran and got classified",
    async () => {
      const run = await corpusRun();
      const expected = run.corpus.scenarios.flatMap(
        (scenario) => scenario.probes,
      ).length;
      expect(run.results).toHaveLength(expected);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "substance precision holds the floor",
    async () => {
      const run = await corpusRun();
      expect(
        run.metrics.substancePrecision,
        explain(run, "substance precision", run.metrics.substancePrecision),
      ).toBeGreaterThanOrEqual(FLOOR_SUBSTANCE_PRECISION);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "substance recall holds the floor — an always-silent selector cannot pass",
    async () => {
      const run = await corpusRun();
      expect(
        run.metrics.substanceRecall,
        explain(run, "substance recall", run.metrics.substanceRecall),
      ).toBeGreaterThanOrEqual(FLOOR_SUBSTANCE_RECALL);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "silence correctness holds the floor — nothing labeled SILENCE fired",
    async () => {
      const run = await corpusRun();
      expect(
        run.metrics.silenceCorrectness,
        explain(run, "silence correctness", run.metrics.silenceCorrectness),
      ).toBeGreaterThanOrEqual(FLOOR_SILENCE_CORRECTNESS);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "pointer discipline holds the floor — nothing labeled POINTER arrived as substance",
    async () => {
      const run = await corpusRun();
      expect(
        run.metrics.pointerDiscipline,
        explain(run, "pointer discipline", run.metrics.pointerDiscipline),
      ).toBeGreaterThanOrEqual(FLOOR_POINTER_DISCIPLINE);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "pointer recall holds the floor — pointers arrive as pointers, not silence",
    async () => {
      const run = await corpusRun();
      expect(
        run.metrics.pointerRecall,
        explain(run, "pointer recall", run.metrics.pointerRecall),
      ).toBeGreaterThanOrEqual(FLOOR_POINTER_RECALL);
    },
    TEST_TIMEOUT_MS,
  );
});
