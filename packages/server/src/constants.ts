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
 * Most unreviewed Tier-1 drafts one GET /api/drafts response carries
 * (DESIGN.md §3 Tier 1 promotion loop). Well above what the summarizer cap
 * lets one session mint, and bounded like every list query:
 *
 * VERIFY: bun -e 'const s=await import("./packages/server/src/constants.ts");const c=await import("./packages/connector-core/src/constants.ts");console.log(s.MAX_DRAFTS_LISTED > c.SUMMARIZER_MAX_FIRES_PER_SESSION)'
 * PRINTS: true
 */
export const MAX_DRAFTS_LISTED = 20;

export const EVENT_KINDS = {
  DEVELOPER_CREATED: "developer_created",
  SESSION_STARTED: "session_started",
  SESSION_ENDED: "session_ended",
  WORK_CONTEXT_CREATED: "work_context_created",
  WORK_CONTEXT_UPDATED: "work_context_updated",
  CLAIM_ADDED: "claim_added",
  CLAIM_EDGE_ADDED: "claim_edge_added",
} as const;

export type EventKind = (typeof EVENT_KINDS)[keyof typeof EVENT_KINDS];