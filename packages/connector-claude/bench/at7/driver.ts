/**
 * The sweep over a run order (09 §7, A1.6, A2.4, A2.5): every slot is run
 * until it counts, a void attempt is re-run IN ITS SLOT, and more than five
 * void attempts in all abort the measurement.
 *
 * RESUME IS THE DEFAULT READING OF THE DISK. The driver starts from the
 * ledger of the attempts already in the results dir (attempt-store.ts): a
 * slot already won is skipped, attempt numbers continue after the highest one
 * present, an attempt without an outcome counts as a void, and a results dir
 * already past the cap aborts before running anything. (Whether a resume is
 * ALLOWED — same mode, order, harness and payloads — is cli.ts's check, made
 * against the manifest before the driver is called.)
 *
 * EVERY ATTEMPT IS OPAQUE (A2.4). Its work root is `<realpath(workBase)>/<id>`
 * with a random hex id, so nothing in the agent's working directory names the
 * slot, the arm, the payload or the attempt; the mapping is in attempt.json,
 * in the results dir.
 *
 * The driver writes outcome.json itself, after the attempt returns or
 * throws, so every finished attempt leaves one. A failed void-log append is
 * thrown, never swallowed.
 */
import type { AttemptFacts, AttemptInput } from "./attempt.ts";
import { harnessThrewFacts } from "./attempt.ts";
import { appendVoidLog, finishAttempt, loadAttempts, startAttempt } from "./attempt-store.ts";
import { createWorkRoot, newAttemptId } from "./layout.ts";
import type { Arm, Slot } from "./manifest.ts";
import type { RunOutcome } from "./report.ts";
import {
  countsTowardCap,
  ledgerOf,
  nextAttemptNumber,
  recordVoidAttempt,
  remainingSlots,
  VOID_BUDGET,
} from "./sweep.ts";
import type { SweepProgress } from "./sweep.ts";

export interface SweepInput {
  readonly order: readonly Slot[];
  /** The results dir: attempts/, voids.jsonl. */
  readonly outDir: string;
  /** Where each attempt's opaque work root is created (realpath'd). */
  readonly workBase: string;
  readonly runAttempt: (input: AttemptInput) => Promise<AttemptFacts>;
  /** One progress line per call; the sweep prints no key or token. */
  readonly log: (line: string) => void;
  readonly newAttemptId?: () => string;
}

export interface SweepResult {
  /** Every attempt's outcome, earlier sessions' included. */
  readonly outcomes: readonly RunOutcome[];
  /** The attempts this session ran. */
  readonly facts: readonly AttemptFacts[];
  readonly voidAttempts: number;
  /** True once the void cap was exceeded: no verdict may be read. */
  readonly aborted: boolean;
  /**
   * True when an attempt met the account's usage limit (A4.3): the sweep
   * stopped there, the measurement is incomplete, and `--resume` after the
   * reset continues it. No verdict may be read until it has finished.
   */
  readonly pausedForUsageLimit: boolean;
}

const armLabel = (arm: Arm): string => (arm.kind === "control" ? "control" : arm.payload);

const logLine = (facts: AttemptFacts): string => {
  const { outcome } = facts;
  return (
    `  attempt ${String(outcome.attempt)} (${outcome.attemptId}) ` +
    `hits=${outcome.hits.map((h) => `${h.id}:${h.label}`).join(",") || "none"} ` +
    `void=${outcome.voids.join(",") || "none"} ` +
    `task=${outcome.taskSucceeded ? "ok" : "RED"} ` +
    `mcp=[${facts.mcpServers.join(",")}] plugins=[${facts.plugins.join(",")}]` +
    (facts.error === undefined ? "" : ` error=${facts.error}`)
  );
};

/** One attempt: recorded as started, run, then its outcome written. */
const runOne = async (input: SweepInput, slot: Slot, attempt: number): Promise<AttemptFacts> => {
  const attemptId = (input.newAttemptId ?? newAttemptId)();
  const workRoot = await createWorkRoot(input.workBase, attemptId);
  const resultsDir = await startAttempt(input.outDir, {
    attemptId,
    slotIndex: slot.index,
    arm: slot.arm,
    attempt,
    workRoot,
    startedAt: new Date().toISOString(),
  });
  const attemptInput: AttemptInput = { slot, attemptId, attempt, workRoot, resultsDir };
  let facts: AttemptFacts;
  try {
    facts = await input.runAttempt(attemptInput);
  } catch (error) {
    facts = harnessThrewFacts(attemptInput, error);
  }
  await finishAttempt(input.outDir, facts);
  return facts;
};

const logVoid = async (outDir: string, facts: AttemptFacts): Promise<void> => {
  const { outcome } = facts;
  await appendVoidLog(outDir, {
    attemptId: outcome.attemptId,
    slotIndex: outcome.slotIndex,
    arm: outcome.arm,
    attempt: outcome.attempt,
    voids: outcome.voids,
    error: facts.error ?? null,
    at: new Date().toISOString(),
  });
};

export const runSweep = async (input: SweepInput): Promise<SweepResult> => {
  const ledger = ledgerOf(await loadAttempts(input.outDir));
  const outcomes: RunOutcome[] = [...ledger.outcomes];
  const facts: AttemptFacts[] = [];
  let progress: SweepProgress = {
    voidAttempts: ledger.voidAttempts,
    aborted: ledger.voidAttempts > VOID_BUDGET,
  };
  let paused = false;
  const result = (): SweepResult => ({
    outcomes,
    facts,
    voidAttempts: progress.voidAttempts,
    aborted: progress.aborted,
    pausedForUsageLimit: paused,
  });
  if (progress.aborted) {
    input.log(`already ${String(progress.voidAttempts)} void attempts on disk — over the cap; running nothing`);
    return result();
  }
  for (const slot of remainingSlots(input.order, ledger.winners.keys())) {
    input.log(`· run #${String(slot.index)} ${armLabel(slot.arm)} …`);
    for (let attempt = nextAttemptNumber(ledger, slot.index); ; attempt += 1) {
      const attemptFacts = await runOne(input, slot, attempt);
      facts.push(attemptFacts);
      outcomes.push(attemptFacts.outcome);
      input.log(logLine(attemptFacts));
      if (attemptFacts.outcome.voids.length === 0) {
        break;
      }
      await logVoid(input.outDir, attemptFacts);
      if (!countsTowardCap(attemptFacts.outcome.voids)) {
        // A4.3: the account's usage limit. Every next attempt would meet it
        // too, so stop here rather than spend the slot's attempts on it.
        input.log("  account usage limit reached — sweep paused; resume with --resume after the reset");
        paused = true;
        return result();
      }
      progress = recordVoidAttempt(progress);
      if (progress.aborted) {
        return result();
      }
    }
  }
  return result();
};
