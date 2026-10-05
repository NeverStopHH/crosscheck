/**
 * A FIGURE IS MEASURED OR SAYS WHY NOT (1.0 spec 07 §5) — the one type every
 * pilot reader returns, shared by the report and by proof 4's labelled
 * figures so the rule has one definition.
 *
 * A zero that means "not measured" printed beside a zero that means "nothing
 * happened" is AT-9's exact confusion, so a figure is never a bare number.
 */
import type { PilotUnavailableReason } from "@crosscheck/schema";

export type Figure =
  | { readonly kind: "measured"; readonly value: number }
  | { readonly kind: "unavailable"; readonly reason: PilotUnavailableReason };

export const measured = (value: number): Figure => ({ kind: "measured", value });

export const unavailable = (reason: PilotUnavailableReason): Figure => ({
  kind: "unavailable",
  reason,
});

/** Every rate in the report is per hundred sessions. */
export const PER_HUNDRED = 100;
