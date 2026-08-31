/**
 * What rendering a hub-maximal diagnosis costs, and where the cost actually is.
 *
 * WHY THIS EXISTS. `appendSection` used to carry a timing in a comment that was
 * wrong twice over: the quoted milliseconds were a reading taken at the OLD
 * 400-character body cap, and the mechanism they were credited to — the
 * quadratic `joinedLength` re-join — was a couple of percent of the work. The
 * real cost was one `spanRedactedUntrusted` per claim, paid for all five
 * hundred claims so that the fitter could print four of them.
 *
 * A figure nobody can reproduce is worse than no figure at all, so the comment
 * now names this script and this script prints the numbers.
 *
 * WHAT IT MEASURES. The worst tree the wire can carry: HUB_MAX_CLAIMS claims,
 * each body at MAX_CLAIM_BODY_LENGTH, through the real `renderDiagnosis`.
 *
 *   LAZY  — what the tree does today. `Section.rows` are thunks, so only the
 *           rows the fitter tries are ever built.
 *   EAGER — the same render with every claim row's body sanitised first, which
 *           is exactly what a materialised `lines` array paid for. Standing in
 *           for the old shape rather than reverting to it: `quotedBody` is the
 *           call `claimLine` makes, at the cap `claimLine` passes.
 *
 * Both lengths are read out of the tree this runs in, so the same script
 * measures the before and the after of any future cap change.
 *
 *   bun run packages/connector-core/scripts/measure-diagnosis-render.ts
 *   bun run packages/connector-core/scripts/measure-diagnosis-render.ts --check
 *
 * `--check` prints two booleans instead of milliseconds, which is what the
 * VERIFY directive on `appendSection` pins: absolute timings differ per host
 * and per load and could never be pinned, but "the lazy path is much cheaper"
 * and "it stays well inside the MCP timeout" are the two things the comment
 * actually claims, and both survive a slow machine.
 *
 * THE NUMBERS ARE A READING FROM ONE HOST ON ONE DAY, like every other timing
 * table in this repo. Runs, load and machine belong with any figure quoted
 * from it.
 */
import { MAX_CLAIM_BODY_LENGTH } from "@crosscheck/schema";

import type { Diagnosis, DiagnosisClaim } from "../src/http/hub.ts";
import { quotedBody, renderDiagnosis } from "../src/mcp/render.ts";

/**
 * The hub's own claims-per-tree bound, MIRRORED rather than imported: the
 * server package exports only its root, and reaching across packages for one
 * number is not worth widening that. Mirrored numbers drift, so this one is
 * pinned to its source the same way HUB_MAX_DIAGNOSIS_TARGETS is.
 *
 * VERIFY: bun -e 'const m=await import("./packages/connector-core/scripts/measure-diagnosis-render.ts");const d=await import("./packages/server/src/services/diagnosis.ts");console.log(m.HUB_MAX_CLAIMS === d.DIAGNOSIS_MAX_CLAIMS)'
 * PRINTS: true
 */
export const HUB_MAX_CLAIMS = 500;

const CREATED = "2026-07-24T09:00:00.000Z";
const NOW = new Date("2026-08-14T09:00:00.000Z");
const WARMUP_RUNS = 3;
const TIMED_RUNS = 5;
const NS_PER_MS = 1_000_000;

/** The comment's two claims, as thresholds a slow host still satisfies. */
const MIN_SPEEDUP = 5;
const MAX_LAZY_P50_MS = 25;

const claimAt = (index: number): DiagnosisClaim => ({
  id: `clm_${String(index).padStart(3, "0")}`,
  workContextId: "wc_01",
  authorSessionId: "cc_a-uuid",
  authorDeveloperId: "dev_nick",
  authorDeveloperName: "Nick",
  kind: "hypothesis",
  body: "b".repeat(MAX_CLAIM_BODY_LENGTH),
  status: "proposed",
  confidence: 0.8,
  captureMode: "agent",
  provenance: "declared",
  dedupCount: 1,
  evidenceRefs: [],
  createdAt: CREATED,
});

const CLAIMS: readonly DiagnosisClaim[] = Array.from(
  { length: HUB_MAX_CLAIMS },
  (_unused, index) => claimAt(index),
);

const TREE: Diagnosis = {
  workContext: {
    id: "wc_01",
    sessionId: "cc_a-uuid",
    title: "Login 500s on staging",
    description: null,
    status: "analyzing",
    createdAt: CREATED,
    updatedAt: null,
  },
  claims: CLAIMS,
  edges: [],
  externalClaims: [],
  targets: [],
  targetsReported: true,
  truncated: false,
  droppedRows: 0,
};

const lazyRender = (): unknown => renderDiagnosis(TREE, NOW);

/**
 * The eager shape's extra work: every claim body sanitised whether or not its
 * row can fit. `void` because only the COST is wanted — a materialised array
 * the fitter then ignores is precisely the defect being measured.
 */
const eagerRender = (): unknown => {
  for (const claim of CLAIMS) {
    void quotedBody(claim.body, MAX_CLAIM_BODY_LENGTH);
  }
  return renderDiagnosis(TREE, NOW);
};

const timeMs = (run: () => unknown): readonly number[] => {
  for (let index = 0; index < WARMUP_RUNS; index++) {
    void run();
  }
  return Array.from({ length: TIMED_RUNS }, () => {
    const started = Bun.nanoseconds();
    void run();
    return (Bun.nanoseconds() - started) / NS_PER_MS;
  });
};

const p50 = (samples: readonly number[]): number => {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const round = (value: number): string => value.toFixed(1);

/**
 * Guarded so that IMPORTING this module is side-effect free — the VERIFY
 * directive above imports it for one constant, and a script that measured and
 * printed on import would make that directive's output the timing table.
 */
const main = (): void => {
  const lazy = timeMs(lazyRender);
  const eager = timeMs(eagerRender);
  const lazyP50 = p50(lazy);
  const eagerP50 = p50(eager);
  const speedup = lazyP50 === 0 ? Infinity : eagerP50 / lazyP50;

  if (process.argv.includes("--check")) {
    console.log(
      `eager-vs-lazy speedup >= ${String(MIN_SPEEDUP)}x: ${String(speedup >= MIN_SPEEDUP)}`,
    );
    console.log(
      `lazy p50 under ${String(MAX_LAZY_P50_MS)} ms: ${String(lazyP50 < MAX_LAZY_P50_MS)}`,
    );
    return;
  }
  console.log(
    `${String(HUB_MAX_CLAIMS)} claims at ${String(MAX_CLAIM_BODY_LENGTH)} chars -> ${String(renderDiagnosis(TREE, NOW).length)}-char document`,
  );
  console.log(
    `lazy   min ${round(Math.min(...lazy))}  p50 ${round(lazyP50)}  max ${round(Math.max(...lazy))} ms`,
  );
  console.log(
    `eager  min ${round(Math.min(...eager))}  p50 ${round(eagerP50)}  max ${round(Math.max(...eager))} ms`,
  );
  console.log(`speedup ${round(speedup)}x`);
};

if (import.meta.main) {
  main();
}
