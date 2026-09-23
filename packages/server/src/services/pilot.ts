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

import { pilotAttributions } from "../db/schema.ts";
import { isJudgeable } from "./coverage.ts";
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
