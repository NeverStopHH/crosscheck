/**
 * WHAT EVERY SCENARIO MUST LEAVE TRUE once it has drained (test/spool-simulation.test.ts):
 *
 *   I1  every captured record is delivered OR counted once in the loss ledger
 *       with a named cause — a work context a debt was refused for, released,
 *       counted once too;
 *   I2  no record is delivered under the wrong life or session, nor filed into
 *       a session the hub had already ended;
 *   I3  the order within (session, epoch) is preserved on the hub;
 *   I4  no work context's final status is older than the newest one written;
 *   I5  every drain returns inside its deadline, and the scenario settles;
 *   I6  a live conversation's records are never spent by another flusher.
 *
 * The ground truth is what the hooks and the proxy logged (sim-hooks.ts,
 * sim-hub.ts), never what the code under test says about itself.
 */
import { readSessionCausalOrder } from "@crosscheck/server";

import type { SimHub } from "./sim-hub.ts";
import type { Run } from "./sim-world.ts";

export interface Verdict {
  readonly invariant: "I1" | "I2" | "I3" | "I4" | "I5" | "I6";
  readonly detail: string;
}

const TAKEN: ReadonlySet<string> = new Set(["accepted", "duplicate"]);
/** The work context a debt was refused for, released and counted: one drop of its own. */
const OWED_REFUSED = "owed_wc_refused";

const isDebtRelease = (drop: Run["drops"][number]): boolean =>
  drop.count === 1 &&
  drop.causes[OWED_REFUSED] === 1 &&
  drop.kinds["work_context"] === 1 &&
  Object.keys(drop.kinds).length === 1;

const lostList = (lost: Run["captured"]): string =>
  lost.map((captured) => `${captured.kind}@step${String(captured.step)}`).join(", ");

/**
 * Records the hub took while the connector never learned it — the answer was
 * lost, or the process died before the cursor write past them. The connector
 * may count each of them once later: refused on a re-send under a life the hub
 * had ended since (the hub answers the producer before the duplicate), or
 * withheld as a refused life's straggler. A record counted though the hub
 * holds it is the honest direction, and a documented residual
 * (loss-accounting §4.3).
 */
const takenUnheard = (run: Run): number => {
  const isUnheard = (delivery: Run["deliveries"][number]): boolean =>
    delivery.answerLost || run.crashedSteps.has(delivery.step);
  const heard = new Set(
    run.deliveries.filter((delivery) => TAKEN.has(delivery.status) && !isUnheard(delivery)).map((delivery) => delivery.id),
  );
  return new Set(
    run.deliveries
      .filter((delivery) => TAKEN.has(delivery.status) && isUnheard(delivery) && !heard.has(delivery.id))
      .map((delivery) => delivery.id),
  ).size;
};

/** The I1 balance as numbers: what the sweep prints, to measure the over-count (the round-7 review's Q3). */
export const accountingStats = (run: Run) => {
  const taken = new Set(run.deliveries.filter((delivery) => TAKEN.has(delivery.status)).map((delivery) => delivery.id));
  const lost = run.captured.filter((captured) => !taken.has(captured.id)).length;
  const releases = run.drops.filter(isDebtRelease).length;
  return {
    captured: run.captured.length,
    lost,
    ledger: run.ledgerTotal,
    /** Counted beyond what was lost: records the hub HOLDS that the ledger calls lost. */
    overCounted: Math.max(0, run.ledgerTotal - (lost + releases)),
  };
};

/** I1: what was captured and never taken is exactly what the ledger counts. */
const accounting = (run: Run): readonly Verdict[] => {
  const taken = new Set(run.deliveries.filter((delivery) => TAKEN.has(delivery.status)).map((delivery) => delivery.id));
  const lost = run.captured.filter((captured) => !taken.has(captured.id));
  const releases = run.drops.filter(isDebtRelease).length;
  const expected = lost.length + releases;
  const allowance = run.overCountAllowance + takenUnheard(run);
  const unnamed = run.drops.filter((drop) => drop.reason === "rejected" && Object.keys(drop.causes).length === 0);
  const silent: readonly Verdict[] =
    run.ledgerTotal < expected
      ? [
          {
            invariant: "I1",
            detail: `${String(expected - run.ledgerTotal)} record(s) lost and never counted (lost: ${lostList(lost)}; released debts ${String(releases)}; ledger ${String(run.ledgerTotal)})`,
          },
        ]
      : [];
  const twice: readonly Verdict[] =
    run.ledgerTotal > expected + allowance
      ? [
          {
            invariant: "I1",
            detail: `${String(run.ledgerTotal - expected)} record(s) counted twice (ledger ${String(run.ledgerTotal)}, lost ${String(lost.length)}, released debts ${String(releases)}, allowance ${String(allowance)})`,
          },
        ]
      : [];
  return [
    ...silent,
    ...twice,
    ...unnamed.map((drop) => ({
      invariant: "I1" as const,
      detail: `${String(drop.count)} refusal(s) counted with no cause at step ${String(drop.step)}`,
    })),
  ];
};

/**
 * I2: a record goes under its own life, a later life of its own conversation,
 * or — once that conversation is over — any flusher's; and never into a
 * session the hub had ended.
 */
const placement = (run: Run): readonly Verdict[] => {
  const writers = new Map(run.captured.map((captured) => [captured.id, captured]));
  return run.deliveries
    .filter((delivery) => TAKEN.has(delivery.status))
    .flatMap((delivery): readonly Verdict[] => {
      // An older connector reads no refused-lives note: its late filings are
      // the documented residual (L5), not this connector's.
      const late: readonly Verdict[] =
        delivery.status === "accepted" &&
        delivery.intoEndedSession &&
        delivery.endKnown &&
        !run.oldFlushSteps.has(delivery.step)
          ? [
              {
                invariant: "I2",
                detail: `${delivery.kind} ${delivery.id} filed into ${delivery.bodySession ?? "?"} after the connector was told it ended (step ${String(delivery.step)})`,
              },
            ]
          : [];
      const captured = writers.get(delivery.id);
      if (captured === undefined || captured.writer === delivery.producer || run.oldFlushSteps.has(delivery.step)) {
        return late;
      }
      const own = run.conversationOf(captured.writer);
      const flusher = run.conversationOf(delivery.producer);
      // Live on both sides of the step: one a parallel process ended or
      // started within it may have been ended when the send was decided.
      const isLive = (phase: string): boolean => phase === "live";
      const wasLiveThroughout =
        own !== null && isLive(run.phaseBefore(own, delivery.step)) && isLive(run.phaseAfter(own, delivery.step));
      return own !== flusher && wasLiveThroughout
        ? [
            ...late,
            {
              invariant: "I2",
              detail: `${delivery.kind} written by ${captured.writer} delivered under ${delivery.producer} while its conversation was live (step ${String(delivery.step)})`,
            },
          ]
        : late;
    });
};

/** I3: no session the scenario touched holds a broken order. */
const order = async (hub: SimHub, run: Run): Promise<readonly Verdict[]> => {
  const verdicts: Verdict[] = [];
  for (const life of run.lives) {
    if (life === "") {
      continue;
    }
    const causal = await readSessionCausalOrder(hub.db, life);
    if (causal.state === "broken") {
      verdicts.push({ invariant: "I3", detail: `${life}: order ${causal.reason} (${String(causal.epochs)} epochs)` });
    }
  }
  return verdicts;
};

/**
 * I4: the hub's status is the newest one set_intent wrote — the newest the hub
 * took from it, or the newest it left in the state (which every other sender
 * reads), when a post it wrote there never landed.
 */
const freshness = async (hub: SimHub, run: Run): Promise<readonly Verdict[]> => {
  const verdicts: Verdict[] = [];
  // An older connector's flush sends a spooled copy as it was spooled: its
  // revert is the documented residual (L5), not this connector's.
  const oldFlushed = new Set(
    run.deliveries
      .filter((delivery) => delivery.kind === "work_context" && run.oldFlushSteps.has(delivery.step))
      .map((delivery) => delivery.workContextId),
  );
  for (const [workContextId, status] of run.latestStatus.entries()) {
    if (oldFlushed.has(workContextId)) {
      continue;
    }
    const rows = await hub.raw<{ status: string }>("select status from work_contexts where id = $1", [workContextId]);
    const onHub = rows[0]?.status;
    const written = run.writtenStatus.get(workContextId) ?? status;
    if (onHub !== undefined && onHub !== status && onHub !== written) {
      verdicts.push({ invariant: "I4", detail: `${workContextId}: the hub says ${onHub}, the newest written is ${status}` });
    }
  }
  return verdicts;
};

/** I5: every drain inside its deadline, and nothing left on disk at the end. */
const termination = (run: Run): readonly Verdict[] => [
  ...run.timings
    .filter((timing) => timing.ms > timing.limitMs)
    .map((timing) => ({
      invariant: "I5" as const,
      detail: `step ${String(timing.step)}: a drain took ${String(timing.ms)} ms against ${String(timing.limitMs)}`,
    })),
  ...(run.quiescent
    ? []
    : [{ invariant: "I5" as const, detail: "the scenario never settled: records or a debt still on disk after the final drain" }]),
];

/** I6: what the per-step snapshots saw (sim-world.ts checkSix). */
const ownership = (run: Run): readonly Verdict[] =>
  run.sixViolations.map((detail) => ({ invariant: "I6" as const, detail }));

export const checkInvariants = async (hub: SimHub, run: Run): Promise<readonly Verdict[]> => [
  ...accounting(run),
  ...placement(run),
  ...(await order(hub, run)),
  ...(await freshness(hub, run)),
  ...termination(run),
  ...ownership(run),
];
