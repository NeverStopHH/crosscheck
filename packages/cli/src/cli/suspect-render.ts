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
import { coverageNote } from "@crosscheck/connector-core/coverage/render.ts";
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

/**
 * How many candidates the hub ever sends (SUSPECT_TOP_CANDIDATES). Spelled
 * here rather than counted from the rows, so the sentence states the BOUND
 * and not the length of this particular answer.
 */
const MAX_LISTED_CANDIDATES = 3;

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

/**
 * THE SCOPE, WITH THE DEAD PATHS MARKED — the same (MISSING) marker
 * `crosscheck pin list` gives the same data, because a path git no longer has
 * can never be intersected against: a touch row only ever exists for a path
 * that EXISTS. Rendering a dead path as if it were being watched turns "the
 * intersection was empty" into "nobody was in there", which is a fact about
 * the world rather than a fact about the pin, and points at the wrong remedy.
 */
const scopeLine = (view: SuspectView): string => {
  const gone = new Set(view.scope.missingFiles);
  const shown = view.scope.files.slice(0, MAX_PRINTED_FILES);
  const rest = view.scope.files.length - shown.length;
  const paths = shown
    .map((path) =>
      gone.has(path) ? `${filePath(path)} (MISSING)` : filePath(path),
    )
    .join(", ");
  return `  files: ${paths}${rest > 0 ? ` … and ${String(rest)} more` : ""}`;
};

/**
 * WHY THE ZERO IS A ZERO, when the pin is the reason. `no_touch` over a pin
 * whose paths git has lost is not evidence about anybody: the remedy is to
 * re-pin the surface at its new path, not to go looking for a session. Said
 * only when it applies, and the partial case is said too — a half-dead file
 * set narrows the intersection without emptying it, which is the same lie in
 * smaller print.
 */
/**
 * THE FILE SET MOVED, SO THE ANSWER MOVED. A sweep rewrites the paths a pin
 * watches, and those paths are exactly what this answer intersected — so a
 * rewrite changes which sessions can appear here, under this same surface
 * label and this same "the check was run and failed" header. No developer
 * name: `suspect` names sessions, and `crosscheck pin list` is where the
 * reader takes the hop to who ran the sweep.
 */
const rewriteLines = (view: SuspectView, now: Date): readonly string[] =>
  view.scope.rewrittenPaths === 0
    ? []
    : [
        `${String(view.scope.rewrittenPaths)} pinned path(s) were rewritten by a sweep${
          view.scope.rewrittenAt === null
            ? ""
            : ` ${ageOf(view.scope.rewrittenAt, now)}`
        }, so this answer intersected a file set that has moved since the pin was made: crosscheck pin list names who ran it.`,
      ];

const deadScopeLines = (view: SuspectView): readonly string[] => {
  const gone = view.scope.missingFiles.length;
  if (gone === 0 || view.scope.files.length === 0) {
    return [];
  }
  if (gone >= view.scope.files.length) {
    return [
      "every path this pin watches is gone from git, so nothing could ever have matched: this zero is about the pin, not about anybody. Re-pin the surface at its new path (crosscheck pin --sweep re-resolves a rename).",
    ];
  }
  return [
    `${String(gone)} of ${String(view.scope.files.length)} pinned path(s) are gone from git, so no touch of them could ever match: the intersection above is narrower than the surface.`,
  ];
};

/**
 * THE READ BOUND, SAID OUT LOUD. The hub scores the highest-lift contexts
 * first and cuts at its read bound, so a cut row scored below every row
 * printed — but a reader handed "50 session(s) touched this surface" when 305
 * did has been given the bound as if it were the world. `crosscheck pin list`
 * already prints "showing 200 of 250" one level up; this is the same sentence
 * on the one surface where being wrong costs somebody an accusation.
 */
const boundLines = (view: SuspectView): readonly string[] =>
  view.totals.sessionsScored >= view.totals.sessionsTouching
    ? []
    : [
        `scored ${String(view.totals.sessionsScored)} of ${String(view.totals.sessionsTouching)} — the rest scored below every session above and are not listed`,
      ];

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
/**
 * ONE CLAUSE ON THE INTENT LINE — was that plan written before this session
 * touched the file, or after? (spec 06 §5, decision 10.2.)
 *
 * This is the surface where the missing distinction costs most: it names
 * sessions beside their declared intent, and a reader who cannot tell a plan
 * from an excuse reads every intent as a plan.
 *
 * THE VALUE NEVER TRAVELS WITHOUT ITS REASON, and `absent` is never printed
 * as a bare word. "Absent" alone asserts that no explanation exists — which
 * accuses a developer — while the reason says only that we cannot tell when
 * one was written, which excuses them. Those are different claims, and the
 * more damaging one must not be the default reading.
 *
 * EVERY WORD HERE IS RENDERER-OWNED. The hub sends two enum values; this maps
 * them, so no hub-chosen prose reaches the terminal through this clause.
 */
const TIMING_CLAUSES: Readonly<Record<string, string>> = {
  declared_before: "declared before this file was touched",
  declared_after: "declared after this file was touched",
  declared_non_goal_edited: "declared as OFF LIMITS, then touched",
  no_intent: "timing unknown: no intent was recorded",
  derived_excluded: "timing unknown: the only intent here was derived, not declared",
  different_session: "timing unknown: the intent belongs to another session",
  not_comparable: "timing unknown: these two cannot be ordered",
  scope_not_named: "timing unknown: the intent named no files",
};

const timingClause = (candidate: SuspectCandidate): string | null => {
  const timing = candidate.intentTiming;
  if (timing === null || timing === undefined) {
    return null;
  }
  // An unknown REASON prints nothing rather than a half-sentence: a hub newer
  // than this binary may send a word this renderer has never heard of, and a
  // clause it cannot spell is one it must not guess at.
  return TIMING_CLAUSES[timing.reason] ?? null;
};

const candidateLines = (
  candidate: SuspectCandidate,
  index: number,
  now: Date,
): readonly string[] => {
  const intent = renderIntent(candidate.intent);
  const timing = timingClause(candidate);
  const flags = [
    ...(candidate.isSelf ? ["your own session"] : []),
    ...(candidate.readerMuted
      ? ["notices to this session's author are suppressed by your mute — not unanswered"]
      : []),
  ];
  return [
    `${String(index + 1)}. session ${safeId(candidate.sessionId)} · ${bareUntrusted(candidate.agentKind)} · branch ${bareUntrusted(candidate.branch)} · last active ${ageOf(candidate.lastActiveAt, now)}`,
    `   ${quoted(candidate.workContextTitle, MAX_WORK_CONTEXT_TITLE_CHARS)}`,
    ...(intent === null
      ? []
      : [`   ${intent}${timing === null ? "" : ` — ${timing}`}`]),
    `   score ${candidate.lift.toFixed(SCORE_DECIMALS)} = ${String(candidate.overlap)} pinned file(s) of ${String(candidate.authorTouches)} this author touched · evidence: ${candidate.sources.map((source) => bareUntrusted(source)).join(" + ")}`,
    ...flags.map((flag) => `   ${flag}`),
    `   read it: get_diagnosis ${safeId(candidate.workContextId)}`,
  ];
};

const coverageLines = (view: SuspectView, now: Date): readonly string[] => {
  const note = coverageNote(view.coverage, now);
  return note === null ? [] : [note];
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
    // 03 §5.1's SOFT rule, above the outcome because it is the same kind of
    // statement as the falsifier one line up: the premise the ranking below
    // rests on. It renders only on a positively observed gap, scoped to the
    // pinned files (§3.2a), and it NEVER blocks or withholds a row.
    //
    // The EMPTY-result rule on `no_touch` is deliberately NOT applied here:
    // 03 refusal 5 hands `no_touch` to the verdict spec, which owns the
    // ATTRIBUTED / UNATTRIBUTED / INDETERMINATE mapping this record decides.
    ...coverageLines(view, now),
    outcomeLine(view),
    ...rewriteLines(view, now),
    ...deadScopeLines(view),
    ...boundLines(view),
    ...view.candidates.flatMap((candidate, index) =>
      candidateLines(candidate, index, now),
    ),
    // The top-3 bound is printed even when it did not bite: a list of three
    // that never says three is the most it shows reads as a complete answer.
    ...(view.candidates.length > 0
      ? [
          `(at most ${String(MAX_LISTED_CANDIDATES)} are listed; sessions, not people — open a work context above to see whose it is)`,
        ]
      : []),
    "",
  ].join("\n");
};
