/**
 * Solved trees matching CURRENT work — the "solved before" surface
 * (VISION.md §1). Deterministic and strong by construction: a solved tree
 * qualifies only through target IDENTITY with a context active inside the
 * recency window, and only for the two highest-precision kinds (error
 * fingerprint ≻ file). Symbols and components recur across unrelated work,
 * and this feeds a SessionStart line that asserts relevance unasked — the
 * anchoring bar is the briefing's, not search's.
 *
 * ONE HUB IS ONE TEAM MEMORY, so the candidate side is NOT limited to the
 * asking repo: `get_diagnosis` has always been cross-repo readable, and a
 * symptom somebody diagnosed in the web app is the same answer when it
 * reappears in the api. What travels is decided by identity, not by
 * convenience — see CROSS_REPO_TARGET_KIND. The row names the repo it came
 * from so the renderer never has to guess where the reader should look.
 *
 * Derived fresh per read like the deterministic contradictions — no stored
 * pairs, no ingest-order dependence, nothing to go stale.
 */
import { and, asc, desc, eq, gte, inArray, ne, notInArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  SOLVED_MATCH_ACTIVE_WINDOW_DAYS,
  SOLVED_MATCH_MAX_LIVE_CONTEXTS,
  SOLVED_MATCH_INTENT_MIN_TOKEN_HITS,
  SOLVED_MATCH_MAX_FINDINGS,
  SOLVED_MATCH_MAX_INTENT_CANDIDATES,
  SOLVED_MATCH_MAX_INTENT_FINDINGS,
  SOLVED_MATCH_MAX_LIVE_INTENTS,
  SOLVED_MATCH_MAX_PAIR_ROWS,
  SOLVED_MATCH_MAX_PROBE_FINDINGS,
  SOLVED_MATCH_MAX_PROBE_ROWS,
} from "../constants.ts";
import {
  agentSessions,
  developers,
  workContexts,
  workContextTargets,
} from "../db/schema.ts";
import { ftsTokens } from "./search.ts";
import {
  listSolvedInfo,
  listSolvedRootCauses,
  solvedCandidateCondition,
} from "./solved.ts";
import { notMutedCondition } from "./visibility.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

/** Strong-match target kinds, most precise first. */
const MATCH_TARGET_KINDS = ["error_fingerprint", "file"] as const;

/**
 * The one kind whose identity is CONTENT rather than location: a fingerprint
 * is derived from the failure TEXT (connector-core/capture/fingerprint.ts),
 * so it means the same thing in every checkout on this hub. A file target is
 * a repo-RELATIVE path — `src/index.ts` names a different file in every repo
 * — so it is identity only INSIDE one repo, and letting it travel would turn
 * a "you have seen this before" line into the fuzzy similarity that cries
 * wolf. This constant is therefore the cross-repo gate, not a label.
 */
const CROSS_REPO_TARGET_KIND = "error_fingerprint";

const MS_PER_DAY = 86_400_000;

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

export interface SolvedMatchView {
  readonly workContextId: string;
  readonly title: string;
  readonly developerName: string;
  /**
   * The repo the SOLVED tree lives in, which is no longer necessarily the
   * repo that asked: sent on every row, same-repo ones included, so the
   * renderer decides by comparing rather than by guessing from an absence.
   */
  readonly repo: string;
  readonly solvedAt: string;
  readonly landedAt: string | null;
  /** Which shared target kind carried the match — fingerprint wins ties. */
  readonly matchedTargetKind: string;
  /**
   * What the tree says the cause WAS — sent ONLY for a fingerprint match,
   * null otherwise. Two conditions have to hold before a solved answer is
   * pushed into a reader's context unasked, and this field is where they
   * meet: the claim is evidence-backed and vouched (the solved predicate,
   * services/solved.ts), AND the match is content identity rather than a
   * shared location. A file two people touched says they are near each
   * other; a fingerprint says they hit the SAME failure, which is the only
   * evidence this surface has that the old answer is about the new problem.
   * A weaker match keeps the pointer and nothing else — DESIGN.md §4.
   *
   * It is also why the field is null rather than absent-but-fetched: what is
   * not rendered is not sent (the V2-X4 rule).
   */
  readonly rootCause: string | null;
}

/** Why a tree matched, strongest reason first — fingerprint ≻ file ≻ intent. */
interface MatchStrength {
  readonly viaFingerprint: boolean;
  readonly viaIntent: boolean;
}

/**
 * The one place a strength becomes the word on the wire. `session_intent` is
 * not a target kind and the field is named `matchedTargetKind` — an honest
 * mismatch: the field is the wire's OPEN "why", the renderer maps it by
 * strict equality and drops a value it does not know, and renaming a shipped
 * field would cost every older connector the whole section.
 */
const matchKindOf = (strength: MatchStrength): string => {
  if (strength.viaFingerprint) {
    return "error_fingerprint";
  }
  return strength.viaIntent ? "session_intent" : "file";
};

interface PairRow {
  readonly candidateId: string;
  readonly liveId: string;
  readonly kind: string;
}

/**
 * (candidate, live, kind) triples where candidate and live share a strong
 * target and the live side was active inside the window on this repo.
 *
 * BOUNDED ON BOTH SIDES BEFORE THEY MEET, which is the whole shape of this
 * query and was learned the hard way. A join of the target table against
 * itself makes a row per PAIR, so N contexts sharing one value — a lockfile,
 * or the error every session hits — cost N², and the LIMIT can only apply
 * after the ORDER BY has materialized all of them. Measured on a seeded hub
 * of 10^4 contexts: 1.2 s with 2000 contexts sharing one fingerprint, on the
 * SessionStart path whose whole hook budget is 1000 ms. Worse than the time,
 * the ANSWER fell out: 400 unsolved contexts sharing a hot fingerprint fill
 * the pair window ahead of the one solved tree that shares it, so the busiest
 * hub is the one where collective memory silently says nothing
 * (test/solved-fanout.test.ts). Hence two bounds:
 *
 *   - the CANDIDATE side must already hold a claim that could make it solved
 *     (solvedCandidateCondition — necessary, never sufficient, with the
 *     authoritative rule still applied by listSolvedInfo below). Unsolved
 *     crowds never enter the join at all, which is what makes both the cost
 *     and the window a function of ANSWERS rather than of traffic;
 *   - the LIVE side is the repo's most recently active contexts, capped at
 *     SOLVED_MATCH_MAX_LIVE_CONTEXTS. "Current work" is a small set by
 *     definition, and capping it caps the multiplier that is left.
 *
 * Both sides may still be unsolved after all that — solvedness is resolved
 * once, in one bounded lookup, because the full solved rule is a claims-side
 * predicate this join has no business duplicating.
 */
const listSharedTargetPairs = async (
  deps: Deps,
  viewerDeveloperId: string,
  repo: string,
): Promise<readonly PairRow[]> => {
  const liveTargets = alias(workContextTargets, "live_targets");
  const liveContexts = alias(workContexts, "live_contexts");
  const liveSessions = alias(agentSessions, "live_sessions");
  const cutoff = new Date(
    deps.now().getTime() - SOLVED_MATCH_ACTIVE_WINDOW_DAYS * MS_PER_DAY,
  );
  // The live side, bounded before it multiplies anything: the repo's freshest
  // active contexts, and no more of them than the cap. Ordered by activity so
  // the cap drops the stalest work rather than an arbitrary page.
  const liveIds = deps.db
    .select({ id: liveContexts.id })
    .from(liveContexts)
    .innerJoin(liveSessions, eq(liveContexts.sessionId, liveSessions.id))
    .where(
      and(
        eq(liveSessions.repo, repo),
        gte(
          sql`coalesce(${liveContexts.updatedAt}, ${liveContexts.createdAt})`,
          cutoff,
        ),
      ),
    )
    .orderBy(
      desc(sql`coalesce(${liveContexts.updatedAt}, ${liveContexts.createdAt})`),
      asc(liveContexts.id),
    )
    .limit(SOLVED_MATCH_MAX_LIVE_CONTEXTS);
  return deps.db
    .selectDistinct({
      candidateId: workContextTargets.workContextId,
      liveId: liveTargets.workContextId,
      kind: workContextTargets.kind,
    })
    .from(workContextTargets)
    .innerJoin(
      liveTargets,
      and(
        eq(liveTargets.kind, workContextTargets.kind),
        eq(liveTargets.value, workContextTargets.value),
        ne(liveTargets.workContextId, workContextTargets.workContextId),
      ),
    )
    .innerJoin(
      workContexts,
      eq(workContexts.id, workContextTargets.workContextId),
    )
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(
      and(
        inArray(workContextTargets.kind, [...MATCH_TARGET_KINDS]),
        // Necessary, not sufficient (services/solved.ts): a candidate that
        // could not become an answer never enters the join, so the pair count
        // is a function of the hub's ANSWERS rather than of its traffic.
        solvedCandidateCondition(workContextTargets.workContextId),
        // The CANDIDATE side may live anywhere on the hub, but only through
        // the content-identity kind (CROSS_REPO_TARGET_KIND): a fingerprint
        // travels, a repo-relative path does not. The LIVE side stays pinned
        // to the asking repo — "current work" means work in the checkout the
        // briefing is for.
        or(
          eq(workContextTargets.kind, CROSS_REPO_TARGET_KIND),
          eq(agentSessions.repo, repo),
        ),
        inArray(liveTargets.workContextId, liveIds),
        // The viewer's mutes apply to the CANDIDATE side — the solved author
        // this pointer would name in the briefing (services/visibility.ts).
        // The live side is not filtered: it is never named in the pointer.
        // Opt-out does not apply — a solved tree is published knowledge.
        notMutedCondition(viewerDeveloperId, agentSessions.developerId),
      ),
    )
    // LIMIT without ORDER BY hands the planner the choice of WHICH pairs
    // survive the cap — nondeterministic, and worst for exactly the rows
    // that matter most (one hot shared file can fill the window by itself).
    // Highest-precision kind first — "error_fingerprint" sorts before
    // "file", pinned by the crowded-window test — then stable id order so
    // repeated calls answer alike. SELECT DISTINCT restricts ORDER BY to
    // selected columns, which is why precedence rides on the kind value.
    .orderBy(
      asc(workContextTargets.kind),
      asc(workContextTargets.workContextId),
      asc(liveTargets.workContextId),
    )
    .limit(SOLVED_MATCH_MAX_PAIR_ROWS);
};

/**
 * The INTENT tier (VISION.md §1: the current session's symptoms are its
 * fingerprints, its targets AND its intent). Deliberately the weakest of the
 * three, and everything about its shape is an answer to that:
 *
 *   - the inputs are the CALLER'S OWN live intents on this repo, not the
 *     repo's. A fingerprint is a fact about a failure and belongs to whoever
 *     hits it; an intent is a sentence about what one developer is doing, and
 *     matching solved trees against a TEAMMATE'S sentence would put lines in
 *     my briefing about somebody else's topic;
 *   - a candidate qualifies on a COUNT of distinct matching words
 *     (SOLVED_MATCH_INTENT_MIN_TOKEN_HITS), never on a relevance score, so
 *     the rule can be stated to the person who was shown the line;
 *   - it is SAME-REPO ONLY, unlike the fingerprint tier. Text overlap is not
 *     identity, and the searchable doc still folds in the repo label and the
 *     default branch name (audit row M13, Block 6's edit) — until that is
 *     cleaned up, letting prose match across repos would make "rebase onto
 *     main" a hit on every repo the hub holds;
 *   - and what it earns is a POINTER. `rootCause` is fingerprint-only, so a
 *     tree reached this way is a line saying WHERE the answer is, never the
 *     answer.
 *
 * BOUNDED ON SOLVEDNESS like the pair join above, and the same defect is
 * why: the candidate window is SOLVED_MATCH_MAX_INTENT_CANDIDATES rows wide
 * and ordered by word count first, so a team all working on one topic fills
 * it with each other's ordinary contexts and the one tree holding the answer
 * drops out. Measured with one solved tree and N same-repo contexts carrying
 * the same words: the answer came back at N = 19 and the tier went silent at
 * N = SOLVED_MATCH_MAX_INTENT_CANDIDATES (test/solved-intent.test.ts). The
 * crowd only has to match as MANY words as the answer, not more — fewer, and
 * it sorts below and is harmless.
 */
const listIntentMatchIds = async (
  deps: Deps,
  viewerDeveloperId: string,
  repo: string,
): Promise<readonly string[]> => {
  const activity = sql`coalesce(${workContexts.updatedAt}, ${workContexts.createdAt})`;
  const cutoff = new Date(
    deps.now().getTime() - SOLVED_MATCH_ACTIVE_WINDOW_DAYS * MS_PER_DAY,
  );
  const mine = await deps.db
    .select({
      id: workContexts.id,
      summary: sql<string>`${workContexts.intent} ->> 'summary'`,
    })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(
      and(
        eq(agentSessions.repo, repo),
        eq(agentSessions.developerId, viewerDeveloperId),
        gte(activity, cutoff),
        sql`${workContexts.intent} ->> 'summary' IS NOT NULL`,
      ),
    )
    .orderBy(desc(activity))
    .limit(SOLVED_MATCH_MAX_LIVE_INTENTS);
  const tokens = ftsTokens(mine.map((row) => row.summary).join(" "));
  const sourceIds = mine.map((row) => row.id);
  if (tokens.length < SOLVED_MATCH_INTENT_MIN_TOKEN_HITS) {
    return [];
  }
  // One 0/1 term per distinct word, summed: the count the floor is stated in.
  // English stopwords cost nothing here — plainto_tsquery drops them, so
  // their term is 0 for every row rather than a free hit on all of them.
  const hits = sql`(${sql.join(
    tokens.map(
      (token) =>
        sql`(case when ${workContexts.tsv} @@ plainto_tsquery('english', ${token}) then 1 else 0 end)`,
    ),
    sql` + `,
  )})`;
  // The GIN prefilter first (work_contexts_tsv_idx), so the per-row sum is
  // only ever computed for rows that match at least one word.
  const anyToken = sql`websearch_to_tsquery('english', ${tokens.join(" or ")})`;
  const rows = await deps.db
    .select({ id: workContexts.id })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(
      and(
        eq(agentSessions.repo, repo),
        notInArray(workContexts.id, sourceIds),
        sql`${workContexts.tsv} @@ ${anyToken}`,
        sql`${hits} >= ${SOLVED_MATCH_INTENT_MIN_TOKEN_HITS}`,
        // The same bound the target tier carries, for the same reason: this
        // window is SOLVED_MATCH_MAX_INTENT_CANDIDATES rows wide, and a team
        // all working on one topic fills it with each other's ordinary
        // contexts. Necessary, never sufficient (services/solved.ts) — the
        // authoritative rule is still applied by listSolvedInfo afterwards.
        solvedCandidateCondition(workContexts.id),
        notMutedCondition(viewerDeveloperId, agentSessions.developerId),
      ),
    )
    .orderBy(desc(hits), desc(activity))
    .limit(SOLVED_MATCH_MAX_INTENT_CANDIDATES);
  return rows.map((row) => row.id);
};

/** Display rows for the winning solved contexts, keyed by id. */
const hydrateMatches = async (
  db: Db,
  ids: readonly string[],
): Promise<
  ReadonlyMap<
    string,
    { title: string; developerName: string; repo: string; landedAt: Date | null }
  >
> => {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      id: workContexts.id,
      title: workContexts.title,
      landedAt: workContexts.landedAt,
      developerName: developers.name,
      repo: agentSessions.repo,
    })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .innerJoin(developers, eq(agentSessions.developerId, developers.id))
    .where(inArray(workContexts.id, [...ids]));
  return new Map(
    rows.map((row) => [
      row.id,
      {
        title: row.title,
        developerName: row.developerName,
        repo: row.repo,
        landedAt: row.landedAt,
      },
    ]),
  );
};

/**
 * Assembles the wire rows for a set of winning context ids — hydration, the
 * solved dates, and the root-cause bodies for the ones allowed to carry one.
 * Shared by the briefing listing and the fingerprint probe so the two cannot
 * answer differently about the same tree.
 */
const toMatchViews = async (
  db: Db,
  winners: readonly (MatchStrength & { id: string })[],
  solvedInfo: ReadonlyMap<string, Date>,
): Promise<readonly SolvedMatchView[]> => {
  const [display, rootCauses] = await Promise.all([
    hydrateMatches(
      db,
      winners.map((winner) => winner.id),
    ),
    // Bodies only for the trees that will be allowed to carry one, so a
    // file-matched tree's claim never leaves the hub at all.
    listSolvedRootCauses(
      db,
      winners
        .filter((winner) => winner.viaFingerprint)
        .map((winner) => winner.id),
    ),
  ]);
  return winners.flatMap((winner) => {
    const row = display.get(winner.id);
    const solvedAt = solvedInfo.get(winner.id);
    if (row === undefined || solvedAt === undefined) {
      return [];
    }
    return [
      {
        workContextId: winner.id,
        title: row.title,
        developerName: row.developerName,
        repo: row.repo,
        solvedAt: solvedAt.toISOString(),
        landedAt: row.landedAt === null ? null : row.landedAt.toISOString(),
        matchedTargetKind: matchKindOf(winner),
        rootCause: rootCauses.get(winner.id) ?? null,
      },
    ];
  });
};

/**
 * Solved trees carrying THIS EXACT error fingerprint, newest diagnosis
 * first — the probe a connector runs the moment a tool fails, instead of
 * waiting for the next SessionStart to say the answer already existed.
 *
 * No live-side join and no repo filter, and both absences are the point.
 * The "current work" the briefing listing has to infer is not a guess here:
 * the caller is holding the failure. And a fingerprint is content identity,
 * so it travels across every repo on the hub exactly as it does in the
 * listing (CROSS_REPO_TARGET_KIND).
 *
 * THE CANDIDATE SIDE IS BOUNDED ON SOLVEDNESS, exactly as the listing's is
 * and for the same defect. An equality on one hot value is cheap, but the
 * window it fills is not the same thing as the answer: every context that
 * ever hit that failure carries the value, solved or not, and only a
 * handful of them ever hold a diagnosis. Measured with one solved tree plus
 * N unsolved contexts on one fingerprint, the probe answered the tree at
 * N = 199 and went SILENT at N = SOLVED_MATCH_MAX_PROBE_ROWS
 * (test/solved-probe.test.ts). It fails to silence, which is the shape
 * nothing reports: no row is shown, so the precision counter has nothing to
 * count and `doctor` says PASS. The `solvedCandidateCondition` below is
 * necessary-and-not-sufficient (services/solved.ts), with `listSolvedInfo`
 * still the authority afterwards — so the window holds rows that could be
 * answers, and ordering it newest-context-first keeps the freshest of them
 * rather than whichever ids happened to sort low.
 *
 * Every row is a fingerprint match by construction, so every solved one may
 * carry its recorded cause.
 */
export const listSolvedByFingerprint = async (
  deps: Deps,
  viewerDeveloperId: string,
  fingerprint: string,
): Promise<readonly SolvedMatchView[]> => {
  const candidates = await deps.db
    .selectDistinct({
      id: workContextTargets.workContextId,
      // Selected because SELECT DISTINCT restricts ORDER BY to the selected
      // columns — the same constraint the pair query's comment records.
      createdAt: workContexts.createdAt,
    })
    .from(workContextTargets)
    .innerJoin(
      workContexts,
      eq(workContexts.id, workContextTargets.workContextId),
    )
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(
      and(
        eq(workContextTargets.kind, CROSS_REPO_TARGET_KIND),
        eq(workContextTargets.value, fingerprint),
        // Traffic out, answers in — see the header. Necessary, never
        // sufficient: listSolvedInfo below is still the authority.
        solvedCandidateCondition(workContextTargets.workContextId),
        notMutedCondition(viewerDeveloperId, agentSessions.developerId),
      ),
    )
    // Newest context first, then a stable id order so repeated probes of one
    // fingerprint answer alike. An ascending id was neither: it is
    // uncorrelated with solvedness AND with recency, so the cap dropped
    // whichever answers happened to sort high.
    .orderBy(desc(workContexts.createdAt), asc(workContextTargets.workContextId))
    .limit(SOLVED_MATCH_MAX_PROBE_ROWS);
  if (candidates.length === 0) {
    return [];
  }
  const ids = candidates.map((row) => row.id);
  const solvedInfo = await listSolvedInfo(deps.db, ids);
  const winners = ids
    .filter((id) => solvedInfo.has(id))
    .map((id) => ({
      id,
      viaFingerprint: true,
      viaIntent: false,
      solvedAtMs: solvedInfo.get(id)?.getTime() ?? 0,
    }))
    .sort((left, right) => right.solvedAtMs - left.solvedAtMs)
    .slice(0, SOLVED_MATCH_MAX_PROBE_FINDINGS);
  return toMatchViews(deps.db, winners, solvedInfo);
};

/**
 * Solved trees sharing a strong target with currently active work on `repo`,
 * fingerprint matches first, then most recently solved. Bounded end to end:
 * pair rows, the solved lookup (over pair-bounded ids), the hydration, and
 * the finding cap are all named constants.
 */
export const listSolvedMatches = async (
  deps: Deps,
  viewerDeveloperId: string,
  repo: string,
): Promise<readonly SolvedMatchView[]> => {
  // The two tiers run in parallel: they read different tables and neither
  // needs the other's answer. An empty target tier is not an empty result any
  // more — a session with no captured targets yet (every SessionStart) still
  // has an intent.
  const [pairs, intentIds] = await Promise.all([
    listSharedTargetPairs(deps, viewerDeveloperId, repo),
    listIntentMatchIds(deps, viewerDeveloperId, repo),
  ]);
  if (pairs.length === 0 && intentIds.length === 0) {
    return [];
  }
  const allIds = [
    ...new Set([
      ...pairs.flatMap((pair) => [pair.candidateId, pair.liveId]),
      ...intentIds,
    ]),
  ];
  const solvedInfo = await listSolvedInfo(deps.db, allIds);

  // A pair counts when the candidate is solved and the live side is NOT —
  // two solved trees sharing a fingerprint is history meeting history, not
  // current work meeting an answer.
  const byCandidate = new Map<string, MatchStrength>();
  for (const pair of pairs) {
    if (!solvedInfo.has(pair.candidateId) || solvedInfo.has(pair.liveId)) {
      continue;
    }
    const known = byCandidate.get(pair.candidateId);
    byCandidate.set(pair.candidateId, {
      viaFingerprint:
        (known?.viaFingerprint ?? false) || pair.kind === "error_fingerprint",
      viaIntent: false,
    });
  }
  // Intent hits are added LAST and never overwrite a target hit: a tree
  // reached both ways is reported under the stronger reason, because the
  // reason is what the reader is asked to trust.
  const intentWinners = intentIds
    .filter((id) => solvedInfo.has(id) && !byCandidate.has(id))
    .slice(0, SOLVED_MATCH_MAX_INTENT_FINDINGS);
  for (const id of intentWinners) {
    byCandidate.set(id, { viaFingerprint: false, viaIntent: true });
  }
  const winners = [...byCandidate.entries()]
    .map(([id, strength]) => ({
      id,
      ...strength,
      solvedAtMs: solvedInfo.get(id)?.getTime() ?? 0,
    }))
    .sort(
      (left, right) =>
        Number(right.viaFingerprint) - Number(left.viaFingerprint) ||
        Number(left.viaIntent) - Number(right.viaIntent) ||
        right.solvedAtMs - left.solvedAtMs,
    )
    .slice(0, SOLVED_MATCH_MAX_FINDINGS);

  return toMatchViews(deps.db, winners, solvedInfo);
};
