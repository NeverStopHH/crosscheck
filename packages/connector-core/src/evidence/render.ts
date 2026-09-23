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
import { axesLabel } from "@crosscheck/schema";
import type { EvidenceAxes } from "@crosscheck/schema";

import { formatAge } from "../briefing/render.ts";

/**
 * How much of a sha is printed. Seven, the length git itself abbreviates to,
 * and the length every other commit reference on these surfaces already uses.
 */
export const SHORT_SHA_CHARS = 7;

const HEX = /^[0-9a-f]+$/;

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
  // The WHO and WHAT sentences come from briefing/render.ts, which owns them
  // because both unsolicited surfaces need them and this module already
  // imports that one. What is added HERE is what only a pulled surface may
  // carry: an age, and a commit hash.
  const label = axesLabel(axes);
  if (label.length === 0) {
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
  return `${label}${tail}`;
};
