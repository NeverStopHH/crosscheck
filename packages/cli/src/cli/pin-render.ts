/**
 * `crosscheck pin list` — the registry as a person reads it, and as an agent
 * that ran the command through Bash reads it too.
 *
 * FRAMED CLASS, with the quoted-data notice, unlike `crosscheck status`. The
 * difference is who wrote the text: status prints presence facts and this
 * prints OTHER PEOPLE'S PROSE — a surface label somebody typed, a check
 * recipe somebody typed — and an agent is a likely reader, because "run
 * crosscheck pin list" is exactly what an agent does when asked what is
 * watched here. So the untrusted values sit inside « » and the document says
 * the frame means data rather than instruction.
 *
 * WHAT EACH CLASS IS USED FOR, and why:
 *   LABEL (`quoted`)      the surface label — a NAME for something, blanked
 *                         whole if it reads like an instruction;
 *   BODY  (`quotedBody`)  the check recipe — the recipe IS the answer, so a
 *                         phrase match redacts the span, never the sentence
 *                         (a reader left with "[redacted]" where their next
 *                         step should be cannot falsify anything);
 *   BARE  (`bareUntrusted`) the verifier's display name, printed outside the
 *                         frame on a ·-separated line;
 *   ID    (`safeId`)      pin ids and commits, so what prints is what the
 *                         reader can pass back to `--broke`.
 *
 * ONE « » PAIR PER LINE, everywhere. The notice owns a pair of its own and
 * therefore owns its line — the rule every framed surface in this product
 * follows, asserted over the whole injection corpus.
 */
import { formatAge, QUOTED_DATA_NOTICE } from "@crosscheck/connector-core/briefing/render.ts";
import { bareUntrusted } from "@crosscheck/connector-core/briefing/sanitize.ts";
import { quoted, quotedBody, safeId } from "@crosscheck/connector-core/mcp/render.ts";
import {
  MAX_PIN_CHECK_CHARS,
  MAX_PIN_PATH_CHARS,
  MAX_PIN_SURFACE_CHARS,
} from "@crosscheck/schema";
import type { PinEntry, PinRegistry } from "@crosscheck/connector-core/http/hub.ts";

import { pinCoverageSentence } from "./pin-observability.ts";

/** How many paths one pin prints before the tail becomes a count. */
const MAX_PRINTED_PATHS = 8;

const ageOf = (iso: string, now: Date): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "unknown" : `${formatAge(now.getTime() - ms)} ago`;
};

/**
 * The trust label, and `captureMode` is in it deliberately: `HintTrust`
 * exposes provenance and provenance alone never distinguished "Nick verified
 * this" from "an agent wrote that Nick verified this". A pin whose stored
 * mode is not "human" — which the hub refuses to create, so this can only be
 * a hub that changed its mind — is printed as what it is rather than as a
 * human's word.
 */
const trustLabel = (pin: PinEntry): string =>
  pin.captureMode === "human"
    ? `verified by ${bareUntrusted(pin.verifiedByName)} (a human, at a terminal)`
    : `RECORDED BY ${bareUntrusted(pin.captureMode)} — not a human's word`;

/**
 * A repo-relative path is a BARE field, not an ID. `safeId`'s alphabet is
 * `A-Za-z0-9_.:-` — no slash — so rendering a path through it silently turns
 * `src/workbench/usePlayback.ts` into `srcworkbenchusePlayback.ts`: a path
 * nobody can open and no `git` command can find. Same class the tripwire
 * renderer already gives a repo-relative file (hints/render.ts).
 */
const filePath = (path: string): string => bareUntrusted(path, MAX_PIN_PATH_CHARS);

const fileLine = (pin: PinEntry): string => {
  const shown = pin.files.slice(0, MAX_PRINTED_PATHS);
  const rest = pin.files.length - shown.length;
  const paths = shown
    .map((file) =>
      file.status === "missing"
        ? `${filePath(file.path)} (MISSING)`
        : filePath(file.path),
    )
    .join(", ");
  return `  files: ${paths}${rest > 0 ? ` … and ${String(rest)} more` : ""}`;
};

const pinLines = (pin: PinEntry, now: Date): readonly string[] => {
  const state =
    pin.brokeAt !== null
      ? `RETRACTED ${ageOf(pin.brokeAt, now)}${pin.brokeByName === null ? "" : ` by ${bareUntrusted(pin.brokeByName)}`}`
      : pin.missingPaths > 0
        ? `BROKEN — ${String(pin.missingPaths)} of ${String(pin.files.length)} paths missing`
        : pin.speaking
          ? "watching"
          : "watching (briefing-only: too many files to speak)";
  return [
    `- ${safeId(pin.id)} ${quoted(pin.surface, MAX_PIN_SURFACE_CHARS)}`,
    `  ${trustLabel(pin)} · at ${safeId(pin.verifiedAtCommit)} · ${ageOf(pin.verifiedAt, now)} · ${state}`,
    ...(pin.check === null
      ? ["  check: none recorded — this pin can never be falsified in 30 seconds"]
      : [`  check: ${quotedBody(pin.check, MAX_PIN_CHECK_CHARS)}`]),
    fileLine(pin),
  ];
};

/**
 * The whole listing. The header names the repo the registry belongs to, and
 * the coverage sentence comes BEFORE the rows: a reader who stops after one
 * line should still have the denominator rather than the first pin.
 */
export const renderPinList = (
  repoId: string,
  registry: PinRegistry,
  now: Date,
): string =>
  [
    `crosscheck pins for ${bareUntrusted(repoId)}.`,
    QUOTED_DATA_NOTICE,
    pinCoverageSentence(registry, now),
    ...(registry.pins.length === 0
      ? ['(no pins yet — crosscheck pin "a surface that works" --files … --check "…" records one)']
      : registry.pins.flatMap((pin) => pinLines(pin, now))),
    "",
  ].join("\n");
