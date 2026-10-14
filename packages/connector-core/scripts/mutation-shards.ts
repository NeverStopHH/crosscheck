/**
 * WHICH ANCHORS ONE RUN OF THE MUTATION PROOF PROVES (scripts/mutation-check.ts).
 *
 * The whole list, one anchor after another, outgrew a hosted runner: the base
 * branch's 1,825 anchors took 3 h 19 min, and 3,880 at that pace is seven
 * hours against GitHub's six-hour job limit. CI runs the proof as a matrix of
 * shards (.github/workflows/ci.yml `mutation`):
 *
 *   bun run packages/connector-core/scripts/mutation-check.ts --shard 3/10
 *
 * A SHARD IS WHOLE GUARDS, AS FAR AS ONE FITS. Every guard test is run once
 * unmutated before its first anchor in a run (mutation-check.ts
 * assertGuardIsGreen), so a guard's anchors go to one shard and that run is
 * paid once — unless the guard alone costs more than a shard's share of the
 * whole list. Such a guard is cut, in list order, into as many parts as its
 * cost holds shares (never finer than one anchor a part), and each part pays
 * its own unmutated run. One guard needs it today: the opt-out differential
 * walk, about 200 s a run on a laptop for 16 anchors.
 *
 * DEALT BY SECONDS, NOT BY COUNT. One run of a guard file costs 0.1 s to
 * more than 200 s, so eight shards of 487 anchors each ran 37 to more than
 * 85 minutes on ubuntu-latest (CI run 38470399845). A guard costs its
 * measured seconds per run (scripts/mutation-guard-seconds.json, made by
 * scripts/mutation-guard-times.ts from the proof's own CI logs) times its
 * runs — its anchors plus the unmutated one; a guard the table never measured
 * costs the table's median pace. Guards and parts are dealt costliest first
 * to the shard with the least cost so far (ties to the lower shard; equal
 * costs in list order), so the split depends on the list and the table alone
 * — the same on every runner — and no shard is predicted longer than another
 * plus the costliest guard. Within a shard the list's own order is kept.
 *
 * `--label <label>` (repeatable) proves just the anchors so named: the
 * strict proof of the anchors a change adds or touches, run locally. A label
 * no anchor has is refused rather than proving nothing and passing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** Seconds one run of each guard file took, by its repo-relative path. */
export type GuardSeconds = Readonly<Record<string, number>>;

/** The measured table, beside this script. */
export const GUARD_SECONDS_PATH = join(import.meta.dir, "mutation-guard-seconds.json");

const GuardTableSchema = z.object({
  source: z.string().min(1),
  secondsPerRun: z.record(z.string(), z.number().positive()),
});

/** The measured table, validated: a source, and a positive pace for every file it names. */
export const readGuardSeconds = (path: string = GUARD_SECONDS_PATH): GuardSeconds =>
  GuardTableSchema.parse(JSON.parse(readFileSync(path, "utf8"))).secondsPerRun;

const medianOf = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/** What the split reads of an anchor. */
export interface Guarded {
  readonly label: string;
  readonly test: string;
}

export interface Selection {
  /** 1-based shard of `count`, or null for the whole list. */
  readonly shard: { readonly index: number; readonly count: number } | null;
  readonly labels: readonly string[];
}

const SHARD_PATTERN = /^(\d+)\/(\d+)$/;

const shardFrom = (written: string): { readonly index: number; readonly count: number } => {
  const match = SHARD_PATTERN.exec(written);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (match === null || count < 1 || index < 1 || index > count) {
    throw new Error(`--shard takes k/n with 1 <= k <= n, not "${written}"`);
  }
  return { index, count };
};

export const parseSelection = (args: readonly string[]): Selection => {
  const valueAfter = (at: number, flag: string): string => {
    const value = args[at + 1];
    if (value === undefined) {
      throw new Error(`${flag} needs a value`);
    }
    return value;
  };
  const shards = args.flatMap((arg, at) => (arg === "--shard" ? [shardFrom(valueAfter(at, arg))] : []));
  const labels = args.flatMap((arg, at) => (arg === "--label" ? [valueAfter(at, arg)] : []));
  const unknown = args.filter((arg, at) => arg.startsWith("--") && arg !== "--shard" && arg !== "--label" && args[at - 1] !== "--label");
  if (unknown.length > 0) {
    throw new Error(`unknown argument: ${unknown.join(", ")} (--shard k/n, --label <label>)`);
  }
  if (shards.length > 1) {
    throw new Error("--shard may be given once");
  }
  return { shard: shards[0] ?? null, labels };
};

/** Each guard's anchors as positions in the list, guards in the order the list first names them. */
const positionsByGuard = (items: readonly Guarded[]): ReadonlyMap<string, readonly number[]> => {
  const positions = new Map<string, number[]>();
  items.forEach((item, at) => {
    positions.set(item.test, [...(positions.get(item.test) ?? []), at]);
  });
  return positions;
};

/** The table's pace for a guard, or its median pace for one it never measured. */
const paceFor = (secondsPerRun: GuardSeconds): ((guard: string) => number) => {
  const paces = Object.values(secondsPerRun);
  if (paces.length === 0) {
    throw new Error("the guard-seconds table is empty: every guard would cost nothing");
  }
  const median = medianOf(paces);
  return (guard) => secondsPerRun[guard] ?? median;
};

/**
 * Each guard's predicted seconds, in the order the list first names them:
 * its runs (anchors + the unmutated one) at its measured pace, or at the
 * table's median pace when the table never measured it.
 */
export const costsOf = (items: readonly Guarded[], secondsPerRun: GuardSeconds): ReadonlyMap<string, number> => {
  const pace = paceFor(secondsPerRun);
  return new Map([...positionsByGuard(items).entries()].map(([guard, at]) => [guard, (at.length + 1) * pace(guard)]));
};

/** Every shard's anchors in list order, and the seconds the table predicts for it. */
export interface ShardPlan<T> {
  readonly shards: readonly (readonly T[])[];
  readonly seconds: readonly number[];
}

/** Positions cut into `parts` runs in their own order, as even as they go, the longer runs first. */
const cut = (positions: readonly number[], parts: number): readonly (readonly number[])[] => {
  const base = Math.floor(positions.length / parts);
  const longer = positions.length % parts;
  return Array.from({ length: parts }, (_, part) => {
    const start = part * base + Math.min(part, longer);
    return positions.slice(start, start + base + (part < longer ? 1 : 0));
  });
};

/** The whole split: whole guards, and the parts of a guard costlier than a shard's share, dealt costliest first to the least-loaded shard. */
export const planShards = <T extends Guarded>(items: readonly T[], count: number, secondsPerRun: GuardSeconds): ShardPlan<T> => {
  const pace = paceFor(secondsPerRun);
  const guards = [...positionsByGuard(items).entries()];
  const share = guards.reduce((sum, [guard, at]) => sum + (at.length + 1) * pace(guard), 0) / count;
  const units = guards.flatMap(([guard, at]) => {
    const parts = Math.min(at.length, Math.max(1, Math.ceil(((at.length + 1) * pace(guard)) / share)));
    return cut(at, parts).map((part) => ({ positions: part, cost: (part.length + 1) * pace(guard) }));
  });
  // Costliest first; equal costs in list order (a stable sort over the units as made).
  const dealt = [...units].sort((left, right) => right.cost - left.cost);
  const loads = Array.from({ length: count }, () => 0);
  const ownerOf = new Map<number, number>();
  for (const unit of dealt) {
    const lightest = loads.indexOf(Math.min(...loads));
    for (const position of unit.positions) {
      ownerOf.set(position, lightest);
    }
    loads[lightest] = (loads[lightest] ?? 0) + unit.cost;
  }
  return {
    shards: loads.map((_, shard) => items.filter((_item, at) => ownerOf.get(at) === shard)),
    seconds: loads,
  };
};

/** Shard `index` of `count` (1-based) of the plan. */
export const shardOf = <T extends Guarded>(
  items: readonly T[],
  index: number,
  count: number,
  secondsPerRun: GuardSeconds,
): readonly T[] => planShards(items, count, secondsPerRun).shards[index - 1] ?? [];

/** What a run proves: the whole list, one shard of it, or the anchors named by label. */
export const selectMutations = <T extends Guarded>(
  items: readonly T[],
  args: readonly string[],
  secondsPerRun: GuardSeconds,
): readonly T[] => {
  const selection = parseSelection(args);
  const unknownLabels = selection.labels.filter((label) => !items.some((item) => item.label === label));
  if (unknownLabels.length > 0) {
    throw new Error(`--label names no anchor: ${unknownLabels.join(" | ")}`);
  }
  const labelled = selection.labels.length === 0 ? items : items.filter((item) => selection.labels.includes(item.label));
  return selection.shard === null
    ? labelled
    : shardOf(labelled, selection.shard.index, selection.shard.count, secondsPerRun);
};
