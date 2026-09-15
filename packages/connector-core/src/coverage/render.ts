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
 * The head word is the WORST state among the rungs that can be read. A rung
 * that cannot exist never drags the head: with `runtime` permanently
 * `unavailable`, an "unavailable" head would be the permanent state of every
 * answer and would say nothing. The three refused rungs are printed by name
 * in `crosscheck doctor` instead, once, where somebody can act on them.
 */
const headOf = (record: CoverageRecord): string => {
  const readable = record.sources.filter((row) => row.state !== "unavailable");
  if (readable.some((row) => row.state === "incomplete")) {
    return "Coverage incomplete";
  }
  return readable.some((row) => row.state === "unknown")
    ? "Coverage unknown"
    : "Coverage complete";
};

const HUB_SILENT = "Coverage unknown: this hub does not report coverage.";

/** Belt and braces on the bound the briefing's uncuttable seat rests on. */
const fit = (line: string): string =>
  line.length <= MAX_COVERAGE_LINE_CHARS
    ? line
    : `${line.slice(0, MAX_COVERAGE_LINE_CHARS - 1)}.`;

export const coverageClause = (record: CoverageRecord, now: Date): string => {
  if (
    record.sources.length > 0 &&
    record.sources.every((row) => row.reason === "hub_did_not_report")
  ) {
    return HUB_SILENT;
  }
  const fragments = [
    agentEventFragment(rowOf(record, "agent_event")),
    gitFragment(rowOf(record, "git"), now),
  ].filter((fragment): fragment is string => fragment !== null);
  const head = headOf(record);
  return fit(
    fragments.length === 0 ? `${head}.` : `${head}: ${fragments.join("; ")}.`,
  );
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
