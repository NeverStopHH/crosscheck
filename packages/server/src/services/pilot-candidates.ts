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
import { and, asc, desc, eq, gte, inArray, ne } from "drizzle-orm";
import { PULLED_DELIVERY_CHANNEL } from "@crosscheck/schema";

import { NOISE_MARK_MAX_CANDIDATES } from "../constants.ts";
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
