/**
 * The run order, drawn ONCE from a seeded shuffle and written to the results
 * directory before the first run (09 §3, §9 step 4). A fixed order means a
 * service that drifts over the hour, or a time-of-day effect, cannot line up
 * with an arm; a SEEDED shuffle (not Math.random) means the order is in the
 * record and reproducible — the pre-registration's "written to the manifest
 * before the first run" is a promise only a deterministic generator can keep.
 *
 *   --measured: 40 slots — 20 control and the five payloads four times each.
 *   --dry-run:  6 slots  — 1 control and one run per payload (§8 step 3),
 *               NEVER counted, so they are a fixed probe order, not shuffled.
 *
 * mulberry32 is the PRNG: a tiny, well-distributed 32-bit generator, seeded
 * from one fixed constant, so this module has no dependency and no global
 * state. Determinism is pinned in test/at7-manifest.test.ts.
 */

export const CONTROL_RUNS = 20;
export const TREATMENT_RUNS_PER_PAYLOAD = 4;
export const PAYLOAD_IDS = ["P1", "P2", "P3", "P4", "P5"] as const;
export type PayloadId = (typeof PAYLOAD_IDS)[number];

/** 20 control + 5 payloads × 4 = 40 measured runs. */
export const MEASURED_TOTAL =
  CONTROL_RUNS + PAYLOAD_IDS.length * TREATMENT_RUNS_PER_PAYLOAD;

/** The one fixed seed the measured order is drawn from — in the record. */
export const MANIFEST_SEED = 0x4154_3721;

export type Arm =
  | { readonly kind: "control" }
  | { readonly kind: "treatment"; readonly payload: PayloadId };

export interface Slot {
  /** Position in the run order, 0-based — the slot a void run re-runs into. */
  readonly index: number;
  readonly arm: Arm;
}

/** mulberry32 — a 32-bit seeded PRNG returning a float in [0, 1). */
const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Fisher–Yates over a copy, driven by the seeded PRNG — never mutates input. */
const seededShuffle = <T>(items: readonly T[], seed: number): T[] => {
  const next = mulberry32(seed);
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const a = shuffled[i] as T;
    const b = shuffled[j] as T;
    shuffled[i] = b;
    shuffled[j] = a;
  }
  return shuffled;
};

const CONTROL: Arm = { kind: "control" };

/** The unshuffled bag of 40 arms: 20 control, then 4 of each payload. */
const measuredArms = (): readonly Arm[] => [
  ...Array.from({ length: CONTROL_RUNS }, (): Arm => CONTROL),
  ...PAYLOAD_IDS.flatMap((payload) =>
    Array.from(
      { length: TREATMENT_RUNS_PER_PAYLOAD },
      (): Arm => ({ kind: "treatment", payload }),
    ),
  ),
];

/**
 * The measured order: the 40-arm bag shuffled by `seed`, each slot indexed by
 * its final position. The default seed is MANIFEST_SEED, so a caller that
 * passes nothing gets the one order the pre-registration fixes.
 */
export const measuredOrder = (seed: number = MANIFEST_SEED): readonly Slot[] =>
  seededShuffle(measuredArms(), seed).map((arm, index) => ({ index, arm }));

/**
 * The dry-run probe order: one control, then one run per payload, in payload
 * order. Not shuffled — these six runs are never counted (§8 step 3), so the
 * only thing that matters is that each delivery path is exercised once.
 */
export const dryRunOrder = (): readonly Slot[] =>
  [
    CONTROL,
    ...PAYLOAD_IDS.map((payload): Arm => ({ kind: "treatment", payload })),
  ].map((arm, index) => ({ index, arm }));
