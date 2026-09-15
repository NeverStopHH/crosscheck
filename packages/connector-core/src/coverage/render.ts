/**
 * The coverage qualifier as one line (03 §3.3, §3.4, §5.3).
 *
 * NO AUTHOR-WRITTEN STRING REACHES THIS OUTPUT, which is what lets the line
 * land on every answer surface without adding an untrusted slot to any of
 * them. `state` and `reason` are enums; `gapSince` and `observedAt` are
 * strings the HUB sent and are therefore never printed through — each is
 * parsed and re-formatted from the parsed instant, so a hub that sends prose
 * where an ISO belongs loses the instant and never the sentence. The whole
 * injection corpus is planted in both fields in test/coverage-render.test.ts,
 * because a claim of "no untrusted slot here" is exactly the claim that
 * should not be taken on trust.
 *
 * TWO FUNCTIONS, BECAUSE §5.1 HAS TWO RULES.
 *
 *   `coverageClause` — the HARD empty-result rule (AT-1). An empty answer may
 *   not stand alone while `agent_event` or `git` is anything but `complete`,
 *   `unknown` included. It always returns a sentence, including the good one:
 *   "nothing matched, and we WERE watching" is a stronger answer than
 *   "nothing matched", and one code path is harder to get wrong than two.
 *
 *   `coverageNote` — the SOFT annotation rule (AT-9, Nick's decision 4). On a
 *   NON-EMPTY answer it renders only on `incomplete`, a positively observed
 *   gap, and returns null otherwise. Not on `unknown`: that is the ordinary
 *   state of a fresh install, and a caveat on every answer is the noise that
 *   teaches people to ignore caveats (cli/src/cli/doctor.ts:1322-1325).
 *   `unknown` still reaches doctor and `crosscheck status` every time, so no
 *   state is invisible.
 *
 * PHRASING INHERITED VERBATIM from server/src/services/absences.ts:89-99: a
 * factual observation, never an inference about what somebody did. We see
 * agent sessions, not keystrokes.
 */
import { MAX_COVERAGE_LINE_CHARS } from "../constants.ts";
import { formatAge } from "../briefing/render.ts";
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

const rowOf = (
  record: CoverageRecord,
  source: "agent_event" | "git",
): CoverageSourceRecord | undefined =>
  record.sources.find((entry) => entry.source === source);

const agentEventFragment = (
  row: CoverageSourceRecord | undefined,
): string | null => {
  if (row === undefined) {
    return null;
  }
  const when = instant(row.gapSince);
  const quiet =
    when === null
      ? "agent sessions on this repo went quiet"
      : `agent sessions on this repo went quiet ${when}`;
  switch (row.state) {
    case "complete":
      return "agent sessions reported";
    case "incomplete":
      return row.reason === "session_reaped"
        ? `${quiet} (reaped)`
        : row.reason === "session_silent"
          ? `${quiet} (unclosed)`
          : quiet;
    case "unknown":
      return row.reason === "hub_did_not_report"
        ? null
        : "no agent session reported on this repo";
    default:
      return null;
  }
};

const gitFragment = (
  row: CoverageSourceRecord | undefined,
  now: Date,
): string | null => {
  if (row === undefined) {
    return null;
  }
  switch (row.state) {
    case "complete":
      return "git evidence reported";
    case "incomplete": {
      if (row.reason === "evidence_stale") {
        const age = ageSince(row.observedAt, now);
        return age === null
          ? "git evidence is stale"
          : `git evidence last collected ${age} ago`;
      }
      const since = instant(row.gapSince);
      return since === null
        ? "commit authors with no reported session"
        : `commit authors with no reported session since ${since}`;
    }
    case "unknown":
      return row.reason === "hub_did_not_report"
        ? null
        : "no commit evidence on this repo";
    default:
      return null;
  }
};

/**
 * THE RUNGS 05 AND LATER OWN, so that a rung which can set the head word can
 * also appear in the sentence. `headOf` reads all five; the body read two, so
 * `ci`, `runtime` and `human_edit` could each turn the head to "incomplete"
 * over a body that said nothing was missing — and by decision 2 that sentence
 * is the first, uncuttable line of every SessionStart briefing for as long as
 * the gap lasts. A caveat a reader cannot reconcile reads as a crosscheck
 * bug, which is how the next real one gets skipped.
 *
 * Only a rung that can DRAG the head is rendered: `complete` and `unavailable`
 * say nothing the head does not already say, and every character here is spent
 * against the 160 the briefing seat rests on.
 */
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

/**
 * The head word is the WORST state among the rungs that can be read. A rung
 * that cannot exist never drags the head: with `runtime` permanently
 * `unavailable`, an "unavailable" head would be the permanent state of every
 * answer and would say nothing. The three refused rungs are printed by name
 * in `crosscheck doctor` instead, once, where somebody can act on them.
 *
 * AND AN EMPTY READABLE SET IS `unknown`, NEVER `complete`. Filtering
 * `unavailable` out and then asking `.some()` twice answers false twice over
 * nothing, and falling through to "Coverage complete" is a pass produced from
 * zero evidence — AT-10's "no fake pass" in one line, and the state on which
 * `mustQualifyEmptyAnswer` says the opposite.
 */
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

/**
 * WHAT THIS CLIENT HOLDS, NOT WHAT THE HUB IS. A record whose every row reads
 * `hub_did_not_report` is reached four ways: a hub too old to send coverage, a
 * hub NEWER than this client whose `reason` values its enum does not know, a
 * body that failed to parse, and an HTTP error. "This hub does not report
 * coverage" named only the first — a claim about the hub's VERSION produced
 * from this client's own failure to read an answer, which sends a reader to
 * upgrade something that may be perfectly current.
 */
const HUB_SILENT = "Coverage unknown: no coverage report this client can read.";

/**
 * The fifth way, and the one that must never wear the sentence above: the hub
 * was not reached at all. That is a statement about the NETWORK, and the
 * caller knows which it has — `HubResult` carries `kind: "network"`. Shared
 * between `crosscheck status` and `crosscheck doctor` so the two cannot
 * describe one unreachable hub in two ways; doctor appends the connection
 * cause, which is the remedy channel status does not have.
 */
export const COVERAGE_HUB_UNREACHABLE =
  "could not reach the hub, so nothing here says what was watched";

export const HUB_UNREACHABLE_CLAUSE = `Coverage unknown: ${COVERAGE_HUB_UNREACHABLE}.`;

/**
 * The bound the briefing's uncuttable seat rests on, spent in PRIORITY ORDER.
 * Fragments are added while they fit and dropped whole once they do not, so a
 * long sentence loses a trailing clause rather than half a word — and the two
 * rungs that decide judging are first in the list, so they are the last to go.
 * The head word survives every cut, because it is the part a reader acts on.
 */
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

export const coverageClause = (record: CoverageRecord, now: Date): string => {
  if (
    record.sources.length > 0 &&
    record.sources.every((row) => row.reason === "hub_did_not_report")
  ) {
    return HUB_SILENT;
  }
  const reserved = record.sources
    .filter((row) => row.source !== "agent_event" && row.source !== "git")
    .map(reservedFragment);
  const fragments = [
    agentEventFragment(rowOf(record, "agent_event")),
    gitFragment(rowOf(record, "git"), now),
    ...reserved,
  ].filter((fragment): fragment is string => fragment !== null);
  return fit(headOf(record), fragments);
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
