/**
 * THE ENGLISH STEM, AS THE HUB'S DATABASE COMPUTES IT (hold-out review round
 * 3, follow-up). The hub matched a prompt's words on PostgreSQL's english
 * lexemes, and a connector recounting an old hub matched them as written, so
 * "shows" was a topic on one side and the conversation word "show" on the
 * other. This is Snowball's English (Porter2) algorithm exactly as
 * PostgreSQL's english_stem dictionary runs it — the classic version, R1
 * exceptions gener, commun and arsen — so both sides call one function and
 * the database itself is the reference it is pinned against
 * (server/test/english-stem-parity.test.ts).
 *
 * The input is one lower-case word; a non-ASCII letter is never a vowel, as
 * in the database's UTF-8 stemmer.
 */

const VOWELS = "aeiouy";
/** What the last letter of a short syllable may not be: a vowel, w, x or a consonant Y. */
const VOWELS_WXY = "aeiouywxY";
/** The letters a deletable "li" may follow (step 2). */
const VALID_LI_ENDINGS = "cdeghkmnrt";
/** A word this short is its own stem. */
const MIN_STEMMED_CHARS = 3;

const isVowel = (char: string | undefined): boolean => char !== undefined && VOWELS.includes(char);

/** Whole words with a stem of their own, decided before any step. */
const EXCEPTIONAL_WORDS: ReadonlyMap<string, string> = new Map([
  ["skis", "ski"], ["skies", "sky"], ["dying", "die"], ["lying", "lie"], ["tying", "tie"],
  ["idly", "idl"], ["gently", "gentl"], ["ugly", "ugli"], ["early", "earli"], ["only", "onli"], ["singly", "singl"],
  ["sky", "sky"], ["news", "news"], ["howe", "howe"], ["atlas", "atlas"], ["cosmos", "cosmos"], ["bias", "bias"], ["andes", "andes"],
]);

/** Words left as they are once step 1a has run. */
const INVARIANT_AFTER_1A: ReadonlySet<string> = new Set(["inning", "outing", "canning", "herring", "earring", "proceed", "exceed", "succeed"]);

/** Prefixes after which R1 begins, whatever the vowels say. */
const R1_PREFIXES = ["gener", "commun", "arsen"] as const;

/** A y at the start, or after a vowel, is a consonant: marked Y until the end. */
const withConsonantYs = (word: string): string =>
  [...word].reduce<string>((marked, char, index) => marked + (char === "y" && (index === 0 || isVowel(marked[index - 1])) ? "Y" : char), "");

/** The index after the first non-vowel that follows a vowel, searching from `from`; the word's length if none. */
const regionAfter = (word: string, from: number): number => {
  const vowel = [...word].findIndex((char, index) => index >= from && isVowel(char));
  if (vowel < 0) {
    return word.length;
  }
  const consonant = [...word].findIndex((char, index) => index > vowel && !isVowel(char));
  return consonant < 0 ? word.length : consonant + 1;
};

interface Regions {
  readonly r1: number;
  readonly r2: number;
}

const regionsOf = (word: string): Regions => {
  const prefix = R1_PREFIXES.find((candidate) => word.startsWith(candidate));
  const r1 = prefix === undefined ? regionAfter(word, 0) : prefix.length;
  return { r1, r2: regionAfter(word, r1) };
};

/** The longest of `suffixes` the word ends with. */
const longestSuffix = (word: string, suffixes: readonly string[]): string | undefined =>
  [...suffixes].sort((left, right) => right.length - left.length).find((suffix) => word.endsWith(suffix));

/** A short syllable ends the text: consonant, vowel, consonant other than w, x or Y — or vowel, consonant as the whole text. */
const endsWithShortSyllable = (text: string): boolean => {
  const last = text[text.length - 1];
  const vowel = text[text.length - 2];
  const before = text[text.length - 3];
  return (
    (text.length >= 3 && last !== undefined && !VOWELS_WXY.includes(last) && isVowel(vowel) && !isVowel(before)) ||
    (text.length === 2 && !isVowel(last) && isVowel(vowel))
  );
};

const step1a = (word: string): string => {
  const suffix = longestSuffix(word, ["sses", "ied", "ies", "us", "ss", "s"]);
  if (suffix === "sses") {
    return word.slice(0, -2);
  }
  if (suffix === "ied" || suffix === "ies") {
    const stem = word.slice(0, -3);
    return stem + (stem.length >= 2 ? "i" : "ie");
  }
  if (suffix === "s") {
    // Deleted when a vowel stands somewhere before the letter in front of the s.
    const stem = word.slice(0, -1);
    return [...stem.slice(0, -1)].some(isVowel) ? stem : word;
  }
  return word;
};

const DOUBLES = ["bb", "dd", "ff", "gg", "mm", "nn", "pp", "rr", "tt"] as const;

/** What step 1b does to a stem once its ed or ing is gone. */
const afterEdOrIng = (stem: string, regions: Regions): string => {
  if (["at", "bl", "iz"].some((ending) => stem.endsWith(ending))) {
    return `${stem}e`;
  }
  if (DOUBLES.some((double) => stem.endsWith(double))) {
    return stem.slice(0, -1);
  }
  return stem.length === regions.r1 && endsWithShortSyllable(stem) ? `${stem}e` : stem;
};

const step1b = (word: string, regions: Regions): string => {
  const suffix = longestSuffix(word, ["eed", "eedly", "ed", "edly", "ing", "ingly"]);
  if (suffix === undefined) {
    return word;
  }
  const stem = word.slice(0, -suffix.length);
  if (suffix === "eed" || suffix === "eedly") {
    return stem.length >= regions.r1 ? `${stem}ee` : word;
  }
  return [...stem].some(isVowel) ? afterEdOrIng(stem, regions) : word;
};

/** A final y after a consonant that is not the first letter becomes i. */
const step1c = (word: string): string => {
  const last = word[word.length - 1];
  return (last === "y" || last === "Y") && word.length >= MIN_STEMMED_CHARS && !isVowel(word[word.length - 2])
    ? `${word.slice(0, -1)}i`
    : word;
};

/** One rule of steps 2 to 4: a suffix, what replaces it, and what the letter before it must be. */
interface SuffixRule {
  readonly replacement: string;
  readonly precededBy?: string;
}

const rule = (replacement: string, precededBy?: string): SuffixRule => ({ replacement, ...(precededBy === undefined ? {} : { precededBy }) });

const STEP2_RULES: ReadonlyMap<string, SuffixRule> = new Map([
  ["tional", rule("tion")], ["enci", rule("ence")], ["anci", rule("ance")], ["abli", rule("able")], ["entli", rule("ent")],
  ["izer", rule("ize")], ["ization", rule("ize")], ["ational", rule("ate")], ["ation", rule("ate")], ["ator", rule("ate")],
  ["alism", rule("al")], ["aliti", rule("al")], ["alli", rule("al")], ["fulness", rule("ful")], ["ousli", rule("ous")],
  ["ousness", rule("ous")], ["iveness", rule("ive")], ["iviti", rule("ive")], ["biliti", rule("ble")], ["bli", rule("ble")],
  ["ogi", rule("og", "l")], ["fulli", rule("ful")], ["lessli", rule("less")], ["li", rule("", VALID_LI_ENDINGS)],
]);

const STEP3_RULES: ReadonlyMap<string, SuffixRule> = new Map([
  ["tional", rule("tion")], ["ational", rule("ate")], ["alize", rule("al")], ["icate", rule("ic")], ["iciti", rule("ic")],
  ["ical", rule("ic")], ["ful", rule("")], ["ness", rule("")], ["ative", rule("")],
]);

const STEP4_RULES: ReadonlyMap<string, SuffixRule> = new Map([
  ...["al", "ance", "ence", "er", "ic", "able", "ible", "ant", "ement", "ment", "ent", "ism", "ate", "iti", "ous", "ive", "ize"].map(
    (suffix): [string, SuffixRule] => [suffix, rule("")],
  ),
  ["ion", rule("", "st")],
]);

/**
 * The longest suffix of the rules, replaced when it begins at or after
 * `regionStart` and the letter before it is one it allows. A longest suffix
 * that fails its conditions changes nothing: there is no falling back to a
 * shorter one.
 */
const replaceSuffix = (word: string, rules: ReadonlyMap<string, SuffixRule>, regionStart: (suffix: string) => number): string => {
  const suffix = longestSuffix(word, [...rules.keys()]);
  const found = suffix === undefined ? undefined : rules.get(suffix);
  if (suffix === undefined || found === undefined) {
    return word;
  }
  const start = word.length - suffix.length;
  const before = word[start - 1];
  const isAllowed = found.precededBy === undefined || (before !== undefined && found.precededBy.includes(before));
  return start >= regionStart(suffix) && isAllowed ? word.slice(0, start) + found.replacement : word;
};

const step2 = (word: string, regions: Regions): string => replaceSuffix(word, STEP2_RULES, () => regions.r1);

/** Step 3 works in R1, and "ative" in R2. */
const step3 = (word: string, regions: Regions): string =>
  replaceSuffix(word, STEP3_RULES, (suffix) => (suffix === "ative" ? Math.max(regions.r1, regions.r2) : regions.r1));

const step4 = (word: string, regions: Regions): string => replaceSuffix(word, STEP4_RULES, () => regions.r2);

const step5 = (word: string, regions: Regions): string => {
  const start = word.length - 1;
  const stem = word.slice(0, -1);
  if (word.endsWith("e")) {
    return start >= regions.r2 || (start >= regions.r1 && !endsWithShortSyllable(stem)) ? stem : word;
  }
  return word.endsWith("l") && start >= regions.r2 && stem.endsWith("l") ? stem : word;
};

/** The english_stem of one lower-case word. */
export const englishStem = (word: string): string => {
  const exceptional = EXCEPTIONAL_WORDS.get(word);
  if (exceptional !== undefined) {
    return exceptional;
  }
  if (word.length < MIN_STEMMED_CHARS) {
    return word;
  }
  const marked = withConsonantYs(word.startsWith("'") ? word.slice(1) : word);
  const regions = regionsOf(marked);
  const afterOneA = step1a(marked);
  const stemmed = INVARIANT_AFTER_1A.has(afterOneA)
    ? afterOneA
    : [step1b, step1c, step2, step3, step4, step5].reduce((current, step) => step(current, regions), afterOneA);
  return stemmed.replaceAll("Y", "y");
};
