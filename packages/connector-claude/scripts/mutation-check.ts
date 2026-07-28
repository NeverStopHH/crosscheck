/**
 * Proves the verification checks can fail.
 *
 * A green test says nothing until you have watched it go red for the right
 * reason. Every defect below was real: the reserve one shipped and cost
 * SessionStart its briefing, and the sanitizer ones are the mechanisms the
 * injection corpus exists to guard — two of them were found by weakening the
 * checks and watching the corpus stay green anyway. Each is re-introduced here
 * as a single textual edit, the guarding test is run, and the mutation is a
 * FAILURE of this script if that test stays green.
 *
 * The hook-contract check needs no entry here: hook-contract.test.ts already
 * asserts the watcher's red paths directly — an altered snapshot must exit
 * DRIFT, and an unreadable source must exit UNREADABLE rather than either of
 * the other two. Those run on every pull request.
 *
 * Each guarding test is run UNMUTATED first, and an already-red one aborts the
 * run. Without that, `caught: exitCode !== 0` reports a defect as detected when
 * the guard was simply broken to begin with — see assertGuardIsGreen for the
 * container in which this script did exactly that.
 *
 * Every file is restored in a `finally`, so a run that dies half-way leaves the
 * tree as it found it. If one ever does not, `git checkout -- packages` is the
 * whole recovery: nothing here writes anywhere else.
 *
 *   bun run packages/connector-claude/scripts/mutation-check.ts
 */
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const CONNECTOR = "packages/connector-claude";

interface Mutation {
  /** Names the incident, not the edit. */
  readonly label: string;
  readonly file: string;
  readonly from: string;
  readonly to: string;
  /** The check that must go red. */
  readonly test: string;
  readonly because: string;
}

/** Exported so the guard-count claim below can be re-derived from the data. */
export const MUTATIONS: readonly Mutation[] = [
  {
    label: "maintenance spends the hook's reserve",
    file: `${CONNECTOR}/src/constants.ts`,
    from: "export const HOOK_RESERVE_RATIO = 1;",
    to: "export const HOOK_RESERVE_RATIO = 0;",
    test: `${CONNECTOR}/test/hook-time-budget.test.ts`,
    because:
      "spareMs() collapses to the raw remainder, which is the defect that took " +
      "SessionStart to 1035 ms with no briefing and SessionEnd to 831 ms with no end",
  },
  {
    label: "the sanitizer stops stripping zero-width and format characters",
    file: `${CONNECTOR}/src/briefing/sanitize.ts`,
    from: '    .replace(ZERO_WIDTH_PATTERN, "")\n',
    to: "",
    test: `${CONNECTOR}/test/injection-corpus.test.ts`,
    because: "invisible characters reach the reader's context verbatim",
  },
  {
    // HISTORICAL, not re-derivable from this tree. This one exists because the
    // corpus's invariant USED to be a character-for-character copy of the
    // sanitizer's own pattern, which meant it agreed with the implementation
    // however that was weakened — it could not see the invisible characters
    // both of them let through. That copy is gone: the invariant is now derived
    // from Unicode general categories, so no command here can re-measure the
    // overlap, and none is offered. This mutation is what keeps the new
    // arrangement honest: narrow the implementation's class and the corpus must
    // notice.
    label: "the sanitizer narrows to control characters only",
    file: `${CONNECTOR}/src/briefing/sanitize.ts`,
    from: String.raw`\\p{Cc}\\p{Cf}`,
    to: String.raw`\\p{Cc}`,
    test: `${CONNECTOR}/test/injection-corpus.test.ts`,
    because:
      "every Unicode format character — soft hyphen, the zero-width set, the " +
      "invisible operators, the tag alphabet — reaches the reader again, and a " +
      "corpus that borrowed the implementation's pattern would not say so",
  },
  {
    label: "the sanitizer spaces zero-width characters instead of removing them",
    file: `${CONNECTOR}/src/briefing/sanitize.ts`,
    from: '    .replace(ZERO_WIDTH_PATTERN, "")',
    to: '    .replace(ZERO_WIDTH_PATTERN, " ")',
    test: `${CONNECTOR}/test/injection-corpus.test.ts`,
    because:
      "a space substituted for a zero-width character invents a word break, " +
      "which is how `ig<ZWSP>nore previous` walked past the phrase filter",
  },
  {
    // The tag-block range was DECORATION until this was written. Every tag
    // character in the corpus was \p{Cf}, so the general category caught them
    // all and deleting the explicit range left that corpus entirely green —
    // measured 2026-07-28 against the pre-round corpus, by modelling it in a
    // scratch copy. HISTORICAL: that corpus no longer exists, so no total is
    // quoted and nothing here re-derives it. The durable half is the shape —
    // nothing went red. The range exists for the tag code points that are Cn,
    // so the corpus now carries a payload built from three of them
    // (`tag-characters-unassigned`), and this mutation is what keeps that
    // payload from being deleted along with the range it guards.
    label: "the sanitizer stops covering the unassigned tag code points",
    file: `${CONNECTOR}/src/briefing/sanitize.ts`,
    from: String.raw`\\u{E0000}-\\u{E007F}`,
    to: "",
    test: `${CONNECTOR}/test/injection-corpus.test.ts`,
    because:
      "U+E0000 and U+E0002-U+E001F are category Cn, so \\p{Cf} never sees them " +
      "and the ASCII-smuggling alphabet is invisible to the sanitizer again",
  },
  {
    // Found by sweeping the whole Default_Ignorable property rather than by
    // guessing at ranges — scripts/default-ignorable-sweep.ts. Each of these
    // four reproduced the U+034F phrase-filter bypass on its own.
    label: "the sanitizer stops covering the Mongolian free variation selectors",
    file: `${CONNECTOR}/src/briefing/sanitize.ts`,
    from: String.raw`\\u180B-\\u180D\\u180F`,
    to: "",
    test: `${CONNECTOR}/test/injection-corpus.test.ts`,
    because:
      "U+180B-U+180D and U+180F are Mn, so neither \\p{Cc} nor \\p{Cf} reaches " +
      "them, and `ig<FVS1>nore previous` splits past the phrase filter again",
  },
  {
    label: "the briefing stops framing quoted teammate text",
    file: `${CONNECTOR}/src/briefing/render.ts`,
    from: "status ${status}: «${title}»",
    to: "status ${status}: ${title}",
    test: `${CONNECTOR}/test/injection-corpus.test.ts`,
    because:
      "teammate-authored text arrives unquoted and unlabelled, which is the " +
      "one defence that still holds for every known-not-caught payload",
  },
];

const readOriginal = async (mutation: Mutation): Promise<string> => {
  const path = resolve(REPO_ROOT, mutation.file);
  const original = await Bun.file(path).text();
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `${mutation.file}: expected exactly 1 occurrence of the mutated text, found ${String(occurrences)}. The code moved — update this mutation.`,
    );
  }
  return original;
};

const runTest = async (testPath: string): Promise<number> => {
  const proc = Bun.spawn({
    // process.execPath, not "bun": this has to work from a checkout where the
    // runtime is not on PATH, which is how it is invoked in CI.
    cmd: [process.execPath, "test", testPath],
    cwd: REPO_ROOT,
    stdout: "ignore",
    stderr: "ignore",
  });
  return proc.exited;
};

interface Outcome {
  readonly label: string;
  readonly caught: boolean;
}

/**
 * Guards already proven green this run, keyed by the GUARD TEST path — so that
 * is the grouping any count here has to be about. An earlier version of this
 * comment said "the same file backs 5 mutations", which is the count grouped by
 * the MUTATED SOURCE file (5 of the 7 edit sanitize.ts): a real number about a
 * different column of the same table, and not the one this map performs.
 *
 * VERIFY: bun -e 'const {MUTATIONS}=await import("./packages/connector-claude/scripts/mutation-check.ts");const m=new Map();for(const x of MUTATIONS)m.set(x.test.split("/").pop(),(m.get(x.test.split("/").pop())??0)+1);for(const [k,v] of [...m].sort())console.log(k,v)'
 * PRINTS: hook-time-budget.test.ts 1
 * PRINTS: injection-corpus.test.ts 6
 */
const greenGuards = new Map<string, boolean>();

/**
 * A guard that is ALREADY RED makes every "caught" beneath it a false positive.
 * `exitCode !== 0` cannot tell "the mutation broke it" from "it was broken
 * before I touched anything" — which is this script's own thesis, one level up,
 * and it had this defect itself.
 *
 * MEASURED, not hypothetical. In a container with no git installed,
 * test/helpers.ts `makeRepo` cannot create a repo, so
 * test/hook-time-budget.test.ts runs 0 pass / 5 fail UNMUTATED — and this script
 * still printed "maintenance spends the hook's reserve / caught by
 * packages/connector-claude/test/hook-time-budget.test.ts" and exited 0.
 * Reproduce both that and this guard's refusal to repeat it with:
 *
 *   docker run --rm -v "$PWD":/w -w /w --cpus=2 oven/bun:1 sh -c '
 *     bun install --frozen-lockfile >/dev/null 2>&1
 *     bun test packages/connector-claude/test/hook-time-budget.test.ts
 *     bun run packages/connector-claude/scripts/mutation-check.ts'
 *
 * — the missing `apt-get install -y git` is the whole point of that recipe.
 */
const assertGuardIsGreen = async (testPath: string): Promise<void> => {
  if (greenGuards.get(testPath) === true) {
    return;
  }
  const exitCode = await runTest(testPath);
  greenGuards.set(testPath, exitCode === 0);
  if (exitCode !== 0) {
    throw new Error(
      `${testPath} is already failing WITHOUT any mutation (exit ${String(exitCode)}). ` +
        "Every \"caught\" this script could report against it would be a false " +
        "positive, so the run is abandoned rather than manufacturing one. Run " +
        "that file on its own to see why; a container without git is the usual " +
        "cause, because test/helpers.ts makeRepo shells out to it.",
    );
  }
};

const applyAndRun = async (mutation: Mutation): Promise<Outcome> => {
  const path = resolve(REPO_ROOT, mutation.file);
  const original = await readOriginal(mutation);
  // Before the mutation, never after: a guard proven green only afterwards
  // would already have produced the false positive this prevents.
  await assertGuardIsGreen(mutation.test);
  try {
    await Bun.write(path, original.replace(mutation.from, mutation.to));
    const exitCode = await runTest(mutation.test);
    return { label: mutation.label, caught: exitCode !== 0 };
  } finally {
    await Bun.write(path, original);
  }
};

const main = async (): Promise<number> => {
  const outcomes: Outcome[] = [];
  for (const mutation of MUTATIONS) {
    process.stdout.write(`· ${mutation.label}\n`);
    let outcome: Outcome;
    try {
      outcome = await applyAndRun(mutation);
    } catch (error) {
      // An already-red guard, or a mutation whose text moved. Either way the
      // remaining results would be unreadable, so stop and say why.
      process.stdout.write(
        `::error::${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
    outcomes.push(outcome);
    process.stdout.write(
      outcome.caught
        ? `  caught by ${mutation.test}\n`
        : `::error::NOT CAUGHT by ${mutation.test} — ${mutation.because}\n`,
    );
  }
  const missed = outcomes.filter((outcome) => !outcome.caught);
  if (missed.length > 0) {
    process.stdout.write(
      `\n${String(missed.length)} of ${String(outcomes.length)} defects went undetected. Those checks are decoration.\n`,
    );
    return 1;
  }
  process.stdout.write(
    `\nall ${String(outcomes.length)} re-introduced defects were caught\n`,
  );
  return 0;
};

if (import.meta.main) {
  process.exit(await main());
}