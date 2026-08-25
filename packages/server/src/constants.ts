/** Sessions with a heartbeat older than this are no longer present (DESIGN.md §5). */
export const PRESENCE_TTL_SECONDS = 90;

/** SSE outbox poll cadence; pg NOTIFY wiring is a later latency optimization. */
export const POLL_INTERVAL_MS = 1000;

/** SSE comment-line heartbeat so proxies do not close idle streams. */
export const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

export const EVENTS_DEFAULT_LIMIT = 100;
export const EVENTS_MAX_LIMIT = 500;

/** Upper bound for one POST /api/records spool flush; larger batches get 422. */
export const MAX_INGEST_BATCH = 100;

export const DEFAULT_PORT = 7100;

// ── Absence detection ───────────────────────────────────────────────────────

/**
 * Commit-evidence rows whose newest commit is older than this are pruned on
 * the next ingest for their repo — the bound on commit_evidence table growth.
 */
export const COMMIT_EVIDENCE_RETENTION_DAYS = 30;
/**
 * Evidence older than this never fires a finding. Every SessionStart of every
 * connected teammate refreshes collection, so evidence this stale means nobody
 * connected has run a session in a week — at which point per-developer absence
 * lines would indict everyone and say nothing; silence is the honest output
 * (staleness honesty, task item 4).
 */
export const ABSENCE_EVIDENCE_MAX_AGE_DAYS = 7;
/** A commit older than the connector's scan window is history, not absence. */
export const ABSENCE_COMMIT_MAX_AGE_DAYS = 14;
/**
 * Committing right after (or during) an agent session is the normal workflow,
 * not a reporting gap — the motivating incident was DAYS of unreported work.
 * A finding fires only when the newest commit postdates the last reported
 * session by more than this.
 */
export const ABSENCE_MIN_GAP_HOURS = 24;
/** Upper bound on findings per response; commit-freshest win the slots. */
export const ABSENCE_MAX_FINDINGS = 20;
/** Read bound on evidence rows considered per absence query. */
export const ABSENCE_MAX_EVIDENCE_ROWS = 200;

// ── Solved-tree matching (VISION.md §1 collective memory) ───────────────────

/**
 * How recently a live context must have been active for a solved tree
 * sharing its target to count as "matching current work". Mirrors the
 * briefing's related-work window (CONTEXT_MAX_AGE_DAYS in the connector).
 */
export const SOLVED_MATCH_ACTIVE_WINDOW_DAYS = 14;
/** Upper bound on findings per response; fingerprint matches win the slots. */
export const SOLVED_MATCH_MAX_FINDINGS = 5;
/** Read bound on shared-target pair rows considered per query. */
export const SOLVED_MATCH_MAX_PAIR_ROWS = 200;

/**
 * The INTENT tier (VISION.md §1: symptoms are fingerprints, targets AND the
 * session intent). Its inputs are the CALLER'S OWN live intents on this repo
 * — an intent is a statement about what THIS developer is doing, so unlike
 * the target tiers it is not read repo-wide.
 */
export const SOLVED_MATCH_MAX_LIVE_INTENTS = 5;
/**
 * How many DISTINCT intent words a solved tree's searchable doc must match
 * before the tier will point at it. Text overlap is not identity, so this is
 * the whole precision story of the tier, and it is a COUNT rather than a
 * relevance score on purpose: a tuned float is a number nobody can argue
 * with, while "three different words of what I said I am doing" is a
 * sentence a tired reader can check against the line they were shown. Two
 * would fire on any pair of workhorse words ("fix", "test"); the floor test
 * in solved-intent.test.ts is what keeps this honest.
 */
export const SOLVED_MATCH_INTENT_MIN_TOKEN_HITS = 3;
/** Read bound on candidate rows the intent tier scores per query. */
export const SOLVED_MATCH_MAX_INTENT_CANDIDATES = 20;
/**
 * Findings the intent tier may contribute. ONE: it is the weakest signal
 * here and must never crowd out an identity match, and a briefing shows
 * MAX_SOLVED_POINTERS = 2 entries in total anyway.
 */
export const SOLVED_MATCH_MAX_INTENT_FINDINGS = 1;

/**
 * Most unreviewed Tier-1 drafts one GET /api/drafts response carries
 * (DESIGN.md §3 Tier 1 promotion loop). Well above what the summarizer cap
 * lets one session mint, and bounded like every list query:
 *
 * VERIFY: bun -e 'const s=await import("./packages/server/src/constants.ts");const c=await import("./packages/connector-core/src/constants.ts");console.log(s.MAX_DRAFTS_LISTED > c.SUMMARIZER_MAX_FIRES_PER_SESSION)'
 * PRINTS: true
 */
export const MAX_DRAFTS_LISTED = 20;

// ── The asynchronous question channel (roadmap R2) ─────────────────────────

/**
 * How long an unanswered question stays open. Applied LAZILY on read (no
 * cron, no background job): every listing demands `expires_at > now()` in
 * SQL, and the asker's own route flips the status of their own expired rows
 * when it passes over them. A question that outlived its window is a haunted
 * briefing — Slack's follow-up bots track a question "for a chosen amount of
 * time" for the same reason, and two weeks is one sprint plus slack.
 */
export const QUESTION_TTL_DAYS = 14;

/**
 * Spam budgets, hub-enforced (a modified connector must not be able to lift
 * them). Three axes, because they fail differently:
 *
 *   PER AUTHOR — how many questions one person may have waiting anywhere. The
 *   ceiling on "I asked everyone about everything and now nobody answers
 *   anything".
 *   PER TARGET — how many of those may point at ONE teammate. Without it a
 *   single author can spend their whole allowance on one person's briefing,
 *   which is exactly the "Questions for you" block filling up with one voice.
 *   PER DAY — a rate limit over a rolling 24 h, so an agent in a loop cannot
 *   burn and re-burn the open budget by withdrawing and re-asking.
 */
export const MAX_OPEN_QUESTIONS_PER_AUTHOR = 5;
export const MAX_OPEN_QUESTIONS_PER_TARGET = 3;
export const MAX_QUESTIONS_PER_AUTHOR_PER_DAY = 20;

/** Most inbox questions one GET /api/questions response carries. */
export const MAX_QUESTIONS_LISTED = 20;

/**
 * How far back the UNDELIVERED-ANSWER probe looks, counted on the QUESTION.
 *
 * WHY IT EXISTS: without it the probe's outer set is every question this
 * developer ever asked, so its cost grows monotonically with the lifetime of
 * the account and never shrinks — `hint_deliveries` has no reaper, and a
 * delivered answer does not stop being scanned. Measured on a seeded hub: 11
 * ms at 3 000 lifetime answers and 25 ms at 7 300 (about a year at a modest
 * rate), on the UserPromptSubmit path, every prompt. With the window the
 * outer set is bounded by the ASKER'S OWN BUDGET instead — at most
 * MAX_QUESTIONS_PER_AUTHOR_PER_DAY a day over this many days — so it is
 * bounded by a rule rather than by how long somebody has used the product.
 *
 * TWICE THE TTL, so nothing reachable is cut: a question cannot be answered
 * after it expires (QUESTION_TTL_DAYS), which leaves a full further TTL for
 * the asker to start a session and be handed the answer. An answer older than
 * that is not injected; the asker's `answered` counter still reports it.
 */
export const QUESTION_ANSWER_WINDOW_DAYS = QUESTION_TTL_DAYS * 2;

/**
 * Most undelivered ANSWERS one response carries. Small on purpose: they ride
 * the UserPromptSubmit path, one per prompt, inside the hint budget — a
 * bigger window would only buy rows the connector throws away.
 */
export const MAX_QUESTION_ANSWERS_LISTED = 3;

export const EVENT_KINDS = {
  DEVELOPER_CREATED: "developer_created",
  SESSION_STARTED: "session_started",
  SESSION_ENDED: "session_ended",
  WORK_CONTEXT_CREATED: "work_context_created",
  WORK_CONTEXT_UPDATED: "work_context_updated",
  CLAIM_ADDED: "claim_added",
  CLAIM_EDGE_ADDED: "claim_edge_added",
  // NO question kinds here on purpose. A question is addressed to ONE person
  // and the outbox is a team-wide feed; an event row saying "Nick asked Ken
  // something" would put addressed communication on a surface nobody asked
  // for, and the feed's opt-out filter is written for the SUBJECT of a row,
  // which a question has two of. The channel's own counters (GET
  // /api/questions) are where its activity is visible, to the two people it
  // concerns.
} as const;

export type EventKind = (typeof EVENT_KINDS)[keyof typeof EVENT_KINDS];