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

import { and, asc, eq, sql } from "drizzle-orm";

import {
  agentSessions,
  hintDeliveries,
  pilotAttributions,
  pilotCounters,
  pilotMarks,
  pilotSessions,
  pins,
  sessionEvents,
} from "../db/schema.ts";
import { PILOT_MAX_SESSIONS } from "../constants.ts";
import { COVERAGE_SOURCES, isJudgeable, readCoverage } from "./coverage.ts";
import { readTeamSettings } from "./team-settings.ts";
import type { CoverageRecord } from "./coverage.ts";
import type { SuspectView } from "./suspect.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";
import type { PilotMark, PilotMarkRefKind } from "@crosscheck/schema";

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
  // TWO ANSWERS, NOT ONE. `/candidates` and `/tripwire` are different
  // questions with different readers, and a shared name would count them as
  // one surface — which is the same collapse the channel split exists to
  // undo one layer up.
  "api-hints-candidates",
  "api-hints-tripwire",
  "api-search",
  "api-work-context-diagnosis",
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

/**
 * WHAT ONE SESSION'S SEQUENCE LOOKED LIKE, and whether it can be read at all.
 *
 * `seq` IS A PAIR — an epoch and a number (01 §3.1) — and everything here
 * turns on that. A session whose counter restarted holds more than one epoch,
 * and `first .. last` ACROSS two epochs is not a span: it is two unrelated
 * counters subtracted from each other, which would print as a confident
 * number about work nobody can order. So the epoch count is measured, and the
 * report refuses the span when it is greater than one.
 *
 * NULL-POSITIONED RECORDS ARE COUNTED, NOT SKIPPED. An event with no position
 * is a fact about this session's instrumentation — a lane that sent no
 * bracket, a refusal the emitter recorded — and dropping it would make a
 * session with half its events unordered look exactly like one with all of
 * them ordered.
 */
interface SeqResidue {
  readonly epoch: string | null;
  readonly first: number | null;
  readonly last: number | null;
  readonly gaps: number | null;
  readonly nullRecords: number;
  readonly epochs: number;
}

const readSeqResidue = async (
  deps: Deps,
  sessionId: string,
): Promise<SeqResidue> => {
  const rows = await deps.db
    .select({ epoch: sessionEvents.seqEpoch, n: sessionEvents.seqN })
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, sessionId))
    .orderBy(asc(sessionEvents.seqN));
  const positioned = rows.filter(
    (row): row is { epoch: string; n: number } =>
      row.epoch !== null && row.n !== null,
  );
  const epochs = new Set(positioned.map((row) => row.epoch));
  const nullRecords = rows.length - positioned.length;
  if (positioned.length === 0) {
    return {
      epoch: null,
      first: null,
      last: null,
      gaps: null,
      nullRecords,
      epochs: 0,
    };
  }
  // ONE EPOCH OR NONE. Across two, `first` and `last` belong to different
  // counters and the span is refused rather than computed — the report says
  // "sequence restarted" and prints no numbers, which is 01's epoch-split
  // refusal arriving at the counting layer instead of being re-argued here.
  if (epochs.size > 1) {
    return {
      epoch: null,
      first: null,
      last: null,
      gaps: null,
      nullRecords,
      epochs: epochs.size,
    };
  }
  const numbers = positioned.map((row) => row.n).sort((a, b) => a - b);
  const first = numbers[0] ?? null;
  const last = numbers[numbers.length - 1] ?? null;
  return {
    epoch: positioned[0]?.epoch ?? null,
    first,
    last,
    // A GAP IS A MISSING POSITION, not a missing record: the span is what the
    // counter reached, and the difference between that and what arrived is
    // how much this session's order is missing.
    gaps:
      first === null || last === null ? null : last - first + 1 - numbers.length,
    nullRecords,
    epochs: 1,
  };
};

export interface RecordPilotSessionInput {
  readonly sessionId: string;
  readonly repo: string;
  readonly developerId: string;
  readonly endReason: "reported" | "reaped";
}

/**
 * ONE SESSION'S RESIDUE, at the moment it ended (§3.6).
 *
 * WRITTEN HUB-SIDE, FROM WHAT THE HUB ALREADY HAS. §6 budgets zero new round
 * trips at SessionStart and SessionEnd, and this keeps that: nothing is asked
 * of a connector, and nothing runs on a hook path.
 *
 * `coverage` IS A SNAPSHOT AND SAYS SO. 03 §3.2 refuses a coverage TABLE
 * because a stored verdict outlives its evidence — `reaped_at` is revocable,
 * so the same question answered tomorrow can answer differently. This stores
 * five triples anyway, bounded exactly as §9 promises: at most fifty sessions
 * on an enrolled repo, never read by an answer surface, never a fallback for
 * `readCoverage`. It is what the hub SAID at this instant, which is the only
 * proof-5 input that cannot be recomputed.
 *
 * THE 51st IS REFUSED AND COUNTED, never dropped silently. A measurement that
 * hit its own cap and said nothing would report fifty sessions as though that
 * were the population — non-negotiable 4 applied to this project's own
 * instrumentation.
 */
export const recordPilotSession = async (
  deps: Deps,
  input: RecordPilotSessionInput,
): Promise<void> => {
  const settings = await readTeamSettings(deps, input.repo);
  if (!settings.pilotEnrolled) {
    return;
  }
  const now = deps.now();
  const taken = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(pilotSessions)
    .where(eq(pilotSessions.repo, input.repo));
  if ((taken[0]?.n ?? 0) >= PILOT_MAX_SESSIONS) {
    await deps.db
      .insert(pilotCounters)
      .values({
        repo: input.repo,
        day: utcDay(now),
        surface: "pilot-sessions",
        counter: "pilot_sessions_refused",
        value: 1,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          pilotCounters.repo,
          pilotCounters.day,
          pilotCounters.surface,
          pilotCounters.counter,
        ],
        set: { value: sql`${pilotCounters.value} + 1`, updatedAt: now },
      });
    return;
  }
  const [coverage, seq] = await Promise.all([
    readCoverage(deps, input.developerId, input.repo),
    readSeqResidue(deps, input.sessionId),
  ]);
  await deps.db
    .insert(pilotSessions)
    .values({
      sessionId: input.sessionId,
      repo: input.repo,
      observedAt: now,
      endReason: input.endReason,
      // ENUMS ONLY. The record carries no instants and no free text — the
      // reason and the state are words this hub chose, and `gapSince` would
      // be an instant about a session that has ended.
      coverage: coverage.sources.map((row) => ({
        source: row.source,
        state: row.state,
        reason: row.reason,
      })),
      seqEpoch: seq.epoch,
      seqFirst: seq.first,
      seqLast: seq.last,
      seqGaps: seq.gaps,
      seqNullRecords: seq.nullRecords,
      seqEpochs: seq.epochs,
    })
    // A REVIVED SESSION CAN END TWICE. `reviveReapedSession` undoes an
    // inferred end when a record arrives from that session, so the same id
    // reaches this function again — and the SECOND end is the true one.
    .onConflictDoUpdate({
      target: pilotSessions.sessionId,
      set: {
        observedAt: now,
        endReason: input.endReason,
        seqEpoch: seq.epoch,
        seqFirst: seq.first,
        seqLast: seq.last,
        seqGaps: seq.gaps,
        seqNullRecords: seq.nullRecords,
        seqEpochs: seq.epochs,
      },
    });
};

/**
 * What a hub stamps on a mark, always. Never taken from a body: here the
 * assertion would be the very thing being measured.
 */
const HUMAN_CAPTURE_MODE = "human" as const;

/** Why a mark was refused — an enum, so a route never invents prose. */
export type MarkRefusal =
  | "not_enrolled"
  | "unknown_ref"
  | "wrong_repo"
  | "not_yours"
  | "pin_broken";

/** What a mark is about, reduced to what decides whether it may be made. */
interface MarkTarget {
  readonly repo: string;
  /** Whoever received it — a delivery only; anybody may run a pin's recipe. */
  readonly recipient: string | null;
  readonly broken: boolean;
}

const readMarkTarget = async (
  deps: Deps,
  refKind: PilotMarkRefKind,
  refId: string,
): Promise<MarkTarget | undefined> => {
  if (refKind === "pin") {
    const rows = await deps.db
      .select({ repo: pins.repo, brokeAt: pins.brokeAt })
      .from(pins)
      .where(eq(pins.id, refId))
      .limit(1);
    const row = rows[0];
    return row === undefined
      ? undefined
      : { repo: row.repo, recipient: null, broken: row.brokeAt !== null };
  }
  const rows = await deps.db
    .select({ repo: agentSessions.repo, recipient: agentSessions.developerId })
    .from(hintDeliveries)
    .innerJoin(agentSessions, eq(hintDeliveries.sessionId, agentSessions.id))
    .where(eq(hintDeliveries.id, refId))
    .limit(1);
  const row = rows[0];
  return row === undefined
    ? undefined
    : { repo: row.repo, recipient: row.recipient, broken: false };
};

/**
 * WHETHER THIS PERSON MAY SAY THIS ABOUT THIS, in the order a person would
 * want to be told: a mistyped id before a policy.
 *
 * NOT YOURS. Proof 4 counts how many people found what reached THEM noisy. A
 * teammate calling somebody else's delivery noise is taste about a session
 * they never sat in, and counting it would turn "interrupted" into "has an
 * opinion". A pin is the opposite case: its falsifier is a recipe, and
 * whoever ran it is the one who knows, whoever pinned it.
 *
 * NOT ON A BREAK. "Ok" about a pin recorded broken is either a mistake or a
 * repair, and a repair needs the commit and the files that only `pin add`
 * records — accepting it here would leave the break unrepaired in the record
 * while proof 4 counted the surface as fine.
 */
const refuseMark = (
  target: MarkTarget | undefined,
  input: WriteMarkInput,
): MarkRefusal | null => {
  if (target === undefined) {
    return "unknown_ref";
  }
  if (target.repo !== input.repo) {
    return "wrong_repo";
  }
  if (target.recipient !== null && target.recipient !== input.markedBy) {
    return "not_yours";
  }
  if (target.broken) {
    return "pin_broken";
  }
  return null;
};

export interface WriteMarkInput {
  readonly repo: string;
  readonly refKind: PilotMarkRefKind;
  readonly refId: string;
  readonly mark: PilotMark;
  readonly markedBy: string;
}

export type WriteMarkOutcome =
  | { readonly id: string; readonly repeated: boolean }
  | { readonly refusal: MarkRefusal };

/**
 * ONE PERSON'S ONE MARK ABOUT ONE THING (§3.2).
 *
 * REPEATING IS NOT A SECOND COMPLAINT. Somebody who types `crosscheck noise`
 * twice has said one thing twice; counting both would make the noise figure a
 * keystroke count, and the figure's whole job is to say how many PEOPLE found
 * this product noisy. The unique key is the database's, not this function's —
 * but the answer a person reads has to distinguish "recorded" from "you had
 * already said that", or the second attempt looks like it did nothing.
 *
 * THE REF IS CHECKED, and refusing an unknown one is not pedantry: a mark on
 * an id that does not exist is a row that can never join to anything, and
 * proof 4's denominator would grow with marks about nothing. It also catches
 * the ordinary case — a mistyped id — with a sentence instead of silence.
 *
 * REPO-SCOPED, like every other answer in this product. A mark on another
 * repo's delivery would count somebody else's noise against this team.
 */
export const writePilotMark = async (
  deps: Deps,
  input: WriteMarkInput,
): Promise<WriteMarkOutcome> => {
  const settings = await readTeamSettings(deps, input.repo);
  if (!settings.pilotEnrolled) {
    // NOT silence: a person typed this, and "nothing happened" is the one
    // answer a gesture must never get.
    return { refusal: "not_enrolled" };
  }
  const refusal = refuseMark(
    await readMarkTarget(deps, input.refKind, input.refId),
    input,
  );
  if (refusal !== null) {
    return { refusal };
  }
  const id = `pm_${randomUUID()}`;
  const inserted = await deps.db
    .insert(pilotMarks)
    .values({
      id,
      repo: input.repo,
      refKind: input.refKind,
      refId: input.refId,
      mark: input.mark,
      markedBy: input.markedBy,
      // STAMPED BY THE HUB. The body said what it OBSERVED; only the hub says
      // what that observation is worth.
      captureMode: HUMAN_CAPTURE_MODE,
      createdAt: deps.now(),
    })
    .onConflictDoNothing()
    .returning({ id: pilotMarks.id });
  return inserted[0] === undefined
    ? { id: input.refId, repeated: true }
    : { id, repeated: false };
};
