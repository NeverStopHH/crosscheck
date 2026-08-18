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
 * Cap on bytes queued behind the LOG append chain (the recorder has its own,
 * larger ACP_RECORD_MAX_PENDING_BYTES below). Observability writes never sit
 * on the forward path (§2.3 rule 2), so a stuck disk would otherwise queue
 * entries without bound; past this an entry is dropped and counted instead —
 * on disk, delivered, or counted, the spool's own rule.
 */
export const ACP_OBS_MAX_PENDING_BYTES = 1_048_576;

/**
 * Pending-byte cap for `--record` appends, deliberately LARGER than the
 * observer's line cap: a recorded entry is the observed line JSON-escaped
 * inside an envelope, and worst-case escaping (every byte a control
 * character, 6 bytes each) makes a 1 MiB wire line need ~6 MiB of entry.
 * This cap fits any single observable line plus envelope and gap marker, so
 * an idle-disk recording never drops a line for size alone — while staying
 * the recorder's hard memory bound under a stuck disk (opt-in flag, bounded
 * cost). Pinned in test/recorder.test.ts.
 */
export const ACP_RECORD_MAX_PENDING_BYTES = 8_388_608;

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

/**
 * Prefix of the per-proxy FIFO temp dirs, used by NOTHING else on purpose:
 * the startup sweep (fifo-sweep.ts) is prefix-gated, so a distinct prefix
 * is what makes it structurally unable to touch any other temp artifact.
 * Abnormal proxy death (SIGKILL, OOM, power loss) leaks one dir per death —
 * no in-process cleanup survives those — and the next proxy start reaps the
 * aged remains, mirroring the log sweep's ACP_LOG_MAX_AGE_DAYS bound.
 */
export const ACP_FIFO_DIR_PREFIX = "crosscheck-acp-fifo-";

/**
 * Test seam: an environment carrying this variable with the value below
 * makes the proxy throw right after spawning the agent — the only
 * deterministic way the E2E suite can prove a post-spawn INTERNAL failure
 * (fd exhaustion, a tmp reaper racing the FIFO opens, our own bug) is
 * CONTAINED: agent terminated, one stderr line, one log line, EXIT_FAIL —
 * never a silent exit through the bin's usage catch.
 */
export const ACP_TEST_FAULT_ENV_VAR = "CROSSCHECK_ACP_TEST_FAULT";
export const ACP_TEST_FAULT_POST_SPAWN = "post-spawn";

/** The shell's own convention: a command that cannot be spawned is 127. */
export const EXIT_SPAWN_FAILURE = 127;

/** Shell convention for death-by-signal: 128 + the signal number. */
export const SIGNAL_EXIT_BASE = 128;
