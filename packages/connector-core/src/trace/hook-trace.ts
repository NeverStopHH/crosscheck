/**
 * HOOK PHASE TIMING — a measurement, never a behaviour (release gate, review
 * of batch 2, M6). Claude Code waits for a SYNC hook's process to EXIT, so
 * what a developer waits for is the process's whole wall time: start, boot,
 * the budgeted race, the bookings after it, and the exit. The budget only
 * bounds the race.
 *
 * OFF unless `CX_HOOK_TRACE=1` is in the environment of a real hook process:
 * only the CLI entry installs it (`startHookTrace`), so an in-process call of
 * a hook — every test that runs one — never traces. Off, every helper below
 * is a single null check.
 *
 * ON, each hook process writes ONE JSON file when it exits, into
 * `CX_HOOK_TRACE_DIR` (default: <tmp>/crosscheck-hook-trace), named
 * `<hook>-<pid>-<start>.json`: when the process started (epoch ms), how long
 * boot took (start → the entry's first statement: runtime and module load),
 * every span by label with its start and duration (ms since process start),
 * the spans still OPEN at exit (work the budget's race abandoned), and when
 * the exit handler ran. Labels name phases and kinds only — never a path, a
 * session, a file or anything a payload carried.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const HOOK_TRACE_ENV = "CX_HOOK_TRACE";
export const HOOK_TRACE_DIR_ENV = "CX_HOOK_TRACE_DIR";
export const DEFAULT_HOOK_TRACE_DIR = join(tmpdir(), "crosscheck-hook-trace");

export interface TraceSpan {
  readonly label: string;
  /** Ms since the process started (performance.now()). */
  readonly startMs: number;
  readonly durationMs: number;
  /** Still running when the process exited: the race abandoned it. */
  readonly isOpen?: true;
}

export interface HookTrace {
  readonly hook: string;
  readonly pid: number;
  /** Epoch ms when the process started (performance.timeOrigin). */
  readonly timeOrigin: number;
  /** Process start → the entry's first statement. */
  readonly bootMs: number;
  readonly spans: readonly TraceSpan[];
  /** Process start → the exit handler. */
  readonly exitMs: number;
}

interface Sink {
  readonly hook: string;
  readonly bootMs: number;
  readonly spans: TraceSpan[];
  readonly open: Map<number, { readonly label: string; readonly startMs: number }>;
  nextId: number;
}

/** The one trace of this process, or none: a holder rather than a bare `let`. */
const holder: { current: Sink | null } = { current: null };

const writeTrace = (dir: string): void => {
  const sink = holder.current;
  if (sink === null) {
    return;
  }
  const exitMs = performance.now();
  const abandoned = [...sink.open.values()].map((span) => ({
    label: span.label,
    startMs: span.startMs,
    durationMs: exitMs - span.startMs,
    isOpen: true as const,
  }));
  const trace: HookTrace = {
    hook: sink.hook,
    pid: process.pid,
    timeOrigin: performance.timeOrigin,
    bootMs: sink.bootMs,
    spans: [...sink.spans, ...abandoned],
    exitMs,
  };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sink.hook}-${String(process.pid)}-${String(Math.round(performance.timeOrigin))}.json`), JSON.stringify(trace));
  } catch {
    // A trace that cannot be written costs the trace, never the hook: a hook
    // never fails the developer's session, and this file is a measurement.
  }
};

/** Installs this process's trace when `env` asks for it; the CLI entry's first statement for a hook. */
export const startHookTrace = (hook: string, env: Readonly<Record<string, string | undefined>>): void => {
  if (env[HOOK_TRACE_ENV] !== "1" || holder.current !== null) {
    return;
  }
  holder.current = { hook, bootMs: performance.now(), spans: [], open: new Map(), nextId: 0 };
  const dir = env[HOOK_TRACE_DIR_ENV] ?? DEFAULT_HOOK_TRACE_DIR;
  process.on("exit", () => {
    writeTrace(dir);
  });
};

/** Starts a span; the returned function ends it. A no-op when no trace is installed. */
export const traceBegin = (label: string): (() => void) => {
  const sink = holder.current;
  if (sink === null) {
    return () => undefined;
  }
  const id = sink.nextId;
  sink.nextId += 1;
  const startMs = performance.now();
  sink.open.set(id, { label, startMs });
  return () => {
    sink.open.delete(id);
    sink.spans.push({ label, startMs, durationMs: performance.now() - startMs });
  };
};

/** `run`, timed as `label`. */
export const traceSpan = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
  const end = traceBegin(label);
  try {
    return await run();
  } finally {
    end();
  }
};

/** An instant, as a zero-length span. */
export const traceMark = (label: string): void => {
  traceBegin(label)();
};
