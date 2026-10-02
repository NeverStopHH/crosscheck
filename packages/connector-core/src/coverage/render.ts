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
 *   `unknown` included. It always returns A SENTENCE, for any record it is
 *   handed; WHEN an empty answer carries one is `mustQualifyEmptyAnswer`'s
 *   call at the bottom of this file, and the answer surfaces ask it (see
 *   mcp/render.ts `coverageQualifier`). Under `complete` they print nothing,
 *   because the unqualified sentence has already said it: "No work context ON
 *   THIS REPO matched" is a claim about the repository, which the gapped
 *   branch may not make. `crosscheck status` is the exception and prints on
 *   every state — every other line of that command does too, and AT-9 names
 *   it as the surface nobody should have to run doctor after.
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

/** How an instant is printed: to the minute, to the day, or not at all. */
type InstantForm = "minute" | "day" | "none";

/** `2026-09-05T08:13` and `2026-09-05`: the prefixes of an ISO instant each form keeps. */
const MINUTE_PREFIX_CHARS = 16;
const DAY_PREFIX_CHARS = 10;

/**
 * Minute precision, and the seconds are dropped on purpose: AT-1's own
 * sentence names "Friday 08:13", nobody acts on the second a heartbeat
 * stopped, and every character here is spent against the 160-char bound of
 * a line in the briefing's uncuttable seat. The day form is the shorter
 * instant a full line spends first (decided by Nick, 2026-10-02) — on the git
 * rung only: the agent rung's minute is COV-1's.
 */
const instant = (iso: string | null, form: InstantForm): string | null => {
  if (iso === null || form === "none") {
    return null;
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return null;
  }
  const stamp = new Date(ms).toISOString();
  return form === "day" ? stamp.slice(0, DAY_PREFIX_CHARS) : `${stamp.slice(0, MINUTE_PREFIX_CHARS)}Z`;
};

/**
 * ONE WAY TO WRITE THE SENTENCE. What a full line may shed, and nothing else:
 * the reaped/unclosed label and the git rung's instant (and its age with it).
 * The agent rung's minute (COV-1), its age (COV-11), every rung and the order
 * block's state and reason are in every form.
 */
interface LineForm {
  readonly labels: boolean;
  readonly gitInstant: InstantForm;
}

/**
 * Trailing qualifiers, joined once: `(10d ago, reaped)` rather than one
 * parenthetical per fact.
 *
 * THE INSTANT AND ITS AGE, BECAUSE EVERY LINE BESIDE IT IS AN AGE. This is
 * the only line in the briefing that prints a machine timestamp, and it
 * printed BOTH conventions inside one sentence: an ISO for the rung that went
 * quiet and "9d ago" for the rung beside it. A reader comparing the two had
 * to convert one by hand, on the line §5.3 makes uncuttable because it says
 * how far everything under it can be trusted.
 *
 * The instant is NOT dropped — COV-1 requires `2026-09-05T08:13Z` in the
 * output, and an absolute instant is what somebody greps a log for. The age
 * is ADDED beside it, in the parenthetical that already carried the reason,
 * so one sentence answers "when" and "how long ago" in one reading. Empty in,
 * nothing out: an unparseable instant costs the age, never the sentence.
 */
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

/**
 * WHAT THE RECORD IS ABOUT, in the sentence rather than only in the data.
 *
 * §3.2a lets a caller narrow the question: `/api/search` passes the caller's
 * own `since` and the pin lane passes a file set. The hub's record is honest
 * about it — the reason says `no_session_in_window` and `scope` carries both
 * — and a renderer that dropped the scope said "no agent session reported on
 * this repo" about a busy, fully-watched repo somebody had asked a one-hour
 * question about. Fail-safe direction, still a statement nobody observed, and
 * it fires "Coverage unknown" on ordinary short-window searches.
 *
 * An UNSCOPED record reads exactly as it did: the briefing and doctor pass
 * nothing and get the repo-wide answer (§3.2a).
 */
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

/**
 * THE TWO LOSS REASONS (docs/1.0/loss-accounting.md §4.6) open the sentence
 * differently: a session that went QUIET and a session that LOST records are
 * two facts, and the second is the one the connector wrote down itself. The
 * subject is always "on this repo", never "on these files", even under a
 * file-set scope — a loss is repo-wide by construction (the ledger keeps no
 * paths), and narrowing the sentence to the pinned files would claim a
 * precision the data does not have. No count: coverage carries none.
 */
const lossOpening = (reason: string, when: string | null): string | null => {
  const since = when === null ? "" : ` since ${when}`;
  switch (reason) {
    case "telemetry_lost":
      return `agent telemetry on this repo was lost${since}`;
    case "record_kinds_ignored":
      return `the hub ignored agent record kinds on this repo${since}`;
    default:
      return null;
  }
};

const agentEventFragment = (
  record: CoverageRecord,
  row: CoverageSourceRecord | undefined,
  now: Date,
  form: LineForm,
): string | null => {
  if (row === undefined) {
    return null;
  }
  const when = instant(row.gapSince, "minute");
  const subject = scopeSubject(record);
  const quiet =
    when === null
      ? `agent sessions ${subject} went quiet`
      : `agent sessions ${subject} went quiet ${when}`;
  switch (row.state) {
    case "complete":
      return "agent sessions reported";
    case "incomplete": {
      const age = agedSince(row.gapSince, now);
      const loss = lossOpening(row.reason, when);
      if (loss !== null) {
        return `${loss}${parenthetical([age])}`;
      }
      // The age first, the reason second: a reader scanning fourteen days of
      // briefings after ONE over-fired reap sees the same instant every day,
      // and only the age says the fact is ageing rather than recurring.
      return `${quiet}${parenthetical([
        age,
        form.labels ? (INCOMPLETE_LABELS[row.reason] ?? null) : null,
      ])}`;
    }
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

/**
 * The git rung. Its instant is the first thing a full line shortens (to the
 * day), and the last thing it sheds before a second line: the rung keeps its
 * words either way.
 */
const gitFragment = (
  row: CoverageSourceRecord | undefined,
  now: Date,
  form: LineForm,
): string | null => {
  if (row === undefined) {
    return null;
  }
  switch (row.state) {
    case "complete":
      return "git evidence reported";
    case "incomplete": {
      if (row.reason === "evidence_stale") {
        // An age with no instant to pair with.
        const age = ageSince(row.observedAt, now);
        return age === null
          ? "git evidence is stale"
          : `git evidence last collected ${age} ago`;
      }
      const since = instant(row.gapSince, form.gitInstant);
      // Same rule as the rung above it: the instant, and the age beside it,
      // so the two halves of one sentence can be compared without arithmetic.
      return since === null
        ? "commit authors with no reported session"
        : `commit authors with no reported session since ${since}${parenthetical([agedSince(row.gapSince, now)])}`;
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
 * WHAT THE SESSIONS IN SCOPE COULD SAY ABOUT ORDER (01a §3.7, §5): the state
 * and its reason, both enum values the parser admitted — no count, no
 * sentence, no author text. Always rendered, `guaranteed` included: the line
 * is where a reader learns whether a timing answer beside it can be trusted,
 * and silence would read as the strong case. The REASON is never dropped for
 * length either (decided by Nick, 2026-10-02): the state says THAT something
 * is missing, the reason says WHAT.
 */
const orderFragment = (record: CoverageRecord): string =>
  `order: ${record.order.state} (${record.order.reason})`;

const isPresent = (fragment: string | null): fragment is string => fragment !== null;

const reservedFragments = (record: CoverageRecord): readonly string[] =>
  record.sources
    .filter((row) => row.source !== "agent_event" && row.source !== "git")
    .map(reservedFragment)
    .filter(isPresent);

/** The two judging rungs first, then the order block, then the reserved rungs. */
const fragmentsOf = (record: CoverageRecord, now: Date, form: LineForm): readonly string[] => [
  ...[
    agentEventFragment(record, rowOf(record, "agent_event"), now, form),
    gitFragment(rowOf(record, "git"), now, form),
  ].filter(isPresent),
  orderFragment(record),
  ...reservedFragments(record),
];

/**
 * THE ORDER A FULL LINE IS SHORTENED IN (decided by Nick, 2026-10-02): the
 * timestamp format first — the git rung's minute becomes its day — then the
 * less important metadata, the reaped/unclosed label and then the git rung's
 * instant. Nothing past the last form is shed: a shape it cannot fit takes a
 * second line (`twoLines`).
 */
const LINE_FORMS: readonly LineForm[] = [
  { labels: true, gitInstant: "minute" },
  { labels: true, gitInstant: "day" },
  { labels: false, gitInstant: "day" },
  { labels: false, gitInstant: "none" },
];

const lineOf = (head: string, fragments: readonly string[]): string =>
  fragments.length === 0 ? `${head}.` : `${head}: ${fragments.join("; ")}.`;

const holds = (line: string): boolean => line.length <= MAX_COVERAGE_LINE_CHARS;

/**
 * One form as two lines: as many fragments after the head as fit the first
 * line, which ends `;`, and the rest — order block included — on the second.
 * Null when the form needs no split or the second line does not hold.
 */
const splitOf = (head: string, fragments: readonly string[]): string | null => {
  const firstCount = fragments.findIndex(
    (_fragment, index) => !holds(`${head}: ${fragments.slice(0, index + 1).join("; ")};`),
  );
  if (firstCount < 1) {
    return null;
  }
  const second = `${fragments.slice(firstCount).join("; ")}.`;
  return holds(second) ? `${head}: ${fragments.slice(0, firstCount).join("; ")};\n${second}` : null;
};

/**
 * THE LAST RESORT (decided by Nick, 2026-10-02). Every one-line form failed,
 * so the clause takes a second line rather than drop a rung, the age, the
 * agent rung's minute or the order block's reason — and with a second line
 * there is room again, so the fullest form whose split holds is the one used.
 * That some split holds is checked, not argued: coverage-render.test.ts
 * sweeps every shape of all five rungs beside the longest order block.
 */
const twoLines = (head: string, forms: readonly (readonly string[])[]): string => {
  const splits = forms.map((fragments) => splitOf(head, fragments));
  return splits.find(isPresent) ?? lineOf(head, forms[forms.length - 1] ?? []);
};

/**
 * THE AGE IS NOT DECORATION ANY MORE, AND NEITHER IS THE REASON. Both rungs
 * gapped with an instant each, beside the longest order block, is 220
 * characters against the 160 a line of the briefing seat rests on. The old
 * answer was `fit`, which drops a whole fragment — so it cut the order block,
 * then its reason (review H1, decided by Nick, 2026-10-02). Now the sentence
 * is shortened in LINE_FORMS' order and, past the last form, split.
 */
export const coverageClause = (record: CoverageRecord, now: Date): string => {
  if (
    record.sources.length > 0 &&
    record.sources.every((row) => row.reason === "hub_did_not_report")
  ) {
    return HUB_SILENT;
  }
  const head = headOf(record);
  const forms = LINE_FORMS.map((form) => fragmentsOf(record, now, form));
  const single = forms.find((fragments) => holds(lineOf(head, fragments)));
  return single === undefined ? twoLines(head, forms) : lineOf(head, single);
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
