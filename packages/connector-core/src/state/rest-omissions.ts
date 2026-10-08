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
 *   the capture-loss ledger (`rest_unchecked`, counted per FILE): it travels
 *     to the hub, whose coverage says the watch had a gap;
 *   this ledger (one line per BOOKING, reason `rest_unchecked`): local, like
 *     every omission — the same window, cap and key rule — so the machine's
 *     own count of moments its person may not have been told about a
 *     collision sits beside the briefings and landed-change checks it did
 *     not deliver whole.
 */
import { omissionLedger } from "./omission-ledger.ts";
import type { OmissionCounts, OmissionEntry } from "./omission-ledger.ts";

/** Why a collision's person may not have been told: a rest whose recheck never ran. */
export const REST_OMISSION_REASONS = ["rest_unchecked"] as const;

export type RestOmissionReason = (typeof REST_OMISSION_REASONS)[number];

const LEDGER = omissionLedger("rest-omissions.jsonl", REST_OMISSION_REASONS);

export const restOmissionsPath = LEDGER.path;

export type RestOmission = OmissionEntry<RestOmissionReason>;

export type RestOmissionCounts = OmissionCounts<RestOmissionReason>;

export const recordRestOmission = LEDGER.record;

export const readRestOmissions = LEDGER.read;
