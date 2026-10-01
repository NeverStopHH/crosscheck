/**
 * WHICH DELIVERY `crosscheck noise` MEANS (1.0 spec 07 §3.2).
 *
 * The gesture is one word typed beside the session that got a bad
 * intervention, so this answers "which one was that" from very little: the
 * caller's own deliveries, on this repo, to the sessions the caller names
 * (the ones live on their machine), inside a window — or every delivery of
 * the one ref the caller saw printed in a hint.
 *
 * THE CALLER'S OWN, NEVER A TEAMMATE'S. The mark route refuses a delivery
 * somebody else received; listing one here would make that refusal the first
 * thing a person meets. And never a pulled answer: somebody asked for it, and
 * proof 4 is about what arrived unasked.
 *
 * BOUNDED, AND THE CUT IS SAID. One row more than the bound is read so the
 * answer can say "there are more" without counting them, which keeps the cost
 * of a keystroke independent of how busy the morning was.
 */
import { and, asc, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { PULLED_DELIVERY_CHANNEL } from "@crosscheck/schema";

import {
  NOISE_MARK_MAX_CANDIDATES,
  PILOT_LABEL_MAX_CANDIDATES,
} from "../constants.ts";
import { agentSessions, hintDeliveries } from "../db/schema.ts";
import { readTeamSettings } from "./team-settings.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

const MS_PER_MINUTE = 60_000;

export interface MarkCandidate {
  readonly id: string;
  readonly sessionId: string;
  readonly channel: string;
  readonly refKind: string;
  readonly refId: string;
  readonly deliveredAt: string;
}

export interface MarkCandidates {
  readonly candidates: readonly MarkCandidate[];
  /** More matched than NOISE_MARK_MAX_CANDIDATES; the rest are not listed. */
  readonly more: boolean;
}

export interface ReadMarkCandidatesInput {
  readonly repo: string;
  readonly developerId: string;
  /** Empty: every session of the caller's on this repo. */
  readonly sessions: readonly string[];
  /** The work-context or claim id the caller saw printed, if they named one. */
  readonly ref: string | null;
  readonly withinMinutes: number;
}

export const readMarkCandidates = async (
  deps: Deps,
  input: ReadMarkCandidatesInput,
): Promise<MarkCandidates | { readonly refusal: "not_enrolled" }> => {
  const settings = await readTeamSettings(deps, input.repo);
  if (!settings.pilotEnrolled) {
    return { refusal: "not_enrolled" };
  }
  const since = new Date(
    deps.now().getTime() - input.withinMinutes * MS_PER_MINUTE,
  );
  const rows = await deps.db
    .select({
      id: hintDeliveries.id,
      sessionId: hintDeliveries.sessionId,
      channel: hintDeliveries.channel,
      refKind: hintDeliveries.refKind,
      refId: hintDeliveries.refId,
      deliveredAt: hintDeliveries.deliveredAt,
    })
    .from(hintDeliveries)
    .innerJoin(agentSessions, eq(hintDeliveries.sessionId, agentSessions.id))
    .where(
      and(
        eq(agentSessions.repo, input.repo),
        eq(agentSessions.developerId, input.developerId),
        ne(hintDeliveries.channel, PULLED_DELIVERY_CHANNEL),
        gte(hintDeliveries.deliveredAt, since),
        input.sessions.length === 0
          ? undefined
          : inArray(hintDeliveries.sessionId, [...input.sessions]),
        input.ref === null ? undefined : eq(hintDeliveries.refId, input.ref),
      ),
    )
    .orderBy(desc(hintDeliveries.deliveredAt), asc(hintDeliveries.id))
    .limit(NOISE_MARK_MAX_CANDIDATES + 1);
  return {
    candidates: rows.slice(0, NOISE_MARK_MAX_CANDIDATES).map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      channel: row.channel,
      refKind: row.refKind,
      refId: row.refId,
      deliveredAt: row.deliveredAt.toISOString(),
    })),
    more: rows.length > NOISE_MARK_MAX_CANDIDATES,
  };
};

/**
 * THE WORK CONTEXT A DELIVERY POINTED AT, whichever ref kind it names — a
 * claim's is its parent's. Written against the alias `hd`; the report and
 * the label walk both read it, so there is one definition of "pointed".
 */
export const POINTED_WORK_CONTEXT = sql`CASE WHEN hd.ref_kind = 'work_context' THEN hd.ref_id
  ELSE (SELECT c.work_context_id FROM claims c WHERE c.id = hd.ref_id) END`;

export interface UnlabeledIntervention extends MarkCandidate {
  /** What was shown: the pointed work context's title, or null when nothing resolves. */
  readonly title: string | null;
}

export interface UnlabeledInterventions {
  readonly candidates: readonly UnlabeledIntervention[];
  /** More matched than PILOT_LABEL_MAX_CANDIDATES; the next run continues. */
  readonly more: boolean;
}

export interface ReadUnlabeledInput {
  readonly repo: string;
  readonly developerId: string;
  readonly withinMinutes: number;
}

type UnlabeledRow = {
  readonly id: string;
  readonly session_id: string;
  readonly channel: string;
  readonly ref_kind: string;
  readonly ref_id: string;
  readonly delivered_at: string | Date;
  readonly title: string | null;
};

/**
 * WHAT `crosscheck pilot label` WALKS (07 §12): the caller's own unasked
 * deliveries on this repo that THE CALLER has not labelled, newest first,
 * inside a window, each with the title it pointed at.
 *
 * NOT LIVE SESSIONS: `crosscheck noise` narrows to the sessions live on the
 * machine because it is typed beside one; a label walk happens after the
 * session, when its state file is gone, so the window alone bounds it.
 *
 * "NOT LABELLED" IS PER CALLER, and only the caller can have labelled it —
 * the mark route refuses everybody else — so the anti-join is on this
 * developer's marks, whatever word they carry.
 *
 * THE TITLE IS A TEAMMATE'S PROSE. It rides here so a person can judge what
 * they were shown; the CLI frames it as quoted data, as the report does.
 * And it is THIS REPO's, as in the report (07 §11.9): a delivery's ref is the
 * client's own word, so a pointer at another repo's work context is listed
 * — it did reach this person — with no title rather than with that repo's.
 */
export const readUnlabeledInterventions = async (
  deps: Deps,
  input: ReadUnlabeledInput,
): Promise<UnlabeledInterventions | { readonly refusal: "not_enrolled" }> => {
  const settings = await readTeamSettings(deps, input.repo);
  if (!settings.pilotEnrolled) {
    return { refusal: "not_enrolled" };
  }
  const since = new Date(deps.now().getTime() - input.withinMinutes * MS_PER_MINUTE);
  const rows = await deps.db.execute<UnlabeledRow>(sql`
    SELECT hd.id, hd.session_id, hd.channel, hd.ref_kind, hd.ref_id, hd.delivered_at,
           wc.title AS title
    FROM hint_deliveries hd
    JOIN agent_sessions s ON s.id = hd.session_id
    LEFT JOIN work_contexts wc ON wc.id = (${POINTED_WORK_CONTEXT})
      AND EXISTS (SELECT 1 FROM agent_sessions owner
                  WHERE owner.id = wc.session_id AND owner.repo = ${input.repo})
    WHERE s.repo = ${input.repo}
      AND s.developer_id = ${input.developerId}
      AND hd.channel <> ${PULLED_DELIVERY_CHANNEL}
      AND hd.delivered_at >= ${since.toISOString()}::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM pilot_marks m
        WHERE m.ref_kind = 'hint_delivery' AND m.ref_id = hd.id
          AND m.marked_by = ${input.developerId}
      )
    ORDER BY hd.delivered_at DESC, hd.id ASC
    LIMIT ${PILOT_LABEL_MAX_CANDIDATES + 1}`);
  return {
    candidates: rows.rows.slice(0, PILOT_LABEL_MAX_CANDIDATES).map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      channel: row.channel,
      refKind: row.ref_kind,
      refId: row.ref_id,
      deliveredAt: new Date(row.delivered_at).toISOString(),
      title: row.title,
    })),
    more: rows.rows.length > PILOT_LABEL_MAX_CANDIDATES,
  };
};
