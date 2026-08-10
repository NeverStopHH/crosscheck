/** Every budget, cap and TTL the connector obeys — no magic numbers elsewhere. */

export const DEFAULT_AGENT_KIND = "claude-code";

/** Per-request hub timeout (AbortSignal.timeout), DESIGN.md §3 "fails open". */
export const HTTP_TIMEOUT_MS = 400;

/**
 * Total hook budgets are expressed as multiples of the per-request timeout so a
 * raised CROSSCHECK_TIMEOUT_MS (slow hub, CI) widens them consistently.
 * With the 400 ms default this yields the specified 1000 ms / 800 ms.
 */
export const SESSION_START_BUDGET_RATIO = 2.5;
export const SESSION_END_BUDGET_RATIO = 2;
export const POST_TOOL_USE_BUDGET_RATIO = 4;
/**
 * What a hook holds back from its own maintenance so the thing it exists for
 * still fits afterwards: SessionStart's briefing, SessionEnd's `end` call.
 *
 * Both kinds of maintenance are held to it, and `spareMs` is the only way
 * either asks for time — it is the sole accessor on HookBudget (hooks/runner.ts).
 * The two are the spool drain, in all three hooks, and the deferred end
 * SessionStart hands to `reap`.
 *
 * One per-request timeout, because that is the longest a single hub call can
 * take (`AbortSignal.timeout(ctx.timeoutMs)` in http/client.ts). Each kind was
 * measured taking the hook that hosted it. The drain, on a fixed ratio, with a
 * 600-record backlog and a 350 ms hub: SessionStart 1035 ms with no briefing,
 * SessionEnd 831 ms with no `end`. The deferred end, on the raw remainder, with
 * a stranded marker and a 300 ms hub: SessionStart 1083 ms with no briefing,
 * because a call started inside the reserve finishes after the budget race has
 * already resolved.
 *
 * The cost is that maintenance gives up sooner on a slow hub — a deferred end
 * needs a hook with a full request timeout to spare, so a hub slow enough leaves
 * the marker for later. MAX_SPOOL_AGE_DAYS is what stops "later" being forever.
 *
 * GUARDED IN TWO PLACES, and the split is the point. test/hook-reserve.test.ts
 * asserts the SUBTRACTION — a frozen clock, no process, no file — and that is
 * what scripts/mutation-check.ts runs, because setting this to 0 has to be
 * caught on every machine rather than only on one where maintenance is slow.
 * test/hook-time-budget.test.ts asserts the CONSEQUENCE through the real binary:
 * briefing present, `end` sent, marker written, state file gone. Neither is
 * redundant. The first is the detector; the second is the reason there is
 * anything worth detecting.
 */
export const HOOK_RESERVE_RATIO = 1;

/**
 * ── In-session hints (DESIGN.md §4) ─────────────────────────────────────────
 *
 * UserPromptSubmit runs inside the developer's keystroke-to-first-token wait,
 * so its TOTAL budget — preparation, one hub call, one bounded git call,
 * rendering — is the §4-specified 800 ms at the default request timeout:
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-claude/src/constants.ts");console.log(c.USER_PROMPT_SUBMIT_BUDGET_RATIO*c.HTTP_TIMEOUT_MS, c.PRE_TOOL_USE_BUDGET_RATIO*c.HTTP_TIMEOUT_MS)'
 * PRINTS: 800 800
 *
 * Guarded twice, the hook-reserve split: test/hint-budget.test.ts is the
 * arithmetic detector (runs identically on every machine, and what
 * scripts/mutation-check.ts re-breaks), test/hint-hook-latency.test.ts is the
 * measured consequence through the real runHook.
 */
export const USER_PROMPT_SUBMIT_BUDGET_RATIO = 2;
/** PreToolUse blocks a tool call — the same keystroke-grade bound applies. */
export const PRE_TOOL_USE_BUDGET_RATIO = 2;
/**
 * Noise budgets (DESIGN.md §10 risk 1): at most one hint per prompt and five
 * per session, then silence for the rest of the session. MAX_HINTS_PER_PROMPT
 * is enforced structurally — the selector returns ONE selection, never a list
 * (src/hints/select.ts) — and this constant is the number tests pin that to.
 */
export const MAX_HINTS_PER_PROMPT = 1;
export const MAX_HINTS_PER_SESSION = 5;
/**
 * Substance requires evidence (§4 anchoring asymmetry): claims below this
 * many evidence refs are pointer-only, whatever their status claims.
 */
export const HINT_MIN_EVIDENCE_REFS = 1;
/**
 * Words shorter than this carry grammar, not meaning — the same floor the hub
 * search applies (SEARCH_MIN_TOKEN_CHARS). Checked BEFORE the hub call: a
 * prompt with no searchable word costs zero HTTP.
 */
export const HINT_MIN_TOKEN_CHARS = 3;
/** Tripwire asks once per file per session; FIFO cap on the remembered set. */
export const MAX_TRIPWIRE_ASKED_FILES = 100;

/** git is spawned per hook; a hung repo must never hold the session hostage. */
export const GIT_TIMEOUT_MS = 1500;

/**
 * Reading the hook payload happens before any budget exists, and SessionStart /
 * SessionEnd are synchronous hooks: an stdin that is never closed would block
 * the developer's session forever.
 */
export const STDIN_TIMEOUT_MS = 1000;

export const HEARTBEAT_MIN_INTERVAL_MS = 20_000;

export const MAX_TARGETS_PER_INVOCATION = 20;
export const MAX_SEEN_TARGETS = 500;

/**
 * The spool's only cap, and the reason compaction no longer exists: an append
 * that would push a session's data file past this is REFUSED and counted,
 * rather than making room by rewriting a file other processes append to.
 *
 * Size, not line count, because it is one `stat` on the hook's hot path where a
 * line count would mean reading the whole file on every append. Size is also
 * what actually bounds the disk. A file may exceed the cap by at most the one
 * batch that was in flight when it crossed.
 */
export const MAX_SPOOL_BYTES = 2_000_000;
/**
 * Growth bound for files whose session is gone but whose records were never
 * delivered — without it a permanently dead hub fills the disk. It bounds the
 * three artifacts that grow with USE, and each one keeps what a human still
 * needs after the bytes go, because nothing records that anybody read the
 * number:
 *   - data files, by mtime (`isOlderThanMaxAge`); the records they gave up are
 *     counted in `.drops` first;
 *   - `.drops` ledgers, by their newest entry; the per-batch detail goes, the
 *     TOTAL is folded into `archive.dropsummary`;
 *   - `.pending-end` markers, by the deferral time they carry; the retry goes,
 *     the count of sessions never closed is folded into `unclosed.endsummary`.
 *
 * It bounds nothing else in the spool directory, and nothing else needs it:
 *   - `archive.dropsummary`, `unclosed.endsummary` and `unrecorded.dropmarker`
 *     are the facts age must NOT delete — that is the whole point of folding
 *     into them — and each is one fixed-size line per repo, rewritten in place;
 *   - `.cursor` files are removed with the data file they belong to, and a
 *     leftover is inert rather than growing: `readCursorOffset` ignores a
 *     cursor that cannot prove it belongs to the file at the path
 *     (spool/identity.ts);
 *   - `flush.lock` is one fixed-size file per repo, and what has to expire on it
 *     is a dead holder's CLAIM, which SPOOL_LOCK_STALE_MS retires in seconds.
 *     "Dead" is now checked rather than assumed: that deadline used to retire
 *     LIVE holders' claims too, which is not expiry but theft, and it is the
 *     holder's pid that decides (spool/lock.ts). A claim whose holder is gone
 *     still goes in seconds; one whose holder is running does not go at all,
 *     and DOCTOR_FLUSH_LOCK_WARN_MS is what keeps that from being silent.
 */
export const MAX_SPOOL_AGE_DAYS = 7;
/**
 * Quiescence a data file must show before `reap` may remove it.
 *
 * This makes reap UNWILLING to unlink a file that anything wrote to recently.
 * It does not make the removal race impossible, and the earlier claim that it
 * did was wrong: an appender only has to be between its open and its write when
 * the unlink lands, and it can open a file that has been quiet for hours. The
 * unlink window itself measures p50 70 µs / p99 230 µs, and a deterministic
 * repro lost its record at a 0.49 ms open→write gap.
 *
 * What actually closes that hole is recovery at both ends: `appendThroughHandle`
 * fstats after its write and re-appends when `nlink` is 0 (write.ts), and reap
 * reads back off the unlinked inode whatever arrived after its last size check
 * (`rescueTail`). This constant is what keeps reap from taking the shot in the
 * first place, which is why both recovery paths stay rare. Deferring costs
 * nothing: the next SessionStart reaps the file instead.
 */
export const SPOOL_REAP_GRACE_MS = 5000;

/** Mirrors the server's MAX_INGEST_BATCH — larger batches are rejected with 422. */
export const MAX_INGEST_BATCH = 100;
/**
 * A flush keeps sending batches until the spool is empty, so a backlog does not
 * need one lucky hook invocation per batch. The wall-clock allowance is NOT a
 * constant: the hosting hook passes what is left of its own budget, minus its
 * reserve. This is the hard ceiling for a hub that answers instantly.
 */
export const MAX_FLUSH_BATCHES_PER_HOOK = 20;
export const SPOOL_LOCK_STALE_MS = 5000;
/**
 * The lock guards flush and reap only — appends are lock-free — so a busy lock
 * costs a deferred flush that the next hook retries, never a record. Retries ×
 * delay stays far below the smallest hook budget.
 *
 * That accounting covers a BUSY lock, which is the only way an acquisition may
 * fail. A STOLEN lock was never in it: two holders inside the section at once
 * cost concurrent rewrites of the per-repo aggregates and a reap deleting a
 * file the flush was mid-delivery of. Stealing from a live holder is what
 * spool/lock.ts now refuses, which is what makes the sentence above complete.
 */
export const SPOOL_LOCK_RETRIES = 5;
export const SPOOL_LOCK_RETRY_DELAY_MS = 20;

/** ~550 tokens at 4 chars/token, under the ≤600 token briefing budget (§4). */
export const MAX_BRIEFING_CHARS = 2200;
export const MAX_TEAMMATES = 5;
export const MAX_CONTEXTS = 5;
export const MAX_TITLE_CHARS = 80;
/** One git process per distinct teammate base commit, never more. */
export const MAX_DRIFT_LOOKUPS = 5;
/** Drift is a nice-to-have label: a slow git loses it, never the briefing. */
export const DRIFT_GIT_TIMEOUT_MS = 250;
export const MAX_WORK_CONTEXT_TITLE_CHARS = 120;
export const CONTEXT_MAX_AGE_DAYS = 14;

// ── Absence detection ───────────────────────────────────────────────────────

/** How far back the SessionStart commit-authorship scan looks. */
export const COMMIT_EVIDENCE_WINDOW_DAYS = 14;
/** Hard cap on commits one scan reads — the count bound on the git walk. */
export const COMMIT_EVIDENCE_MAX_COMMITS = 400;
/**
 * Evidence is a nice-to-have like drift: a slow git loses it, never the
 * briefing. Runs inside SessionStart's parallel hub-fetch block, and this
 * bound keeps it below the per-request hub timeout that block already waits
 * for, so collection adds no wall clock of its own — at the DEFAULT timeouts:
 * the directive below compares constants, and a CROSSCHECK_TIMEOUT_MS override
 * that pushes the per-request hub timeout under this git bound inverts the
 * relation, leaving git the longest leg of the parallel block (still bounded,
 * no longer free):
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-claude/src/constants.ts");console.log(c.COMMIT_EVIDENCE_GIT_TIMEOUT_MS < c.HTTP_TIMEOUT_MS)'
 * PRINTS: true
 */
export const COMMIT_EVIDENCE_GIT_TIMEOUT_MS = 250;
/**
 * Absence lines the briefing may spend, LAST in section order on purpose:
 * absence is context, not a hint, and must never crowd out presence or
 * related work (§4 briefing budget).
 */
export const MAX_ABSENCE_LINES = 3;
/** Evidence older than this gets its age said in the absence header. */
export const ABSENCE_EVIDENCE_NOTE_AGE_HOURS = 24;
/**
 * `crosscheck status` shows more than the briefing (a human asked), but still
 * bounded: the row count is hub-controlled input.
 */
export const STATUS_MAX_ABSENCE_LINES = 20;

export const PRESENCE_CACHE_TTL_MS = 10_000;
export const STATUSLINE_MAX_CHARS = 90;
export const STATUSLINE_MAX_NAMES = 3;
export const STATUSLINE_NAME_CHARS = 12;

export const FINGERPRINT_SOURCE_CHARS = 4000;
export const FINGERPRINT_KEEP_CHARS = 1200;
export const FINGERPRINT_MIN_CHARS = 32;
export const FINGERPRINT_HASH_CHARS = 32;

export const REPO_KEY_CHARS = 16;
export const LOCAL_REPO_HASH_CHARS = 12;

/**
 * How much of a spool data file is read to fingerprint WHICH file it is
 * (spool/identity.ts). One record's JSON, comfortably: a target's `value` is a
 * path the OS itself caps near 4096 bytes, and a work context's title is capped
 * at MAX_WORK_CONTEXT_TITLE_CHARS. A first line longer than this is still
 * fingerprinted, by this many bytes of it.
 */
export const FIRST_LINE_PROBE_BYTES = 8192;
/** 128 bits of SHA-256, the same truncation FINGERPRINT_HASH_CHARS uses. */
export const FIRST_LINE_HASH_CHARS = 32;

export const HOME_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export const MS_PER_SECOND = 1000;
export const SECONDS_PER_MINUTE = 60;
export const MINUTES_PER_HOUR = 60;
export const HOURS_PER_DAY = 24;
/** Ages below this many hours render as `Nh`, above as `Nd` (§D). */
export const AGE_HOURS_BEFORE_DAYS = 48;

export const MS_PER_DAY =
  MS_PER_SECOND * SECONDS_PER_MINUTE * MINUTES_PER_HOUR * HOURS_PER_DAY;

/** Clock skew above this breaks the 90 s presence TTL (server PRESENCE_TTL_SECONDS). */
export const MAX_CLOCK_SKEW_SECONDS = 120;

export const DOCTOR_SPOOL_DEPTH_WARN = 200;
export const DOCTOR_SPOOL_DEPTH_FAIL = 1500;
export const DOCTOR_SPOOL_AGE_WARN_HOURS = 24;
export const DOCTOR_LAST_SYNC_WARN_MINUTES = 10;
/**
 * How long a flush lock may be held by a RUNNING process before `doctor` calls
 * it wedged.
 *
 * The lock will not take a claim whose holder is still alive, which is what
 * stops a slow flush being robbed mid-request (spool/lock.ts). What that buys
 * is a claim nobody will ever retire: a crashed holder's pid reused by an
 * unrelated long-lived process. Flush and reap are then deferred silently, and
 * the spool stops growing only when it reaches MAX_SPOOL_BYTES.
 *
 * A minute is far above any legitimate hold and far below the point where the
 * backlog matters. The longest a hook may run at all is
 * POST_TOOL_USE_BUDGET_RATIO request timeouts, and a holder is inside the lock
 * for less than that:
 *
 * VERIFY: bun -e 'import {HTTP_TIMEOUT_MS as t, POST_TOOL_USE_BUDGET_RATIO as r} from "./packages/connector-claude/src/constants.ts"; console.log(t * r)'
 * PRINTS: 1600
 *
 * A DEAD holder's claim is not reported: the next acquisition retires it, so it
 * is noise rather than news.
 */
export const DOCTOR_FLUSH_LOCK_WARN_MS = 60_000;

export const EXIT_OK = 0;
export const EXIT_WARN = 1;
/** `init` refused to touch a file it could not parse — nothing was changed. */
export const EXIT_ABORTED = 1;
export const EXIT_FAIL = 2;
export const EXIT_UNREACHABLE = 3;
export const EXIT_USAGE = 64;

export const PROBE_REPO = "crosscheck-login-probe";

/** Written into the repo's committed .crosscheck.json. */
export const REPO_CONFIG_FILE = ".crosscheck.json";
export const CLAUDE_SETTINGS_DIR = ".claude";
export const CLAUDE_SETTINGS_FILE = "settings.json";

export const POST_TOOL_USE_MATCHER = "Edit|Write|MultiEdit|NotebookEdit|Bash";
/** Tripwire fires on writes only — Bash carries no file to overlap on. */
export const PRE_TOOL_USE_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";

/**
 * Project-scoped MCP registration, committed alongside `.claude/settings.json`
 * so a teammate gets the tools on `git pull` (DESIGN.md §2).
 */
export const MCP_CONFIG_FILE = ".mcp.json";
/** The key `init` owns inside `mcpServers`; every other key is left alone. */
export const MCP_SERVER_KEY = "crosscheck";
export const MCP_SERVER_NAME = "crosscheck";

/**
 * Reported in `initialize`, and kept equal to the package version rather than
 * drifting from it.
 *
 * VERIFY: bun -e 'const p=await Bun.file("packages/connector-claude/package.json").json(); const c=await import("./packages/connector-claude/src/constants.ts"); console.log(p.version === c.MCP_SERVER_VERSION)'
 * PRINTS: true
 */
export const MCP_SERVER_VERSION = "0.1.0";

/**
 * MCP revisions this server can speak, newest first. `initialize` echoes the
 * client's version when it is one of these and otherwise answers with the first
 * — the spec's own negotiation rule, which lets an older client keep talking to
 * a newer server instead of failing the handshake.
 */
export const MCP_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

/**
 * Per-request hub timeout for MCP tools — 25× the hook timeout, deliberately.
 *
 * HTTP_TIMEOUT_MS exists because a hook runs inside a developer's keystroke and
 * must fail open before it is noticed. An MCP tool call is the opposite trade on
 * every axis: the agent ASKED for it, it is waiting for the answer, a failure is
 * visible to it rather than swallowed, and `get_diagnosis` costs the hub four
 * queries against a work context that may carry hundreds of claims. Holding that
 * to 400 ms would turn an ordinary slow query into an unreachable-hub message
 * and teach an agent that the tools do not work.
 */
export const MCP_TIMEOUT_MS = 10_000;

/**
 * Rendering caps for the two tools that put OTHER developers' text into the
 * reader's context. The briefing's caps cannot be reused: MAX_BRIEFING_CHARS is
 * sized for unsolicited injection at every SessionStart, whereas a tree is
 * pulled once, deliberately, in answer to a question the agent asked.
 *
 * A claim body is capped at 400 characters by the wire contract
 * (MAX_CLAIM_BODY_LENGTH in @crosscheck/schema), so MAX_DIAGNOSIS_CHARS is
 * roughly thirty full-length claims — past which the tool says what it dropped
 * instead of truncating in silence.
 */
export const MAX_DIAGNOSIS_CHARS = 12_000;
export const MAX_SEARCH_RESULTS = 10;
export const MAX_SEARCH_CHARS = 2400;

/**
 * Mirrors the hub's SEARCH_MAX_QUERY_CHARS (server search route rejects
 * longer queries with 400). The tool description invites "distinctive words
 * of the problem" and agents oblige with whole stack traces; truncating here
 * keeps that call answerable instead of bouncing it off the hub's boundary.
 */
export const MAX_SEARCH_QUERY_CHARS = 2_000;

/**
 * Width of an id as the MCP renderer prints it — bare, outside the « » frame,
 * because an agent has to pass it back into another tool.
 *
 * Wider than any id this connector mints and narrower than a paragraph. The
 * deterministic ids are `cc_<uuid>` and `wc_cc_<uuid>` (state/session-state.ts),
 * 39 and 42 characters, so a legitimate id is never truncated:
 *
 * VERIFY: bun -e 'const {crosscheckSessionIdFor,workContextIdFor}=await import("./packages/connector-claude/src/state/session-state.ts");const s=crosscheckSessionIdFor(crypto.randomUUID());console.log(s.length,workContextIdFor(s).length)'
 * PRINTS: 39 42
 */
export const MAX_ID_CHARS = 64;

/**
 * Width of a string THE HUB chose, as a tool prints it back.
 *
 * A hub error message and a per-record rejection issue are not this connector's
 * text: http/client.ts already states the threat model — "A hostile hub must not
 * be able to inject arbitrary text into the developer's context" — and the
 * envelope validation it describes checks the SHAPE of a response, never the
 * contents of the strings inside it. So they are quoted and capped like any
 * other untrusted prose.
 *
 * Wider than a title (MAX_TITLE_CHARS) because a rejection issue is a sentence
 * about a rule and losing half of it would defeat the point of forwarding it;
 * far narrower than a claim body, because nothing a hub has to say about one
 * refused record needs a paragraph.
 */
export const MAX_HUB_MESSAGE_CHARS = 200;
