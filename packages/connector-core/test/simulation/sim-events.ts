/**
 * The simulation's events, spelled as a scenario reads them: what the fixed
 * scenarios (test/spool-simulation.test.ts) and the seed corpus
 * (simulation/seed-corpus.ts) write their shrunk traces in.
 */
import type { SimEvent } from "./sim-world.ts";

export const start = (c: number): SimEvent => ({ kind: "start", c });
export const edit = (c: number): SimEvent => ({ kind: "edit", c });
export const end = (c: number): SimEvent => ({ kind: "end", c });
export const hubEnd = (c: number): SimEvent => ({ kind: "hubEnd", c });
export const flush = (c: number): SimEvent => ({ kind: "flush", c });
export const abandon = (c: number): SimEvent => ({ kind: "abandon", c });
export const refuseWc = (c: number): SimEvent => ({ kind: "refuseWc", c });
export const oldFlush = (c: number): SimEvent => ({ kind: "oldFlush", c });
export const intent = (c: number, status: string): SimEvent => ({ kind: "intent", c, status });
export const crash = (at: number, when: "before" | "after"): SimEvent => ({ kind: "crash", at, when });
export const fault = (
  kind: "records503" | "recordsLate" | "registersDown" | "endsLate",
  count: number,
  after: number,
): SimEvent => ({ kind: "fault", fault: kind, count, after });
export const slow = (ms: number, count: number, after: number): SimEvent => ({ kind: "fault", fault: "slow", count, after, ms });
export const par = (a: SimEvent, b: SimEvent): SimEvent => ({ kind: "par", a, b });
export const age = (c: number): SimEvent => ({ kind: "age", c });
export const NIGHT: SimEvent = { kind: "night" };
export const VACATION: SimEvent = { kind: "vacation" };
export const wake = (c: number): SimEvent => ({ kind: "wake", c });
export const recover = (c: number): SimEvent => ({ kind: "recover", c });
export const beat = (c: number): SimEvent => ({ kind: "beat", c });
export const straggle = (c: number): SimEvent => ({ kind: "straggle", c });
export const ioFail = (at: number, count: number): SimEvent => ({ kind: "ioFail", at, count });
