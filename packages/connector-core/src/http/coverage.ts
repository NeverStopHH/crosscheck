/**
 * The coverage record as it arrives on the wire (03 §3.1, §4).
 *
 * THE PARSE RULE INVERTS THIS TREE'S TOLERANT-PARSE CONVENTION, and that is
 * the whole point of the file. Everywhere else a missing optional block means
 * "nothing is claimed" and the renderer prints nothing — `SearchOutcome.filters`
 * is `null` from an older hub for exactly that reason (http/hub.ts:828). For
 * coverage, printing nothing IS the failure: an answer that says nothing about
 * what was observed reads as an answer that observed everything.
 *
 *   Absent coverage is `unknown`, never silence and never `complete`.
 *
 * A response with no `coverage` block, or one that fails to parse, becomes
 * UNKNOWN_COVERAGE — five rows, all `unknown`, reason `hub_did_not_report`.
 * The hub is the only authority here: this client does NOT substitute its own
 * knowledge of which emitters exist, because a connector guessing at coverage
 * is a second definition of "were we watching".
 *
 * THE NAMES ARE THE HUB'S (packages/server/src/services/coverage.ts), not a
 * second vocabulary. They are re-declared here because the connector cannot
 * import the server, and test/coverage-wire.test.ts pins the three enums
 * against the server's own so drift is a red build rather than a review catch.
 */
import { z } from "zod";

export const COVERAGE_SOURCES = [
  "agent_event",
  "git",
  "ci",
  "runtime",
  "human_edit",
] as const;

export const COVERAGE_STATES = [
  "complete",
  "incomplete",
  "unknown",
  "unavailable",
] as const;

export const COVERAGE_REASONS = [
  "sessions_reported",
  "session_reaped",
  "session_silent",
  "no_session_in_window",
  "commits_reported",
  "commit_authors_unreported",
  "evidence_stale",
  "no_commit_evidence",
  "no_emitter",
  "out_of_scope_1_0",
  "no_platform_rung",
  "hub_did_not_report",
  "ci_lanes_reported",
  "ci_lanes_missing",
  "ci_awaiting_rerun",
  "ci_not_reported_yet",
] as const;

export type CoverageSource = (typeof COVERAGE_SOURCES)[number];
export type CoverageState = (typeof COVERAGE_STATES)[number];
export type CoverageReason = (typeof COVERAGE_REASONS)[number];

export interface CoverageSourceRecord {
  readonly source: CoverageSource;
  readonly state: CoverageState;
  readonly reason: CoverageReason;
  /** ISO; null unless `incomplete`. */
  readonly gapSince: string | null;
  readonly observedAt: string | null;
}

export interface CoverageScope {
  readonly sinceIso: string;
  readonly paths?: readonly string[];
}

export interface CoverageRecord {
  /**
   * `repo`, `computedAt` and `scope` are the HUB's provenance for this
   * answer, and a hub that reported no coverage supplies none of them — so
   * unlike the hub-side type these are nullable here, on the tree's own
   * "then nothing is claimed" convention. `sources` is never nullable and
   * never short: five rows, always, because a missing row is the one thing a
   * reader could mistake for `complete`.
   */
  readonly repo: string | null;
  readonly computedAt: string | null;
  readonly scope: CoverageScope | null;
  readonly sources: readonly CoverageSourceRecord[];
}

const CoverageSourceRecordSchema = z.looseObject({
  source: z.enum(COVERAGE_SOURCES),
  state: z.enum(COVERAGE_STATES),
  reason: z.enum(COVERAGE_REASONS),
  gapSince: z.string().min(1).nullable().default(null),
  observedAt: z.string().min(1).nullable().default(null),
});

const CoverageScopeSchema = z.looseObject({
  sinceIso: z.string().min(1),
  paths: z.array(z.string().min(1)).optional(),
});

const CoverageEnvelopeSchema = z.looseObject({
  repo: z.string().min(1).nullable().default(null),
  computedAt: z.string().min(1).nullable().default(null),
  scope: z.unknown().optional(),
  sources: z.array(z.unknown()).default([]),
});

/** Rebuilt field by field: an absent `paths` is absent, never `undefined`. */
const toScope = (raw: unknown): CoverageScope | null => {
  const parsed = CoverageScopeSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const paths = parsed.data.paths;
  return paths === undefined
    ? { sinceIso: parsed.data.sinceIso }
    : { sinceIso: parsed.data.sinceIso, paths };
};

const unknownRow = (source: CoverageSource): CoverageSourceRecord => ({
  source,
  state: "unknown",
  reason: "hub_did_not_report",
  gapSince: null,
  observedAt: null,
});

/** Five rows, all `unknown`: what an un-upgraded or unreachable hub means. */
export const UNKNOWN_COVERAGE: CoverageRecord = {
  repo: null,
  computedAt: null,
  scope: null,
  sources: COVERAGE_SOURCES.map(unknownRow),
};

/**
 * PER ROW, FAIL CLOSED. A hub that sent four good rows and one this client
 * cannot read keeps the four and reads the fifth as `unknown` — never as
 * absent, and never upgraded. Nothing here can turn a row the hub did not
 * send into `complete`, which is the only direction that would be dangerous.
 */
export const parseCoverage = (raw: unknown): CoverageRecord => {
  const envelope = CoverageEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return UNKNOWN_COVERAGE;
  }
  const bySource = new Map<CoverageSource, CoverageSourceRecord>();
  for (const item of envelope.data.sources) {
    const row = CoverageSourceRecordSchema.safeParse(item);
    if (row.success && !bySource.has(row.data.source)) {
      bySource.set(row.data.source, row.data);
    }
  }
  return {
    repo: envelope.data.repo,
    computedAt: envelope.data.computedAt,
    scope: toScope(envelope.data.scope),
    sources: COVERAGE_SOURCES.map(
      (source) => bySource.get(source) ?? unknownRow(source),
    ),
  };
};

export const coverageStateOf = (
  record: CoverageRecord,
  source: CoverageSource,
): CoverageState =>
  record.sources.find((row) => row.source === source)?.state ?? "unknown";
