/** Every budget and cap the ACP proxy obeys — no magic numbers elsewhere. */

/**
 * Parse-copy cap per NDJSON line. FORWARDING IS UNAFFECTED — bytes stream
 * through whatever the line's length; this bounds only the observer's line
 * buffer (drop counters + `--record`). Past it the line is counted
 * `oversized`, its buffered copy is dropped, and the observer skips to the
 * next newline, so §4.2's 10 MB torture line costs the proxy at most this
 * much observer memory (pinned in test/observer.test.ts).
 */
export const ACP_MAX_PARSE_LINE_BYTES = 1_048_576;

/**
 * Cap on bytes queued behind the log/record append chains. Observability
 * writes never sit on the forward path (§2.3 rule 2), so a stuck disk would
 * otherwise queue entries without bound; past this an entry is dropped and
 * counted instead — on disk, delivered, or counted, the spool's own rule.
 */
export const ACP_OBS_MAX_PENDING_BYTES = 1_048_576;

/** Per-proxy log size cap; crossing it rotates once to `<log>.1`. */
export const ACP_LOG_MAX_BYTES = 1_000_000;

/**
 * Logs from dead proxies are swept at logger startup past this age (mtime) —
 * the same bound the spool applies to its own aged artifacts
 * (MAX_SPOOL_AGE_DAYS), for the same reason: growth with use must not
 * outlive its usefulness.
 */
export const ACP_LOG_MAX_AGE_DAYS = 7;

/** Directory under the crosscheck home where proxy logs live (§2.2). */
export const ACP_LOG_DIR_NAME = "logs";

/**
 * Bounded wait for the exit-time log/record flush. The child is already
 * dead; nothing here may hold the client's waitpid hostage.
 */
export const ACP_EXIT_FLUSH_TIMEOUT_MS = 500;

/** The shell's own convention: a command that cannot be spawned is 127. */
export const EXIT_SPAWN_FAILURE = 127;

/** Shell convention for death-by-signal: 128 + the signal number. */
export const SIGNAL_EXIT_BASE = 128;
