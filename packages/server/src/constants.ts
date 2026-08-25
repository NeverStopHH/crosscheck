/** Sessions with a heartbeat older than this are no longer present (DESIGN.md §5). */
export const PRESENCE_TTL_SECONDS = 90;

/** SSE outbox poll cadence; pg NOTIFY wiring is a later latency optimization. */
export const POLL_INTERVAL_MS = 1000;

/** SSE comment-line heartbeat so proxies do not close idle streams. */
export const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

export const EVENTS_DEFAULT_LIMIT = 100;
export const EVENTS_MAX_LIMIT = 500;

/**
 * Hard cap on one `GET /api/work-contexts` page (trial finding M8).
 *
 * The listing had no LIMIT and no window at all: 127 rows / 56 928 bytes on
 * the trial hub after three days, growing ~40 rows a day, fetched by every
 * SessionStart under a 400 ms budget (2000 ms for the teammate on tailscale).
 * Serialisation was measured and is NOT the problem — 14 600 rows render in
 * 112-143 ms on loopback — the multi-megabyte TRANSFER over a tailnet is.
 *
 * The default is deliberately NOT a 14-day window, and the ledger's first
 * reading said it should be. A server-side default window silently truncates
 * every connector that does not know to ask for more, and 0.7.2 connectors
 * send no parameters at all. So the server's default stays "everything",
 * bounded by this cap and ordered newest-first, and the NEW connector passes
 * `?since=&limit=` explicitly (connector-core http/hub.ts getWorkContexts). An
 * old connector against a 250-row repo then loses the oldest 50 — which it
 * already discards client-side at CONTEXT_MAX_AGE_DAYS = 14.
 */
export const WORK_CONTEXT_LIST_MAX = 200;

/**
 * How long a session may go without a heartbeat before the hub closes it
 * (trial finding M6).
 *
 * `/api/events` on the trial hub: 127 sessions started, 23 ended, **104 never
 * ended**. `services/sessions.ts endSession` was the only writer of
 * `ended_at` and nothing anywhere ran on a timer, so a killed orchestration
 * agent, a closed terminal or a SessionEnd that never got its budget left a
 * session "live" forever — visible in presence until its 90-second TTL, and
 * open in every listing and every event stream after that.
 *
 * SIX HOURS, which is 240x PRESENCE_TTL_SECONDS — and the number is the LEAST
 * important half of the design, because six hours of silence does not mean the
 * session is dead. The heartbeat this reads only moves on an Edit or a Bash
 * PostToolUse (connector-claude post-tool-use.ts, the ledger's M7), so a
 * session that spent the afternoon prompting, reading and reviewing crosses
 * six hours routinely while being fully alive, and one left open overnight
 * crosses it every single night. An earlier draft of this comment claimed such
 * a session "gets a loud 409 already_ended on its next heartbeat rather than
 * silent data loss"; it got neither. `flows/heartbeat.ts` discards the
 * HubResult by design, and ingest answered its records HTTP 200 /
 * `accepted:0` / `rejected:N` while `spool/flush.ts` advanced the cursor past
 * them — the loss was silent and total (review finding B2-01).
 *
 * SO THE VERDICT IS NOT ALLOWED TO BE FINAL. Two mechanisms carry that, both
 * in services/records.ts: an accepted flush refreshes `last_heartbeat_at`, so
 * a session that captures anything never becomes a candidate; and a record
 * from a session the hub DID close reopens it (`reviveReapedSession`) instead
 * of being rejected. A wrong reap therefore costs a listing entry until the
 * session next speaks, never its work. A SessionEnd the connector reported
 * stays final — `reaped_at` is what tells the two apart.
 */
export const SESSION_REAP_STALE_HOURS = 6;
/** Sessions one reaper pass closes — a bounded UPDATE, never a table sweep. */
export const SESSION_REAP_MAX_PER_PASS = 100;
/** How often the hub's own reaper runs. Started in startServer only. */
export const SESSION_REAP_INTERVAL_MS = 15 * 60 * 1000;
/** Bound on `GET /api/sessions?open=1`. */
export const OPEN_SESSIONS_MAX = 200;

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