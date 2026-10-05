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
  DEFAULT_DENYLIST,
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
  /** The rule named: this machine's first match, else the shipped list's. */
  readonly pattern: string;
  /** This machine's capture excludes it too; false = only machines that keep the shipped list do. */
  readonly here: boolean;
  /**
   * The first shipped rule that matches, whether or not a local one does:
   * every teammate who kept the defaults applies it, so no config on this
   * machine can lift the exclusion. Null = only this machine's list excludes it.
   */
  readonly shippedPattern: string | null;
}

/** How a rule that binds only OTHER machines is named, after the rule itself. */
const ELSEWHERE = "on machines that keep the shipped denylist";
/** How a rule that binds only THIS machine is named, after the rule itself. */
const HERE_ONLY = "on this machine only";

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
): readonly PinShadow[] =>
  deniedPinPaths(
    [
      ...new Set(
        registry.pins
          .filter((pin) => pin.brokeAt === null)
          .flatMap((pin) => pin.files.map((file) => file.path)),
      ),
    ],
    patterns,
  );

/**
 * Each of `paths` a pin cannot guard, with the rule that excludes it. One
 * question with four askers — the pin door and the sweep over paths about to
 * be pinned, the status and doctor shadow line over the registry
 * (loss-accounting §10 item 4) — so they cannot disagree.
 *
 * TWO LISTS, because the denylist is per-machine config: `local` is the
 * caller's `resolveDenylist` answer, what capture HERE applies, and the
 * shipped defaults are what every teammate who kept them applies. A
 * developer whose config replaces the defaults still has those teammates, and
 * on each of their machines a pin over `yarn.lock` is blind while it reads
 * as a guard. The shipped half is decided by a MATCH, never by comparing rule
 * text, so a local `*.lock` backed by the shipped `**\/*.lock` is still known
 * to be unliftable.
 */
export const deniedPinPaths = (
  paths: readonly string[],
  local: readonly string[],
): readonly PinShadow[] =>
  paths.flatMap((path) => {
    const localPattern = local.find((candidate) => matchesGlob(candidate, path));
    const shippedPattern = DEFAULT_DENYLIST.find((candidate) => matchesGlob(candidate, path));
    const pattern = localPattern ?? shippedPattern;
    return pattern === undefined
      ? []
      : [{ path, pattern, here: localPattern !== undefined, shippedPattern: shippedPattern ?? null }];
  });

/**
 * WHERE an excluded file goes unrecorded — the three reaches a match can
 * have, because the denylist is per-machine config. Every sentence below
 * says only what is true of its reach: a file this machine's own rule skips
 * IS recorded by a teammate on the shipped list, and a file only the shipped
 * list skips IS recorded here.
 */
type ShadowReach = "everywhere" | "here" | "elsewhere";

interface Reachable {
  readonly here: boolean;
  readonly shippedPattern: string | null;
}

const reachOf = (shadow: Reachable): ShadowReach =>
  !shadow.here ? "elsewhere" : shadow.shippedPattern === null ? "here" : "everywhere";

const REACHES: readonly ShadowReach[] = ["everywhere", "here", "elsewhere"];

/** Why a pin over a file is refused, by reach (loss-accounting §10 item 4). */
export const DENYLIST_REFUSAL_WHY =
  "no session here, nor on any machine that keeps the shipped denylist, records touching them";
export const DENYLIST_REFUSAL_WHY_HERE =
  "this machine's own denylist skips them; teammates who kept the shipped denylist record them";
export const DENYLIST_REFUSAL_WHY_ELSEWHERE =
  "this machine records touching them, but no machine that keeps the shipped denylist does";

const WHY_BY_REACH: Readonly<Record<ShadowReach, string>> = {
  everywhere: DENYLIST_REFUSAL_WHY,
  here: DENYLIST_REFUSAL_WHY_HERE,
  elsewhere: DENYLIST_REFUSAL_WHY_ELSEWHERE,
};

/** The consequence every reach shares, said once after its reasons. */
const GUARD_COST = "a guard over a file some sessions never record could never say who broke it";

const capitalised = (sentence: string): string =>
  `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;

const excludedBy = (shadow: Reachable & { readonly pattern: string }): string => {
  const reach = reachOf(shadow);
  const rule = `excluded by ${token(shadow.pattern)}`;
  return reach === "everywhere" ? rule : `${rule} ${reach === "here" ? HERE_ONLY : ELSEWHERE}`;
};

/**
 * One reason line per reach present, each NAMING the files it is about — never
 * one sentence over the whole list that is false of some of them.
 */
const refusalWhyLines = <T extends Reachable>(
  items: readonly T[],
  pathOf: (item: T) => string,
): readonly string[] =>
  REACHES.flatMap((reach) => {
    const files = items.filter((item) => reachOf(item) === reach).map(pathOf);
    return files.length === 0 ? [] : [`${files.map(token).join(", ")}: ${WHY_BY_REACH[reach]}`];
  });

/**
 * WHAT THE PIN DOOR PRINTS when the denylist excludes a file (loss-accounting
 * §10 item 4). EVERY excluded file is named with its rule — not the first
 * three the status line names — because each one has to leave the command,
 * or its rule the config, before this pin can exist. A pin carries at most
 * MAX_PIN_FILES paths, which bounds the list.
 */
export const pinDenylistRefusal = (denied: readonly PinShadow[]): string => {
  const shipped = [
    ...new Set(denied.flatMap((shadow) => (shadow.shippedPattern === null ? [] : [shadow.shippedPattern]))),
  ];
  // A shipped rule binds every teammate who kept the defaults, so no config
  // on this machine can lift it — the config remedy is offered only when some
  // file is excluded by this machine's list ALONE, the one case it can fix.
  const configCanLift = denied.some((shadow) => shadow.shippedPattern === null);
  return [
    `nothing was pinned — the hot-file denylist excludes ${String(denied.length)} of these file(s) from capture:`,
    ...denied.map((shadow) => `  ${token(shadow.path)} (${excludedBy(shadow)})`),
    ...refusalWhyLines(denied, (shadow) => shadow.path).map((why) => `${why}.`),
    `${capitalised(GUARD_COST)}.`,
    ...(shipped.length === 0
      ? []
      : [
          `${shipped.map(token).join(", ")} ${shipped.length === 1 ? "is" : "are"} on crosscheck's shipped default list, which every teammate who kept the defaults applies — changing this machine's config does not lift ${shipped.length === 1 ? "it" : "them"}.`,
        ]),
    configCanLift
      ? "Pin the files they are made from instead, or change the denylist in the crosscheck config."
      : "Pin the files they are made from instead.",
    "",
  ].join("\n");
};

/** A rename git followed into a path the denylist excludes. */
export interface DeniedMove {
  readonly path: string;
  readonly newPath: string;
  readonly pattern: string;
  /** As on PinShadow: false = only machines that keep the shipped list exclude the new path. */
  readonly here: boolean;
  /** As on PinShadow: the shipped rule matching the new path, or null. */
  readonly shippedPattern: string | null;
}

/**
 * WHAT A SWEEP PRINTS for the renames it would not record (loss-accounting
 * §10 item 4): git followed the file into an excluded path, and a pin there
 * would watch a file whose touches are never recorded. The update went to the
 * hub as `missing` instead, so the pin reads BROKEN rather than quietly blind.
 */
export const sweepDenylistLines = (moves: readonly DeniedMove[]): readonly string[] =>
  moves.length === 0
    ? []
    : [
        `${String(moves.length)} renamed path(s) recorded as missing — git followed each into a file the hot-file denylist excludes from capture:`,
        ...moves.map((move) => `  ${token(move.path)} moved to ${token(move.newPath)} (${excludedBy(move)})`),
        ...refusalWhyLines(moves, (move) => move.newPath).map((why) => `${why}.`),
        `${capitalised(GUARD_COST)}. Re-pin the surface on files capture records, or retire the pin: crosscheck pin --broke with the pin id.`,
      ];

/**
 * The shadowing sentence. It says what the suppression COSTS — no target
 * record, so `suspect` answers "nobody touched this" with total confidence —
 * rather than only that it happened, because the consequence is the part a
 * reader cannot derive from the fact.
 */
const namedShadows = (shadows: readonly PinShadow[]): string => {
  const named = shadows
    .slice(0, MAX_NAMED_SHADOWS)
    .map((shadow) => `${token(shadow.path)} (${token(shadow.pattern)})`)
    .join(", ");
  const rest = shadows.length - Math.min(shadows.length, MAX_NAMED_SHADOWS);
  return `${named}${rest > 0 ? ` … and ${String(rest)} more` : ""}`;
};

export const shadowSentence = (
  shadows: readonly PinShadow[],
  patternCount: number,
): string => {
  if (shadows.length === 0) {
    return `no pinned file is shadowed by the ${String(patternCount)} effective hot-file pattern(s)`;
  }
  // One clause per reach, each true only of its own files: a file this
  // machine records is never called unrecorded, and a file a teammate records
  // is never called unrecorded by anyone.
  return REACHES.flatMap((reach) => {
    const own = shadows.filter((shadow) => reachOf(shadow) === reach);
    return own.length === 0 ? [] : [SHADOW_CLAUSE[reach](own)];
  }).join("; ");
};

const SHADOW_CLAUSE: Readonly<Record<ShadowReach, (own: readonly PinShadow[]) => string>> = {
  everywhere: (own) =>
    `${String(own.length)} pinned file(s) are never captured here or ${ELSEWHERE}: ${namedShadows(own)} — ` +
    'no session on those machines records touching them, so crosscheck trace answers "no session touched this surface" for every one of them',
  here: (own) =>
    `${String(own.length)} pinned file(s) are never captured on this machine: ${namedShadows(own)} — ` +
    "its own denylist skips them; teammates who kept the shipped denylist record them, so crosscheck trace cannot name a session run here",
  elsewhere: (own) =>
    `${String(own.length)} pinned file(s) are never captured ${ELSEWHERE}: ${namedShadows(own)} — ` +
    "this machine records touching them, but crosscheck trace cannot name a session on those machines",
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
      ? "trace names sessions and their declared intents"
      : "trace prints counts only, naming nobody";
  const origin =
    settings.updatedAt === null ? "shipped defaults" : "set for this repo";
  return `guard settings: ${who} · ${names} (${origin})`;
};

/**
 * The whole `status` block, in reading order: the denominator, then what is
 * broken, then what is suppressed, then the settings that explain the shape
 * of all three. A reader who stops after one line still has the denominator.
 */
/**
 * HOW MANY FENCES ARE OPEN, AND UNTIL WHEN — and nothing else (04 §5).
 *
 * This module is registered `framing: "bare"`, and that registration is a
 * promise: it prints paths, glob patterns, counts and machine timestamps, and
 * NEVER another person's prose. So a waiver reaches `status` and `doctor` as a
 * number and an instant. The reason and the granter's name stay on `pin list`
 * and on the `suspect` verdict, which are framed surfaces carrying the
 * quoted-data notice and can hold a teammate's sentence safely.
 *
 * WHY IT IS HERE AT ALL rather than only on those framed surfaces: an open
 * fence SUPPRESSES a `PROTECTED_CONFLICT`, so `status` would otherwise report
 * a repo as quiet precisely because somebody silenced it. A count and a
 * deadline are enough to send a reader to `crosscheck pin list`, which is the
 * whole job of this line.
 *
 * THE EARLIEST EXPIRY, not the latest — the next moment the answer a reader is
 * looking at can change on its own.
 */
const waiverSentence = (registry: PinRegistry): string | null => {
  const expiries = registry.pins
    .map((pin) => pin.liveWaiver?.expiresAt)
    .filter((value): value is string => value !== undefined && value !== "");
  if (expiries.length === 0) {
    return null;
  }
  // Re-serialised, never echoed: the wire keeps an expiry it cannot read (a
  // dropped waiver would read as a closed fence), so the string is the hub's
  // choice until this process writes it.
  const readable = expiries
    .map((iso) => Date.parse(iso))
    .filter((ms) => !Number.isNaN(ms))
    .sort((a, b) => a - b);
  const earliest = readable[0];
  const next = earliest === undefined ? "an unreadable time" : new Date(earliest).toISOString();
  return `${String(expiries.length)} live waiver(s) — next expires ${next}; run crosscheck pin list to see who opened which, and why`;
};

/**
 * HOW MANY FENCES THE HUB CLOSED on a passkey revocation (04a D-PK-1), as a
 * count — this surface is bare, so the ids and instants stay on `pin list`.
 * Without it, a repo whose waivers were just closed reads as one where nobody
 * ever opened a fence.
 */
const closedFencesSentence = (registry: PinRegistry): string | null => {
  const closed = registry.pins.filter((pin) => (pin.closedWaiver ?? null) !== null).length;
  return closed === 0
    ? null
    : `${String(closed)} waiver(s) closed by the hub because the passkey that approved them was revoked — run crosscheck pin list to see which`;
};

export const pinStatusLines = (
  registry: PinRegistry,
  patterns: readonly string[],
  settings: TeamSettings | null,
  now: Date,
): readonly string[] => {
  const orphans = orphanSentence(orphanedPins(registry));
  const shadows = shadowedPinPaths(registry, patterns);
  const waivers = waiverSentence(registry);
  const closed = closedFencesSentence(registry);
  return [
    pinCoverageSentence(registry, now),
    ...(orphans === null ? [] : [`  ${orphans}`]),
    ...(shadows.length === 0
      ? []
      : [`  ${shadowSentence(shadows, patterns.length)}`]),
    ...(waivers === null ? [] : [`  ${waivers}`]),
    ...(closed === null ? [] : [`  ${closed}`]),
    ...(settings === null ? [] : [guardSettingsSentence(settings)]),
  ];
};
