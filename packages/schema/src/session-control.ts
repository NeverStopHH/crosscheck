/**
 * Words that steer the SESSION rather than name a task (DESIGN.md §4): a
 * prompt made only of them — "mache weiter, limit zurückgesetzt, bitte alles
 * wiederaufnehmen", "please continue, the limit was reset" — is content-free,
 * typos or not. Live on 0.10.0, exactly that prompt pointed at an unrelated
 * teammate tree whose German claim shared "mache", "Limit" and "bitte".
 *
 * A WHOLE-PROMPT RULE, NEVER A WORD FILTER: one task word beside them makes
 * it a prompt again, and then every word counts as before — "limit" is the
 * point of "rate limit headers missing". So this list can only cost a hint on
 * a prompt of nothing but these words; capture never reads it.
 *
 * WHAT IT IS NOT: a stop list. The hub's two stop lists (PostgreSQL's English
 * and German) run first and already drop "weiter", "alles", "machen", "jetzt",
 * "again"; these are the session-steering words those lists keep. Covered:
 * English and German, the languages the stop lists cover.
 *
 * TYPOS: a word within a few edits of one of these counts as it — none at
 * five letters or fewer, so "cache" is never "mache"; then one, two, three as
 * the words grow ("macxhe", "zurukgsetz", "wiederuafnhemen"). Optimal string
 * alignment distance: a swapped pair is one edit, as a typist makes it.
 */

/** Session-steering words the English and German stop lists keep, folded. */
const SESSION_CONTROL_WORDS: readonly string[] = [
  // English
  "continue", "resume", "proceed", "carry", "keep", "going", "retry", "restart",
  "please", "everything", "limit", "reset", "usage", "okay", "thanks", "yes",
  // German
  "mach", "mache", "bitte", "fortsetzen", "fortfahren", "weitermachen",
  "wiederaufnehmen", "zuruckgesetzt", "zurucksetzen", "nochmal", "erneut",
  "danke", "einfach", "schon", "mal", "los",
];

/** [longest word length, edits allowed] — beyond the last row, LONG_WORD_EDITS. */
const TYPO_EDITS_BY_LENGTH: readonly (readonly [number, number])[] = [
  [5, 0],
  [8, 1],
  [12, 2],
];
const LONG_WORD_EDITS = 3;

/** Lower case, accents off, ß as ss: "Zurückgesetzt" is "zuruckgesetzt". */
const fold = (word: string): string =>
  word.normalize("NFKD").replace(/\p{M}/gu, "").replace(/ß/g, "ss").toLowerCase();

const editsAllowed = (length: number): number =>
  TYPO_EDITS_BY_LENGTH.find(([longest]) => length <= longest)?.[1] ?? LONG_WORD_EDITS;

/**
 * Optimal string alignment distance — insert, delete, substitute, swap two
 * neighbours — one row at a time, each row built from the two before it.
 */
const typoDistance = (a: string, b: string): number => {
  const firstRow = Array.from({ length: b.length + 1 }, (_, j) => j);
  const { oneBack } = [...a].reduce(
    ({ twoBack, oneBack: above }, charA, aIndex) => {
      const i = aIndex + 1;
      const row = [...b].reduce<readonly number[]>((built, charB, bIndex) => {
        const j = bIndex + 1;
        const best = Math.min(above[j]! + 1, built[j - 1]! + 1, above[j - 1]! + (charA === charB ? 0 : 1));
        const swapped = i > 1 && j > 1 && charA === b[j - 2] && a[i - 2] === charB;
        return [...built, swapped ? Math.min(best, twoBack[j - 2]! + 1) : best];
      }, [i]);
      return { twoBack: above, oneBack: row };
    },
    { twoBack: firstRow as readonly number[], oneBack: firstRow as readonly number[] },
  );
  return oneBack[b.length]!;
};

const isControlWord = (word: string): boolean => {
  const folded = fold(word);
  return SESSION_CONTROL_WORDS.some((control) => {
    const allowed = editsAllowed(Math.max(folded.length, control.length));
    return (
      Math.abs(folded.length - control.length) <= allowed &&
      typoDistance(folded, control) <= allowed
    );
  });
};

/**
 * True when every word is one that steers the session — the prompt carries
 * no task. Empty is false: nothing said is not a command either, and the
 * content floor already finds nothing for it.
 */
export const isSessionControlOnly = (words: readonly string[]): boolean =>
  words.length > 0 && words.every(isControlWord);
