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
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");console.log(c.USER_PROMPT_SUBMIT_BUDGET_RATIO*c.HTTP_TIMEOUT_MS, c.PRE_TOOL_USE_BUDGET_RATIO*c.HTTP_TIMEOUT_MS)'
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
/**
 * Echo-loop exclusion across sessions (DESIGN.md §3): delivered-hint body
 * hashes persist per repo so yesterday's hint cannot come back as today's
 * derived draft. FIFO like MAX_SEEN_TARGETS — at 5 substance hints/session
 * this holds ~100 sessions of deliveries, and the oldest fall out first.
 */
export const MAX_DELIVERED_HINT_HASHES_PER_REPO = 512;

/** git is spawned per hook; a hung repo must never hold the session hostage. */
export const GIT_TIMEOUT_MS = 1500;

/**
 * Bound on the one `ssh -G <host>` that resolves an ssh ALIAS to the real
 * hostname during repo identity resolution (git/ssh-hostname.ts). Tighter
 * than GIT_TIMEOUT_MS because identity runs on EVERY hook invocation and
 * `ssh -G` is local config evaluation (~10 ms measured) — a config whose
 * Match exec outlives half a second loses its aliasing for that call
 * (fail-open to the literal host), never the hook.
 */
export const SSH_RESOLVE_TIMEOUT_MS = 500;

/**
 * Environment switch that disables ssh identity canonicalization outright:
 * when the variable holds "off", the default resolver answers null without
 * spawning anything and every remote keeps its LITERAL host — fail-open,
 * identical to ssh being absent. Two audiences:
 *
 *   - a developer whose ssh config rewrites real forge hosts to unrelated
 *     proxies (a corporate `Host *` HostName override) and who would rather
 *     keep the literal identity than have it follow the proxy's name;
 *   - the test suite, whose preload (test/preload.ts) sets it so no identity
 *     assertion ever consults the machine's ~/.ssh/config — tests exercising
 *     the real resolution opt back in per spawned subprocess.
 *
 * Values other than "off" (including unset) leave canonicalization on.
 */
export const SSH_CANONICALIZE_ENV = "CROSSCHECK_SSH_CANONICALIZE";
export const SSH_CANONICALIZE_OFF = "off";

/**
 * Grace between the deadline's SIGTERM and the SIGKILL escalation for a git
 * that outlived its budget (git/git.ts). SIGTERM first so git can remove its
 * lock files; the escalation covers a git that ignores it. Nothing waits on
 * either signal — the caller already has its null by the time they fire.
 */
export const GIT_KILL_GRACE_MS = 500;

/**
 * Reading the hook payload happens before any budget exists, and SessionStart /
 * SessionEnd are synchronous hooks: an stdin that is never closed would block
 * the developer's session forever.
 */
export const STDIN_TIMEOUT_MS = 1000;

/**
 * How long `crosscheck login` waits on a piped (non-tty) stdin before giving
 * up. Hooks bound their read with STDIN_TIMEOUT_MS because they hold a
 * session open; login is a human-run command whose pipe may legitimately be
 * slow (a secret manager decrypting), so its patience is measured in tens of
 * seconds — but a wrapper that hands it an open pipe it never writes (npm
 * lifecycle scripts, Makefiles) must end in a clear "no api key supplied",
 * not a silent forever-hang (cli/login.ts).
 */
export const LOGIN_STDIN_TIMEOUT_MS = 60_000;

/**
 * ── Latency-aware timeout (login + doctor) ─────────────────────────────────
 *
 * HTTP_TIMEOUT_MS is sized for a same-LAN hub. A hub reached across a relay is
 * not hypothetical: a teammate on a Tailscale DERP path measured 200-580 ms
 * RTT, so every hub call died as "unreachable" while plain curl succeeded —
 * and the escape hatch (CROSSCHECK_TIMEOUT_MS, stored timeoutMs) existed but
 * nothing pointed at it. Login therefore measures the hub's distance itself:
 * median RTT over LATENCY_PROBE_COUNT sequential probes, times
 * LATENCY_TIMEOUT_MULTIPLIER, plus LATENCY_TIMEOUT_FLOOR_MS of absolute
 * headroom, clamped to [HTTP_TIMEOUT_MS, LATENCY_TIMEOUT_MAX_MS] — and stores
 * the result ONLY when it exceeds the default and only over values it wrote
 * itself (config/timeout-policy.ts):
 *
 * VERIFY: bun -e 'const l=await import("./packages/connector-core/src/http/latency.ts");console.log(l.recommendedTimeoutMs(500), l.recommendedTimeoutMs(0), l.recommendedTimeoutMs(10000))'
 * PRINTS: 2200 400 5000
 *
 * The multiplier absorbs relay jitter (spikes of 2-3x median are ordinary on
 * relayed paths); the floor keeps a small median from producing a timeout with
 * no absolute headroom; the lower clamp is the never-lower rule — a LAN user
 * keeps the tight default untouched.
 *
 * THE UPPER CLAMP IS A BUDGET STATEMENT, and the honest part: the hook budgets
 * are RATIOS of the effective timeout (resolveBudget, hooks/runner.ts), so a
 * stored timeout widens every hook ceiling proportionally — at the cap,
 * UserPromptSubmit's race resolves at 10 s instead of 800 ms, and what a far
 * hub actually costs each prompt is up to one real round trip of added wait.
 * A hub far enough that even the cap cannot cover it degrades the tight
 * in-session surfaces (prompt hints, the tripwire) FIRST and silently — they
 * fail open by design, silence over delay — while briefings, doctor, login and
 * the MCP tools (patient budgets) keep working. doctor's `hub latency` WARN is
 * where that state gets said out loud.
 */
export const LATENCY_PROBE_COUNT = 5;
/**
 * Login and doctor probes wait like MCP tools (a human asked and is watching),
 * not like hooks (nobody did). Also the auth probe's own timeout: held to
 * HTTP_TIMEOUT_MS, a hub 580 ms away could never complete a login at all, and
 * the one command that could fix the timeout would be the one dying of it.
 */
export const LATENCY_PROBE_TIMEOUT_MS = 10_000;
export const LATENCY_TIMEOUT_MULTIPLIER = 4;
export const LATENCY_TIMEOUT_FLOOR_MS = 200;
export const LATENCY_TIMEOUT_MAX_MS = 5_000;
/**
 * doctor warns when median RTT times this reaches the effective timeout:
 * ordinary jitter then crosses the timeout on bad samples and calls flap —
 * the in-session surfaces going silent first, per the budget statement above.
 */
export const LATENCY_FLAP_WARN_RATIO = 2;

/**
 * Bound on the one node:dns lookup that splits Bun's collapsed "could not
 * connect" into its DNS half (http/connection-error.ts). Only login and
 * doctor refine — a human is waiting there — and a resolver that is itself
 * behind the dead VPN must not hang the CLI: the deadline races the lookup
 * and the answer falls back to the unrefined cause.
 */
export const DNS_REFINE_TIMEOUT_MS = 1_000;

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
/**
 * Rows one `GET /api/work-contexts` asks for (trial finding M8). The hub caps
 * at its own WORK_CONTEXT_LIST_MAX regardless; asking for the same number
 * keeps the two honest about each other, and asking at all is what makes the
 * window opt-IN rather than a server default that would truncate every
 * connector too old to know about it.
 */
export const WORK_CONTEXT_LIST_LIMIT = 200;

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
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");console.log(c.COMMIT_EVIDENCE_GIT_TIMEOUT_MS < c.HTTP_TIMEOUT_MS)'
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

// ── Collective memory (VISION.md §1) ────────────────────────────────────────

/**
 * Landed detection (DESIGN.md §5) is a nice-to-have like drift: a slow git
 * loses the report, never the briefing. The default-branch resolution rides
 * INSIDE the SessionStart parallel hub-fetch block (its timeout below the
 * per-request hub timeout, same free ride as COMMIT_EVIDENCE_GIT_TIMEOUT_MS),
 * and the ancestry fan-out runs in parallel with the drift lookups — both
 * bounded by this, so the block's wall clock does not grow.
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");console.log(c.LANDED_GIT_TIMEOUT_MS < c.HTTP_TIMEOUT_MS)'
 * PRINTS: true
 */
export const LANDED_GIT_TIMEOUT_MS = 250;
/** Most base commits one SessionStart checks for ancestry — one git each. */
export const MAX_LANDED_ANCESTRY_CHECKS = 10;
/** The solved staleness probe is one git call at MCP pull time, bounded. */
export const STALENESS_GIT_TIMEOUT_MS = 250;
/** Most referenced files one staleness probe hands git as pathspecs. */
export const STALENESS_MAX_PATHS = 20;
/**
 * "Solved before" pointers one briefing may spend — pointer discipline like
 * MAX_CONTRADICTION_POINTERS: title + id + age, the tree is a pull.
 */
export const MAX_SOLVED_POINTERS = 2;
/**
 * FIFO cap on the remembered briefing pointers (state/session-state.ts).
 * Defensive: one SessionStart fire appends at most MAX_SOLVED_POINTERS, and
 * a re-fire re-creates the state file fresh (hooks/session-start.ts), so the
 * list never accumulates across fires — the cap bounds it like its sibling
 * state lists so no future second writer can grow it unbounded.
 */
export const MAX_BRIEFING_SOLVED_REFS = 20;
/** Solved ages render as days up to here, months beyond ("diagnosed 5mo ago"). */
export const SOLVED_AGE_MONTHS_THRESHOLD_DAYS = 60;
export const DAYS_PER_MONTH_APPROX = 30;

// ── Tier-1 summarizer (DESIGN.md §3 Tier 1, §10 risks 4 + 7) ────────────────

/**
 * Hard per-session cap on summarizer fires — the spec'd 6/session. Every fire
 * spends the developer's OWN Claude quota (§10 risk 7), so the cap is a hard
 * budget, not a tuning knob. Guarded by scripts/mutation-check.ts through
 * test/stop-gate.test.ts ("refuses fire number cap+1 exactly"), which pins the
 * arithmetic on every machine rather than a stopwatch.
 */
export const SUMMARIZER_MAX_FIRES_PER_SESSION = 6;
/** Debounce: a fire needs at least this many Stop turns since the last one. */
export const SUMMARIZER_DEBOUNCE_TURNS = 2;
/**
 * How much of the transcript file's tail the gate reads — one bounded local
 * read on the Stop hook's path, no hub, no LLM. 128 KiB covers a long turn
 * comfortably; a turn larger than this is gated on its most recent part.
 */
export const SUMMARIZER_TAIL_BYTES = 131_072;
/**
 * Ceiling on the extracted slice text handed to the summarizer prompt — the
 * token bill's other bound (≈ SUMMARIZER_SLICE_MAX_CHARS / 4 tokens at the
 * CHARS_PER_TOKEN_ESTIMATE rate the cost estimate uses).
 */
export const SUMMARIZER_SLICE_MAX_CHARS = 24_000;
/** Per content block, so one giant tool result cannot eat the whole slice. */
export const SUMMARIZER_BLOCK_MAX_CHARS = 2_000;
/**
 * Hard wall-clock timeout on the detached summarizer process. It runs OUTSIDE
 * any hook budget (the Stop hook only spawns and exits), so this is generous —
 * but it is a kill, not a wait: a hung claude binary must never accumulate.
 * CROSSCHECK_SUMMARIZER_TIMEOUT_MS overrides it (tests, slow machines).
 *
 * 60 s, raised from 30 s by trial finding #14: a nested `claude -p` that
 * loaded the developer's whole settings stack took 35–116 s to answer a
 * trivial slice (measured four runs on 2026-08-21), so the 30 s deadline
 * killed every fire before the model spoke. The lean argv
 * (summarizer/runner.ts) brings a run to ~9 s; the doubled deadline is the
 * margin for a cold Haiku or a slower laptop — the worker is detached, so
 * a longer deadline costs nothing on the keyboard.
 *
 * VERIFY: bun -e 'import {SUMMARIZER_TIMEOUT_MS as t} from "./packages/connector-core/src/constants.ts"; console.log(t / 1000)'
 * PRINTS: 60
 */
export const SUMMARIZER_TIMEOUT_MS = 60_000;
/**
 * The env marker the summarizer's nested `claude -p` carries
 * (summarizer/worker-env.ts sets it on the worker, summarizer/runner.ts on
 * the model process): EVERY crosscheck hook entry exits silently when it is
 * set (hooks/runner.ts, connector-cursor/src/runner.ts). Trial finding #14:
 * the nested claude ran crosscheck's own globally installed hooks, minting
 * phantom sessions — 3 state files per plain run, 6 under
 * --strict-mcp-config — and its Stop hook could fire the summarizer AGAIN.
 * The lean argv keeps hooks out too; the marker is the guard that does not
 * depend on which flags a given Claude Code version honours.
 */
export const SUMMARIZER_CHILD_ENV = "CROSSCHECK_SUMMARIZER_CHILD";
export const SUMMARIZER_CHILD_ON = "1";
/**
 * Bound on the booked failure text (state/session-state.ts
 * summarizerLastFailure): the first stdout line of a failed run, sanitized
 * through bareUntrusted — it is model/CLI output, untrusted — and cut here.
 * Long enough for "Not logged in · Please run /login" or "error: unknown
 * option '--tools'", short enough that a chatty binary cannot grow the
 * state file. Enforced by the WRITER (gate.ts withSummarizerFailure), not
 * the schema: a schema max would turn one over-long string into an
 * unparseable state file and silence the whole session's capture.
 */
export const SUMMARIZER_FAILURE_MAX_CHARS = 120;
/**
 * `crosscheck doctor` calls the summarizer silently dead once this many
 * fires have produced neither a NONE nor a draft (cli/doctor.ts): below it,
 * one or two runs lost to a slow laptop are noise; at it, the remainder is
 * the finding-#14 signature — 17 of 17 fires answered nothing for a whole
 * trial and no surface said so.
 */
export const DOCTOR_SUMMARIZER_SILENT_FIRES_WARN = 3;
/**
 * The second silent-death signature (trial finding M5) needs a bigger sample
 * than the first, so it has its own floor.
 *
 * "Not one answer in three fires" is unambiguous at three. "More than half of
 * the fires ended unexplained" is not: a draft dropped by the echo, secret or
 * contract gates is a NORMAL outcome that books nothing, and at three fires
 * two such drops would fire the WARN on a perfectly healthy machine. Ten is
 * where the ratio starts meaning something — and the state it exists for was
 * far past it: 27 fires on the trial machine with 21 unexplained.
 */
export const DOCTOR_SUMMARIZER_MOSTLY_DEAD_MIN_FIRES = 10;
/**
 * The slice the doctor's runner probe hands the REAL argv: a progress
 * report the prompt names out explicitly, so a working runner answers NONE
 * and a non-NONE answer is a precision note, not a failure.
 */
export const DOCTOR_SUMMARIZER_PROBE_SLICE =
  "user: run the suite\nassistant: I ran the suite and all 42 tests pass now.";
/** Bound on `claude --version` for the doctor probe's PASS line. */
export const DOCTOR_SUMMARIZER_VERSION_TIMEOUT_MS = 5000;
/**
 * The oldest Claude Code the nested summarizer may run on. The lean flags
 * are accepted well before it (changelog first mentions: --setting-sources
 * 2.0.24, --tools 2.1.0); the floor is there because `--setting-sources ""`
 * — no `user` source — let Claude Code's background cleanup ignore
 * cleanupPeriodDays and delete conversation history older than 30 days,
 * until 2.1.101 fixed it (Claude Code CHANGELOG.md, 2.1.101: "Fixed
 * --setting-sources without user causing background cleanup to ignore
 * cleanupPeriodDays and delete conversation history older than 30 days").
 * A developer with a longer retention on such a CLI would lose transcripts
 * on every fire. The argv does not change per version (an older CLI that
 * also lacks a flag fails loudly anyway); doctor's runner probe reads
 * `claude --version` and WARNs below this (summarizer/probe.ts
 * isBelowSummarizerVersionFloor).
 */
export const SUMMARIZER_CLAUDE_MIN_VERSION = "2.1.101";
/**
 * Set to "1" to skip the doctor's runner probe — it spends one Haiku call
 * on the developer's own quota per `crosscheck doctor` (acceptable for a
 * manual diagnostic, not for a script that runs doctor in a loop).
 */
export const DOCTOR_NO_PROBE_ENV = "CROSSCHECK_DOCTOR_NO_PROBE";
/** Ceiling on captured summarizer stdout — a claim is one sentence, not a log. */
export const SUMMARIZER_OUTPUT_MAX_BYTES = 16_384;
/**
 * Confidence a draft gets when the summarizer omits one. Well under the
 * DERIVED_CONFIDENCE_CAP (0.5, @crosscheck/schema), which the worker ALSO
 * clamps to client-side so an honest connector never sends more.
 */
export const SUMMARIZER_DEFAULT_CONFIDENCE = 0.3;
/**
 * The ~4 chars/token rule of thumb the briefing budget already uses
 * (MAX_BRIEFING_CHARS). Cost figures derived from it are ESTIMATES and every
 * surface printing them says so — and they count the slice and prompt the
 * hook hands over, not the nested claude's own system prompt, which on a
 * real call is an order of magnitude more (connector-claude
 * summarizer/cost.ts records the measurement).
 */
export const CHARS_PER_TOKEN_ESTIMATE = 4;
/** Haiku-class, per DESIGN.md §2: cheap capture on the developer's own auth. */
export const SUMMARIZER_MODEL = "haiku";
/**
 * The Stop hook does no hub round trip of its own (gate + spawn are local);
 * the budget exists for the state lock and the maintenance flush it hosts.
 */
export const STOP_BUDGET_RATIO = 2;
/** Draft pointers one briefing may spend — pointer discipline like solved. */
export const MAX_DRAFT_POINTERS = 2;
/** Most session state files one cost scan reads (status/doctor, bounded). */
export const STATUS_MAX_SESSION_STATES = 50;

export const PRESENCE_CACHE_TTL_MS = 10_000;
export const STATUSLINE_MAX_CHARS = 90;
/**
 * Teammates the `cx 0` branch may name as last-seen (Anhang A, A4-09). Three,
 * because the whole line is STATUSLINE_MAX_CHARS wide and `capLine` truncates
 * whatever does not fit — the point is to tell "offline" from "never
 * onboarded", which the first name already does.
 */
export const STATUSLINE_MAX_LAST_SEEN = 3;
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
 * How long a registered hook event may go without firing, while a session is
 * live, before `doctor` says so (trial finding M2).
 *
 * SIXTY MINUTES, not ten. PostToolUse fires per edit, so the quiet stretches
 * this must survive are lunch, a meeting, a long read — a ten-minute threshold
 * would WARN through every one of them, and a doctor that cries wolf daily is
 * a doctor nobody reads. An hour still catches the failure this exists for:
 * hooks that stopped at the last agent restart, at an `nvm use`, or at a
 * `CROSSCHECK_DISABLED` and never resumed.
 *
 * Applied only to the events that fire REPEATEDLY on their own (PostToolUse,
 * UserPromptSubmit, Stop). PreToolUse and SessionEnd render an age and never
 * WARN: the tripwire only fires on a write to a file a teammate holds, and
 * SessionEnd may legitimately never have fired on a machine whose sessions are
 * still open. SESSION START IS OFF THE LIST TOO, and an earlier version of
 * this comment argued for excluding it and then listed it anyway: it fires
 * ONCE per session and its marker is per-repo last-writer-wins, so its age is
 * "time since the last session started here". Three hours into one session it
 * WARNed on a line whose own numbers read `PostToolUse 8s · Stop 30s` (review
 * finding B2-05).
 *
 * The threshold also gates the NEVER-FIRED case against the session's own age
 * (cli doctor.ts hooksFiringCheck): an event that has never fired is silence
 * only once a session has been running long enough to have produced it.
 */
export const DOCTOR_HOOK_SILENT_WARN_MINUTES = 60;
/**
 * How long the statusline may go unrendered, while a session is live, before
 * `doctor` says so (trial finding H7).
 *
 * Same hour, and for once the WARN is EXPECTED on a healthy machine: the
 * statusline is a terminal-TUI feature, and every session of the trial ran
 * `--output-format stream-json` under the VS Code extension, where Claude Code
 * never calls it at all. That is why the wording leads with the explanation
 * and names where presence actually reaches such a session (the SessionStart
 * briefing) instead of offering a fix for something that is not broken.
 */
export const DOCTOR_STATUSLINE_SILENT_WARN_MINUTES = 60;
/**
 * A session-state file whose heartbeat is older than this is not a live
 * session (trial finding M2/M6): 75 of 100 state files on the trial machine
 * were past it while `unclosed sessions` read "none", because that line
 * counted only aged-out `.pending-end` markers. The hub's own presence TTL is
 * 90 seconds (server PRESENCE_TTL_SECONDS); an hour is 40× that, so nothing
 * merely slow is ever counted here.
 */
export const DOCTOR_ZOMBIE_STATE_WARN_HOURS = 1;
/**
 * Bound on the `crosscheck mcp` handshake `doctor` spawns (trial finding M3).
 * Mirrors the identity probe's 3 s in config/launcher.ts: a human is watching,
 * and a server that cannot answer `initialize` + `tools/list` in three seconds
 * has already failed the thing being asked.
 */
export const DOCTOR_MCP_PROBE_TIMEOUT_MS = 3_000;
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
 * VERIFY: bun -e 'import {HTTP_TIMEOUT_MS as t, POST_TOOL_USE_BUDGET_RATIO as r} from "./packages/connector-core/src/constants.ts"; console.log(t * r)'
 * PRINTS: 1600
 *
 * A DEAD holder's claim is not reported: the next acquisition retires it, so it
 * is noise rather than news.
 */
export const DOCTOR_FLUSH_LOCK_WARN_MS = 60_000;

/**
 * ── Doctor's agent-restart check (trial finding #8) ─────────────────────────
 *
 * Hooks load at agent/editor process start, so an agent already running when
 * `crosscheck init` writes the settings keeps running WITHOUT them —
 * silently, hooks failing open by design. The check lists processes once
 * (`ps`, bounded below), keeps the ones whose NAME matches a known agent and
 * whose start predates the settings file, and then resolves each candidate's
 * WORKING DIRECTORY (readlink /proc/<pid>/cwd on Linux, one bounded lsof on
 * macOS) — because an agent running in a DIFFERENT repo is not affected by
 * this repo's hooks, and warning about it would be the false positive that
 * teaches people to ignore doctor. A cwd that cannot be resolved is NOT an
 * offender: fail-open, a missed warning over a wrong one.
 */
export const DOCTOR_AGENT_PS_TIMEOUT_MS = 1500;
/** Bound on ONE cwd resolution (lsof can be slow; doctor is human-run). */
export const DOCTOR_AGENT_CWD_TIMEOUT_MS = 1000;
/**
 * Most candidate processes whose cwd is parsed.
 *
 * It used to be 8 and it used to buy something: every cwd cost its own `lsof`
 * spawn on macOS, so the cap was a spawn budget. It is now ONE batched
 * `lsof -a -p <csv> -d cwd -Fn` for the whole list (cli/doctor.ts), so the cap
 * bounds a parse and nothing else — and at 8 it was actively harmful. Measured
 * on the author's Mac during the trial audit: 23 processes whose `ps comm`
 * basenames to `claude`, twelve or more of them
 * `/Applications/Claude.app/Contents/{MacOS,Frameworks}/…` desktop helpers.
 * They arrive in ps order, so eight slots were spent on helpers and a real
 * offender at position 25 read `PASS no running agent predates the hooks`.
 * Helpers are excluded by path now and the survivors are sorted newest-first;
 * 64 covers a very busy day with room.
 */
export const DOCTOR_AGENT_MAX_CWD_PROBES = 64;
/** Parse bound on ps output — a runaway process table stays a bounded read. */
export const DOCTOR_AGENT_PS_MAX_LINES = 4096;

/**
 * Bound on the session-state files the foreign-repo drop scan reads
 * (state/foreign-drops.ts) — doctor/status surface the drop counter, and a
 * home littered with stale session files stays a bounded read. Live
 * sessions on one machine number in the handfuls; 200 is generous.
 */
export const FOREIGN_DROPS_SCAN_MAX_FILES = 200;
/** Most repo ids the drop summary NAMES — the sentence stays readable. */
export const FOREIGN_DROPS_MAX_NAMED_REPOS = 3;

/**
 * Bound on the session-state files `doctor`'s stale-state count and the
 * SessionStart zombie reap walk (state/session-scan.ts). Larger than the cost
 * scan's 50 because these two are COUNTING and DELETING rather than summing:
 * the number worth printing is how many stale files there are, and a home
 * that accumulated a hundred zombies is exactly the machine that needs them
 * gone.
 */
export const SESSION_STATE_SCAN_MAX_FILES = 200;
/**
 * Most zombie state files ONE SessionStart deletes. A home with a hundred of
 * them drains over four sessions instead of costing one session a hundred-file
 * unlink storm on the hook whose latency the developer feels most.
 */
export const SESSION_STATE_REAP_MAX_PER_RUN = 25;
/** A deferred end whose session the hub has never heard of (trial finding M6). */
export const HTTP_NOT_FOUND = 404;

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
 * The six Claude Code hook events `crosscheck init` registers, mapped to the
 * `crosscheck hook <name>` subcommand each one calls.
 *
 * ONE LIST, because three places used to keep their own and two of them
 * drifted (trial finding M17): `settings-merge.ts buildSettingsPlan` writes
 * six, `doctor.ts REQUIRED_HOOK_EVENTS` required six, and
 * `scripts/hook-contract-watch.ts` watched THREE while its comment claimed to
 * watch "the events we register" — so the PreToolUse tripwire's whole output
 * contract (permissionDecision, permissionDecisionReason, the literal `ask`)
 * went unwatched for as long as it existed. Every consumer now reads this,
 * which kills that class of drift by construction rather than by review.
 *
 * The insertion order is the order doctor prints them in, and it is the
 * lifecycle order a reader expects, not alphabetical.
 */
export const REGISTERED_HOOK_EVENTS = {
  SessionStart: "session-start",
  PostToolUse: "post-tool-use",
  SessionEnd: "session-end",
  UserPromptSubmit: "user-prompt-submit",
  PreToolUse: "pre-tool-use",
  Stop: "stop",
} as const;

export type RegisteredHookEvent = keyof typeof REGISTERED_HOOK_EVENTS;

/** The same six as a list, for the callers that only need the names. */
export const REGISTERED_HOOK_EVENT_NAMES = Object.keys(
  REGISTERED_HOOK_EVENTS,
) as readonly RegisteredHookEvent[];

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
 * VERIFY: bun -e 'const p=await Bun.file("packages/connector-claude/package.json").json(); const c=await import("./packages/connector-core/src/constants.ts"); console.log(p.version === c.MCP_SERVER_VERSION)'
 * PRINTS: true
 */
export const MCP_SERVER_VERSION = "0.7.2";

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
 * Rendering caps for `get_referee_brief` — PER SECTION, not one document cap,
 * and that is the neutrality mechanism: a single document budget spends itself
 * on whichever position renders first, so the later side would truncate
 * earlier exactly when the case file is fullest. Equal per-position budgets
 * keep the A/B swap invariance (test/mcp-referee-render.test.ts) true even
 * under truncation. A position is one claim line plus up to ten evidence and
 * ten ruled-out lines (hub caps, server referee.ts), each line bounded by the
 * 400-char claim-body cap — the budget covers the common case and the "(+N
 * lines not shown)" line says when it did not.
 */
export const MAX_REFEREE_POSITION_CHARS = 4000;
export const MAX_REFEREE_SHARED_CHARS = 800;
export const MAX_REFEREE_TIMELINE_CHARS = 1600;

/**
 * Contradiction pointers one briefing may spend — pointer discipline
 * (DESIGN.md §4): a one-line pointer naming get_referee_brief and the pair
 * id, never the case file itself, and never more than this many.
 */
export const MAX_CONTRADICTION_POINTERS = 2;

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
 * VERIFY: bun -e 'const {crosscheckSessionIdFor,workContextIdFor}=await import("./packages/connector-core/src/state/session-state.ts");const s=crosscheckSessionIdFor(crypto.randomUUID());console.log(s.length,workContextIdFor(s).length)'
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
