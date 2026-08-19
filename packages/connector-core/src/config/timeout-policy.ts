/**
 * Who owns the effective timeout, and what login may do about it.
 *
 * THE RULE, decided here and nowhere else: login overwrites ONLY values it
 * wrote itself. Its own writes carry timeoutSource MEASURED_TIMEOUT_SOURCE;
 * an explicit CROSSCHECK_TIMEOUT_MS and a stored timeoutMs without the marker
 * are somebody's deliberate choice and are never overwritten silently — login
 * says what it measured and leaves them standing. No prompt, no flag: the one
 * bit of state in the config file makes the behaviour predictable from the
 * file alone.
 *
 * Ownership mirrors resolveTimeoutMs's precedence (env > stored > default)
 * exactly — including that an unparseable env value falls through.
 */
import { HTTP_TIMEOUT_MS } from "../constants.ts";
import { envTimeoutMs, MEASURED_TIMEOUT_SOURCE } from "./config.ts";
import type { Config } from "./config.ts";
import type { Env } from "./paths.ts";

export type TimeoutOwner = "env" | "manual" | "login" | "none";

export const timeoutOwner = (env: Env, stored: Config | null): TimeoutOwner => {
  if (envTimeoutMs(env) !== null) {
    return "env";
  }
  if (stored?.timeoutMs === undefined) {
    return "none";
  }
  return stored.timeoutSource === MEASURED_TIMEOUT_SOURCE ? "login" : "manual";
};

export type TimeoutDecision =
  | { readonly kind: "store"; readonly timeoutMs: number }
  /** Login's own earlier value is no longer needed — back to the default. */
  | { readonly kind: "reset" }
  /** Somebody else's value (env or hand-set) — never overwritten silently. */
  | { readonly kind: "keep" };

/**
 * A recommendation is stored only when it EXCEEDS the default — at the default
 * (where the clamp lands for every nearby hub) the honest state is absence,
 * so login also retires its own stale value rather than leaving a relay-era
 * timeout behind on a machine that moved back onto the LAN.
 */
export const decideTimeoutUpdate = (
  owner: TimeoutOwner,
  recommendedMs: number,
): TimeoutDecision => {
  if (owner === "env" || owner === "manual") {
    // Known trade, kept deliberately: under env ownership a stored measured
    // value from an earlier login survives even though this login could
    // retire it. The stored layer is invisible while the env var governs,
    // retiring it would need the policy to peek past the owner, and the next
    // env-less login self-heals it anyway.
    return { kind: "keep" };
  }
  return recommendedMs > HTTP_TIMEOUT_MS
    ? { kind: "store", timeoutMs: recommendedMs }
    : { kind: "reset" };
};

/** Applies a decision to the config about to be saved — always a new object. */
export const withTimeoutDecision = (
  base: Config,
  decision: TimeoutDecision,
): Config => {
  if (decision.kind === "keep") {
    return base;
  }
  const { timeoutMs: _timeoutMs, timeoutSource: _timeoutSource, ...rest } = base;
  return decision.kind === "reset"
    ? rest
    : {
        ...rest,
        timeoutMs: decision.timeoutMs,
        timeoutSource: MEASURED_TIMEOUT_SOURCE,
      };
};
