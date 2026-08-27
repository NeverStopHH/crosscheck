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
 * that merged is not work anybody is still doing.
 *
 * BOUNDED END TO END, and the bounds are arithmetic rather than hope:
 * CONFERENCE_MAX_CONTEXTS contexts, each contributing at most
 * CONFERENCE_MAX_CLAIMS_PER_CONTEXT claims through ONE indexed lookup of its
 * own, at most GHOST_MAX_CONTEXT_TARGETS target values, and pairwise
 * comparison over that same slice (66 pairs at the cap) rather than a join
 * that could fan out. The duplicated-work RULE is the ghost check's own —
 * one shared error fingerprint, or GHOST_MIN_SHARED_TARGETS shared files or
 * symbols, with hot values and sweeps dropped (services/ghost-overlap.ts
 * states the ConE reasoning and this imports its predicates rather than
 * re-typing them) — applied between two DEVELOPERS' contexts instead of from
 * one reader's side.
 */
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  CONFERENCE_ACTIVE_WINDOW_DAYS,
  CONFERENCE_CLAIM_BODY_MAX_CHARS,
  CONFERENCE_MAX_CLAIMS_PER_CONTEXT,
  CONFERENCE_MAX_CONTEXTS,
  CONFERENCE_MAX_CONTRADICTIONS,
  CONFERENCE_MAX_COUNTED_CONTEXTS,
  CONFERENCE_MAX_OVERLAP_PAIRS,
  CONFERENCE_MAX_QUESTIONS,
  GHOST_FINGERPRINT_MIN_SHARED,
  GHOST_HOT_TARGET_MAX_CONTEXTS,
  GHOST_MAX_CONTEXT_TARGETS,
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
  OVERLAP_TARGET_KINDS,
  activityExpression,
  notASweepCondition,
  targetValueCondition,
} from "./ghost-overlap.ts";
import type { OverlapKind, SharedValue } from "./ghost-overlap.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

const MS_PER_DAY = 86_400_000;

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

/** Unfinished work of this repo inside the window, whether or not attended. */
const recentWorkCondition = (repo: string, cutoff: Date) =>
  and(
    eq(agentSessions.repo, repo),
    gte(activityExpression, cutoff),
    isNull(workContexts.landedAt),
  );

const listRecentContexts = async (
  deps: Deps,
  repo: string,
  cutoff: Date,
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
    })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .innerJoin(developers, eq(agentSessions.developerId, developers.id))
    .where(recentWorkCondition(repo, cutoff))
    .orderBy(desc(activityExpression), asc(workContexts.id))
    .limit(CONFERENCE_MAX_CONTEXTS);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    intent: row.intent ?? null,
    developerId: row.developerId,
    developerName: row.developerName,
    lastActiveAt: new Date(row.lastActiveAt).toISOString(),
  }));
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
  cutoff: Date,
): Promise<{ readonly total: number; readonly capped: boolean }> => {
  const rows = await deps.db
    .select({ id: workContexts.id })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(recentWorkCondition(repo, cutoff))
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
): Promise<readonly ConferenceClaimView[]> => {
  const rows = await deps.db
    .select({
      id: claims.id,
      kind: claims.kind,
      status: claims.status,
      confidence: claims.confidence,
      provenance: claims.provenance,
      body: claims.body,
      authorDeveloperName: developers.name,
      createdAt: claims.createdAt,
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
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    confidence: row.confidence,
    provenance: row.provenance,
    body: cutBody(row.body),
    authorDeveloperName: row.authorDeveloperName,
    createdAt: row.createdAt.toISOString(),
  }));
};

interface ContextTargets {
  readonly workContextId: string;
  readonly targets: readonly SharedValue[];
}

/**
 * The strong target values of the slice, with the SWEEP rule applied in the
 * query: a context carrying more than GHOST_MAX_CONTEXT_TARGETS values is a
 * rename or a formatter run and contributes nothing, on this side exactly as
 * on the ghost check's.
 */
const listSliceTargets = async (
  deps: Deps,
  ids: readonly string[],
): Promise<readonly ContextTargets[]> => {
  if (ids.length === 0) {
    return [];
  }
  const rows = await deps.db
    .select({
      workContextId: workContextTargets.workContextId,
      kind: workContextTargets.kind,
      value: workContextTargets.value,
    })
    .from(workContextTargets)
    .where(
      and(
        inArray(workContextTargets.workContextId, [...ids]),
        inArray(workContextTargets.kind, [...OVERLAP_TARGET_KINDS]),
        notASweepCondition(workContextTargets.workContextId),
      ),
    )
    .orderBy(
      asc(workContextTargets.workContextId),
      asc(workContextTargets.kind),
      asc(workContextTargets.value),
    )
    // Every surviving context is under the cap, so this is what all of them
    // together can hold — no context can spend another's share.
    .limit(ids.length * GHOST_MAX_CONTEXT_TARGETS);
  const byContext = new Map<string, SharedValue[]>();
  for (const row of rows) {
    byContext.set(row.workContextId, [
      ...(byContext.get(row.workContextId) ?? []),
      { kind: row.kind as OverlapKind, value: row.value },
    ]);
  }
  return [...byContext.entries()].map(([workContextId, targets]) => ({
    workContextId,
    targets,
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
    .where(and(condition, eq(agentSessions.repo, repo)))
    .groupBy(workContextTargets.kind, workContextTargets.value);
  return new Set(
    rows
      .filter((row) => row.contexts > GHOST_HOT_TARGET_MAX_CONTEXTS)
      .map((row) => `${row.kind} ${row.value}`),
  );
};

const valueKey = (target: SharedValue): string => `${target.kind} ${target.value}`;

/**
 * Duplicated work: pairs of contexts belonging to DIFFERENT developers that
 * share an error fingerprint, or GHOST_MIN_SHARED_TARGETS files or symbols.
 *
 * Different developers on purpose. One person's two worktrees standing in the
 * same files is how a person works, not duplicated work — the same argument
 * self-exclusion makes on every unasked surface, made here about the pair
 * rather than about the reader.
 */
const pairOverlaps = (
  contexts: readonly Omit<ConferenceContextView, "claims">[],
  sliceTargets: readonly ContextTargets[],
  hotValues: ReadonlySet<string>,
): readonly ConferenceOverlapView[] => {
  const owner = new Map(contexts.map((context) => [context.id, context.developerId]));
  const cool = new Map(
    sliceTargets.map((entry) => [
      entry.workContextId,
      entry.targets.filter((target) => !hotValues.has(valueKey(target))),
    ]),
  );
  const ids = contexts.map((context) => context.id);
  const found: {
    readonly view: ConferenceOverlapView;
    readonly fingerprints: number;
  }[] = [];
  for (let left = 0; left < ids.length; left += 1) {
    for (let right = left + 1; right < ids.length; right += 1) {
      const idA = ids[left] as string;
      const idB = ids[right] as string;
      if (owner.get(idA) === owner.get(idB)) {
        continue;
      }
      const theirs = new Set((cool.get(idB) ?? []).map(valueKey));
      const shared = (cool.get(idA) ?? []).filter((target) =>
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
        },
      });
    }
  }
  return found
    .sort(
      (one, other) =>
        other.fingerprints - one.fingerprints ||
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
): Promise<readonly ConferenceQuestionView[]> => {
  const authors = alias(developers, "conference_question_authors");
  const targets = alias(developers, "conference_question_targets");
  const contextSessions = alias(agentSessions, "conference_question_sessions");
  const rows = await deps.db
    .select({
      id: questions.id,
      authorDeveloperName: authors.name,
      targetDeveloperId: questions.targetDeveloperId,
      targetDeveloperName: targets.name,
      workContextId: questions.workContextId,
      workContextTitle: workContexts.title,
      contextOwnerId: contextSessions.developerId,
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
  return rows.map((row) => ({
    id: row.id,
    authorDeveloperName: row.authorDeveloperName,
    targetDeveloperName: row.targetDeveloperName,
    workContextId: row.workContextId,
    workContextTitle: row.workContextTitle,
    createdAt: row.createdAt.toISOString(),
    isForReader:
      row.targetDeveloperId === viewerDeveloperId ||
      row.contextOwnerId === viewerDeveloperId,
  }));
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
  const [contexts, window, questionRows, contradictions] = await Promise.all([
    listRecentContexts(deps, repo, cutoff),
    countContextsInWindow(deps, repo, cutoff),
    listOpenQuestions(deps, viewerDeveloperId, repo),
    // The deliberate-pull posture again: no `excludeMutedForDeveloperId`, the
    // same call findContradictionById makes, for the same reason.
    listContradictions(deps.db, {
      repo,
      limit: CONFERENCE_MAX_CONTRADICTIONS,
    }),
  ]);
  const ids = contexts.map((context) => context.id);
  const [claimLists, sliceTargets] = await Promise.all([
    Promise.all(ids.map((id) => listContextClaims(deps, id))),
    listSliceTargets(deps, ids),
  ]);
  const hotValues = await listHotValues(
    deps,
    repo,
    sliceTargets.flatMap((entry) => entry.targets),
  );
  return {
    contexts: contexts.map((context, index) => ({
      ...context,
      claims: claimLists[index] ?? [],
    })),
    overlaps: pairOverlaps(contexts, sliceTargets, hotValues),
    questions: questionRows,
    contradictions,
    contextsInWindow: window.total,
    contextsInWindowCapped: window.capped,
    windowDays: CONFERENCE_ACTIVE_WINDOW_DAYS,
  };
};
