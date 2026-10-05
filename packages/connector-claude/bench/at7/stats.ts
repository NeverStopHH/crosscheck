/**
 * The exact one-sided 95% Clopper–Pearson upper bound on a binomial per-run
 * rate — the number AT-7's pre-registration (docs/1.0/09-behavioral-injection.md
 * §5) prints next to every k, "every time", so zero successes is never read as
 * "impossible".
 *
 * Clopper–Pearson is EXACT (it inverts the binomial CDF), not the normal
 * approximation: at n = 20 the Wald interval around k = 0 is the degenerate
 * [0, 0], which is precisely the false certainty §1 forbids. The one-sided
 * upper limit at confidence 1 − α is the (1 − α) quantile of Beta(k+1, n−k):
 *
 *   - k = 0 has the closed form 1 − α^(1/n) — at n = 20, α = 0.05 that is
 *     0.139108, the 13.9% the spec quotes;
 *   - k = n is certainty: Beta(k+1, 0) is degenerate and the honest bound is 1;
 *   - otherwise the quantile is found by bisection on the regularized
 *     incomplete beta function Iₓ(k+1, n−k) = 1 − α, which is the binomial CDF
 *     tail P(X ≤ k | x) read as a function of the rate x.
 *
 * No dependency: `regularizedIncompleteBeta` is the Numerical Recipes continued
 * fraction, and `logGamma` the Lanczos approximation it needs. Both are pure.
 * The values are pinned in test/at7-stats.test.ts against an independent
 * scipy computation.
 */

/** The alpha this benchmark fixes: a 95% one-sided upper bound. */
export const CONFIDENCE_ALPHA = 0.05;

/** Bisection precision — far tighter than the 4 decimals the report prints. */
const BISECTION_TOLERANCE = 1e-12;

/** Enough halvings to reach BISECTION_TOLERANCE over [0, 1] (2^-60 ≈ 1e-18). */
const BISECTION_MAX_ITERATIONS = 200;

/** Continued-fraction iteration cap; convergence is reached far sooner. */
const BETA_CF_MAX_ITERATIONS = 500;
const BETA_CF_EPSILON = 1e-15;
/** Guards the continued fraction against a division by a near-zero term. */
const BETA_CF_TINY = 1e-300;

/** Lanczos g and coefficients (g = 7, n = 9) — standard, double precision. */
const LANCZOS_G = 7;
const LANCZOS_COEFFICIENTS: readonly number[] = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Γ(x) for x > 0 (Lanczos). Used only through `logBeta`. */
const logGamma = (x: number): number => {
  const shifted = x - 1;
  let series = LANCZOS_COEFFICIENTS[0] as number;
  for (let i = 1; i < LANCZOS_COEFFICIENTS.length; i += 1) {
    series += (LANCZOS_COEFFICIENTS[i] as number) / (shifted + i);
  }
  const t = shifted + LANCZOS_G + 0.5;
  return (
    0.5 * Math.log(2 * Math.PI) +
    (shifted + 0.5) * Math.log(t) -
    t +
    Math.log(series)
  );
};

const logBeta = (a: number, b: number): number =>
  logGamma(a) + logGamma(b) - logGamma(a + b);

/**
 * The Lentz continued fraction for the incomplete beta, as `betacf` in
 * Numerical Recipes §6.4 — the half of `regularizedIncompleteBeta` that runs
 * when x sits on the convergent side of (a+1)/(a+b+2).
 */
const betaContinuedFraction = (a: number, b: number, x: number): number => {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < BETA_CF_TINY) {
    d = BETA_CF_TINY;
  }
  d = 1 / d;
  let result = d;
  for (let m = 1; m <= BETA_CF_MAX_ITERATIONS; m += 1) {
    const m2 = 2 * m;
    const even = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + even * d;
    if (Math.abs(d) < BETA_CF_TINY) {
      d = BETA_CF_TINY;
    }
    c = 1 + even / c;
    if (Math.abs(c) < BETA_CF_TINY) {
      c = BETA_CF_TINY;
    }
    d = 1 / d;
    result *= d * c;
    const odd = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + odd * d;
    if (Math.abs(d) < BETA_CF_TINY) {
      d = BETA_CF_TINY;
    }
    c = 1 + odd / c;
    if (Math.abs(c) < BETA_CF_TINY) {
      c = BETA_CF_TINY;
    }
    d = 1 / d;
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) < BETA_CF_EPSILON) {
      break;
    }
  }
  return result;
};

/**
 * The regularized incomplete beta Iₓ(a, b) ∈ [0, 1] for 0 ≤ x ≤ 1, a,b > 0.
 * As a function of x it is the binomial tail P(X ≤ k | x) with a = k+1,
 * b = n−k, which is what the Clopper–Pearson inversion solves against.
 */
export const regularizedIncompleteBeta = (
  a: number,
  b: number,
  x: number,
): number => {
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  const front = Math.exp(
    a * Math.log(x) + b * Math.log(1 - x) - logBeta(a, b),
  );
  // Both branches use the SAME front factor; the symmetry Iₓ(a,b)=1−I₁₋ₓ(b,a)
  // is what keeps the continued fraction on its convergent side.
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
};

/**
 * The one-sided upper bound at confidence 1 − `alpha` on the per-run rate,
 * given `successes` of `trials`.
 *
 * k = 0 is the closed form, k = n is 1, and every k between is the (1 − alpha)
 * quantile of Beta(k+1, n−k) by bisection — Iₓ is monotone in x, so the
 * bracket [0, 1] halves to the root without a derivative.
 */
export const clopperPearsonUpper = (
  successes: number,
  trials: number,
  alpha: number = CONFIDENCE_ALPHA,
): number => {
  if (!Number.isInteger(successes) || !Number.isInteger(trials)) {
    throw new Error(
      `clopperPearsonUpper needs integer counts, got k=${successes} n=${trials}`,
    );
  }
  if (trials <= 0 || successes < 0 || successes > trials) {
    throw new Error(
      `clopperPearsonUpper needs 0 <= k <= n and n > 0, got k=${successes} n=${trials}`,
    );
  }
  if (successes === 0) {
    return 1 - alpha ** (1 / trials);
  }
  if (successes === trials) {
    return 1;
  }
  const a = successes + 1;
  const b = trials - successes;
  const target = 1 - alpha;
  let low = 0;
  let high = 1;
  for (let i = 0; i < BISECTION_MAX_ITERATIONS; i += 1) {
    const mid = (low + high) / 2;
    if (regularizedIncompleteBeta(a, b, mid) > target) {
      // Iₓ too large means x is past the quantile: pull the ceiling down.
      high = mid;
    } else {
      low = mid;
    }
    if (high - low < BISECTION_TOLERANCE) {
      break;
    }
  }
  return (low + high) / 2;
};
