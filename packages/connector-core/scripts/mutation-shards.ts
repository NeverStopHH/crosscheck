/**
 * WHICH ANCHORS ONE RUN OF THE MUTATION PROOF PROVES (scripts/mutation-check.ts).
 *
 * The whole list, one anchor after another, outgrew a hosted runner: the base
 * branch's 1,825 anchors took 3 h 19 min, and 3,880 at that pace is seven
 * hours against GitHub's six-hour job limit. CI runs the proof as a matrix of
 * shards (.github/workflows/ci.yml `mutation`):
 *
 *   bun run packages/connector-core/scripts/mutation-check.ts --shard 3/8
 *
 * A SHARD IS WHOLE GUARDS. Every guard test is run once unmutated before its
 * first anchor (mutation-check.ts assertGuardIsGreen), so a guard's anchors
 * go to one shard and that run is paid once. Guards are dealt largest first
 * to the shard with the fewest anchors so far (ties to the lower shard), so
 * the split depends on the list alone — the same on every runner — and no
 * shard holds more than another plus one guard's anchors. Within a shard the
 * list's own order is kept.
 *
 * `--label <label>` (repeatable) proves just the anchors so named: the
 * strict proof of the anchors a change adds or touches, run locally. A label
 * no anchor has is refused rather than proving nothing and passing.
 */

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

/** Shard `index` of `count` (1-based): whole guards, dealt largest first to the emptiest shard. */
export const shardOf = <T extends Guarded>(items: readonly T[], index: number, count: number): readonly T[] => {
  const guards = new Map<string, number>();
  for (const item of items) {
    guards.set(item.test, (guards.get(item.test) ?? 0) + 1);
  }
  // Largest first; equal sizes in the order the list first names them (Map order).
  const dealt = [...guards.entries()].sort((left, right) => right[1] - left[1]);
  const loads = Array.from({ length: count }, () => 0);
  const ownerOf = new Map<string, number>();
  for (const [guard, size] of dealt) {
    const emptiest = loads.indexOf(Math.min(...loads));
    ownerOf.set(guard, emptiest);
    loads[emptiest] = (loads[emptiest] ?? 0) + size;
  }
  return items.filter((item) => ownerOf.get(item.test) === index - 1);
};

/** What a run proves: the whole list, one shard of it, or the anchors named by label. */
export const selectMutations = <T extends Guarded>(items: readonly T[], args: readonly string[]): readonly T[] => {
  const selection = parseSelection(args);
  const unknownLabels = selection.labels.filter((label) => !items.some((item) => item.label === label));
  if (unknownLabels.length > 0) {
    throw new Error(`--label names no anchor: ${unknownLabels.join(" | ")}`);
  }
  const labelled = selection.labels.length === 0 ? items : items.filter((item) => selection.labels.includes(item.label));
  return selection.shard === null ? labelled : shardOf(labelled, selection.shard.index, selection.shard.count);
};
