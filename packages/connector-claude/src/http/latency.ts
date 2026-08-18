/**
 * How far away is the hub, and what timeout fits that distance?
 *
 * Everything here is arithmetic over an injected probe and an injected clock,
 * so test/latency.test.ts asserts it with scripted values on every machine —
 * the same detector split the hook reserve uses (test/hook-reserve.test.ts).
 * The rationale for every constant lives on the constants themselves (the
 * latency block in src/constants.ts).
 */
import {
  HTTP_TIMEOUT_MS,
  LATENCY_FLAP_WARN_RATIO,
  LATENCY_PROBE_COUNT,
  LATENCY_TIMEOUT_FLOOR_MS,
  LATENCY_TIMEOUT_MAX_MS,
  LATENCY_TIMEOUT_MULTIPLIER,
} from "../constants.ts";

/** One round trip to the hub: true when it answered at all. */
export type RttProbe = () => Promise<boolean>;

export interface LatencyMeasurement {
  readonly medianRttMs: number;
  /** Successful probes the median is over — failures are excluded, not zero. */
  readonly samples: number;
}

/** Median of an already-sorted list; the two middle values average when even. */
const medianOf = (sorted: readonly number[]): number => {
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) {
    return upper;
  }
  const lower = sorted[middle - 1] ?? 0;
  return Math.round((lower + upper) / 2);
};

/**
 * Median round trip over `probeCount` SEQUENTIAL probes — parallel probes
 * would contend on the same path and time each other, not the hub. A probe
 * that fails (or throws) contributes nothing; all of them failing yields null
 * rather than a fabricated number.
 */
export const measureHubLatency = async (
  probe: RttProbe,
  nowMs: () => number,
  probeCount: number = LATENCY_PROBE_COUNT,
): Promise<LatencyMeasurement | null> => {
  let rtts: readonly number[] = [];
  for (let index = 0; index < probeCount; index += 1) {
    const startedMs = nowMs();
    const answered = await probe().catch(() => false);
    const elapsedMs = nowMs() - startedMs;
    rtts = answered ? [...rtts, elapsedMs] : rtts;
  }
  if (rtts.length === 0) {
    return null;
  }
  const sorted = [...rtts].sort((a, b) => a - b);
  return { medianRttMs: medianOf(sorted), samples: rtts.length };
};

/**
 * The timeout that fits a hub `medianRttMs` away: multiplier for jitter, floor
 * for absolute headroom, clamped so it never undercuts the LAN default (the
 * never-lower rule) and never exceeds the cap the hook budgets can carry.
 */
export const recommendedTimeoutMs = (medianRttMs: number): number =>
  Math.min(
    LATENCY_TIMEOUT_MAX_MS,
    Math.max(
      HTTP_TIMEOUT_MS,
      Math.round(medianRttMs * LATENCY_TIMEOUT_MULTIPLIER + LATENCY_TIMEOUT_FLOOR_MS),
    ),
  );

/**
 * Whether ordinary jitter can reach the effective timeout — doctor's WARN
 * threshold. Strict: a hub exactly at the margin is the boundary and passes.
 */
export const isFlapRisk = (
  medianRttMs: number,
  effectiveTimeoutMs: number,
): boolean => medianRttMs * LATENCY_FLAP_WARN_RATIO > effectiveTimeoutMs;
