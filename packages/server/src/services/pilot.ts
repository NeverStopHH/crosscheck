/**
 * The pilot's writers (1.0 spec 07).
 *
 * THIS MODULE COUNTS; IT NEVER JUDGES. Every value it stores was decided by
 * somebody else — `services/suspect.ts` chose the outcome,
 * `services/coverage.ts` decided judgeability, the team decided enrolment. A
 * counting layer that re-derived any of them would be a second authority on a
 * question that already has one, and the two would disagree exactly where it
 * mattered.
 *
 * NOTHING IS WRITTEN FOR A REPO THAT DID NOT OPT IN. `pilot_enrolled` is off
 * by default and an absent settings row means the same thing (§3.6), so a hub
 * running for a team that never agreed to be measured stores nothing at all —
 * not a row marked "not enrolled", nothing. That is the difference between a
 * flag and consent.
 *
 * EVERY COLUMN IS AN ID, AN ENUM, AN INTEGER OR A TIMESTAMP — non-negotiable
 * 6, checkable by reading this file: no prompt, no diff body, no transcript
 * and no free-text mark reaches disk through anything here.
 */
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { pilotAttributions, pilotCounters } from "../db/schema.ts";
import { COVERAGE_SOURCES, isJudgeable } from "./coverage.ts";
import { readTeamSettings } from "./team-settings.ts";
import type { CoverageRecord } from "./coverage.ts";
import type { SuspectView } from "./suspect.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

export interface RecordAttributionInput {
  readonly repo: string;
  /** Null on a reader-named scope — nothing is stored for one; see below. */
  readonly pinId: string | null;
  readonly view: SuspectView;
  readonly coverage: CoverageRecord;
}

/**
 * The answer `GET /api/suspect` just gave, kept as it was given (§3.3).
 *
 * WHY IT IS WRITTEN ON A READ. `services/suspect.ts` persists nothing and its
 * window ends *now*, so the same question asked next week is answered from a
 * different fourteen days. Proof 3 asks whether an attribution was RIGHT,
 * which means comparing what was said to what was later repaired — and
 * neither half of that comparison survives unless the first is stored at the
 * moment it is made.
 *
 * ONLY WHERE A PIN WAS NAMED. A reader-named scope has no invariant to be
 * wrong about and no repair that could ever confirm or refute it, so there is
 * nothing for proof 3 to measure. Storing those rows would grow a denominator
 * with cases that can never resolve, dragging the accuracy figure toward zero
 * the more the product is used.
 *
 * JUDGEABILITY IS RECORDED, NOT APPLIED. The row is written whether or not
 * coverage was judgeable, and the flag goes with it. Refusing to store the
 * unjudgeable ones would hide exactly the cases principle 1 exists for — the
 * report has to say how many answers it EXCLUDED, and it cannot count what
 * was never written.
 */
export const recordAttribution = async (
  deps: Deps,
  input: RecordAttributionInput,
): Promise<void> => {
  if (input.pinId === null) {
    return;
  }
  const settings = await readTeamSettings(deps, input.repo);
  if (!settings.pilotEnrolled) {
    return;
  }
  const top = input.view.candidates[0];
  const named = input.view.outcome === "ranked";
  await deps.db.insert(pilotAttributions).values({
    id: `pa_${randomUUID()}`,
    repo: input.repo,
    pinId: input.pinId,
    outcome: input.view.outcome,
    falsifier: input.view.falsifier.kind,
    // THE TOP CANDIDATE ONLY WHERE ONE WAS NAMED. `no_separation` prints rows
    // and names nobody on purpose, so recording its first row as "the top
    // session" would manufacture an attribution the product declined to make
    // — and proof 3 would then score this product against answers it never
    // gave.
    topSessionId: named ? (top?.sessionId ?? null) : null,
    topLift: named ? (top?.lift ?? null) : null,
    candidates: input.view.candidates.length,
    coverageJudgeable: isJudgeable(input.coverage),
    answeredAt: deps.now(),
  });
};

/**
 * THE HUB ANSWERS THAT CARRY A COVERAGE RECORD (07 §3.5).
 *
 * *Corrected against the spec, which calls this field "a registered
 * render-surface name".* Render surfaces are the CONNECTOR's — they are what
 * a reader sees — and §6 puts this write hub-side, one UPSERT per answer on a
 * coverage-bearing route. The hub has no render surfaces, so a route that
 * tried to name one would be guessing at which of several readers rendered
 * its answer. These are the hub's own answer names, and they are a controlled
 * vocabulary for the same reason the spec wanted one: `surface` must never be
 * a string a caller can choose.
 *
 * WHAT THE COUNT IS AND IS NOT. This measures whether the HUB emitted the
 * qualifier's inputs, not whether a reader's terminal printed the clause. The
 * second half is 03's, held by the render-surface registry and the injection
 * corpus; counting it here would need every connector to report back, and a
 * self-reported render statistic is the weakest possible evidence about
 * rendering.
 */
export const PILOT_ANSWER_SURFACES = [
  "api-suspect",
  "api-absences",
  "api-hints",
  "api-search",
  "api-work-contexts",
] as const;

export type PilotAnswerSurface = (typeof PILOT_ANSWER_SURFACES)[number];

/** The UTC day, as the primary key spells it. Never a local date. */
const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

export interface CountAnswerInput {
  readonly repo: string;
  readonly surface: PilotAnswerSurface;
  readonly coverage: CoverageRecord;
}

/**
 * ONE ANSWER, COUNTED — proof 5, and the only write this spec adds to a read
 * path (§6).
 *
 * ONE STATEMENT, NOT TWENTY-FIVE. Every counter this answer touches is
 * upserted in a single multi-row INSERT … ON CONFLICT, so the cost on a read
 * is one round trip whatever the coverage record says. Twenty-five separate
 * upserts would put the shape of the measurement into the latency of the
 * thing measured.
 *
 * `qualifier_required` AND `not_judgeable` ARE DIFFERENT NUMBERS, and the
 * difference is easy to miss: a qualifier is required when some source is
 * positively `incomplete` — a gap somebody OBSERVED — while judgeability also
 * demands that `agent_event` and `git` be `complete`. A fresh install is not
 * judgeable and needs no qualifier, because nothing has reported anything
 * yet. Folding the two would report every new hub as failing to qualify.
 *
 * THE TWENTY PER-SOURCE TALLIES EXIST INSTEAD OF A PERCENTAGE. 00 §8.1
 * forbids a scalar that collapses the five sources, and storing them this way
 * makes the collapse unrepresentable rather than merely discouraged.
 */
export const countCoverageAnswer = async (
  deps: Deps,
  input: CountAnswerInput,
): Promise<void> => {
  const settings = await readTeamSettings(deps, input.repo);
  if (!settings.pilotEnrolled) {
    return;
  }
  const now = deps.now();
  const day = utcDay(now);
  const required = input.coverage.sources.some(
    (row) => row.state === "incomplete",
  );
  const judgeable = isJudgeable(input.coverage);
  const stateOf = (source: string): string =>
    input.coverage.sources.find((row) => row.source === source)?.state ??
    "unknown";
  const names = [
    "answers_emitted",
    ...(required ? ["qualifier_required"] : []),
    // COUNTED, NEVER ASSUMED. 03 makes every answer carry the record and
    // nothing counted whether it did — which is this proof's whole sentence.
    // The hub emits it on the same object it just built, so this tracks
    // `answers_emitted` today; the day it does not, the gap is a number
    // rather than a discovery.
    ...(required ? ["qualifier_emitted"] : []),
    judgeable ? "judgeable" : "not_judgeable",
    ...COVERAGE_SOURCES.map(
      (source) => `coverage_${source}_${stateOf(source)}`,
    ),
  ];
  await deps.db
    .insert(pilotCounters)
    .values(
      names.map((counter) => ({
        repo: input.repo,
        day,
        surface: input.surface,
        counter,
        value: 1,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [
        pilotCounters.repo,
        pilotCounters.day,
        pilotCounters.surface,
        pilotCounters.counter,
      ],
      set: {
        value: sql`${pilotCounters.value} + 1`,
        updatedAt: now,
      },
    });
};
