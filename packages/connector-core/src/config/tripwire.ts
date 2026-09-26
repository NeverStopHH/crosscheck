/**
 * The PreToolUse tripwire mode (trial finding #25 + Q2), resolved from the
 * environment. See TRIPWIRE_MODE_ENV in constants.ts for the full reasoning:
 * `ask` is DESIGN §4's normative default; `notice` (additionalContext only, no
 * permission decision) exists for headless orchestration/CI sessions that must
 * never one-shot-deny a tool call, since headless cannot be auto-detected.
 *
 * FAIL CLOSED TO `ask`: any value that is not exactly `notice` — unset, a
 * typo, empty — keeps the normative decision. Only the deliberate opt-out
 * turns the decision off.
 */
import { TRIPWIRE_MODE_ASK, TRIPWIRE_MODE_ENV, TRIPWIRE_MODE_NOTICE } from "../constants.ts";
import type { Env } from "./paths.ts";

export type TripwireMode = typeof TRIPWIRE_MODE_ASK | typeof TRIPWIRE_MODE_NOTICE;

export const resolveTripwireMode = (env: Env): TripwireMode =>
  env[TRIPWIRE_MODE_ENV] === TRIPWIRE_MODE_NOTICE
    ? TRIPWIRE_MODE_NOTICE
    : TRIPWIRE_MODE_ASK;

/**
 * Whether a PERSON reads this session — false in `notice` mode, the explicit
 * mark of a headless run. The author's notice (landed changes, step 4) turns
 * on it at both ends: a reader's stop no person saw tells nobody, and an
 * author's session no person reads is told nothing, so a notice is never
 * spent on a run nobody reads.
 */
export const aPersonReads = (env: Env): boolean => resolveTripwireMode(env) !== TRIPWIRE_MODE_NOTICE;
