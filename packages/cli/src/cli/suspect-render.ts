/**
 * `crosscheck suspect` — the answer, as a person reads it and as the agent
 * that ran the command through Bash reads it.
 *
 * THE ORDER OF THIS DOCUMENT IS THE ARGUMENT. Premise first (what makes us
 * believe the surface is broken at all), then scope (which files), then the
 * outcome sentence, and only then the rows. A ranking whose premise is
 * printed underneath it is an accusation with the evidence in a footnote.
 *
 * WHAT IT NEVER PRINTS: a developer's name or id. The hub does not send one —
 * `suspect` names SESSIONS and their declared intents, and reaching a person
 * is one deliberate hop the reader takes with `get_diagnosis <work context>`.
 * That is a design decision about what a tool may make visible about people,
 * not a rendering convenience, so the renderer has nothing to leak.
 *
 * FRAMED CLASS with the quoted-data notice, because the rows quote other
 * people's prose: a work-context title and a declared intent. The intent goes
 * through `renderIntent`, the ONE framed fragment every surface in this
 * product spells the same way.
 */
import { formatAge, QUOTED_DATA_NOTICE } from "@crosscheck/connector-core/briefing/render.ts";
import { renderIntent } from "@crosscheck/connector-core/briefing/intent.ts";
import { bareUntrusted } from "@crosscheck/connector-core/briefing/sanitize.ts";
import { quoted, quotedBody, safeId } from "@crosscheck/connector-core/mcp/render.ts";
import {
  MAX_PIN_CHECK_CHARS,
  MAX_PIN_PATH_CHARS,
  MAX_PIN_SURFACE_CHARS,
} from "@crosscheck/schema";
import { MAX_WORK_CONTEXT_TITLE_CHARS } from "@crosscheck/connector-core/constants.ts";
import type {
  SuspectCandidate,
  SuspectView,
} from "@crosscheck/connector-core/http/hub.ts";

/** Two decimals: a score with more looks like a measurement it is not. */
const SCORE_DECIMALS = 2;

const MAX_PRINTED_FILES = 8;

const ageOf = (iso: string, now: Date): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "unknown" : `${formatAge(now.getTime() - ms)} ago`;
};

/**
 * WHY WE BELIEVE THE SURFACE IS BROKEN — first, always, and in the reader's
 * own terms. The gated cases print the recipe as the next action rather than
 * a refusal, because "run this, then come back" is a step somebody can take.
 */
const falsifierLines = (view: SuspectView, now: Date): readonly string[] => {
  switch (view.falsifier.kind) {
    case "recorded_break":
      return [
        `falsified: the pin's check was run and failed ${
          view.falsifier.at === null ? "(time unknown)" : ageOf(view.falsifier.at, now)
        }.`,
        ...(view.falsifier.check === null
          ? []
          : [`  check: ${quotedBody(view.falsifier.check, MAX_PIN_CHECK_CHARS)}`]),
      ];
    case "not_recorded_broken":
      return [
        "nothing is named yet: nobody has recorded running this pin's check and watching it fail.",
        ...(view.falsifier.check === null
          ? []
          : [`  run it: ${quotedBody(view.falsifier.check, MAX_PIN_CHECK_CHARS)}`]),
        ...(view.scope.pinId === null
          ? []
          : [
              `  then record it: crosscheck pin --broke ${safeId(view.scope.pinId)}`,
            ]),
      ];
    case "no_check_recipe":
      return [
        "nothing can be named: this pin carries no check recipe, so there is nothing anybody could have run and failed.",
      ];
    default:
      return [
        "no pin here: you named these files yourself, so the breakage rests on your own observation rather than on a recorded check.",
      ];
  }
};

/**
 * A repo-relative path is a BARE field, not an ID: `safeId`'s alphabet holds
 * no slash, so it would print `srcworkbenchusePlayback.ts` — a path the
 * reader cannot open. The tripwire renderer gives a repo-relative file the
 * same class (hints/render.ts).
 */
const filePath = (path: string): string => bareUntrusted(path, MAX_PIN_PATH_CHARS);

const scopeLine = (view: SuspectView): string => {
  const shown = view.scope.files.slice(0, MAX_PRINTED_FILES);
  const rest = view.scope.files.length - shown.length;
  return `  files: ${shown.map((path) => filePath(path)).join(", ")}${
    rest > 0 ? ` … and ${String(rest)} more` : ""
  }`;
};

/**
 * The outcome sentence. Four of them, and the three that name nobody are as
 * first-class as the one that does: "nothing touched these files" and "no
 * separated suspect" are different facts, and a reader who cannot tell them
 * apart learns nothing from either.
 */
const outcomeLine = (view: SuspectView): string => {
  const touched = `${String(view.totals.sessionsTouching)} session(s) touched this surface in the last ${String(view.totals.windowDays)} days`;
  switch (view.outcome) {
    case "ranked":
      return `${touched}; one stands out.`;
    case "no_separation":
      return `${touched}; NO SEPARATED SUSPECT — the top scores are too close to call.`;
    case "no_touch":
      return `no session touched this surface in the last ${String(view.totals.windowDays)} days. Whatever broke it is not in crosscheck's record.`;
    default:
      return view.attribution === "counts_only"
        ? `${touched}. This team's setting prints counts only, so no session is named.`
        : touched;
  }
};

/**
 * One candidate. `lift` is printed WITH both of its inputs, because a score
 * whose arithmetic is hidden cannot be argued with — and being argued with is
 * the point: the reader knows things the hub does not.
 */
const candidateLines = (
  candidate: SuspectCandidate,
  index: number,
  now: Date,
): readonly string[] => {
  const intent = renderIntent(candidate.intent);
  const flags = [
    ...(candidate.isSelf ? ["your own session"] : []),
    ...(candidate.readerMuted
      ? ["notices to this session's author are suppressed by your mute — not unanswered"]
      : []),
  ];
  return [
    `${String(index + 1)}. session ${safeId(candidate.sessionId)} · ${bareUntrusted(candidate.agentKind)} · branch ${bareUntrusted(candidate.branch)} · last active ${ageOf(candidate.lastActiveAt, now)}`,
    `   ${quoted(candidate.workContextTitle, MAX_WORK_CONTEXT_TITLE_CHARS)}`,
    ...(intent === null ? [] : [`   ${intent}`]),
    `   score ${candidate.lift.toFixed(SCORE_DECIMALS)} = ${String(candidate.overlap)} pinned file(s) of ${String(candidate.authorTouches)} this author touched · evidence: ${candidate.sources.map((source) => bareUntrusted(source)).join(" + ")}`,
    ...flags.map((flag) => `   ${flag}`),
    `   read it: get_diagnosis ${safeId(candidate.workContextId)}`,
  ];
};

export const renderSuspect = (view: SuspectView, now: Date): string => {
  const surface =
    view.scope.surface === null
      ? "the files you named"
      : quoted(view.scope.surface, MAX_PIN_SURFACE_CHARS);
  return [
    `crosscheck suspect: ${surface}`,
    QUOTED_DATA_NOTICE,
    ...falsifierLines(view, now),
    scopeLine(view),
    outcomeLine(view),
    ...view.candidates.flatMap((candidate, index) =>
      candidateLines(candidate, index, now),
    ),
    // The bound is printed even when it did not bite: a list of three that
    // never says three is the most it shows reads as a complete answer.
    ...(view.candidates.length > 0
      ? ["(sessions, not people — open a work context above to see whose it is)"]
      : []),
    "",
  ].join("\n");
};
