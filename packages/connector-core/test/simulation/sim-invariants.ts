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
  /** `I1u`: records nothing on disk counts, because the disk refused the ledger line AND the marker (review-2 round 8). */
  readonly invariant: "I1" | "I1u" | "I2" | "I3" | "I4" | "I5" | "I6";
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
 * Records the hub took while the connector never learned it: the answer was
 * lost (a 504, or a request that timed out after the hub committed), or the
 * process died before the cursor write past them.
 */
const takenUnheardIds = (run: Run): ReadonlySet<string> => {
  const isUnheard = (delivery: Run["deliveries"][number]): boolean =>
    delivery.answerLost || run.crashedSteps.has(delivery.step);
  const heard = new Set(
    run.deliveries.filter((delivery) => TAKEN.has(delivery.status) && !isUnheard(delivery)).map((delivery) => delivery.id),
  );
  return new Set(
    run.deliveries
      .filter((delivery) => TAKEN.has(delivery.status) && isUnheard(delivery) && !heard.has(delivery.id))
      .map((delivery) => delivery.id),
  );
};

/** The drops that counted each record, by its envelope id. */
const countsById = (run: Run): ReadonlyMap<string, readonly Run["drops"][number][]> => {
  const counted = new Map<string, Run["drops"][number][]>();
  for (const drop of run.drops) {
    for (const id of drop.ids) {
      counted.set(id, [...(counted.get(id) ?? []), drop]);
    }
  }
  return counted;
};

/** Each captured record's fate, for I1 and the over-count the sweep prints. */
interface Fates {
  readonly takenAndCounted: readonly Run["captured"][number][];
  readonly countedTwice: readonly Run["captured"][number][];
  readonly neither: readonly Run["captured"][number][];
  readonly lost: number;
}

/**
 * PER RECORD (review-2 round 8, M4): each captured record is delivered — the
 * hub took it, as often as it was sent — or counted exactly once, never both
 * and never neither. Drops carry their records' envelope ids
 * (spool/drops.ts recordDrop); a drop without ids (a torn line, an older
 * connector's flush) covers that many records no id names.
 *
 * Residuals each counted, never silent (loss-accounting §4.3):
 *   - a record the hub took unheard and the connector then withheld or let
 *     expire — never re-sent, so no `duplicate` could tell it the hub holds
 *     it — is counted though the hub holds it;
 *   - a record counted by a step that died between the ledger append and the
 *     cursor write past it may be counted again by the next drain.
 */
const fatesOf = (run: Run): Fates => {
  const taken = new Set(run.deliveries.filter((delivery) => TAKEN.has(delivery.status)).map((delivery) => delivery.id));
  const counted = countsById(run);
  const unheard = takenUnheardIds(run);
  // A released debt counts the work context a heal owed, which no spool line holds.
  let idless = run.drops
    .filter((drop) => !isDebtRelease(drop))
    .reduce((sum, drop) => sum + Math.max(0, drop.count - drop.ids.length), 0);
  const takenAndCounted: Run["captured"][number][] = [];
  const countedTwice: Run["captured"][number][] = [];
  const neither: Run["captured"][number][] = [];
  let lost = 0;
  const uncountableIds = new Set(run.uncountable.ids);
  for (const record of run.captured) {
    if (uncountableIds.has(record.id) && !taken.has(record.id)) {
      lost += 1;
      continue;
    }
    const drops = counted.get(record.id) ?? [];
    const isTaken = taken.has(record.id);
    const isNeverResent = drops.every((drop) => drop.reason === "withheld" || drop.reason === "expired");
    const isCrashWindow = drops.some((drop) => run.overCountSteps.has(drop.step));
    lost += isTaken ? 0 : 1;
    if (isTaken && drops.length > 0 && !(unheard.has(record.id) && isNeverResent) && !isCrashWindow) {
      takenAndCounted.push(record);
    } else if (!isTaken && drops.length > 1 && !isCrashWindow) {
      countedTwice.push(record);
    } else if (!isTaken && drops.length === 0) {
      if (idless > 0) {
        idless -= 1;
      } else {
        neither.push(record);
      }
    }
  }
  return { takenAndCounted, countedTwice, neither, lost };
};

/** The I1 numbers as the sweep prints them, to measure the over-count (the round-7 review's Q3). */
export const accountingStats = (run: Run) => {
  const taken = new Set(run.deliveries.filter((delivery) => TAKEN.has(delivery.status)).map((delivery) => delivery.id));
  const counted = countsById(run);
  return {
    captured: run.captured.length,
    lost: fatesOf(run).lost,
    /** Records the ledger calls lost that the hub HOLDS, residuals included. */
    overCounted: run.captured.filter((record) => taken.has(record.id) && (counted.get(record.id) ?? []).length > 0).length,
  };
};

const fateVerdict = (records: readonly Run["captured"][number][], what: string): readonly Verdict[] =>
  records.length === 0 ? [] : [{ invariant: "I1", detail: `${String(records.length)} record(s) ${what}: ${lostList(records)}` }];

/**
 * A drop that counts records the code holds names every one of them: only a
 * torn line has no id, an older connector names none, and a released debt
 * counts a work context no spool line holds.
 */
const unnamedRecords = (run: Run): readonly Verdict[] =>
  run.drops
    // An append refusal (`write-failed`, `short-write`) counts records no spool line ever held.
    .filter((drop) => drop.reason !== "write-failed" && drop.reason !== "short-write")
    .filter((drop) => drop.reason !== "unparsable" && !isDebtRelease(drop) && !run.oldFlushSteps.has(drop.step))
    .filter((drop) => drop.ids.length !== drop.count)
    .map((drop) => ({
      invariant: "I1" as const,
      detail: `a ${drop.reason} drop at step ${String(drop.step)} counts ${String(drop.count)} record(s) and names ${String(drop.ids.length)}`,
    }));

/** I1: every captured record delivered or counted once — never both, never neither — and every refusal named. */
const accounting = (run: Run): readonly Verdict[] => {
  const fates = fatesOf(run);
  const unnamed = run.drops.filter((drop) => drop.reason === "rejected" && Object.keys(drop.causes).length === 0);
  return [
    ...(run.uncountable.count > 0
      ? [
          {
            invariant: "I1u" as const,
            detail: `${String(run.uncountable.count)} record(s) counted nowhere: the disk refused the ledger line and the unrecorded marker`,
          },
        ]
      : []),
    ...fateVerdict(fates.neither, "lost and never counted"),
    ...fateVerdict(fates.countedTwice, "counted twice"),
    ...fateVerdict(fates.takenAndCounted, "counted though the hub holds them"),
    ...unnamedRecords(run),
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
 * The newest status set_intent posted that the hub TOOK, heard or not, per
 * work context (sleep seed 4643): a post the hub took while its answer was
 * lost is a status the hub took from set_intent all the same. `latestStatus`
 * holds only the ones whose answer came back.
 */
const newestTakenIntent = (run: Run): ReadonlyMap<string, string> => {
  const taken = new Set(run.deliveries.filter((delivery) => TAKEN.has(delivery.status)).map((delivery) => delivery.id));
  const newest = new Map<string, string>();
  for (const post of run.intentPosts) {
    if (taken.has(post.id)) {
      newest.set(post.workContextId, post.status);
    }
  }
  return newest;
};

/**
 * I4: the hub's status is the newest one set_intent wrote — the newest the hub
 * took from it, heard or not, or the newest it left in the state (which every
 * other sender reads), when a post it wrote there never landed.
 */
const freshness = async (hub: SimHub, run: Run): Promise<readonly Verdict[]> => {
  const tookUnheard = newestTakenIntent(run);
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
    if (onHub !== undefined && onHub !== status && onHub !== written && onHub !== tookUnheard.get(workContextId)) {
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
