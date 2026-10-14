/**
 * WHAT ONE RUN OF EACH GUARD COSTS ON A HOSTED RUNNER, read from the mutation
 * proof's own CI logs — the table scripts/mutation-shards.ts deals the shards
 * by (scripts/mutation-guard-seconds.json).
 *
 * WHY SECONDS AND NOT ANCHOR COUNTS: one run of a guard file took from 0.1 s
 * (a schema test) to 144 s (the spool simulation) on ubuntu-latest, median
 * 1.7 s. Dealt by count, eight shards of 487 anchors each ran 37 to more than
 * 85 minutes (CI run 38470399845).
 *
 * READ FROM THE LINES mutation-check.ts PRINTS, under GitHub's timestamps: an
 * anchor's time runs from its "· label" line to the line that says how it
 * ended ("caught by" or "NOT CAUGHT by" its guard). A guard's first anchor
 * also paid the guard's unmutated run (assertGuardIsGreen), so a guard with n
 * anchors ran n + 1 times. An anchor the log ends inside — a cancelled job, a
 * guard already red — is left out rather than guessed.
 *
 * Regenerate after the list or a slow guard changes much: download every
 * shard's log of one green run and print the table —
 *
 *   gh api repos/<owner>/<repo>/actions/jobs/<job-id>/logs > shard-<k>.log   # each shard
 *   bun run packages/connector-core/scripts/mutation-guard-times.ts "<source>" shard-*.log
 *
 * — then put what it prints in scripts/mutation-guard-seconds.json. A stale
 * table only unbalances the shards; it never changes what a shard proves.
 */
import { readFile } from "node:fs/promises";

/** A guard's anchors in one log and the seconds they took together. */
export interface GuardRuns {
  readonly anchors: number;
  readonly seconds: number;
}

/** What scripts/mutation-guard-seconds.json holds. */
export interface GuardTable {
  readonly source: string;
  readonly secondsPerRun: Readonly<Record<string, number>>;
}

const STAMPED = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (.*)$/;
const ANCHOR_START = /^· /;
const ANCHOR_END = /(?:caught by|NOT CAUGHT by) (\S+)/;

/** Fractions as precise as the hundredths the table keeps. */
const HUNDREDTHS = 100;

const secondsOf = (stamp: string): number => Date.parse(stamp) / 1000;

/** Each guard's anchors and their summed seconds in one shard log. */
export const guardRunsOf = (log: string): ReadonlyMap<string, GuardRuns> => {
  const stamped = log
    .split("\n")
    .map((line) => STAMPED.exec(line.replace(/\r$/, "")))
    .filter((match) => match !== null);
  if (stamped.length === 0) {
    throw new Error("no line carries GitHub's timestamp: pass the job log as the API serves it");
  }
  const runs = new Map<string, GuardRuns>();
  let startedAt: number | null = null;
  for (const [, stamp, text] of stamped) {
    if (stamp === undefined || text === undefined) {
      continue;
    }
    if (ANCHOR_START.test(text)) {
      startedAt = secondsOf(stamp);
      continue;
    }
    const ended = ANCHOR_END.exec(text);
    const guard = ended?.[1];
    if (guard === undefined || startedAt === null) {
      continue;
    }
    const known = runs.get(guard) ?? { anchors: 0, seconds: 0 };
    runs.set(guard, { anchors: known.anchors + 1, seconds: known.seconds + (secondsOf(stamp) - startedAt) });
    startedAt = null;
  }
  return runs;
};

/** Seconds per run of each guard over every log: its pace in each (n anchors + the unmutated run), averaged. */
export const guardSecondsOf = (logs: readonly string[]): ReadonlyMap<string, number> => {
  const paces = new Map<string, number[]>();
  for (const log of logs) {
    for (const [guard, run] of guardRunsOf(log)) {
      paces.set(guard, [...(paces.get(guard) ?? []), run.seconds / (run.anchors + 1)]);
    }
  }
  return new Map(
    [...paces.entries()].map(([guard, each]) => [guard, each.reduce((sum, pace) => sum + pace, 0) / each.length]),
  );
};

/** The checked-in table: files sorted, seconds in hundredths and never zero. */
export const tableOf = (seconds: ReadonlyMap<string, number>, source: string): GuardTable => ({
  source,
  secondsPerRun: Object.fromEntries(
    [...seconds.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([guard, pace]) => [guard, Math.max(1, Math.round(pace * HUNDREDTHS)) / HUNDREDTHS]),
  ),
});

const main = async (): Promise<number> => {
  const [source, ...paths] = process.argv.slice(2);
  if (source === undefined || paths.length === 0) {
    process.stderr.write('usage: mutation-guard-times.ts "<where the logs came from>" <shard log>...\n');
    return 1;
  }
  const logs = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  process.stdout.write(`${JSON.stringify(tableOf(guardSecondsOf(logs), source), null, 2)}\n`);
  return 0;
};

if (import.meta.main) {
  process.exit(await main());
}
