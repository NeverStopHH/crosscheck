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
