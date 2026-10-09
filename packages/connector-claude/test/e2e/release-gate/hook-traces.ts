/**
 * WHERE A HOOK'S WALL TIME GOES, from the gate's side — for a run made with
 * CX_HOOK_TRACE=1 (connector-core trace/hook-trace.ts). Each hook process the
 * process host started is joined to its trace file by pid (and by its start
 * falling between the host's spawn and the exit it saw), and its wall time —
 * what Claude Code waits for on a sync hook — is split into phases that add up:
 *
 *   start      the host's spawn → the process's own start (exec, scheduling)
 *   boot       the process's start → the entry's first statement (runtime, module load)
 *   stdin      reading the payload
 *   budget     resolving the hook's budget (a config read)
 *   race       the budgeted race: repo identity and the handler (inside it,
 *              the lock waits, hub requests, git spawns and flush are summed
 *              as busy time; they overlap where the hook runs them at once)
 *   post-race  the bookings after the race, the fired marker
 *   exit       the hook's return → its exit handler (writing stdout, exit)
 *   seen       its exit → the host noticing (the host's own event loop, which
 *              the in-process hub's PGlite shares)
 *
 * A measurement, nothing the gate asserts.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_HOOK_TRACE_DIR, HOOK_TRACE_DIR_ENV, HOOK_TRACE_ENV } from "@crosscheck/connector-core/trace/hook-trace.ts";
import type { HookTrace, TraceSpan } from "@crosscheck/connector-core/trace/hook-trace.ts";

import type { HookRun } from "./host.ts";

/** A trace whose start lies this far before the host's spawn stamp is still its run (clock granularity). */
const SPAWN_SLACK_MS = 50;
const PERCENTILE_P90 = 0.9;

export const isHookTraceOn = (): boolean => process.env[HOOK_TRACE_ENV] === "1";

const traceDir = (): string => process.env[HOOK_TRACE_DIR_ENV] ?? DEFAULT_HOOK_TRACE_DIR;

export const readHookTraces = async (): Promise<readonly HookTrace[]> => {
  const dir = traceDir();
  const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(".json"));
  const traces = await Promise.all(
    names.map(async (name) => {
      try {
        return [JSON.parse(await readFile(join(dir, name), "utf8")) as HookTrace];
      } catch {
        return [];
      }
    }),
  );
  return traces.flat();
};

export const PHASES = ["wall", "start", "boot", "stdin", "budget", "race", "post-race", "exit", "seen"] as const;
export const RACE_PARTS = ["prepare", "handler", "lock-wait", "hub", "git", "flush"] as const;
type Phase = (typeof PHASES)[number] | (typeof RACE_PARTS)[number];

export type Breakdown = Readonly<Record<Phase, number>> & { readonly wasCut: boolean };

const spanMs = (spans: readonly TraceSpan[], label: string): number =>
  spans.filter((span) => span.label === label).reduce((sum, span) => sum + span.durationMs, 0);

const prefixMs = (spans: readonly TraceSpan[], prefix: string): number =>
  spans.filter((span) => span.label.startsWith(prefix)).reduce((sum, span) => sum + span.durationMs, 0);

/** One hook process's wall time, phase by phase; null when it left no trace. */
export const breakdownOf = (run: HookRun, traces: readonly HookTrace[]): Breakdown | null => {
  const times = run.times;
  if (times === null) {
    return null;
  }
  const trace = traces.find(
    (candidate) =>
      candidate.pid === times.pid &&
      candidate.timeOrigin >= times.spawnedAt - SPAWN_SLACK_MS &&
      candidate.timeOrigin <= times.exitedAt,
  );
  if (trace === undefined) {
    return null;
  }
  const returnedAt = trace.spans.find((span) => span.label === "returned")?.startMs ?? trace.exitMs;
  return {
    wall: times.exitedAt - times.spawnedAt,
    start: trace.timeOrigin - times.spawnedAt,
    boot: trace.bootMs,
    stdin: spanMs(trace.spans, "stdin"),
    budget: spanMs(trace.spans, "budget"),
    race: spanMs(trace.spans, "race"),
    "post-race": spanMs(trace.spans, "post-race"),
    exit: trace.exitMs - returnedAt,
    seen: times.exitedAt - (trace.timeOrigin + trace.exitMs),
    prepare: spanMs(trace.spans, "prepare"),
    handler: spanMs(trace.spans, "handler"),
    "lock-wait": prefixMs(trace.spans, "lock-wait:"),
    hub: prefixMs(trace.spans, "hub:"),
    git: spanMs(trace.spans, "git"),
    flush: spanMs(trace.spans, "flush"),
    wasCut: trace.spans.some((span) => span.label === "race:timed-out"),
  };
};

const percentile = (values: readonly number[], share: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))] ?? 0;
};

/** `p50 / p90 / max` of each phase over `breakdowns`, one line per phase, for a log. */
export const renderBreakdowns = (title: string, breakdowns: readonly Breakdown[]): readonly string[] => {
  if (breakdowns.length === 0) {
    return [`${title}: no traced process`];
  }
  const row = (phase: Phase): string => {
    const values = breakdowns.map((breakdown) => breakdown[phase]);
    return `  ${phase.padEnd(10)} p50 ${String(Math.round(percentile(values, 0.5))).padStart(5)}  p90 ${String(Math.round(percentile(values, PERCENTILE_P90))).padStart(5)}  max ${String(Math.round(Math.max(...values))).padStart(5)} ms`;
  };
  const cut = breakdowns.filter((breakdown) => breakdown.wasCut).length;
  return [
    `${title}: ${String(breakdowns.length)} processes, ${String(cut)} cut by the budget`,
    ...PHASES.map(row),
    "  inside the race (busy time, overlapping where concurrent):",
    ...RACE_PARTS.map(row),
  ];
};
