/**
 * Sweeps EVERY Unicode Default_Ignorable code point through the real briefing
 * renderer and reports which ones still change what the reader sees.
 *
 * Why this exists as a script rather than a sentence in a comment: a previous
 * round justified the sanitizer's width with "a 43-character probe", and the
 * probe set was never committed, so the figure could not be re-derived by
 * anyone. (HISTORICAL — that probe never existed in this tree and no command
 * recovers it. It is named only to record what this script replaced.)
 * Default_Ignorable is the property Unicode itself uses for "renders as
 * nothing", so it is the honest universe to sweep, and sweeping all of it is
 * cheap enough to do on every CI run.
 *
 *   bun run packages/connector-core/scripts/default-ignorable-sweep.ts
 *   ... --verbose      # list every altered code point rather than the first few
 *
 * Exit 0 when the observed altered set equals RECORDED_ALTERATIONS below, 1 when
 * it differs — so a narrowed sanitizer, or a runtime whose Unicode tables
 * disagree with ours, fails here instead of silently ageing a comment. Run in
 * CI's `test` job on both platforms (.github/workflows/ci.yml).
 *
 * METHOD. Each code point is planted MID-WORD in a work-context title,
 * `rate<CP>limit fix`, and the whole briefing is rendered. Mid-word is what
 * makes the three outcomes distinguishable:
 *
 *   removed      the briefing reads «ratelimit fix» — the words rejoin exactly
 *                as the reader saw them, which is what keeps the phrase filter
 *                able to see `ignore previous` through a planted zero-width.
 *   spaced       the briefing reads «rate limit fix» — a word break that was
 *                never on screen was invented. For a character with no width
 *                that is itself the bypass, not a fix for it.
 *   survives     the code point is still there in a rendered line, i.e. it
 *                reaches the reader's context verbatim.
 *
 * "Altered" below means any outcome other than `removed`: the rendered output
 * is not what a clean title would have produced.
 */
import { renderBriefing } from "../src/index.ts";
import type { PresenceEntry, WorkContextEntry } from "../src/http/hub.ts";

const NOW = new Date("2026-07-20T12:00:00.000Z");
const RECENT = new Date(NOW.getTime() - 30_000).toISOString();
const REPO_ID = "github.com/acme/api";
const MAX_CODE_POINT = 0x10ffff;

const CLEAN = "«ratelimit fix»";
const SPACED = "«rate limit fix»";
/** Without --verbose: enough to read at a glance, and a count for the rest. */
const MAX_LISTED = 40;

const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const UNASSIGNED = /\p{Cn}/u;

const CATEGORIES: readonly (readonly [string, RegExp])[] = [
  ["Cc", /\p{Cc}/u],
  ["Cf", /\p{Cf}/u],
  ["Cn", /\p{Cn}/u],
  ["Co", /\p{Co}/u],
  ["Mn", /\p{Mn}/u],
  ["Lo", /\p{Lo}/u],
  ["Zs", /\p{Zs}/u],
];

const categoryOf = (character: string): string =>
  CATEGORIES.find(([, pattern]) => pattern.test(character))?.[0] ?? "other";

const hex = (codePoint: number): string =>
  `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;

type Kind = "removed" | "spaced" | "survives" | "transformed";

interface Alteration {
  readonly kind: Kind;
  readonly reason: string;
}

/**
 * Every Default_Ignorable code point this sanitizer knowingly still lets change
 * the rendered output, with the reason. Kept as data rather than prose so the
 * script can compare against it: a new one is a diff, not a paragraph somebody
 * has to notice. The long-form reasoning for each lives in briefing/sanitize.ts
 * under DELIBERATELY NOT COVERED, and these are the only entries there.
 */
const RECORDED_ALTERATIONS: Readonly<Record<number, Alteration>> = {
  0x115f: {
    kind: "survives",
    reason:
      "HANGUL CHOSEONG FILLER — category Lo, a letter; stripping letters is a different and riskier defence",
  },
  0x1160: {
    kind: "survives",
    reason: "HANGUL JUNGSEONG FILLER — category Lo, and the NFKC target of U+3164 and U+FFA0",
  },
  0x17b4: {
    kind: "survives",
    reason: "KHMER VOWEL INHERENT AQ — Mn, part of a living script's orthography",
  },
  0x17b5: {
    kind: "survives",
    reason: "KHMER VOWEL INHERENT AA — Mn, part of a living script's orthography",
  },
  0x3164: {
    kind: "transformed",
    reason: "HANGUL FILLER — Lo; NFKC folds it to U+1160 before the strip, so U+1160 is what reaches the reader",
  },
  0xffa0: {
    kind: "transformed",
    reason: "HALFWIDTH HANGUL FILLER — Lo; NFKC folds it to U+1160 before the strip",
  },
};

interface Outcome {
  readonly codePoint: number;
  readonly kind: Kind;
}

const presence = (): readonly PresenceEntry[] => [
  {
    sessionId: "cc_clean",
    developerId: "dev_clean",
    developerName: "Mara",
    branch: "main",
    status: "implementing",
    lastHeartbeatAt: RECENT,
    isSelf: false,
  },
];

const contextWith = (title: string): readonly WorkContextEntry[] => [
  {
    id: "wc_probe",
    developerId: "dev_attacker",
    developerName: "Robin",
    title,
    status: "implementing",
    createdAt: RECENT,
    updatedAt: null,
  },
];

const renderTitle = (title: string): string =>
  renderBriefing({
    repoId: REPO_ID,
    selfDeveloperId: "dev_self",
    presence: presence(),
    workContexts: contextWith(title),
    now: NOW,
  });

/** Per LINE: the briefing joins its lines with U+000A, its own separator. */
const carries = (output: string, codePoint: number): boolean =>
  output
    .split("\n")
    .some((line) =>
      [...line].some((character) => character.codePointAt(0) === codePoint),
    );

const probe = (codePoint: number): Outcome => {
  const output = renderTitle(`rate${String.fromCodePoint(codePoint)}limit fix`);
  if (output.includes(CLEAN)) {
    return { codePoint, kind: "removed" };
  }
  if (carries(output, codePoint)) {
    return { codePoint, kind: "survives" };
  }
  if (output.includes(SPACED)) {
    return { codePoint, kind: "spaced" };
  }
  return { codePoint, kind: "transformed" };
};

const defaultIgnorable = (): readonly number[] => {
  const found: number[] = [];
  for (let codePoint = 0; codePoint <= MAX_CODE_POINT; codePoint += 1) {
    if (DEFAULT_IGNORABLE.test(String.fromCodePoint(codePoint))) {
      found.push(codePoint);
    }
  }
  return found;
};

const describe = (codePoint: number): string => {
  const character = String.fromCodePoint(codePoint);
  const assigned = UNASSIGNED.test(character) ? "unassigned" : "assigned";
  return `${hex(codePoint)}  ${categoryOf(character)}  ${assigned}`;
};

const countBy = (outcomes: readonly Outcome[], kind: Kind): number =>
  outcomes.filter((outcome) => outcome.kind === kind).length;

const main = (verbose: boolean): number => {
  const all = defaultIgnorable();
  const assigned = all.filter(
    (codePoint) => !UNASSIGNED.test(String.fromCodePoint(codePoint)),
  );
  const outcomes = all.map(probe);
  const altered = outcomes.filter((outcome) => outcome.kind !== "removed");

  const out = process.stdout;
  out.write(`platform  ${process.platform}/${process.arch}\n`);
  out.write(`swept     ${String(all.length)} Default_Ignorable code points\n`);
  out.write(`assigned  ${String(assigned.length)} of them\n`);
  out.write(
    `altered   ${String(altered.length)} changed the rendered output ` +
      `(${String(countBy(altered, "survives"))} survive verbatim, ` +
      `${String(countBy(altered, "spaced"))} spaced, ` +
      `${String(countBy(altered, "transformed"))} otherwise transformed)\n`,
  );
  out.write(`removed   ${String(countBy(outcomes, "removed"))} left no trace\n\n`);

  const shown = verbose ? altered : altered.slice(0, MAX_LISTED);
  for (const outcome of shown) {
    const recorded = RECORDED_ALTERATIONS[outcome.codePoint];
    const reason =
      recorded === undefined
        ? "NOT RECORDED"
        : recorded.kind === outcome.kind
          ? recorded.reason
          : `RECORDED AS ${recorded.kind}: ${recorded.reason}`;
    out.write(`${outcome.kind.padEnd(11)} ${describe(outcome.codePoint)}  ${reason}\n`);
  }
  if (shown.length < altered.length) {
    out.write(
      `... and ${String(altered.length - shown.length)} more; pass --verbose to list every one\n`,
    );
  }

  const mismatched = altered.filter(
    (outcome) => RECORDED_ALTERATIONS[outcome.codePoint]?.kind !== outcome.kind,
  );
  const observed = new Set(altered.map((outcome) => outcome.codePoint));
  const gone = Object.keys(RECORDED_ALTERATIONS)
    .map(Number)
    .filter((codePoint) => !observed.has(codePoint));
  if (mismatched.length === 0 && gone.length === 0) {
    out.write(
      `\nthe altered set is exactly the ${String(observed.size)} recorded in this script\n`,
    );
    return 0;
  }
  for (const outcome of mismatched) {
    out.write(
      `::error::UNRECORDED ${outcome.kind} ${describe(outcome.codePoint)} — strip it, or record it here with a reason\n`,
    );
  }
  for (const codePoint of gone) {
    out.write(
      `::error::${describe(codePoint)} no longer alters the output — delete its RECORDED_ALTERATIONS entry\n`,
    );
  }
  return 1;
};

if (import.meta.main) {
  process.exit(main(process.argv.includes("--verbose")));
}
