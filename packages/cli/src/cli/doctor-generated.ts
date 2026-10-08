/**
 * The generated-target line (connector-core capture/generated.ts): how many of
 * this repo's captured targets each signal labelled generated — so the hub
 * keeps them out of every overlap count — and how many could not be
 * classified and therefore stayed ordinary.
 *
 * HONEST COVERAGE IS THE POINT. A rule that silently swallows files is the
 * same failure as a capture that silently drops them, so the number it keeps
 * out is a line, by signal; and so is the number it could NOT judge, because
 * that is the classifier failing — toward a warning, which is the safe
 * direction, but failing. Read off the same scan as the `capture` line, so
 * the two count the same sessions.
 *
 * Always PASS: neither count is a fault on this machine. Generated files kept
 * out of overlap is the rule working; an unknown is a target that still
 * counts, which can cost precision and never a warning.
 */
import { NO_GENERATED, addGeneratedTally } from "@crosscheck/connector-core/capture/generated.ts";
import type { GeneratedTally } from "@crosscheck/connector-core/capture/generated.ts";
import type { CaptureHealth } from "@crosscheck/connector-core/state/capture-health.ts";

import type { Check } from "./doctor.ts";

const NAME = "generated targets";

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

const keptOut = (tally: GeneratedTally): number => tally.path + tally.attribute + tally.header;

const tallyLine = (tally: GeneratedTally): string =>
  `${plural(keptOut(tally), "target")} labelled generated and kept out of overlap ` +
  `(path ${String(tally.path)} · attribute ${String(tally.attribute)} · header ${String(tally.header)}), ` +
  `still captured so suspect and coverage see them; ` +
  `${String(tally.unknown)} could not be classified (git or the file did not answer) and count as ordinary`;

export const generatedTargetsCheck = (health: CaptureHealth): Check => {
  if (health.sessions.length === 0) {
    return {
      level: "PASS",
      name: NAME,
      detail: "no open session of this repo: nothing classified yet (counts are per session and clear at SessionEnd)",
    };
  }
  const measured = health.sessions.flatMap((session) =>
    session.generatedTargets === undefined ? [] : [session.generatedTargets],
  );
  const unmeasured = health.sessions.length - measured.length;
  if (measured.length === 0) {
    return {
      level: "PASS",
      name: NAME,
      detail: `not measured (${plural(unmeasured, "open session")} here started before this count existed)`,
    };
  }
  const total = measured.reduce(addGeneratedTally, NO_GENERATED);
  const older = unmeasured === 0 ? "" : `; ${plural(unmeasured, "session")} started before this count existed`;
  return {
    level: "PASS",
    name: NAME,
    detail: `${tallyLine(total)}${older} (counts are per session and clear at SessionEnd)`,
  };
};
