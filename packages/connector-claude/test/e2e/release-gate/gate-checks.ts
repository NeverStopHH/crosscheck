/**
 * What the release gate's assertions read, shared by every case and every
 * profile: what a person was shown, what an agent was told AS A COLLISION,
 * what "silent" means for a negative control, what the hub answered Mike's
 * own tripwire asks, and — for the loaded lane — what a connector BOOKED.
 */
import { GHOST_SECTION_HEADER } from "@crosscheck/connector-core/briefing/ghost.ts";

import { agentTexts, personLines } from "./host.ts";
import type { HookRun, HostSession } from "./host.ts";
import type { TestHub } from "./hub.ts";
import type { Booking, Moment } from "./observe.ts";
import { conferenceOverlaps, ghostRows } from "./team.ts";
import type { ConferenceOverlap, GateDeveloper, GhostRow } from "./team.ts";

/** A whole case — hundreds of real hook runs against a real hub — per beforeAll. */
export const CASE_TIMEOUT_MS = 600_000;

/** The sweep threshold the pilot tripped (server GHOST_MAX_CONTEXT_TARGETS). */
export const SWEEP_TARGETS = 50;
export const COVERAGE_SOURCE_ORDER = ["agent_event", "git", "ci", "runtime", "human_edit"];
/** Sources no emitter in these scenarios feeds: never `complete`. */
export const SOURCES_WITHOUT_EMITTER = new Set(["ci", "runtime", "human_edit"]);

export const mentions = (texts: readonly string[], needle: string): boolean => texts.some((text) => text.includes(needle));

/** A PostToolUse/PreToolUse run on a file whose path ends with `suffix`. */
export const runsOn = (runs: readonly HookRun[], suffix: string, event: HookRun["event"]): readonly HookRun[] =>
  runs.filter((run) => run.event === event && run.filePath?.endsWith(suffix) === true);

/** The `- …` lines under a briefing's ghost header: the briefing's collision rows. */
const ghostLines = (texts: readonly string[]): readonly string[] =>
  texts.flatMap((text) => {
    const lines = text.split("\n");
    const at = lines.findIndex((line) => line.includes(GHOST_SECTION_HEADER));
    if (at === -1) {
      return [];
    }
    const rest = lines.slice(at + 1);
    const end = rest.findIndex((line) => !line.startsWith("- "));
    return end === -1 ? rest : rest.slice(0, end);
  });

/** What an agent is told AS A COLLISION: tripwire output, and the ghost rows of a briefing — never the presence list. */
export const collisionTextsFor = (runs: readonly HookRun[]): readonly string[] => [
  ...agentTexts(runs.filter((run) => run.event === "PreToolUse")),
  ...ghostLines(agentTexts(runs.filter((run) => run.event !== "PreToolUse"))),
];

/** A field that states how big the teammate's change is (never the shared count, never an identity). */
const SIZE_KEY = /size|large|sweep|surface|breadth|contextTarget|targetTotal|totalTargets|fileCount|touched/i;
/** A field that labels the overlap. */
const QUALIFIER_KEY = /qualif|label|kind|note|scale|class|reason/i;
export const LARGE_WORD = /\b(large|sweep|broad|wide|bulk)\b/i;

const flatten = (value: unknown, prefix = ""): readonly (readonly [string, unknown])[] =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) => flatten(inner, `${prefix}${key}.`))
    : [[prefix.slice(0, -1), value]];

/**
 * "Qualified as a large change", whatever the spelling Sweep ≠ Ignore picks:
 * a size field over the sweep threshold (or true), or a qualifier field that
 * says so in words. Titles, branches, names and ids are never read — a repo
 * or branch that happens to contain "sweep" qualifies nothing.
 */
export const isQualifiedAsLarge = (row: Readonly<Record<string, unknown>>): boolean =>
  flatten(row).some(([key, value]) => {
    const leaf = key.split(".").at(-1) ?? key;
    const isSize = SIZE_KEY.test(leaf) && leaf !== "sharedTargetCount";
    return (
      (isSize && ((typeof value === "number" && value > SWEEP_TARGETS) || value === true)) ||
      (QUALIFIER_KEY.test(leaf) && typeof value === "string" && LARGE_WORD.test(value))
    );
  });

export const nickRows = (rows: readonly GhostRow[]): readonly GhostRow[] => rows.filter((row) => row.developerName === "Nick");

/**
 * SILENT, as the negative controls mean it: no line a person is shown names a
 * teammate, no tripwire output (ask or notice, any thread) names one, no
 * briefing carries a ghost section, no statusline shows an overlap. The hub's
 * own overlap rows are checked beside this, per case.
 */
export const collisionNoise = (
  sessions: readonly HostSession[],
  teammates: readonly string[],
  statuslines: readonly string[],
): Readonly<Record<string, readonly string[]>> => {
  const runs = sessions.flatMap((session) => session.runs());
  const namesTeammate = (text: string): boolean => teammates.some((name) => text.includes(name));
  return {
    personLines: personLines(runs).filter(namesTeammate),
    tripwire: agentTexts(runs.filter((run) => run.event === "PreToolUse")).filter(namesTeammate),
    briefingGhosts: agentTexts(runs.filter((run) => run.event !== "PreToolUse")).filter((text) => text.includes(GHOST_SECTION_HEADER)),
    statuslines: statuslines.filter((line) => line.includes("overlap")),
  };
};

export const SILENT = { personLines: [], tripwire: [], briefingGhosts: [], statuslines: [] };

export interface OverlapRows {
  readonly ghost: readonly GhostRow[];
  readonly conference: readonly ConferenceOverlap[];
}

/** Every overlap row the hub would show any of `readers` on `repo`. */
export const overlapRows = async (on: TestHub, readers: readonly GateDeveloper[], repo: string): Promise<OverlapRows> => ({
  ghost: (await Promise.all(readers.map(async (reader) => ghostRows(on, reader, repo)))).flat(),
  conference: (await Promise.all(readers.map(async (reader) => conferenceOverlaps(on, reader, repo)))).flat(),
});

export interface CoverageRow {
  readonly source: string;
  readonly state: string;
  readonly reason: string;
}

export interface TripwireAnswer {
  readonly sessions: number;
  readonly sources: readonly CoverageRow[];
}

/** Every tripwire answer `developer`'s hooks got on `repo`, as the hub sent it. */
export const tripwireAnswers = (hub: TestHub, developer: string, repo: string): readonly TripwireAnswer[] =>
  hub.wire
    .filter(
      (entry) =>
        entry.developer === developer &&
        entry.path.startsWith("/api/hints/tripwire") &&
        entry.path.includes(encodeURIComponent(repo)),
    )
    .map((entry) => {
      const data = (JSON.parse(entry.responseBody) as {
        data: { sessions: readonly unknown[]; coverage: { sources: readonly CoverageRow[] } };
      }).data;
      return { sessions: data.sessions.length, sources: data.coverage.sources };
    });

export const agentEventOf = (answer: TripwireAnswer): CoverageRow | undefined =>
  answer.sources.find((row) => row.source === "agent_event");

/**
 * Every hook process of `sessions` that crashed (a hook binary always exits
 * 0) or hung until it was killed — none, under every profile. A case whose
 * hooks crashed has not run the scenario its assertions read, so this is a
 * plain setup test beside every case: an expected failure can never be a
 * crash in disguise.
 */
export const crashedHooks = (sessions: readonly HostSession[]): readonly string[] =>
  sessions
    .flatMap((session) => session.runs())
    .filter((run) => run.wasKilled || (run.exitCode !== null && run.exitCode !== 0))
    .map((run) => `${run.developer} ${run.hook} [${run.label}] ${run.wasKilled ? "killed" : `exit ${String(run.exitCode)}`}`);

/** The count in a statusline's `overlap: <who> · N files`, or 0 when it shows none. */
export const overlapFileCount = (statusline: string): number => {
  const match = /overlap: [^·]*· (\d+) files?/.exec(statusline);
  return match === null ? 0 : Number(match[1]);
};

/** A kind that names an edit's collision warning itself: a tripwire cut or unanswered, a collision or relay lost. */
const COLLISION_WARNING_KIND = /^(tripwire|collision|relay)_/;

/**
 * Bookings that SAY WHY a person was not told of a collision in `moment`:
 * booked inside it, and of a kind that names the warning itself — what a
 * connector books when an edit's tripwire was cut or went unanswered
 * (`tripwire_…`), or a collision or relay was lost. Nothing else says that:
 * not `rest_unchecked` (a warning that DID reach the person, whose recheck
 * could not run), not a capture timeout, a spool drop or an allocation
 * failure (a record lost, not a warning), not a landed-probe cut (the
 * review's H2(b) mislabel: "the landed check was cut" where a collision
 * warning was lost), not a briefing omission (the opening briefing, not an
 * edit's warning). On 5a544fff no connector books such a kind, so today the
 * loaded lane's "or booked" accepts nothing the production lane rejects.
 */
export const collisionBookings = (bookings: readonly Booking[], moment: Moment): readonly Booking[] =>
  bookings.filter(
    (booking) =>
      booking.at !== null && booking.at >= moment.from && booking.at <= moment.to && COLLISION_WARNING_KIND.test(booking.kind),
  );
