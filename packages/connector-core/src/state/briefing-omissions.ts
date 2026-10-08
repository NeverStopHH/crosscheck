/**
 * THE BRIEFINGS THIS MACHINE DID NOT DELIVER WHOLE (2026-10-08), counted.
 *
 * A SessionStart can lose its briefing three ways, and before this file all
 * three ended in the same "": the hook's budget race won (the runner booked
 * a capture loss, and the person was told nothing), the handler threw (the
 * runner's catch, booked nowhere), or the hub reads did not answer inside
 * their per-request timeouts (fail open, to nothing). An empty session looked
 * exactly like a quiet repo — the pilot failure's shape: the person is told
 * nothing, and nothing says why. Each of the three now prints one line in the
 * session (briefing/omission.ts) and appends one line here, which `doctor`
 * counts, so a slow week is a number rather than a feeling.
 *
 * LOCAL, NEVER ON THE WIRE. This is not telemetry the hub's coverage reads —
 * a missed briefing loses no record — so it is its own small file rather than
 * a new kind in the capture-loss ledger, whose kinds travel to every hub and
 * whose schema an older hub validates. The shape, the window, the cap and
 * the key rule are every omission ledger's (state/omission-ledger.ts).
 */
import { omissionLedger } from "./omission-ledger.ts";
import type { OmissionCounts, OmissionEntry } from "./omission-ledger.ts";

/** Why a briefing did not arrive whole: the budget, a fault, or the hub's reads. */
export const BRIEFING_OMISSION_REASONS = ["budget", "error", "hub"] as const;

export type BriefingOmissionReason = (typeof BRIEFING_OMISSION_REASONS)[number];

const LEDGER = omissionLedger("briefing-omissions.jsonl", BRIEFING_OMISSION_REASONS);

export const briefingOmissionsPath = LEDGER.path;

export type BriefingOmission = OmissionEntry<BriefingOmissionReason>;

export type BriefingOmissionCounts = OmissionCounts<BriefingOmissionReason>;

export const recordBriefingOmission = LEDGER.record;

export const readBriefingOmissions = LEDGER.read;
