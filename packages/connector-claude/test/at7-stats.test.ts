import { describe, expect, test } from "bun:test";

import {
  clopperPearsonUpper,
  CONFIDENCE_ALPHA,
} from "../bench/at7/stats.ts";

/**
 * The one-sided 95% Clopper–Pearson upper bound is the number the
 * pre-registration (09 §5) prints next to every k, so a drift of a thousandth
 * is a drift in the published claim. The expected values are from an
 * independent computation (scipy.stats.beta.ppf(0.95, k+1, n-k); k=0 via the
 * closed form 1 − 0.05^(1/n)):
 *
 *   n=20 k=0  → 0.139108    n=20 k=1  → 0.216106
 *   n=20 k=2  → 0.282619    n=20 k=5  → 0.455582
 *   n=20 k=10 → 0.698046
 */
describe("clopperPearsonUpper", () => {
  test("zero successes in twenty is the pre-registration's 13.9%", () => {
    // Arrange / Act
    const upper = clopperPearsonUpper(0, 20);

    // Assert
    expect(upper).toBeCloseTo(0.139108, 6);
  });

  test("the closed form for k=0 equals 1 minus alpha to the one over n", () => {
    // Arrange
    const n = 20;

    // Act
    const upper = clopperPearsonUpper(0, n);

    // Assert
    expect(upper).toBeCloseTo(1 - CONFIDENCE_ALPHA ** (1 / n), 12);
  });

  test("one success in twenty bounds the rate at about 21.6%", () => {
    // Act
    const upper = clopperPearsonUpper(1, 20);

    // Assert
    expect(upper).toBeCloseTo(0.216106, 6);
  });

  test("two successes in twenty bounds the rate at about 28.3%", () => {
    // Act
    const upper = clopperPearsonUpper(2, 20);

    // Assert
    expect(upper).toBeCloseTo(0.282619, 6);
  });

  test("five successes in twenty bounds the rate at about 45.6%", () => {
    // Act
    const upper = clopperPearsonUpper(5, 20);

    // Assert
    expect(upper).toBeCloseTo(0.455582, 6);
  });

  test("ten successes in twenty bounds the rate at about 69.8%", () => {
    // Act
    const upper = clopperPearsonUpper(10, 20);

    // Assert
    expect(upper).toBeCloseTo(0.698046, 6);
  });

  test("every success is certainty — k equal to n returns 1", () => {
    // Act
    const upper = clopperPearsonUpper(20, 20);

    // Assert
    expect(upper).toBe(1);
  });

  test("the bound rises monotonically with k at fixed n", () => {
    // Arrange
    const n = 20;

    // Act
    const bounds = Array.from({ length: n + 1 }, (_unused, k) =>
      clopperPearsonUpper(k, n),
    );

    // Assert
    for (let k = 1; k <= n; k += 1) {
      expect(bounds[k]).toBeGreaterThan(bounds[k - 1] as number);
    }
  });

  test("rejects a k outside 0..n rather than returning a wrong number", () => {
    // Act / Assert
    expect(() => clopperPearsonUpper(-1, 20)).toThrow();
    expect(() => clopperPearsonUpper(21, 20)).toThrow();
  });
});
