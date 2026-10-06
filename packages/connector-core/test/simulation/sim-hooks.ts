/**
 * THE SIMULATION'S HOOKS INTO THE REAL CODE (test/spool-simulation.test.ts).
 *
 * The four writers every persisted step of the spool path goes through —
 * `writePrivateFile` and `removeFile` (state, cursor, debt, stamps, markers),
 * `appendRecords` (the spool) and `recordDrop` (the loss ledger) — are wrapped
 * for the scenario's home only. Each call is counted, and a scenario that arms
 * a crash KILLS the process at one of them: before the write lands, or right
 * after it. A dead process writes nothing more and reaches no hub (the proxy
 * reads `isDead`) until the step it died in is over. Captures, drops and debts
 * are logged as the ground truth the invariants are checked against.
 *
 * Any other home passes straight through, so the rest of the suite is untouched.
 */
import { mock } from "bun:test";
import { fileURLToPath } from "node:url";

import * as paths from "../../src/config/paths.ts";
import * as append from "../../src/spool/append.ts";
import * as drops from "../../src/spool/drops.ts";

const realWritePrivateFile = paths.writePrivateFile;
const realRemoveFile = paths.removeFile;
const realAppendRecords = append.appendRecords;
const realRecordDrop = drops.recordDrop;

const sourceOf = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export interface Crash {
  /** The hooked write, counted from 1 in the step, the process dies at. */
  readonly at: number;
  readonly when: "before" | "after";
}

/** A record a step appended to a spool: what the invariants call captured. */
export interface Captured {
  readonly id: string;
  readonly kind: string;
  readonly hostSessionKey: string;
  /** The life that wrote it, as its envelope says. */
  readonly writer: string;
  readonly step: number;
}

export interface DropCall {
  readonly slug: string;
  readonly count: number;
  readonly reason: string;
  readonly kinds: Readonly<Record<string, number>>;
  readonly causes: Readonly<Record<string, number>>;
  readonly step: number;
}

export interface DebtWrite {
  readonly slug: string;
  readonly sessionId: string;
  readonly workContextId: string;
  readonly step: number;
}

export class SimulatedCrash extends Error {
  constructor() {
    super("simulated crash");
  }
}

interface HookState {
  home: string | null;
  step: number;
  crash: Crash | null;
  writes: number;
  dead: boolean;
  /** The process died right after a ledger append: the one over-count the design accepts. */
  diedAfterDrop: boolean;
  /** A ledger append landed earlier in the step that died: a cursor write it waited for may be lost. */
  droppedThisStep: boolean;
  captured: Captured[];
  drops: DropCall[];
  debts: DebtWrite[];
}

const state: HookState = {
  home: null,
  step: 0,
  crash: null,
  writes: 0,
  dead: false,
  diedAfterDrop: false,
  droppedThisStep: false,
  captured: [],
  drops: [],
  debts: [],
};

const isScenarioPath = (path: string): boolean => state.home !== null && path.startsWith(state.home);

/**
 * One hooked write: `landed` logs what it wrote, the moment it lands — before
 * a crash right after it, too, since the bytes are on disk either way.
 */
const guarded = async <T>(
  path: string,
  isDrop: boolean,
  act: () => Promise<T>,
  landed: (result: T) => void = () => undefined,
): Promise<T> => {
  if (!isScenarioPath(path)) {
    return act();
  }
  if (state.dead) {
    throw new SimulatedCrash();
  }
  state.writes += 1;
  if (process.env["SIM_TRACE_WRITES"] === "1") {
    console.log(`[sim-write] step ${String(state.step)} #${String(state.writes)} ${path.slice(state.home?.length ?? 0)}`);
  }
  const dies = state.crash !== null && state.writes === state.crash.at;
  if (dies && state.crash?.when === "before") {
    state.dead = true;
    throw new SimulatedCrash();
  }
  const result = await act();
  landed(result);
  if (dies) {
    state.dead = true;
    state.diedAfterDrop = isDrop;
    throw new SimulatedCrash();
  }
  return result;
};

const DEBT_SUFFIX = ".owed-wc";

const logDebt = (path: string, content: string): void => {
  if (!isScenarioPath(path) || !path.endsWith(DEBT_SUFFIX)) {
    return;
  }
  try {
    const owed = JSON.parse(content) as { sessionId?: unknown; record?: { body?: { id?: unknown } } };
    state.debts.push({
      slug: path.slice(path.lastIndexOf("/") + 1, -DEBT_SUFFIX.length),
      sessionId: typeof owed.sessionId === "string" ? owed.sessionId : "",
      workContextId: typeof owed.record?.body?.id === "string" ? owed.record.body.id : "",
      step: state.step,
    });
  } catch {
    // A debt the code wrote unreadably is the code's to report, not the log's.
  }
};

const capturedOf = (hostSessionKey: string, record: unknown): Captured => {
  const envelope = record as { id?: unknown; kind?: unknown; producer?: { sessionId?: unknown } };
  return {
    id: typeof envelope.id === "string" ? envelope.id : "",
    kind: typeof envelope.kind === "string" ? envelope.kind : "",
    hostSessionKey,
    writer: typeof envelope.producer?.sessionId === "string" ? envelope.producer.sessionId : "",
    step: state.step,
  };
};

mock.module(sourceOf("../../src/config/paths.ts"), () => ({
  ...paths,
  writePrivateFile: (path: string, content: string) =>
    guarded(path, false, () => realWritePrivateFile(path, content), () => logDebt(path, content)),
  removeFile: (path: string) => guarded(path, false, () => realRemoveFile(path)),
}));

mock.module(sourceOf("../../src/spool/append.ts"), () => ({
  ...append,
  appendRecords: (home: string, key: string, hostSessionKey: string, records: readonly unknown[], now: Date) =>
    guarded(
      home,
      false,
      () => realAppendRecords(home, key, hostSessionKey, records, now),
      (result) => {
        if (isScenarioPath(home) && result.persisted) {
          state.captured.push(...records.map((record) => capturedOf(hostSessionKey, record)));
        }
      },
    ),
}));

mock.module(sourceOf("../../src/spool/drops.ts"), () => ({
  ...drops,
  recordDrop: async (
    home: string,
    key: string,
    slug: string,
    count: number,
    reason: drops.DropReason,
    now: Date,
    kinds: Readonly<Record<string, number>> = {},
    causes: Readonly<Record<string, number>> = {},
  ) => {
    if (count <= 0) {
      return;
    }
    await guarded(
      home,
      true,
      () => realRecordDrop(home, key, slug, count, reason, now, kinds, causes),
      () => {
        if (isScenarioPath(home)) {
          state.droppedThisStep = true;
          state.drops.push({ slug, count, reason, kinds, causes, step: state.step });
        }
      },
    );
  },
}));

/** A fresh scenario on `home`: nothing logged, nothing armed. */
export const beginScenario = (home: string): void => {
  state.home = home;
  state.captured = [];
  state.drops = [];
  state.debts = [];
  beginStep(0, null);
};

/** One step begins; `crash`, when given, kills it at that hooked write. */
export const beginStep = (step: number, crash: Crash | null): void => {
  state.step = step;
  state.crash = crash;
  state.writes = 0;
  state.dead = false;
  state.diedAfterDrop = false;
  state.droppedThisStep = false;
};

/**
 * The step is over: whatever died is a new process from here on. `mayOverCount`
 * is the one window the design accepts counting twice in (spool/flush.ts): the
 * process died after a ledger append and before the cursor write past it.
 */
export const endStep = (): { readonly died: boolean; readonly mayOverCount: boolean } => {
  const outcome = { died: state.dead, mayOverCount: state.dead && (state.diedAfterDrop || state.droppedThisStep) };
  state.crash = null;
  state.dead = false;
  state.diedAfterDrop = false;
  state.droppedThisStep = false;
  return outcome;
};

export const endScenario = (): void => {
  state.home = null;
};

export const isDead = (): boolean => state.dead;

export const scenarioLog = (): {
  readonly captured: readonly Captured[];
  readonly drops: readonly DropCall[];
  readonly debts: readonly DebtWrite[];
} => ({ captured: state.captured, drops: state.drops, debts: state.debts });
