/**
 * The generated-target line (connector-core capture/generated.ts): how many of
 * this repo's captured targets each signal kept out of overlap as MECHANICALLY
 * GENERATED AND NON-AUTHORITATIVE, how many a signal fired on but counted
 * anyway as authoritative, and how many could not be classified and therefore
 * stayed ordinary — plus what the repo itself declares authoritative
 * (`authoritativeGenerated` in its committed `.crosscheck.json`).
 *
 * HONEST COVERAGE IS THE POINT. A rule that silently swallows files is the
 * same failure as a capture that silently drops them, so the number it keeps
 * out is a line, by signal; and so is the number it could NOT judge, because
 * that is the classifier failing — toward a warning, which is the safe
 * direction, but failing. Read off the same scan as the `capture` line, so
 * the two count the same sessions.
 *
 * PASS, except for one thing: a declaration entry the connector refused or
 * ignored past the cap. That is a team's explicit word ("this schema counts")
 * not being honoured, and nothing else on any surface would say so.
 */
import { NO_GENERATED, addGeneratedTally } from "@crosscheck/connector-core/capture/generated.ts";
import type { GeneratedTally } from "@crosscheck/connector-core/capture/generated.ts";
import { MAX_AUTHORITATIVE_GENERATED_GLOBS } from "@crosscheck/connector-core/constants.ts";
import type { AuthoritativeGenerated } from "@crosscheck/connector-core/capture/authoritative-generated.ts";
import type { CaptureHealth } from "@crosscheck/connector-core/state/capture-health.ts";

import type { Check } from "./doctor.ts";

const NAME = "generated targets";

/** One refused entry's text on a terminal line: no control character, never long. */
const DISPLAY_GLOB_MAX_CHARS = 60;

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

const keptOut = (tally: GeneratedTally): number => tally.path + tally.attribute + tally.header;

const tallyLine = (tally: GeneratedTally): string =>
  `${plural(keptOut(tally), "mechanically generated, non-authoritative target")} kept out of overlap ` +
  `(path ${String(tally.path)} · attribute ${String(tally.attribute)} · header ${String(tally.header)}), ` +
  `still captured so suspect and coverage see them; ` +
  `${String(tally.authoritative)} counted anyway as authoritative (declared in authoritativeGenerated, or a schema or migration); ` +
  `${String(tally.unknown)} could not be classified (git or the file did not answer) and count as ordinary`;

const displayGlob = (glob: string): string => {
  const clean = glob.replace(/[\p{Cc}\p{Cf}]/gu, "");
  return clean.length <= DISPLAY_GLOB_MAX_CHARS ? clean : `${clean.slice(0, DISPLAY_GLOB_MAX_CHARS - 1)}…`;
};

/** What the repo declares, and what of it the connector could not honour. */
const declarationClause = (declared: AuthoritativeGenerated): string => {
  if (!declared.declared) {
    return "this repo declares no authoritativeGenerated globs";
  }
  const used = `authoritativeGenerated: ${plural(declared.globs.length, "glob")} honoured`;
  const first = declared.refused[0];
  const refused =
    first === undefined
      ? ""
      : `, ${plural(declared.refused.length, "entry")} refused («${displayGlob(first.glob)}»: ${first.reason}${declared.refused.length > 1 ? "; doctor names the first" : ""})`;
  const overCap =
    declared.overCap === 0
      ? ""
      : `, ${plural(declared.overCap, "glob")} past the cap of ${String(MAX_AUTHORITATIVE_GENERATED_GLOBS)} ignored`;
  return `${used}${refused}${overCap}`;
};

const isDeclarationFaulty = (declared: AuthoritativeGenerated): boolean =>
  declared.refused.length > 0 || declared.overCap > 0;

const countsClause = (health: CaptureHealth): string => {
  if (health.sessions.length === 0) {
    return "no open session of this repo: nothing classified yet (counts are per session and clear at SessionEnd)";
  }
  const measured = health.sessions.flatMap((session) =>
    session.generatedTargets === undefined ? [] : [session.generatedTargets],
  );
  const unmeasured = health.sessions.length - measured.length;
  if (measured.length === 0) {
    return `not measured (${plural(unmeasured, "open session")} here started before this count existed)`;
  }
  const total = measured.reduce(addGeneratedTally, NO_GENERATED);
  const older = unmeasured === 0 ? "" : `; ${plural(unmeasured, "session")} started before this count existed`;
  return `${tallyLine(total)}${older} (counts are per session and clear at SessionEnd)`;
};

export const generatedTargetsCheck = (health: CaptureHealth, declared: AuthoritativeGenerated): Check => ({
  level: isDeclarationFaulty(declared) ? "WARN" : "PASS",
  name: NAME,
  detail: `${countsClause(health)} · ${declarationClause(declared)}`,
});
