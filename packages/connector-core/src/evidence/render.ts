/**
 * THE TWO EVIDENCE AXES AS ONE CLAUSE (1.0 spec 08 §3.1, §5).
 *
 * NO AUTHOR-WRITTEN STRING REACHES THIS OUTPUT, and that is the property that
 * lets the clause land beside every confidence the product prints without
 * adding an untrusted slot to any of those surfaces. Three kinds of input come
 * in and nothing else:
 *
 *   - `who`, `support` and `supportReason` are ENUMS. The sentences below are
 *     renderer-owned literals chosen by those enums; the enum value itself is
 *     never interpolated, so a hub sending a member this version has never
 *     heard of loses the clause rather than printing its bytes.
 *   - `observedAt` is a hub-sent string and is NEVER printed through. It is
 *     parsed to an instant and only the derived AGE is formatted, by the
 *     render layer's own `formatAge`, which takes a number — so those bytes
 *     cannot reach the output even by accident. A hub that sends prose where
 *     an ISO belongs loses the age and keeps the sentence; `coverage/render.ts`
 *     applies the same rule to the same class of field.
 *   - `verifiedAtCommit` is a sha, and it is the one value printed from hub
 *     bytes. It is therefore CHARACTER-CLASS CHECKED rather than trusted: hex
 *     only, and cut to `SHORT_SHA_CHARS`. A commit id that is not hex is not a
 *     commit id, and printing it anyway would be the untrusted slot this
 *     module claims not to have.
 *
 * THE REF ITSELF IS NOT HERE, deliberately. A `ci_test` id is author-written
 * text up to 300 characters, and §5 confines it to `get_diagnosis` — the one
 * surface a reader ASKED for. Spending an unsolicited hint's characters on
 * somebody's test name anchors a session on a file path it never chose.
 */
import type {
  EvidenceAxes,
  EvidenceSupportReason,
  EvidenceWho,
} from "@crosscheck/schema";

import { formatAge } from "../briefing/render.ts";

/**
 * How much of a sha is printed. Seven, the length git itself abbreviates to,
 * and the length every other commit reference on these surfaces already uses.
 */
export const SHORT_SHA_CHARS = 7;

const HEX = /^[0-9a-f]+$/;

/**
 * WHO, in the reader's words rather than the enum's.
 *
 * In 1.0 this is always `agent_derived` and the sentence says so plainly
 * instead of dressing it up: a reader who sees "an agent recorded this" knows
 * what weight to give it, and a reader who sees nothing assumes a person did.
 */
const WHO_SENTENCE: Record<EvidenceWho, string> = {
  human_declared: "a person declared this",
  agent_derived: "an agent recorded this",
};

/**
 * WHY the support rung is what it is — one literal per enum member.
 *
 * `Record` rather than a switch with a default, on purpose: adding a member to
 * `EVIDENCE_SUPPORT_REASONS` without adding a sentence here is a TYPE ERROR.
 * A default arm would instead print a vague fallback for the new reason, which
 * is the failure this project keeps finding — a gap that reads like an answer.
 *
 * Every sentence is written so that the WEAK rungs sound weak. "No check was
 * attached" must not read like a clean bill of health, because that is exactly
 * what a reader in a hurry will take it for.
 */
const REASON_SENTENCE: Record<EvidenceSupportReason, string> = {
  no_verification_ref: "no check was attached to it",
  ref_malformed: "the attached check could not be read",
  ref_unresolved: "the attached check names nothing this hub holds",
  observed_failure: "a failure was observed; no fix was shown to land",
  ci_observed: "CI has seen this test, but no red-then-green pair",
  red_then_green: "it failed before and passes now",
  no_binding: "the claim names no commit, so nothing can be checked against it",
  no_ci_coverage: "this repository reports no CI",
  pruned_by_retention: "the earlier run has aged out; the pair is gone",
  no_platform_rung: "nothing here can verify a check of this kind",
};

/**
 * A hub-sent instant as an AGE, never as its own bytes.
 *
 * `formatAge` is the render layer's own formatter — the one the briefing, the
 * hints and the coverage note already use — and it takes a NUMBER of
 * milliseconds, so the hub's string cannot reach the output even by accident:
 * it is parsed, and only the derived duration is formatted. `Date.parse` of
 * prose is NaN, and NaN loses the age while the sentence survives. A
 * degradation, never an injection.
 *
 * AN AGE RATHER THAN A DATE because that is what a reader of these surfaces
 * is asking: "3d ago" answers how much to trust this now, where "2026-07-24"
 * makes them do the arithmetic.
 */
const agedSince = (value: string | null, now: Date): string | null => {
  if (value === null) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed)
    ? null
    : `${formatAge(Math.max(0, now.getTime() - parsed))} ago`;
};

/**
 * A sha printed only if it looks like one.
 *
 * Lowercase hex and nothing else, then cut. This is the single place hub bytes
 * reach the output, so it is the single place that has to be checked — and a
 * character class is checkable, where "the hub would not do that" is not.
 */
const shortSha = (value: string | null): string | null => {
  if (value === null) {
    return null;
  }
  const candidate = value.trim().toLowerCase();
  return HEX.test(candidate) ? candidate.slice(0, SHORT_SHA_CHARS) : null;
};

/**
 * The clause, or the empty string when this version cannot name what it was
 * handed.
 *
 * NEVER EMPTY FOR A WEAK RUNG. The empty return is reserved for an enum member
 * this version has never heard of — the forward-compatibility case — because
 * an unnamed label is worse than none. Every rung the hub can actually produce
 * prints, including and especially `unsupported`: a claim with nothing behind
 * it is precisely the one a reader must not mistake for a checked one.
 */
export const axesClause = (axes: EvidenceAxes, now: Date): string => {
  const who = WHO_SENTENCE[axes.who] as string | undefined;
  const reason = REASON_SENTENCE[axes.supportReason] as string | undefined;
  if (who === undefined || reason === undefined) {
    return "";
  }
  const when = agedSince(axes.observedAt, now);
  const at = shortSha(axes.verifiedAtCommit);
  const tail =
    axes.support === "repository_verified" && at !== null
      ? ` at ${at}`
      : when !== null
        ? ` (${when})`
        : "";
  return `${who} — ${reason}${tail}`;
};
