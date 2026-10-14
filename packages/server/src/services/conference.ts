/**
 * The conference CORPUS (VISION.md §2): everything one `crosscheck conference`
 * run is allowed to read, in one bounded answer.
 *
 * A CONFERENCE IS A DELIBERATE PULL, and every rule below follows from that.
 * A human — or their scheduler — typed the command; nothing here is injected
 * into anybody's session, no hook fires it, and the report it feeds is a
 * document the reader asked for. So this endpoint takes the posture of the
 * other pull surfaces (services/visibility.ts): mute does not filter it, a
 * presence opt-out does not hide anybody from it, and the caller's own
 * contexts are IN it — two people doing the same work is the finding, and one
 * of them is usually the reader. `search` is the exact precedent: the same
 * team-visible knowledge, ranked, with ages, for a caller who asked.
 *
 * WHAT IT MAY DISCLOSE. Claims that a teammate DECLARED and the titles and
 * intents of their work contexts — all of it already readable by this caller
 * through `search_related_work` and `get_diagnosis`, which is what makes the
 * report a re-reading rather than a new disclosure. Two things are therefore
 * NOT here:
 *
 *   - DERIVED claims. A teammate's Tier-1 draft is a machine guess nobody
 *     vouched for (DESIGN.md §3), and feeding one to a model that produces
 *     another derived sentence would launder a guess into a second guess with
 *     a fresh timestamp — ghost/prompt.ts refuses them for the same reason.
 *   - QUESTION BODIES. A question is addressed to ONE person and the database
 *     enforces that it has an addressee at all (schema.ts
 *     questions_addressee_check). A report naming what Ken asked Mira would
 *     turn a private channel into a broadcast — the exact failure R2's model
 *     was designed against — so the question rows on this wire carry WHO
 *     asked, WHO is waiting and HOW LONG, and no body at all. That is not a
 *     renderer's discretion: the column is never selected.
 *
 * LIVE MEANS UNMERGED, NOT UNATTENDED, and that is the one place this differs
 * from the ghost check. A ghost line asserts that somebody is in your way NOW,
 * so it excludes ended sessions; a conference asks what this team has been
 * circling, and VISION §2's own scenario runs it overnight, when nobody's
 * session is live. Excluding ended sessions would make the overnight
 * conference read an empty repo. Landed work is still excluded on both — work
 * that merged is not work anybody is still doing. But ended work is BOUNDED
 * (pilot finding, 2026-10-07): it stays for CONFERENCE_ENDED_GRACE_HOURS after
 * its end and ranks after every open session's, because with landed rarely
 * firing, a fortnight of finished work filled the page (19 to 246 contexts on
 * a copy of the pilot hub) and pushed the live collision off it.
 *
 * BOUNDED END TO END, and the bounds are arithmetic rather than hope:
 * CONFERENCE_MAX_CONTEXTS contexts, each contributing at most
 * CONFERENCE_MAX_CLAIMS_PER_CONTEXT claims through ONE indexed lookup of its
 * own, a probe of at most GHOST_MAX_PROBE_VALUES target values that the other
 * contexts of the page are looked up by, and pairwise comparison over that
 * same slice (66 pairs at the cap) rather than a join that could fan out. The
 * duplicated-work RULE is the ghost check's own — one shared error
 * fingerprint, or GHOST_MIN_SHARED_TARGETS shared files or symbols, with hot
 * values dropped and LARGE CHANGES QUALIFIED, never dropped
 * (services/ghost-overlap.ts states the ConE reasoning and this imports its
 * predicates rather than re-typing them) — applied between two DEVELOPERS'
 * contexts instead of from one reader's side.
 */
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  CONFERENCE_ACTIVE_WINDOW_DAYS,
  CONFERENCE_ENDED_GRACE_HOURS,
  CONFERENCE_CLAIM_BODY_MAX_CHARS,
  CONFERENCE_MAX_CLAIMS_PER_CONTEXT,
  CONFERENCE_MAX_CONTEXTS,
  CONFERENCE_MAX_CONTRADICTIONS,
  CONFERENCE_MAX_COUNTED_CONTEXTS,
  CONFERENCE_MAX_OVERLAP_PAIRS,
  CONFERENCE_MAX_QUESTIONS,
  GHOST_FINGERPRINT_MIN_SHARED,
  GHOST_HOT_TARGET_MAX_CONTEXTS,
  GHOST_MAX_SHARED_SHOWN,
  GHOST_MIN_SHARED_TARGETS,
} from "../constants.ts";
import {
  agentSessions,
  claims,
  developers,
  questions,
  workContexts,
  workContextTargets,
} from "../db/schema.ts";
import { listContradictions } from "./contradictions.ts";
import type { ContradictionView } from "./contradictions.ts";
import {
  activityExpression,
  listLargeChanges,
  listProbeValues,
  targetValueCondition,
} from "./ghost-overlap.ts";
import type { ContextValues, OverlapKind, SharedValue } from "./ghost-overlap.ts";
import { listGeneratedSharedPairs, ordinaryTargetCondition, pairKey } from "./generated-targets.ts";
import { UNRESOLVED_AXES, readEvidenceAxes } from "./evidence-axes.ts";
import { activitySeenBy, locationHiddenFrom, projectRow } from "./live-location.ts";
import type { HiddenLocations } from "./live-location.ts";
import { visiblePresenceCondition } from "./visibility.ts";
import type { EvidenceAxes } from "@crosscheck/schema";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

/** Only what a person or their agent stated — never a machine draft. */
const DECLARED_PROVENANCE = "declared";

/** A claim its own author revised away no longer states a position. */
const SUPERSEDED_STATUS = "superseded";

/** The one kind whose identity is CONTENT — see GHOST_FINGERPRINT_MIN_SHARED. */
const FINGERPRINT_KIND = "error_fingerprint";

const OPEN_STATUS = "open";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

export interface ConferenceClaimView {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly confidence: number;
  /** Was anything actually RUN behind this (1.0 spec 08 §3.1). */
  readonly axes: EvidenceAxes;
  /** Always "declared" here; on the wire so the report can label it anyway. */
  readonly provenance: string;
  /** Cut at CONFERENCE_CLAIM_BODY_MAX_CHARS — the model and the reader see the same text. */
  readonly body: string;
  readonly authorDeveloperName: string;
  readonly createdAt: string;
}

export interface ConferenceContextView {
  readonly id: string;
  readonly title: string;
  readonly developerId: string;
  readonly developerName: string;
  readonly status: string;
  readonly intent: Record<string, unknown> | null;
  /** coalesce(updated_at, created_at): the age every surface prints. */
  readonly lastActiveAt: string;
  readonly claims: readonly ConferenceClaimView[];
}

/** Two contexts of DIFFERENT developers standing on the same ground. */
export interface ConferenceOverlapView {
  readonly workContextIdA: string;
  readonly workContextIdB: string;
  readonly sharedTargets: readonly { readonly kind: string; readonly value: string }[];
  readonly sharedTargetCount: number;
  /**
   * Files both contexts carry that at least one side labelled MECHANICALLY
   * GENERATED AND NON-AUTHORITATIVE
   * (services/generated-targets.ts) — never in the count above, never a
   * reason for the pair, stated beside it. 0 when there are none.
   */
  readonly generatedSharedCount: number;
  /**
   * The files each side's change touched in the window when that side is a
   * LARGE CHANGE (over GHOST_MAX_CONTEXT_TARGETS), else null — the qualifier
   * the report prints beside the pair. Never a reason the pair is missing.
   */
  readonly largeChangeFilesA: number | null;
  readonly largeChangeFilesB: number | null;
}

/**
 * An open question, as a POINTER. No body — see the header: the channel is
 * addressed communication and this is a report about the team.
 */
export interface ConferenceQuestionView {
  readonly id: string;
  readonly authorDeveloperName: string;
  readonly targetDeveloperName: string | null;
  readonly workContextId: string | null;
  readonly workContextTitle: string | null;
  readonly createdAt: string;
  /** True when the READER may answer it — the only case the report prints the call. */
  readonly isForReader: boolean;
}

export interface ConferenceView {
  readonly contexts: readonly ConferenceContextView[];
  readonly overlaps: readonly ConferenceOverlapView[];
  readonly questions: readonly ConferenceQuestionView[];
  readonly contradictions: readonly ContradictionView[];
  /** Work contexts in the window, so the report can say what it did NOT read. */
  readonly contextsInWindow: number;
  /** True when the count hit CONFERENCE_MAX_COUNTED_CONTEXTS and means "or more". */
  readonly contextsInWindowCapped: boolean;
  readonly windowDays: number;
}

/**
 * A context's activity as THIS reader may window and rank by it: a teammate
 * who opted out of presence counts from creation alone (services/live-
 * location.ts activitySeenBy), or "in the window" and "first in the report"
 * would say when she last touched her work.
 */
const activitySeenByReader = (viewerDeveloperId: string) =>
  activitySeenBy(viewerDeveloperId, agentSessions.developerId, workContexts.updatedAt, workContexts.createdAt);

/**
 * Whether a context's session is OPEN, as this reader may rank by it: a
 * session's end is its owner's instant, so for an owner hidden from the
 * reader it is not read — her work ranks with the ended, by creation.
 */
const openSeenByReader = (viewerDeveloperId: string): SQL =>
  sql`(case when ${visiblePresenceCondition(viewerDeveloperId, agentSessions.developerId)} then ${agentSessions.endedAt} is null else false end)`;

/**
 * Ended no longer ago than CONFERENCE_ENDED_GRACE_HOURS — or open — as this
 * reader may judge it: an owner hidden from the reader is judged by
 * creation alone, as the window already judges her.
 */
const withinEndedGrace = (viewerDeveloperId: string, endedSince: Date): SQL =>
  sql`(case when ${visiblePresenceCondition(viewerDeveloperId, agentSessions.developerId)} then (${agentSessions.endedAt} is null or ${agentSessions.endedAt} >= ${endedSince.toISOString()}::timestamptz) else true end)`;

/**
 * Unfinished work of this repo inside the window, attended or not — work
 * whose session ended counts only within CONFERENCE_ENDED_GRACE_HOURS.
 */
const recentWorkCondition = (repo: string, window: ConferenceWindow, viewerDeveloperId: string) =>
  and(
    eq(agentSessions.repo, repo),
    gte(activityExpression, window.cutoff),
    gte(activitySeenByReader(viewerDeveloperId), window.cutoff),
    withinEndedGrace(viewerDeveloperId, window.endedSince),
    isNull(workContexts.landedAt),
  );

/** The two instants a conference reads by: activity since, and ended since. */
interface ConferenceWindow {
  readonly cutoff: Date;
  readonly endedSince: Date;
}

/**
 * The page: OPEN sessions' work first, then the ended work within the grace,
 * each freshest first — so a live collision is never the context a page of
 * yesterday's finished work pushes out.
 */
const listRecentContexts = async (
  deps: Deps,
  repo: string,
  window: ConferenceWindow,
  viewerDeveloperId: string,
  hidden: HiddenLocations,
): Promise<readonly Omit<ConferenceContextView, "claims">[]> => {
  const rows = await deps.db
    .select({
      id: workContexts.id,
      title: workContexts.title,
      status: workContexts.status,
      intent: workContexts.intent,
      developerId: agentSessions.developerId,
      developerName: developers.name,
      lastActiveAt: sql<string>`${activityExpression}`,
      branch: agentSessions.branch,
      titleSource: workContexts.titleSource,
    })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .innerJoin(developers, eq(agentSessions.developerId, developers.id))
    .where(recentWorkCondition(repo, window, viewerDeveloperId))
    .orderBy(
      desc(openSeenByReader(viewerDeveloperId)),
      desc(activitySeenByReader(viewerDeveloperId)),
      asc(workContexts.id),
    )
    .limit(CONFERENCE_MAX_CONTEXTS);
  return rows.map((row) =>
    projectRow(hidden, { developerId: row.developerId, titleFacts: { repo, branch: row.branch, titleSource: row.titleSource } }, {
      id: row.id,
      title: row.title,
      status: row.status,
      intent: row.intent ?? null,
      developerId: row.developerId,
      developerName: row.developerName,
      lastActiveAt: new Date(row.lastActiveAt).toISOString(),
    }),
  );
};

/**
 * How much work the window holds, counted through a BOUNDED read of ids
 * rather than count(*): the number exists so the report can say "12 of 47",
 * and a report line does not get to scan ten thousand rows for it. At the cap
 * the caller is told the count is a floor and the line says so.
 */
const countContextsInWindow = async (
  deps: Deps,
  repo: string,
  window: ConferenceWindow,
  viewerDeveloperId: string,
): Promise<{ readonly total: number; readonly capped: boolean }> => {
  const rows = await deps.db
    .select({ id: workContexts.id })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(recentWorkCondition(repo, window, viewerDeveloperId))
    .limit(CONFERENCE_MAX_COUNTED_CONTEXTS);
  return {
    total: rows.length,
    capped: rows.length === CONFERENCE_MAX_COUNTED_CONTEXTS,
  };
};

/** Code points, never UTF-16 units: a cut must not split a surrogate pair. */
const cutBody = (body: string): string => {
  const points = [...body];
  return points.length <= CONFERENCE_CLAIM_BODY_MAX_CHARS
    ? body
    : points.slice(0, CONFERENCE_CLAIM_BODY_MAX_CHARS).join("");
};

/**
 * The declared claims of ONE context, newest first — one indexed lookup
 * (claims_work_context_created_idx). One query per context rather than a
 * single `IN (…)`: the per-context LIMIT is what makes the read arithmetic,
 * and with twelve contexts sharing one window a tree with nine hundred claims
 * takes the whole of it and empties the eleven beside it (the defect Block 4
 * measured on the reader's own targets). The count is bounded by
 * CONFERENCE_MAX_CONTEXTS, so this is a fixed number of lookups, not an N+1
 * over a list a caller controls.
 */
const listContextClaims = async (
  deps: Deps,
  workContextId: string,
  hidden: HiddenLocations,
): Promise<readonly ConferenceClaimView[]> => {
  const rows = await deps.db
    .select({
      id: claims.id,
      kind: claims.kind,
      status: claims.status,
      confidence: claims.confidence,
      provenance: claims.provenance,
      body: claims.body,
      authorDeveloperId: agentSessions.developerId,
      authorDeveloperName: developers.name,
      createdAt: claims.createdAt,
      // What the evidence ladder needs, off the same row. A conference report
      // quotes a teammate's claim with a confidence beside it and is read at
      // standup, where a number nobody measured does the most persuading.
      workContextId: claims.workContextId,
      verificationRef: claims.verificationRef,
      commitBinding: claims.commitBinding,
      observedAtCommit: claims.observedAtCommit,
      repo: agentSessions.repo,
    })
    .from(claims)
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .innerJoin(developers, eq(agentSessions.developerId, developers.id))
    .where(
      and(
        eq(claims.workContextId, workContextId),
        eq(claims.provenance, DECLARED_PROVENANCE),
        ne(claims.status, SUPERSEDED_STATUS),
      ),
    )
    .orderBy(desc(claims.createdAt), asc(claims.id))
    .limit(CONFERENCE_MAX_CLAIMS_PER_CONTEXT);
  // One read for this context's bounded slice. Grouped by the claim's own
  // repo for the reason every other grouped call has: the ladder resolves CI
  // by repo, and answering against the wrong one fails in the exonerating
  // direction.
  const byRepo = new Map<string, typeof rows>();
  for (const row of rows) {
    byRepo.set(row.repo, [...(byRepo.get(row.repo) ?? []), row]);
  }
  const axes = new Map<string, EvidenceAxes>();
  for (const [repo, group] of byRepo) {
    const derived = await readEvidenceAxes({ db: deps.db, repo, claims: group });
    for (const [id, value] of derived) {
      axes.set(id, value);
    }
  }
  // Each claim by its AUTHOR (services/live-location.ts): the evidence rung's
  // age is when her session observed the failure it cites.
  return rows.map((row) =>
    projectRow(hidden, { developerId: row.authorDeveloperId, kind: "claim" }, {
      id: row.id,
      kind: row.kind,
      status: row.status,
      confidence: row.confidence,
      provenance: row.provenance,
      body: cutBody(row.body),
      authorDeveloperName: row.authorDeveloperName,
      axes: axes.get(row.id) ?? UNRESOLVED_AXES,
      createdAt: row.createdAt.toISOString(),
    }),
  );
};

/**
 * Which contexts of the page HOLD each probed value — the half of the
 * comparison that is looked up, never read whole. Every context's probe
 * (listProbeValues) is looked up in every other context of the page, so a
 * pair is found when EITHER side's probe holds what they share: a large
 * change's file that is not among its own newest touches is found through
 * the focused side's probe, which is what "every file it shares still
 * produces the overlap" costs — and the cost is the probes, never the size
 * of the change.
 *
 * Arithmetic: a context holds a value at most once (the targets primary
 * key), so the page holds at most ids x values rows of these.
 */
const listMembers = async (
  deps: Deps,
  ids: readonly string[],
  values: readonly SharedValue[],
): Promise<readonly ContextValues[]> => {
  const condition = targetValueCondition(values);
  if (ids.length === 0 || condition === undefined) {
    return [];
  }
  const rows = await deps.db
    .select({
      workContextId: workContextTargets.workContextId,
      kind: workContextTargets.kind,
      value: workContextTargets.value,
    })
    .from(workContextTargets)
    // A member holds a value only as EVIDENCE: a generated row of it is no
    // reason for a pair (services/generated-targets.ts).
    .where(and(inArray(workContextTargets.workContextId, [...ids]), condition, ordinaryTargetCondition()))
    .orderBy(
      asc(workContextTargets.workContextId),
      asc(workContextTargets.kind),
      asc(workContextTargets.value),
    )
    .limit(ids.length * values.length);
  const byContext = new Map<string, SharedValue[]>();
  for (const row of rows) {
    byContext.set(row.workContextId, [
      ...(byContext.get(row.workContextId) ?? []),
      { kind: row.kind as OverlapKind, value: row.value },
    ]);
  }
  return [...byContext.entries()].map(([workContextId, held]) => ({
    workContextId,
    values: held,
  }));
};

/**
 * The values too common to mean anything — a lockfile, the router, the config
 * every session edits (GHOST_HOT_TARGET_MAX_CONTEXTS, ConE's rarity rule).
 * Counted over the whole repo, because rarity is a property of the repo and
 * not of the twelve contexts that happen to be in this window.
 */
const listHotValues = async (
  deps: Deps,
  repo: string,
  values: readonly SharedValue[],
): Promise<ReadonlySet<string>> => {
  const condition = targetValueCondition(values);
  if (condition === undefined) {
    return new Set();
  }
  const rows = await deps.db
    .select({
      kind: workContextTargets.kind,
      value: workContextTargets.value,
      contexts: count(),
    })
    .from(workContextTargets)
    .innerJoin(
      workContexts,
      eq(workContexts.id, workContextTargets.workContextId),
    )
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    // Rarity counts evidence only, exactly as the ghost check's hot count.
    .where(and(condition, eq(agentSessions.repo, repo), ordinaryTargetCondition()))
    .groupBy(workContextTargets.kind, workContextTargets.value);
  return new Set(
    rows
      .filter((row) => row.contexts > GHOST_HOT_TARGET_MAX_CONTEXTS)
      .map((row) => `${row.kind} ${row.value}`),
  );
};

const valueKey = (target: SharedValue): string => `${target.kind} ${target.value}`;

/** Each value once: the page's probes overlap wherever two contexts share. */
const uniqueValues = (values: readonly SharedValue[]): readonly SharedValue[] => [
  ...new Map(values.map((target) => [valueKey(target), target])).values(),
];

/**
 * Duplicated work: pairs of contexts belonging to DIFFERENT developers that
 * share an error fingerprint, or GHOST_MIN_SHARED_TARGETS files or symbols.
 *
 * Different developers on purpose. One person's two worktrees standing in the
 * same files is how a person works, not duplicated work — the same argument
 * self-exclusion makes on every unasked surface, made here about the pair
 * rather than about the reader.
 *
 * A LARGE CHANGE PAIRS LIKE ANY OTHER CONTEXT (services/ghost-overlap.ts
 * states why): its size is the pair's qualifier and puts it after the
 * focused pairs, and nothing else. `members` holds only values that are not
 * hot (listHotValues ran over the probes first).
 */
const pairOverlaps = (
  contexts: readonly Omit<ConferenceContextView, "claims">[],
  members: readonly ContextValues[],
  large: ReadonlyMap<string, number>,
  generatedShared: ReadonlyMap<string, number>,
): readonly ConferenceOverlapView[] => {
  const owner = new Map(contexts.map((context) => [context.id, context.developerId]));
  const held = new Map(members.map((entry) => [entry.workContextId, entry.values]));
  const ids = contexts.map((context) => context.id);
  const found: {
    readonly view: ConferenceOverlapView;
    readonly fingerprints: number;
    readonly isLarge: boolean;
  }[] = [];
  for (let left = 0; left < ids.length; left += 1) {
    for (let right = left + 1; right < ids.length; right += 1) {
      const idA = ids[left] as string;
      const idB = ids[right] as string;
      if (owner.get(idA) === owner.get(idB)) {
        continue;
      }
      const theirs = new Set((held.get(idB) ?? []).map(valueKey));
      const shared = (held.get(idA) ?? []).filter((target) =>
        theirs.has(valueKey(target)),
      );
      const fingerprints = shared.filter(
        (target) => target.kind === FINGERPRINT_KIND,
      ).length;
      if (
        fingerprints < GHOST_FINGERPRINT_MIN_SHARED &&
        shared.length < GHOST_MIN_SHARED_TARGETS
      ) {
        continue;
      }
      found.push({
        fingerprints,
        isLarge: large.has(idA) || large.has(idB),
        view: {
          workContextIdA: idA,
          workContextIdB: idB,
          // Strongest kind first, so a truncated list keeps the values a
          // reader would have wanted (OVERLAP_TARGET_KINDS says why the
          // alphabetical order IS strongest-first).
          sharedTargets: [...shared]
            .sort(
              (one, other) =>
                one.kind.localeCompare(other.kind) ||
                one.value.localeCompare(other.value),
            )
            .slice(0, GHOST_MAX_SHARED_SHOWN),
          sharedTargetCount: shared.length,
          generatedSharedCount: generatedShared.get(pairKey(idA, idB)) ?? 0,
          largeChangeFilesA: large.get(idA) ?? null,
          largeChangeFilesB: large.get(idB) ?? null,
        },
      });
    }
  }
  // The ghost check's order (ghost-overlap.ts byStrength): a shared failure
  // first whatever its size, then focused pairs before large changes.
  return found
    .sort(
      (one, other) =>
        other.fingerprints - one.fingerprints ||
        Number(one.isLarge) - Number(other.isLarge) ||
        other.view.sharedTargetCount - one.view.sharedTargetCount ||
        one.view.workContextIdA.localeCompare(other.view.workContextIdA),
    )
    .slice(0, CONFERENCE_MAX_OVERLAP_PAIRS)
    .map((entry) => entry.view);
};

/**
 * Open, unexpired questions of this repo, OLDEST FIRST — the stalest thread is
 * the finding, and the TTL is applied in SQL like every other question read so
 * a status the lazy flip never updated cannot haunt this report either.
 *
 * `isForReader` repeats the hub's own answerability rule (services/questions.ts):
 * the named target, or the owner of the context it is about.
 */
const listOpenQuestions = async (
  deps: Deps,
  viewerDeveloperId: string,
  repo: string,
  hidden: HiddenLocations,
): Promise<readonly ConferenceQuestionView[]> => {
  const authors = alias(developers, "conference_question_authors");
  const targets = alias(developers, "conference_question_targets");
  const contextSessions = alias(agentSessions, "conference_question_sessions");
  const rows = await deps.db
    .select({
      id: questions.id,
      authorDeveloperId: questions.authorDeveloperId,
      authorDeveloperName: authors.name,
      targetDeveloperId: questions.targetDeveloperId,
      targetDeveloperName: targets.name,
      workContextId: questions.workContextId,
      workContextTitle: workContexts.title,
      contextOwnerId: contextSessions.developerId,
      contextBranch: contextSessions.branch,
      contextTitleSource: workContexts.titleSource,
      createdAt: questions.createdAt,
    })
    .from(questions)
    .innerJoin(authors, eq(questions.authorDeveloperId, authors.id))
    .leftJoin(targets, eq(questions.targetDeveloperId, targets.id))
    .leftJoin(workContexts, eq(questions.workContextId, workContexts.id))
    .leftJoin(contextSessions, eq(workContexts.sessionId, contextSessions.id))
    .where(
      and(
        eq(questions.repo, repo),
        eq(questions.status, OPEN_STATUS),
        gt(questions.expiresAt, deps.now()),
      ),
    )
    .orderBy(asc(questions.createdAt), asc(questions.id))
    .limit(CONFERENCE_MAX_QUESTIONS);
  return rows.map((row) => {
    const view = {
      id: row.id,
      authorDeveloperName: row.authorDeveloperName,
      targetDeveloperName: row.targetDeveloperName,
      workContextId: row.workContextId,
      workContextTitle: row.workContextTitle,
      createdAt: row.createdAt.toISOString(),
      isForReader:
        row.targetDeveloperId === viewerDeveloperId ||
        row.contextOwnerId === viewerDeveloperId,
    };
    // Two owners: the question is its asker's; the title names where the
    // CONTEXT's owner is, so it alone is judged by them.
    const asked = projectRow(hidden, { developerId: row.authorDeveloperId, kind: "question" }, view);
    return row.contextOwnerId === null
      ? asked
      : {
          ...asked,
          ...projectRow(hidden, {
            developerId: row.contextOwnerId,
            titleFacts: { repo, branch: row.contextBranch, titleSource: row.contextTitleSource },
          }, { workContextTitle: view.workContextTitle }),
        };
  });
};

/**
 * The whole corpus, in one bounded answer. Every list here is capped by a
 * named constant and the model layer above never asks for more — the route
 * takes no parameter but the repo, so a client cannot widen it.
 */
export const readConference = async (
  deps: Deps,
  viewerDeveloperId: string,
  repo: string,
): Promise<ConferenceView> => {
  const cutoff = new Date(
    deps.now().getTime() - CONFERENCE_ACTIVE_WINDOW_DAYS * MS_PER_DAY,
  );
  const reads: ConferenceWindow = {
    cutoff,
    endedSince: new Date(deps.now().getTime() - CONFERENCE_ENDED_GRACE_HOURS * MS_PER_HOUR),
  };
  const hidden = await locationHiddenFrom(deps.db, viewerDeveloperId);
  const [contexts, window, questionRows] = await Promise.all([
    listRecentContexts(deps, repo, reads, viewerDeveloperId, hidden),
    countContextsInWindow(deps, repo, reads, viewerDeveloperId),
    listOpenQuestions(deps, viewerDeveloperId, repo, hidden),
  ]);
  const ids = contexts.map((context) => context.id);
  const [claimLists, probes, large, contradictions] = await Promise.all([
    Promise.all(ids.map((id) => listContextClaims(deps, id, hidden))),
    listProbeValues(deps.db, viewerDeveloperId, ids),
    listLargeChanges(deps.db, viewerDeveloperId, ids, cutoff),
    // SECOND, because it needs the slice. The deliberate-pull posture again:
    // no `excludeMutedForDeveloperId`, the same call findContradictionById
    // makes, for the same reason. But bounded to the contexts this report
    // printed — an unbounded (kind, value) self-join over a repo's whole
    // history held this hub for 23.7 s on a seeded 10^4-context repo, and a
    // pair whose live side is not on the page is a pointer to nothing.
    listContradictions(deps.db, {
      repo,
      limit: CONFERENCE_MAX_CONTRADICTIONS,
      liveSideWorkContextIds: ids,
    }),
  ]);
  // Rarity over the probes, then who on the page holds the cool ones: each
  // read bounded by the probes, none by the size of any context's change.
  const probed = uniqueValues(probes.flatMap((probe) => probe.values));
  const hotValues = await listHotValues(deps, repo, probed);
  const [members, generatedShared] = await Promise.all([
    listMembers(
      deps,
      ids,
      probed.filter((target) => !hotValues.has(valueKey(target))),
    ),
    // The pair's qualifier, never its reason: bounded by the page.
    listGeneratedSharedPairs(deps.db, ids),
  ]);
  return {
    contexts: contexts.map((context, index) => ({
      ...context,
      claims: claimLists[index] ?? [],
    })),
    overlaps: pairOverlaps(contexts, members, large, generatedShared),
    questions: questionRows,
    contradictions,
    contextsInWindow: window.total,
    contextsInWindowCapped: window.capped,
    windowDays: CONFERENCE_ACTIVE_WINDOW_DAYS,
  };
};
