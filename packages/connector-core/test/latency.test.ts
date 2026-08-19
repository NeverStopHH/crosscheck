/**
 * The latency-aware timeout, asserted as ARITHMETIC — the same split the hook
 * reserve uses (see HOOK_RESERVE_RATIO in src/constants.ts): frozen clocks and
 * scripted probes, no process, no network, no real clock, so the answer is a
 * property of the code on every machine. This file is the guard
 * scripts/mutation-check.ts runs for LATENCY_TIMEOUT_MULTIPLIER,
 * LATENCY_FLAP_WARN_RATIO and the never-below-default clamp.
 *
 * WHY THIS EXISTS. The default HTTP_TIMEOUT_MS (400 ms) is sized for a
 * same-LAN hub. A real teammate reaching the hub over a Tailscale DERP relay
 * measured 200-580 ms RTT: every CLI call died as "hub unreachable" while
 * curl succeeded, and the manual escape hatch (CROSSCHECK_TIMEOUT_MS, stored
 * timeoutMs) existed but nothing pointed at it. Login now measures and stores;
 * these are the numbers that decision is made of.
 */
import { describe, expect, test } from "bun:test";

import {
  HTTP_TIMEOUT_MS,
  LATENCY_PROBE_COUNT,
  LATENCY_TIMEOUT_MAX_MS,
} from "../src/constants.ts";
import {
  isFlapRisk,
  measureHubLatency,
  recommendedTimeoutMs,
} from "../src/http/latency.ts";

/** A clock that answers from a fixed queue — timing is data, not luck. */
const scriptedClock = (ticks: readonly number[]): (() => number) => {
  let index = 0;
  return () => {
    const value = ticks[index];
    if (value === undefined) {
      throw new Error("scripted clock exhausted — the code read more ticks than the test scripted");
    }
    index += 1;
    return value;
  };
};

/** A probe that answers from a fixed queue of outcomes. */
const scriptedProbe = (outcomes: readonly boolean[]): (() => Promise<boolean>) => {
  let index = 0;
  return () => {
    const outcome = outcomes[index];
    index += 1;
    return Promise.resolve(outcome ?? false);
  };
};

/** Clock ticks for probes of the given RTTs: start, start+rtt, repeated. */
const ticksFor = (rtts: readonly number[]): readonly number[] =>
  rtts.flatMap((rtt, probeIndex) => {
    const startMs = probeIndex * 100_000;
    return [startMs, startMs + rtt];
  });

describe("measureHubLatency", () => {
  test("returns the median of the probed round trips", async () => {
    // Arrange: five probes at 100/700/300/500/900 ms, shuffled on purpose —
    // the median must come from sorting, not arrival order
    const rtts = [100, 700, 300, 500, 900];

    // Act
    const measurement = await measureHubLatency(
      scriptedProbe([true, true, true, true, true]),
      scriptedClock(ticksFor(rtts)),
      rtts.length,
    );

    // Assert
    expect(measurement).toEqual({ medianRttMs: 500, samples: 5 });
  });

  test("excludes failed probes from the median instead of counting them as zero", async () => {
    // Arrange: probes 2 and 4 fail; their elapsed time must not pollute the set
    const rtts = [100, 9_000, 300, 9_000, 500];

    // Act
    const measurement = await measureHubLatency(
      scriptedProbe([true, false, true, false, true]),
      scriptedClock(ticksFor(rtts)),
      rtts.length,
    );

    // Assert: median over the three that answered
    expect(measurement).toEqual({ medianRttMs: 300, samples: 3 });
  });

  test("averages the two middle samples on an even count", async () => {
    // Arrange
    const rtts = [100, 200, 400, 800];

    // Act
    const measurement = await measureHubLatency(
      scriptedProbe([true, true, true, true]),
      scriptedClock(ticksFor(rtts)),
      rtts.length,
    );

    // Assert
    expect(measurement?.medianRttMs).toBe(300);
  });

  test("returns null when every probe fails, never a fabricated number", async () => {
    // Act
    const measurement = await measureHubLatency(
      scriptedProbe([false, false, false]),
      scriptedClock(ticksFor([1, 1, 1])),
      3,
    );

    // Assert
    expect(measurement).toBeNull();
  });

  test("probes LATENCY_PROBE_COUNT times by default", async () => {
    // Arrange: exactly one scripted tick pair per default probe — a clock that
    // throws on the first extra read is the count assertion
    const rtts = Array.from({ length: LATENCY_PROBE_COUNT }, () => 10);

    // Act
    const measurement = await measureHubLatency(
      scriptedProbe(rtts.map(() => true)),
      scriptedClock(ticksFor(rtts)),
    );

    // Assert
    expect(measurement).toEqual({ medianRttMs: 10, samples: LATENCY_PROBE_COUNT });
  });
});

describe("recommendedTimeoutMs", () => {
  test("derives 4x median plus the 200 ms floor mid-range", () => {
    // Assert: LITERALS, not the constants re-multiplied — with the multiplier
    // mutated to 0 this collapses to the clamp floor, and the remote teammate
    // the feature exists for would keep the 400 ms that killed every call.
    expect(recommendedTimeoutMs(500)).toBe(2_200);
    // The real incident's worst sample: a DERP relay at 580 ms RTT.
    expect(recommendedTimeoutMs(580)).toBe(2_520);
  });

  test("never recommends below the default — a LAN user keeps the tight timeout", () => {
    // Assert: the never-lower rule as arithmetic. With the clamp floor mutated
    // away a 2 ms LAN median would store ~208 ms and make a NEARBY hub flakier.
    expect(recommendedTimeoutMs(0)).toBe(HTTP_TIMEOUT_MS);
    expect(recommendedTimeoutMs(2)).toBe(HTTP_TIMEOUT_MS);
    // The highest median that still clamps: (400 - 200) / 4 = 50.
    expect(recommendedTimeoutMs(50)).toBe(HTTP_TIMEOUT_MS);
    expect(recommendedTimeoutMs(51)).toBeGreaterThan(HTTP_TIMEOUT_MS);
  });

  test("caps at LATENCY_TIMEOUT_MAX_MS however far the hub is", () => {
    // Assert: the cap bounds what a stored timeout does to the hook budgets,
    // which are ratios OF the timeout (hooks/runner.ts resolveBudget).
    expect(recommendedTimeoutMs(10_000)).toBe(LATENCY_TIMEOUT_MAX_MS);
    expect(recommendedTimeoutMs(LATENCY_TIMEOUT_MAX_MS)).toBe(LATENCY_TIMEOUT_MAX_MS);
  });
});

describe("isFlapRisk (the doctor WARN threshold)", () => {
  test("warns once the median is within the margin of the effective timeout", () => {
    // Assert: strict — a hub exactly at half the timeout is the boundary and
    // passes; one millisecond further and jitter reaches the timeout on
    // ordinary bad samples.
    expect(isFlapRisk(200, 400)).toBe(false);
    expect(isFlapRisk(201, 400)).toBe(true);
  });

  test("flags the incident state and clears after login stores the measured timeout", () => {
    // Assert: 500 ms away on the 400 ms default is the real outage; the same
    // hub on the stored 2200 ms recommendation is healthy.
    expect(isFlapRisk(500, 400)).toBe(true);
    expect(isFlapRisk(500, recommendedTimeoutMs(500))).toBe(false);
  });
});
