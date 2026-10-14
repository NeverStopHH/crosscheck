/**
 * COLLISION RECHECKS THAT NEVER RAN (round 3, F-M2), counted in the local
 * "the person was not told" ledger — the third instance of
 * state/omission-ledger.ts, beside the briefing omissions and the landed
 * probe cuts.
 *
 * A 30 s tripwire rest owes a recheck (connector-claude hooks/rest-recheck.ts):
 * a teammate who started on the file inside the rest is told only by it. A
 * recheck that never ran — the turn crashed, was killed or cut, the hub did
 * not answer, the session ended owing it — is booked TWICE, for two readers:
 *
 *   the capture-loss ledger (`rest_unchecked`, counted per FILE): doctor and
 *     status print it per file; it stays off the wire report, because no
 *     record was lost and the hub's whole-repo coverage is not the place for
 *     one file's unwarned person (review batch 2, M3, state/loss-ledger.ts
 *     LOCAL_CAPTURE_LOSS_KINDS);
 *   this ledger (one line per BOOKING, reason `rest_unchecked`): local, like
 *     every omission — the same window, cap and key rule — so the machine's
 *     own count of moments its person may not have been told about a
 *     collision sits beside the briefings and landed-change checks it did
 *     not deliver whole.
 *
 * And one booking of its own (batch-2 review, H2): a tripwire whose answer
 * named a teammate, and whose hook the budget race then abandoned before its
 * output left — reason `tripwire_cut`, one line per cut hook. The hook's
 * claim is undone and the file left owing a recheck, so the collision is
 * asked again or booked `rest_unchecked`; this line is the moment itself.
 */
import { omissionLedger } from "./omission-ledger.ts";
import type { OmissionCounts, OmissionEntry } from "./omission-ledger.ts";

/**
 * Why a collision's person may not have been told: a rest whose recheck
 * never ran, or a tripwire answer the budget cut before its output left.
 */
export const REST_OMISSION_REASONS = ["rest_unchecked", "tripwire_cut"] as const;

export type RestOmissionReason = (typeof REST_OMISSION_REASONS)[number];

const LEDGER = omissionLedger("rest-omissions.jsonl", REST_OMISSION_REASONS);

export const restOmissionsPath = LEDGER.path;

export type RestOmission = OmissionEntry<RestOmissionReason>;

export type RestOmissionCounts = OmissionCounts<RestOmissionReason>;

export const recordRestOmission = LEDGER.record;

export const readRestOmissions = LEDGER.read;
