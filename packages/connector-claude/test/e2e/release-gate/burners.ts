/**
 * BOUNDED CPU LOAD for the release gate's loaded lane: someone else's work on
 * the developer's machine (a build, another agent, a video call) while the
 * gate's hooks run.
 *
 * Each burner is one bun process spinning one core. They are this file's
 * OWN processes: started here, remembered by PID, and stopped by those PIDs
 * only — never by name, never a process group. Each one also stops itself:
 * at its deadline, and as soon as the process that started it is gone, so a
 * test runner that dies cannot leave a burner spinning.
 */
import { availableParallelism, loadavg } from "node:os";

/** One burner per core unless the lane says otherwise (`CX_GATE_BURNERS`). */
export const BURNERS_ENV = "CX_GATE_BURNERS";
/** How often a burner looks up from its loop: the deadline and its parent. */
const CHECK_EVERY_ITERATIONS = 1_000_000;
/** How long a burner gets to leave on SIGTERM before its own handle sends SIGKILL. */
const STOP_GRACE_MS = 3_000;

const BURNER_SOURCE = `
const deadline = Date.now() + Number(process.env.CX_BURN_MS);
const parent = Number(process.env.CX_BURN_PARENT);
let sink = 0;
for (;;) {
  for (let i = 0; i < ${String(CHECK_EVERY_ITERATIONS)}; i += 1) sink ^= i;
  if (Date.now() > deadline) break;
  try { process.kill(parent, 0); } catch { break; }
}
process.exit(sink === -1 ? 1 : 0);
`;

export interface Burners {
  readonly pids: readonly number[];
  /** The 1-minute load average when they started. */
  readonly loadAtStart: number;
  /** Stops every burner by its own PID, waits for each to exit, and returns the 1-minute load average just before. */
  readonly stop: () => Promise<number>;
}

export const burnerCount = (): number => {
  const asked = Number(process.env[BURNERS_ENV] ?? "");
  return Number.isInteger(asked) && asked > 0 ? asked : availableParallelism();
};

/** `count` burners, each spinning one core for at most `maxMs`. */
export const startBurners = (count: number, maxMs: number): Burners => {
  const children = Array.from({ length: count }, () =>
    Bun.spawn({
      cmd: [process.execPath, "-e", BURNER_SOURCE],
      // A spinning loop needs nothing of this run's environment.
      env: { PATH: process.env["PATH"] ?? "", CX_BURN_MS: String(maxMs), CX_BURN_PARENT: String(process.pid) },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }),
  );
  const stopOne = async (child: (typeof children)[number]): Promise<void> => {
    child.kill("SIGTERM");
    const hasLeft = await Promise.race([child.exited.then(() => true), Bun.sleep(STOP_GRACE_MS).then(() => false)]);
    if (!hasLeft) {
      child.kill("SIGKILL");
      await child.exited;
    }
  };
  return {
    pids: children.map((child) => child.pid),
    loadAtStart: loadavg()[0] ?? 0,
    stop: async () => {
      const loadAtStop = loadavg()[0] ?? 0;
      await Promise.all(children.map(stopOne));
      return loadAtStop;
    },
  };
};
