/**
 * What `status` and `doctor` say about the pin registry (regression-guard
 * Stage 1, observability half). ONE module, because the two surfaces must
 * state the same facts the same way — the rule every other counter in this
 * product follows, and the reason drops, questions and solved pointers each
 * have a shared formatter rather than two hand-kept sentences. The pin
 * listing renders the same denominator through `pinCoverageSentence` too, so
 * there is exactly one of it in the tree.
 *
 * THE DENOMINATOR IS THE POINT. "pins: 4" is a number that reads as
 * protection; "pins: 4 (12 files, oldest verified 9d ago) — nothing else is
 * watched" is the same number telling the truth about every file nobody
 * pinned. A silent week must never be readable as safety, so the sentence
 * carries its own limit and is printed at zero as loudly as at four.
 *
 * THREE FAILURES THIS MODULE EXISTS TO MAKE VISIBLE, none of which anything
 * else in the tree would report:
 *
 *   1. A RENAME KILLED A PIN. `git mv` moves the file and the pin keeps
 *      watching a path that no longer exists — while a registry listing still
 *      counts it. That is fail-silent-dead, so a pin with missing paths is a
 *      WARN naming the remedy (`crosscheck pin --sweep`), never a row that
 *      quietly watches nothing.
 *   2. THE DENYLIST SHADOWS A PINNED FILE. The hot-file denylist lives in
 *      ~/.crosscheck/config.json — OUTSIDE every repo root, where no hook and
 *      no reviewer sees it change — and a denied path never becomes a target
 *      at all (flows/capture-targets.ts). So one `**\/workbench/**` line
 *      disables `suspect` over a whole area permanently and invisibly: the
 *      sessions that touched the pinned files record nothing, and `suspect`
 *      answers "no session touched this surface" with total confidence. The
 *      fix is a printed count, NOT an unwritable config: refusing the write
 *      would be a block, and the ladder forbids blocks.
 *   3. THE HUB DID NOT ANSWER. Coverage unknown is not coverage zero and is
 *      certainly not coverage fine. A hub that predates the registry answers
 *      404 — a deployment state that says nothing about this install — while
 *      a hub that could not be reached leaves the reader without the
 *      denominator, and that is a WARN.
 *
 * NO BACKTICKS, NO ANGLE BRACKETS, NO BACKSLASHES in any rendered sentence.
 * All three are renderer-owned characters under the shared corpus invariants
 * (test/fixtures/untrusted-invariants.ts: "no renderer here ever emits one"),
 * and this module is corpus-run, so the rule is enforced rather than
 * remembered. A command name therefore prints bare — `crosscheck pin --sweep`
 * inside a comment like this one, `crosscheck pin --sweep` without the marks
 * in the output — and a placeholder is named in words ("with the pin id")
 * rather than spelled with angle brackets.
 *
 * CLASSES: everything untrusted here is a BARE token — a repo-relative path
 * and a glob pattern — so it takes `bareUntrusted`, the same class the
 * tripwire renderer gives a repo-relative file. No prose from another person
 * reaches these lines, which is why neither surface needs the quoted-data
 * notice for them. A pin's SURFACE LABEL and its check recipe ARE prose, and
 * they stay in `crosscheck pin list`, which is framed and carries the notice.
 */
import { bareUntrusted } from "@crosscheck/connector-core/briefing/sanitize.ts";
import { formatAge } from "@crosscheck/connector-core/briefing/render.ts";
import {
  isDenied,
  matchesGlob,
} from "@crosscheck/connector-core/capture/denylist.ts";
import { MAX_PIN_PATH_CHARS } from "@crosscheck/schema";
import type {
  PinEntry,
  PinRegistry,
  TeamSettings,
} from "@crosscheck/connector-core/http/hub.ts";

/** How many shadowed paths are named before the tail becomes a count. */
const MAX_NAMED_SHADOWS = 3;

/** A repo-relative path is a BARE field, not an id: `safeId` has no slash. */
const token = (value: string): string =>
  bareUntrusted(value, MAX_PIN_PATH_CHARS);

const ageOf = (iso: string, now: Date): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "unknown" : `${formatAge(now.getTime() - ms)} ago`;
};

/**
 * THE DENOMINATOR, in one sentence, always — including the empty case, where
 * it matters most: a repo with no pins is a repo where nothing at all is
 * watched, and that has to be as easy to read as a repo with four.
 */
export const pinCoverageSentence = (
  registry: PinRegistry,
  now: Date,
): string => {
  const coverage = registry.coverage;
  if (coverage.pins === 0) {
    const retracted =
      coverage.broken === 0 ? "" : ` (${String(coverage.broken)} retracted)`;
    return `pins: 0${retracted} — nothing in this repo is watched`;
  }
  const parts = [
    `${String(coverage.files)} files`,
    ...(coverage.oldestVerifiedAt === null
      ? []
      : [`oldest verified ${ageOf(coverage.oldestVerifiedAt, now)}`]),
    ...(coverage.speaking >= coverage.pins
      ? []
      : [`${String(coverage.pins - coverage.speaking)} briefing-only`]),
    ...(coverage.broken === 0 ? [] : [`${String(coverage.broken)} retracted`]),
  ];
  return `pins: ${String(coverage.pins)} (${parts.join(", ")}) — nothing else is watched`;
};

/**
 * A live pin whose paths git can no longer find. Reported SEPARATELY from the
 * coverage sentence because it is a different fact: coverage says how much is
 * watched, this says how much of that is a lie.
 */
export const orphanedPins = (registry: PinRegistry): readonly PinEntry[] =>
  registry.pins.filter((pin) => pin.brokeAt === null && pin.missingPaths > 0);

export const orphanSentence = (
  orphans: readonly PinEntry[],
): string | null => {
  if (orphans.length === 0) {
    return null;
  }
  const paths = orphans.reduce((total, pin) => total + pin.missingPaths, 0);
  return (
    `${String(orphans.length)} pin(s) BROKEN — ${String(paths)} pinned path(s) no longer exist. ` +
    "A rename moves the file and the pin keeps watching the old name: " +
    "crosscheck pin --sweep re-resolves them; crosscheck pin --broke with the pin id retires it."
  );
};

export interface PinShadow {
  readonly path: string;
  readonly pattern: string;
}

/**
 * Every LIVE pinned path the effective denylist suppresses, with the pattern
 * that did it. The PATTERN is reported and not only the count, because "one
 * of your pins is invisible" without the line to delete is Google's bug
 * predictor: a flag with no named next action, which people learn to ignore.
 *
 * Cost is patterns x pinned paths, both bounded by the registry rather than
 * by the repo — a pin is capped at MAX_PIN_FILES paths and this walks nothing
 * else, so a repo of any size costs the same.
 */
export const shadowedPinPaths = (
  registry: PinRegistry,
  patterns: readonly string[],
): readonly PinShadow[] => {
  const shadows: PinShadow[] = [];
  const seen = new Set<string>();
  for (const pin of registry.pins) {
    if (pin.brokeAt !== null) {
      continue;
    }
    for (const file of pin.files) {
      if (seen.has(file.path) || !isDenied(file.path, patterns)) {
        continue;
      }
      seen.add(file.path);
      const pattern = patterns.find((candidate) =>
        matchesGlob(candidate, file.path),
      );
      shadows.push({ path: file.path, pattern: pattern ?? "(unknown)" });
    }
  }
  return shadows;
};

/**
 * The shadowing sentence. It says what the suppression COSTS — no target
 * record, so `suspect` answers "nobody touched this" with total confidence —
 * rather than only that it happened, because the consequence is the part a
 * reader cannot derive from the fact.
 */
export const shadowSentence = (
  shadows: readonly PinShadow[],
  patternCount: number,
): string => {
  if (shadows.length === 0) {
    return `no pinned file is shadowed by the ${String(patternCount)} effective hot-file pattern(s)`;
  }
  const named = shadows
    .slice(0, MAX_NAMED_SHADOWS)
    .map((shadow) => `${token(shadow.path)} (${token(shadow.pattern)})`)
    .join(", ");
  const rest = shadows.length - Math.min(shadows.length, MAX_NAMED_SHADOWS);
  return (
    `${String(shadows.length)} pinned file(s) are never captured — the hot-file denylist matches them: ` +
    `${named}${rest > 0 ? ` … and ${String(rest)} more` : ""} — ` +
    'no session records touching them, so crosscheck suspect answers "no session touched this surface" no matter who did'
  );
};

/**
 * This team's two settings, printed beside the coverage so that everybody the
 * feature is ABOUT can read what it does. `suspect` naming sessions is a
 * decision about what a tool makes visible concerning people; a team that has
 * it switched on should not have to read the source to find that out.
 */
export const guardSettingsSentence = (settings: TeamSettings): string => {
  const who =
    settings.pinPolicy === "anyone"
      ? "anyone may pin"
      : `pinning limited to ${token(settings.pinPolicy)}`;
  const names =
    settings.suspectAttribution === "sessions"
      ? "suspect names sessions and their declared intents"
      : "suspect prints counts only, naming nobody";
  const origin =
    settings.updatedAt === null ? "shipped defaults" : "set for this repo";
  return `guard settings: ${who} · ${names} (${origin})`;
};

/**
 * The whole `status` block, in reading order: the denominator, then what is
 * broken, then what is suppressed, then the settings that explain the shape
 * of all three. A reader who stops after one line still has the denominator.
 */
export const pinStatusLines = (
  registry: PinRegistry,
  patterns: readonly string[],
  settings: TeamSettings | null,
  now: Date,
): readonly string[] => {
  const orphans = orphanSentence(orphanedPins(registry));
  const shadows = shadowedPinPaths(registry, patterns);
  return [
    pinCoverageSentence(registry, now),
    ...(orphans === null ? [] : [`  ${orphans}`]),
    ...(shadows.length === 0
      ? []
      : [`  ${shadowSentence(shadows, patterns.length)}`]),
    ...(settings === null ? [] : [guardSettingsSentence(settings)]),
  ];
};
