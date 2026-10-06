/**
 * A TYPING SLIP (DESIGN.md §4, hold-out review H1 b): what a typist's hand
 * does to a word, never what a different word looks like. Four slips — two
 * neighbouring letters swapped, a key's neighbour hit instead of it, a
 * letter left out, a letter doubled or a neighbour's key hit beside it —
 * and NEVER IN THE FIRST LETTER, which a hand rarely misses and which keeps
 * most real words apart ("keep" and "deep", "rate" and "date").
 *
 * THE BUDGET GROWS WITH THE WORD: no slip under SLIP_MIN_TARGET_LETTERS (a
 * four-letter word is one key away from dozens of real ones — the
 * dictionary showed "rare", "cook", "find", "shop", "tool"), one up to seven
 * letters, two up to eleven, three from twelve ("zurukgsetz" is three
 * letters short of "zurückgesetzt"). So a typed word is never shorter than
 * four letters and a slip never reaches a three-letter one.
 *
 * Neighbours are keys that touch on a QWERTY or a QWERTZ keyboard.
 */

export const SLIP_MIN_TARGET_LETTERS = 5;
const TWO_SLIPS_FROM_LETTERS = 8;
const THREE_SLIPS_FROM_LETTERS = 12;

/** How many slips a word of this length may carry. */
export const slipBudget = (target: string): number =>
  target.length >= THREE_SLIPS_FROM_LETTERS
    ? 3
    : target.length >= TWO_SLIPS_FROM_LETTERS
      ? 2
      : target.length >= SLIP_MIN_TARGET_LETTERS
        ? 1
        : 0;

const KEYBOARDS: readonly (readonly string[])[] = [
  ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm"],
  ["1234567890", "qwertzuiop", "asdfghjkl", "yxcvbnm"],
];

/** The keys touching (row, column): either side, two above, two below — rows are staggered. */
const TOUCHING: readonly (readonly [number, number])[] = [[0, -1], [0, 1], [-1, 0], [-1, 1], [1, 0], [1, -1]];

const NEIGHBOUR_PAIRS: ReadonlySet<string> = new Set(
  KEYBOARDS.flatMap((rows) =>
    rows.flatMap((row, rowIndex) =>
      [...row].flatMap((key, column) =>
        TOUCHING.map(([down, right]) => rows[rowIndex + down]?.[column + right])
          .filter((touching): touching is string => touching !== undefined)
          .map((touching) => `${key}${touching}`),
      ),
    ),
  ),
);

const areNeighbours = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && NEIGHBOUR_PAIRS.has(`${a}${b}`);

/** A letter typed between two others: doubled, or a key touching one beside it. */
const isStrayKey = (typed: string, at: number, next: string | undefined): boolean => {
  const stray = typed[at];
  const previous = typed[at - 1];
  return stray === previous || stray === next || areNeighbours(stray, previous) || areNeighbours(stray, next);
};

const NEVER = Number.POSITIVE_INFINITY;

/** Every slip a hand makes, or the swapped pair alone. */
type SlipKinds = "all" | "swaps";

/** The cheapest way to cell (row, column), given the cells before it. */
const cellCost = (
  typed: string,
  target: string,
  kinds: SlipKinds,
  cost: readonly (readonly number[])[],
  row: number,
  column: number,
): number => {
  const typedLetter = typed[row - 1];
  const targetLetter = target[column - 1];
  const diagonal = cost[row - 1]?.[column - 1] ?? NEVER;
  const matched = typedLetter === targetLetter ? diagonal : NEVER;
  const isSwap =
    row >= 3 && column >= 3 && typedLetter === target[column - 2] && typed[row - 2] === targetLetter && typedLetter !== targetLetter;
  const swapped = isSwap ? (cost[row - 2]?.[column - 2] ?? NEVER) + 1 : NEVER;
  if (kinds === "swaps") {
    return Math.min(matched, swapped);
  }
  const hitNeighbour = areNeighbours(typedLetter, targetLetter) ? diagonal + 1 : NEVER;
  const leftOut = (cost[row]?.[column - 1] ?? NEVER) + 1;
  const strayKey = isStrayKey(typed, row - 1, target[column]) ? (cost[row - 1]?.[column] ?? NEVER) + 1 : NEVER;
  return Math.min(matched, swapped, hitNeighbour, leftOut, strayKey);
};

/**
 * The fewest slips from `typed` to `target`, both of which begin with the
 * same letter: cell (1, 1) is that letter, matched, and no slip reaches row
 * or column 0, so the first letter is never touched.
 */
const slipsBetween = (typed: string, target: string, kinds: SlipKinds): number => {
  const columns = Array.from({ length: target.length + 1 }, (_, column) => column);
  const cost = Array.from({ length: typed.length + 1 }, (_, row) => row).reduce<readonly (readonly number[])[]>(
    (filled, row) => [
      ...filled,
      columns.reduce<readonly number[]>(
        (cells, column) => [
          ...cells,
          row === 0 || column === 0
            ? NEVER
            : row === 1 && column === 1
              ? 0
              : cellCost(typed, target, kinds, [...filled, cells], row, column),
        ],
        [],
      ),
    ],
    [],
  );
  return cost[typed.length]?.[target.length] ?? NEVER;
};

const isSlipOf = (typed: string, target: string, kinds: SlipKinds): boolean => {
  const budget = slipBudget(target);
  return (
    budget > 0 &&
    typed !== target &&
    typed[0] === target[0] &&
    Math.abs(typed.length - target.length) <= budget &&
    slipsBetween(typed, target, kinds) <= budget
  );
};

/** `typed` is `target` with no more slips than its length allows — and not `target` itself. */
export const isTypingSlipOf = (typed: string, target: string): boolean => isSlipOf(typed, target, "all");

/**
 * The same, with swapped pairs as the only slip — the commonest one, and the
 * one that leaves "pass", "past", "bite" and "look" words of their own.
 */
export const isSwapSlipOf = (typed: string, target: string): boolean => isSlipOf(typed, target, "swaps");
