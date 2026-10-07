/**
 * VENDORED FROM crosscheck v0.10.0, packages/connector-core/src/coverage/render.ts
 * (review round 5, H4). The code is verbatim; some of its doc comments are
 * shortened, and two imports point at today's modules: `MAX_COVERAGE_LINE_CHARS`
 * (160, unchanged since) and `formatAge` (which 0.10.0 re-exported from
 * briefing/render.ts). The parse is the vendored v0.10.0 http/coverage.ts
 * beside this directory. It is how a connector released at 0.10.0 words the
 * coverage block the CURRENT hub sends (server/test/coverage-compat-0.10.test.ts).
 * Never edit the code below: it is the old client, not ours.
 *
 * ── v0.10.0 header (shortened) ──────────────────────────────────────────────
 * The coverage qualifier as one line (03 §3.3, §3.4, §5.3).
 *
 *   `coverageClause` — the HARD empty-result rule (AT-1). An empty answer may
 *   not stand alone while `agent_event` or `git` is anything but `complete`,
 *   `unknown` included.
 *
 *   `coverageNote` — the SOFT annotation rule (AT-9, Nick's decision 4). On a
 *   NON-EMPTY answer it renders only on `incomplete`, a positively observed
 *   gap, and returns null otherwise.
 */
import { MAX_COVERAGE_LINE_CHARS } from "../../../../../src/constants.ts";
import { formatAge } from "../../../../../src/briefing/age.ts";
import { coverageStateOf } from "../http/coverage.ts";
import type {
  CoverageRecord,
  CoverageSourceRecord,
} from "../http/coverage.ts";

/**
 * Minute precision, and the seconds are dropped on purpose: AT-1's own
 * sentence names "Friday 08:13", nobody acts on the second a heartbeat
 * stopped, and every character here is spent against a 160-char bound that
 * makes this line uncuttable in the briefing.
 */
const instant = (iso: string | null): string | null => {
  if (iso === null) {
    return null;
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return null;
  }
  return `${new Date(ms).toISOString().slice(0, 16)}Z`;
};

const parenthetical = (parts: readonly (string | null)[]): string => {
  const kept = parts.filter((part): part is string => part !== null);
  return kept.length === 0 ? "" : ` (${kept.join(", ")})`;
};

const ageSince = (iso: string | null, now: Date): string | null => {
  if (iso === null) {
    return null;
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return null;
  }
  return formatAge(Math.max(0, now.getTime() - ms));
};

const agedSince = (iso: string | null, now: Date): string | null => {
  const age = ageSince(iso, now);
  return age === null ? null : `${age} ago`;
};

const rowOf = (
  record: CoverageRecord,
  source: "agent_event" | "git",
): CoverageSourceRecord | undefined =>
  record.sources.find((entry) => entry.source === source);

const scopeSubject = (record: CoverageRecord): string =>
  (record.scope?.paths?.length ?? 0) > 0
    ? "on these files"
    : "on this repo";

const scopeWindow = (record: CoverageRecord, now: Date): string | null => {
  const since = record.scope?.sinceIso;
  return since === undefined ? null : ageSince(since, now);
};

/**
 * The two `incomplete` reasons the sentence names in a word. A reason with no
 * word here still renders its instant and its age — the parenthetical simply
 * carries one fact instead of two.
 */
const INCOMPLETE_LABELS: Record<string, string> = {
  session_reaped: "reaped",
  session_silent: "unclosed",
};

const agentEventFragment = (
  record: CoverageRecord,
  row: CoverageSourceRecord | undefined,
  now: Date,
  ages: boolean,
): string | null => {
  if (row === undefined) {
    return null;
  }
  const when = instant(row.gapSince);
  const subject = scopeSubject(record);
  const quiet =
    when === null
      ? `agent sessions ${subject} went quiet`
      : `agent sessions ${subject} went quiet ${when}`;
  switch (row.state) {
    case "complete":
      return "agent sessions reported";
    case "incomplete":
      // The age first, the reason second: a reader scanning fourteen days of
      // briefings after ONE over-fired reap sees the same instant every day,
      // and only the age says the fact is ageing rather than recurring.
      return `${quiet}${parenthetical([
        ages ? agedSince(row.gapSince, now) : null,
        INCOMPLETE_LABELS[row.reason] ?? null,
      ])}`;
    case "unknown": {
      if (row.reason === "hub_did_not_report") {
        return null;
      }
      // The window is the other half of "nothing matched": a caller who asked
      // about the last hour is told about the last hour.
      const age = scopeWindow(record, now);
      return age === null
        ? `no agent session reported ${subject}`
        : `no agent session reported ${subject} in the last ${age}`;
    }
    default:
      return null;
  }
};

const gitFragment = (
  row: CoverageSourceRecord | undefined,
  now: Date,
  ages: boolean,
): string | null => {
  if (row === undefined) {
    return null;
  }
  switch (row.state) {
    case "complete":
      return "git evidence reported";
    case "incomplete": {
      if (row.reason === "evidence_stale") {
        // An age with no instant to pair with. It is still an age, so the
        // reduced sentence drops it too: either every time in this sentence
        // is a relative age, or none is — never one of each.
        const age = ages ? ageSince(row.observedAt, now) : null;
        return age === null
          ? "git evidence is stale"
          : `git evidence last collected ${age} ago`;
      }
      const since = instant(row.gapSince);
      // Same rule as the rung above it: the instant, and the age beside it,
      // so the two halves of one sentence can be compared without arithmetic.
      return since === null
        ? "commit authors with no reported session"
        : `commit authors with no reported session since ${since}${parenthetical([ages ? agedSince(row.gapSince, now) : null])}`;
    }
    case "unknown":
      return row.reason === "hub_did_not_report"
        ? null
        : "no commit evidence on this repo";
    default:
      return null;
  }
};

const RESERVED_NOUNS: Record<string, string> = {
  ci: "ci lanes",
  runtime: "runtime signals",
  human_edit: "human edits",
};

const RESERVED_REASONS: Record<string, string> = {
  ci_lanes_missing: "ci lanes did not all report",
  ci_awaiting_rerun: "ci lanes awaiting rerun",
  ci_not_reported_yet: "ci has not reported yet",
};

const reservedFragment = (row: CoverageSourceRecord): string | null => {
  if (row.state === "complete" || row.state === "unavailable") {
    return null;
  }
  const named = RESERVED_REASONS[row.reason];
  if (named !== undefined) {
    return named;
  }
  const noun = RESERVED_NOUNS[row.source] ?? row.source;
  return row.state === "incomplete"
    ? `${noun} did not all report`
    : `${noun} not reported`;
};

const headOf = (record: CoverageRecord): string => {
  const readable = record.sources.filter((row) => row.state !== "unavailable");
  if (readable.length === 0) {
    return "Coverage unknown";
  }
  if (readable.some((row) => row.state === "incomplete")) {
    return "Coverage incomplete";
  }
  return readable.some((row) => row.state === "unknown")
    ? "Coverage unknown"
    : "Coverage complete";
};

const HUB_SILENT = "Coverage unknown: no coverage report this client can read.";

export const COVERAGE_HUB_UNREACHABLE =
  "could not reach the hub, so nothing here says what was watched";

export const HUB_UNREACHABLE_CLAUSE = `Coverage unknown: ${COVERAGE_HUB_UNREACHABLE}.`;

const fit = (head: string, fragments: readonly string[]): string => {
  const kept: string[] = [];
  for (const fragment of fragments) {
    const candidate = `${head}: ${[...kept, fragment].join("; ")}.`;
    if (candidate.length > MAX_COVERAGE_LINE_CHARS) {
      break;
    }
    kept.push(fragment);
  }
  const line = kept.length === 0 ? `${head}.` : `${head}: ${kept.join("; ")}.`;
  return line.length <= MAX_COVERAGE_LINE_CHARS
    ? line
    : `${line.slice(0, MAX_COVERAGE_LINE_CHARS - 1)}.`;
};

const fragmentsOf = (
  record: CoverageRecord,
  now: Date,
  ages: boolean,
): readonly string[] => {
  const reserved = record.sources
    .filter((row) => row.source !== "agent_event" && row.source !== "git")
    .map(reservedFragment);
  return [
    agentEventFragment(record, rowOf(record, "agent_event"), now, ages),
    gitFragment(rowOf(record, "git"), now, ages),
    ...reserved,
  ].filter((fragment): fragment is string => fragment !== null);
};

const holdsEvery = (head: string, fragments: readonly string[]): boolean =>
  `${head}: ${fragments.join("; ")}.`.length <= MAX_COVERAGE_LINE_CHARS;

export const coverageClause = (record: CoverageRecord, now: Date): string => {
  if (
    record.sources.length > 0 &&
    record.sources.every((row) => row.reason === "hub_did_not_report")
  ) {
    return HUB_SILENT;
  }
  const head = headOf(record);
  const aged = fragmentsOf(record, now, true);
  return fit(head, holdsEvery(head, aged) ? aged : fragmentsOf(record, now, false));
};

export const coverageNote = (
  record: CoverageRecord,
  now: Date,
): string | null =>
  record.sources.some((row) => row.state === "incomplete")
    ? coverageClause(record, now)
    : null;

/** True when §5.1's HARD rule binds: an empty answer may not stand alone. */
export const mustQualifyEmptyAnswer = (record: CoverageRecord): boolean =>
  coverageStateOf(record, "agent_event") !== "complete" ||
  coverageStateOf(record, "git") !== "complete";
