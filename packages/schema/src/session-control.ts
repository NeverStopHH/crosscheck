/**
 * Words that steer the SESSION rather than name a task (DESIGN.md §4,
 * review 1006b decision 2). Two closed lists, English and German — the
 * languages the stop lists cover — and the only lists of words this
 * product keeps: function words come from the database (stop-words.ts).
 *
 * STEERING WORDS — continue, weiter, mache, resume, please, bitte, next,
 * step, nochmal … — are never a task word, anywhere: prompt-terms.ts drops
 * them before the verdict and before the hub counts a single shared term,
 * so "mache weiter mit den Tests, limit zurückgesetzt, bitte" cannot reach
 * the limit tree on "mache" and "bitte" (H1). A few of them CONTINUE the
 * session's work (CONTINUATION_TRIGGERS).
 *
 * SESSION-META WORDS — limit, usage, retry, restart, session, context — and
 * the RESET REPORTS beside them — reset, zurückgesetzt, frei, back — are
 * steering only when a continuation trigger AND a reset report stand in the
 * same prompt: "the limit was reset, continue" reports the session, "why
 * does the usage limit reset" asks about the product (M3).
 *
 * TYPO TOLERANCE NEVER MAPS A REAL WORD, AND ONLY TRIGGERS GET IT: a
 * typist's swapped neighbours in a trigger of TRANSPOSITION_MIN_LETTERS or
 * more, two of them from DOUBLE_TRANSPOSITION_MIN_LETTERS ("contineu",
 * "wieter", "wiederuafnhemen"). A trigger is the one word whose slip changes
 * the verdict — it decides whether "limit reset" is a report or a task —
 * while a mistyped "plaese" is a word no tree holds. session-control.test.ts
 * runs the whole system dictionary and a German sample through the matcher;
 * a word that maps to a steering word other than itself fails the suite
 * (with the tolerance on every steering word it found "Greta", "prefect",
 * "waesome", "genua"; with one more edit, "einverstandene"). Everything else
 * matches exactly, after folding.
 */

/** Verbs and particles that carry the session's work on. */
const CONTINUATION_TRIGGERS: readonly string[] = [
  "continue", "continuing", "resume", "carry", "keep", "going", "ahead", "try",
  "weiter", "weitermachen", "fortfahren", "fortsetzen", "fahre", "fahr", "fort", "wiederaufnehmen",
  "versuch", "versuche", "versuchen", "probier", "probiere", "probieren",
];

/** Steering that continues nothing by itself: assent, politeness, sequencing. */
const OTHER_STEERING: readonly string[] = [
  "proceed", "please", "pls", "okay", "yes", "yeah", "yep", "sure", "thanks", "thank", "cool",
  "great", "good", "fine", "perfect", "nice", "awesome", "sounds", "looks", "lgtm", "ship", "next",
  "step", "let", "alright",
  "mach", "mache", "bitte", "danke", "gut", "super", "perfekt", "passt", "klar", "prima", "toll",
  "nochmal", "erneut", "einfach", "schon", "mal", "los", "nachsten", "nachste", "nachster",
  "naechsten", "naechste", "naechster", "schritt", "schritte", "einverstanden", "umsetzen",
  "klingt", "genau", "jawohl",
];

/** The session's own machinery, as a reset report names it. */
const SESSION_META: readonly string[] = [
  "limit", "limits", "usage", "retry", "retries", "restart", "restarts", "session", "sessions",
  "context", "quota", "quotas", "rate", "kontingent", "sitzung", "kontext", "neustart", "nutzung",
  "zurucksetzen", "zuruecksetzen",
];

/** Words that report the machinery is back. */
const RESET_REPORTS: readonly string[] = [
  "reset", "resets", "zuruckgesetzt", "zurueckgesetzt", "frei", "back", "available", "cleared",
  "lifted", "renewed", "refilled", "restored",
];

/** A trigger this long may carry one swapped pair of neighbours. */
const TRANSPOSITION_MIN_LETTERS = 5;
/** A trigger this long may carry two. */
const DOUBLE_TRANSPOSITION_MIN_LETTERS = 10;

const STEERING_SET: ReadonlySet<string> = new Set([...CONTINUATION_TRIGGERS, ...OTHER_STEERING]);
const TRIGGER_SET: ReadonlySet<string> = new Set(CONTINUATION_TRIGGERS);
const META_SET: ReadonlySet<string> = new Set([...SESSION_META, ...RESET_REPORTS]);
const REPORT_SET: ReadonlySet<string> = new Set(RESET_REPORTS);

/** Lower case, accents off, ß as ss: "Zurückgesetzt" is "zuruckgesetzt". */
const foldWord = (word: string): string =>
  word.normalize("NFKD").replace(/\p{M}/gu, "").replace(/ß/g, "ss").toLowerCase();

/**
 * How many disjoint swaps of neighbours turn `a` into `b` — Infinity when
 * anything else differs. One linear pass.
 */
const swapsBetween = (a: string, b: string): number => {
  if (a.length !== b.length) {
    return Number.POSITIVE_INFINITY;
  }
  const step = (index: number, swaps: number): number => {
    if (index >= a.length) {
      return swaps;
    }
    if (a[index] === b[index]) {
      return step(index + 1, swaps);
    }
    const isSwap = a[index] === b[index + 1] && a[index + 1] === b[index];
    return isSwap ? step(index + 2, swaps + 1) : Number.POSITIVE_INFINITY;
  };
  return step(0, 0);
};

const isTypoOf = (folded: string, trigger: string): boolean => {
  const allowedSwaps =
    trigger.length >= DOUBLE_TRANSPOSITION_MIN_LETTERS ? 2 : trigger.length >= TRANSPOSITION_MIN_LETTERS ? 1 : 0;
  return swapsBetween(folded, trigger) <= allowedSwaps;
};

/** The steering word `word` is — a trigger with a typist's swap included — or null. */
export const steeringWordOf = (word: string): string | null => {
  const folded = foldWord(word);
  if (STEERING_SET.has(folded)) {
    return folded;
  }
  return CONTINUATION_TRIGGERS.find((trigger) => isTypoOf(folded, trigger)) ?? null;
};

/** A verb or particle that carries the session's work on. */
export const isContinuationTrigger = (word: string): boolean => {
  const steering = steeringWordOf(word);
  return steering !== null && TRIGGER_SET.has(steering);
};

/** limit, usage, retry, session … — or a reset report. */
export const isSessionMetaWord = (word: string): boolean => META_SET.has(foldWord(word));

/** reset, zurückgesetzt, frei, back … */
export const isResetReport = (word: string): boolean => REPORT_SET.has(foldWord(word));
