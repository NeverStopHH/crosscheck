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
 * PostToolUseFailure runs INSIDE the agent's turn and returns
 * `additionalContext`, so it takes the keystroke-grade bound too — not
 * PostToolUse's maintenance budget, which is four request timeouts because
 * that hook is async and nobody waits on it. Same 800 ms, same reason: the
 * developer is watching a build fail and must not also watch a hook.
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");console.log(c.POST_TOOL_USE_FAILURE_BUDGET_RATIO * c.HTTP_TIMEOUT_MS, c.POST_TOOL_USE_FAILURE_BUDGET_RATIO === c.USER_PROMPT_SUBMIT_BUDGET_RATIO)'
 * PRINTS: 800 true
 */
export const POST_TOOL_USE_FAILURE_BUDGET_RATIO = 2;
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
 * The failure-time solved probe asks the hub about a fingerprint ONCE per
 * session; FIFO cap on the remembered set, the MAX_TRIPWIRE_ASKED_FILES
 * shape. Sized for the distinct failures one session produces rather than
 * for its total failures — the whole point is that a retry loop repeats ONE
 * fingerprint, and a session that genuinely hits 100 different failures has
 * spent its five hint slots long before this cap matters.
 */
export const MAX_PROBED_FINGERPRINTS = 100;
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
 *
 * WHAT IT HOLDS CHANGED WITHOUT THIS NUMBER CHANGING, and that is worth saying
 * plainly rather than leaving to be rediscovered. A claim envelope carrying a
 * MAX_CLAIM_BODY_LENGTH body is about 10.4 KB against about 0.8 KB at the old
 * 400-character width, so the same two megabytes hold roughly 190 of them
 * where they once held roughly 2,400:
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");const s=await import("./packages/schema/src/index.ts");const mk=(n)=>JSON.stringify({cx:"0.1",id:"env_00000000-0000-4000-8000-000000000000",ts:"2026-08-30T12:00:00.000Z",producer:{developerId:"dev_self",agentKind:"claude-code",sessionId:"cc_00000000-0000-4000-8000-000000000000"},kind:"claim",body:{workContextId:"wc_cc_00000000-0000-4000-8000-000000000000",kind:"hypothesis",body:"b".repeat(n),status:"proposed",confidence:0.5,captureMode:"agent",provenance:"declared",evidenceRefs:[]}}).length+1;console.log(Math.floor(c.MAX_SPOOL_BYTES/mk(400)), Math.floor(c.MAX_SPOOL_BYTES/mk(s.MAX_CLAIM_BODY_LENGTH)))'
 * PRINTS: 2418 191
 *
 * THE CAP STAYS ANYWAY. A refused append is COUNTED and surfaced — doctor
 * reports spool depth and drops — so the degraded state is visible rather than
 * silent, which is the property that made this a cap instead of a compaction
 * in the first place. Raising it would trade a visible bound for more disk
 * held by a machine whose hub is unreachable. Nothing here is free of the
 * change, though: the flush cost per hook is measured at the new body length
 * by scripts/measure-body-length-budgets.ts (connector-claude), not assumed.
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

// ── Detached-HEAD work-context titles (trial finding #15) ────────────────────

/**
 * A worktree session runs on a detached HEAD, so its branch reads
 * `detached@<sha>` and the honest fallback title `detached@<sha> @ repo` tells
 * a teammate nothing: on the trial hub 70 of 80 work contexts carried one. At
 * SESSION START ONLY — never in a per-tool hook — the title builder
 * (flows/work-context-title.ts) asks git twice, each call bounded by this:
 * which branch tip the commit sits on (preferred, a worktree made from a
 * branch), else the HEAD commit's subject. Same class as the drift, landed
 * and commit-evidence timeouts: a slow git loses the label, never the
 * registration, and at the default timeouts both calls together stay inside
 * the one hub round trip SessionStart already pays (worst case 2 × 250 ms on
 * a detached session, nothing at all on a branch):
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");console.log(c.HEAD_LABEL_GIT_TIMEOUT_MS < c.HTTP_TIMEOUT_MS, 2 * c.HEAD_LABEL_GIT_TIMEOUT_MS <= c.SESSION_START_BUDGET_RATIO * c.HTTP_TIMEOUT_MS - c.HTTP_TIMEOUT_MS)'
 * PRINTS: true true
 */
export const HEAD_LABEL_GIT_TIMEOUT_MS = 250;
/**
 * Bound on the commit subject folded into a detached title. A subject is a
 * developer's own commit message — untrusted cross-user text once uploaded —
 * so it goes through the PROSE sanitizer at this width before the title is
 * composed; half the title cap, so `detached@<sha> · <subject> @ <repo>`
 * always fits inside MAX_WORK_CONTEXT_TITLE_CHARS with the repo label:
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");console.log(c.DETACHED_SUBJECT_MAX_CHARS * 2 === c.MAX_WORK_CONTEXT_TITLE_CHARS)'
 * PRINTS: true
 */
export const DETACHED_SUBJECT_MAX_CHARS = 60;

// ── Session intent (trial finding #16) ──────────────────────────────────────

/**
 * Render cap for an intent sentence on EVERY surface that shows one — the
 * briefing's presence and context lines, the pointer/claim hints, the
 * tripwire reason, the MCP diagnosis and search, `crosscheck status`. The hub
 * stores up to MAX_INTENT_SUMMARY_CHARS (@crosscheck/schema); a longer
 * declared sentence renders cut with an ellipsis. Equal to the title cap on
 * purpose: an intent line costs the briefing what a title line costs, so
 * the MAX_BRIEFING_CHARS arithmetic (and the saturating-briefing pin in
 * test/injection-corpus.test.ts) keeps its shape:
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");const s=await import("./packages/schema/src/index.ts");console.log(c.INTENT_MAX_CHARS === c.MAX_WORK_CONTEXT_TITLE_CHARS, c.INTENT_MAX_CHARS < s.MAX_INTENT_SUMMARY_CHARS)'
 * PRINTS: true true
 */
export const INTENT_MAX_CHARS = 120;
/**
 * "Substantive" for the derived-intent fire (connector-claude intent/gate.ts):
 * the FIRST user prompt of a session at least this long — below it sits
 * "yes", "go on", "/clear", a pasted path — and not a slash command, not a
 * bare yes/no, with at least one word of HINT_MIN_TOKEN_CHARS. One fire per
 * session state, booked under the state lock BEFORE the worker spawns (the
 * Stop hook's contract), so the one Haiku call this costs on the developer's
 * quota is spent exactly once per SessionStart (a `--resume` re-creates the
 * state and may fire again).
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");console.log(c.INTENT_MIN_PROMPT_CHARS, c.INTENT_MIN_PROMPT_CHARS > c.HINT_MIN_TOKEN_CHARS)'
 * PRINTS: 40 true
 */
export const INTENT_MIN_PROMPT_CHARS = 40;
/**
 * How much of the first prompt the worker hands the model — the token bill's
 * bound for the intent call (≈ INTENT_PROMPT_MAX_CHARS / 4 tokens at the
 * CHARS_PER_TOKEN_ESTIMATE rate). The prompt is written to a 0600 file under
 * the crosscheck home and unlinked by the worker; it never leaves the machine
 * — only the model's one sentence does.
 */
export const INTENT_PROMPT_MAX_CHARS = 4000;
/**
 * Confidence a DERIVED intent carries, fixed — never model-chosen — and under
 * the derived cap the schema enforces on every derived intent and claim
 * (DERIVED_CONFIDENCE_CAP, @crosscheck/schema): the label "(derived)" is what
 * a reader sees; this number is what the wire contract checks.
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");const s=await import("./packages/schema/src/index.ts");console.log(c.INTENT_DERIVED_CONFIDENCE < s.DERIVED_CONFIDENCE_CAP)'
 * PRINTS: true
 */
export const INTENT_DERIVED_CONFIDENCE = 0.4;
/**
 * `crosscheck doctor` calls the derived-intent capture silently dead once
 * this many fires have landed neither a NONE nor an intent — AND on any
 * booked failure at all, whatever the count (cli/doctor.ts checkIntentCost).
 * Lower than the summarizer's threshold (DOCTOR_SUMMARIZER_SILENT_FIRES_WARN)
 * because an intent fires at most ONCE per session state: waiting for three
 * silent fires would mean three sessions of silence before doctor spoke.
 * Never a PASS-only counter (the finding-#14 lesson).
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");console.log(c.DOCTOR_INTENT_SILENT_FIRES_WARN, c.DOCTOR_INTENT_SILENT_FIRES_WARN < c.DOCTOR_SUMMARIZER_SILENT_FIRES_WARN)'
 * PRINTS: 2 true
 */
export const DOCTOR_INTENT_SILENT_FIRES_WARN = 2;

// ── Ghost commits: the gated model layer (VISION.md §3) ────────────────────

/**
 * Ghost checks one session may spend. ONE, and the reason is the same one
 * VISION §3 gives for the whole feature being gated: the deterministic half
 * costs nothing and runs on every SessionStart and every declaration, while
 * this half is a model call on the developer's own quota that answers a
 * question a session only asks once — "does anybody else's plan collide with
 * mine". A second call would compare the same two plans again.
 *
 * Re-declaring an intent re-opens the DEBT (state/session-state.ts
 * withRecordedIntent) but not the allowance: the debt is what makes the check
 * run at all, and this is what stops it running twice.
 */
export const GHOST_MAX_FIRES_PER_SESSION = 1;

/**
 * Confidence a ghost sentence carries, fixed here and never model-chosen —
 * the derived-intent rule applied to a second derived surface, and under the
 * cap the shared wire contract enforces (DERIVED_CONFIDENCE_CAP,
 * @crosscheck/schema). A collision the model INFERRED from two sentences is
 * the weakest thing this product produces; it is a draft the author reviews,
 * never a finding a teammate is shown.
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");const s=await import("./packages/schema/src/index.ts");console.log(c.GHOST_DERIVED_CONFIDENCE < s.DERIVED_CONFIDENCE_CAP, c.GHOST_DERIVED_CONFIDENCE === c.INTENT_DERIVED_CONFIDENCE)'
 * PRINTS: true true
 */
export const GHOST_DERIVED_CONFIDENCE = 0.4;

/**
 * Teammate claims the ghost input may carry. DECLARED ones only, and only
 * from the ONE overlapping context — the model is being asked whether two
 * plans collide, and a longer list buys context the question does not need
 * while widening what a single call reads.
 */
export const GHOST_MAX_TEAMMATE_CLAIMS = 5;

/**
 * How much of one teammate claim body reaches the model. Long enough for a
 * root cause, short enough that five of them plus two intents stay a small
 * prompt — the same "bounded slice" rule the summarizer's tail applies.
 */
export const GHOST_CLAIM_BODY_MAX_CHARS = 300;

/**
 * The longest ghost sentence that becomes a draft. Bounded by THIS writer
 * rather than by the schema, like every other model output here, and short
 * enough that the sentence PLUS the attribution the worker appends — the
 * teammate's name and their context id, both bounded by the sanitizers —
 * still fits MAX_CLAIM_BODY_LENGTH.
 *
 * WHAT IT IS NOT is short enough to escape the briefing's draft line, which
 * cuts a body at MAX_TITLE_CHARS = 80 and marks the cut. That is deliberate
 * and is the shape every other draft on that block already has: the line is a
 * POINTER and `review_draft` is the pull.
 *
 * The worst case is composed through the real function and checked where
 * that function lives (briefing/ghost.ts ghostDraftBody); here is the half
 * this constant owns.
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");const s=await import("./packages/schema/src/index.ts");console.log(c.GHOST_SENTENCE_MAX_CHARS < s.MAX_CLAIM_BODY_LENGTH)'
 * PRINTS: true
 */
export const GHOST_SENTENCE_MAX_CHARS = 200;

/**
 * `crosscheck doctor` calls the ghost layer silently dead once this many
 * fires have landed neither a NONE nor a draft — AND on any booked failure at
 * all. The intent capture's threshold and its reasoning verbatim: a ghost
 * check fires at most once per session (GHOST_MAX_FIRES_PER_SESSION), so
 * waiting for three would mean three sessions of silence before doctor spoke.
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");console.log(c.DOCTOR_GHOST_SILENT_FIRES_WARN === c.DOCTOR_INTENT_SILENT_FIRES_WARN)'
 * PRINTS: true
 */
export const DOCTOR_GHOST_SILENT_FIRES_WARN = 2;

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
 * "Solved before" entries one briefing may spend — title + id + age, and for
 * a fingerprint match one further line carrying the recorded cause.
 */
export const MAX_SOLVED_POINTERS = 2;

/**
 * How much of a solved tree's recorded cause the briefing prints. The claim's
 * own bound is MAX_CLAIM_BODY_LENGTH, which is now WIDER THAN THE WHOLE
 * BRIEFING — one full-length body would not merely outweigh the "Questions
 * for you" block, it would not fit on the page at all. That is the anchoring
 * asymmetry from the other side: a briefing is unsolicited, so it prints a
 * lead and names the tool that reads the rest. This bound keeps
 * the pair below that block's, which is the ordering the budget already
 * states: what somebody is waiting for outranks what somebody once found.
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");const s=await import("./packages/schema/src/index.ts");console.log(c.SOLVED_ROOT_CAUSE_MAX_CHARS < s.MAX_CLAIM_BODY_LENGTH, c.MAX_SOLVED_POINTERS * c.SOLVED_ROOT_CAUSE_MAX_CHARS < c.MAX_BRIEFING_QUESTION_CHARS)'
 * PRINTS: true true
 */
export const SOLVED_ROOT_CAUSE_MAX_CHARS = 200;
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
/**
 * …and as YEARS beyond here ("diagnosed 5y 8mo ago"). Two years is where the
 * month count stops reading at a glance and starts asking the reader to
 * divide, which is the one thing the formatter exists to avoid. It is
 * reachable: solved matches travel across repos, there is no maximum age,
 * and this surface deliberately still shows an old answer — saying plainly
 * how old it is, which "68mo" does not.
 */
export const SOLVED_AGE_YEARS_THRESHOLD_MONTHS = 24;
export const MONTHS_PER_YEAR = 12;

// ── The asynchronous question channel (roadmap R2) ────────────────────

/**
 * Ghost-check lines one SessionStart briefing shows (VISION.md §3). TWO, the
 * solved pointers' ceiling and for the same budget reason — but the product
 * reason is stronger here: a collision notice is something the reader is
 * expected to ACT on, by opening a tree or messaging a person, and one or two
 * names is a decision while three is a list to skim. The hub returns up to
 * GHOST_MAX_FINDINGS so a row this renderer will not vouch for costs the
 * section a line rather than its content:
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");const s=await import("./packages/server/src/constants.ts");console.log(c.MAX_GHOST_POINTERS < s.GHOST_MAX_FINDINGS)'
 * PRINTS: true
 */
export const MAX_GHOST_POINTERS = 2;

/**
 * The most CHARACTERS the ghost block may take out of the briefing. Bounded
 * in items AND in characters for the reason the questions block already
 * states: the item bound alone is not a bound.
 *
 * MEASURED through the real formatter rather than added up from literals,
 * because a ghost line is a composition and its worst case is not the sum of
 * its caps. Two MAXIMAL rows — a name and an intent at their render caps, a
 * shared fingerprint, GHOST_MAX_SHARED_SHOWN paths at
 * GHOST_SHARED_VALUE_MAX_CHARS each, a "+N more of yours" tail, the word
 * count and a full-length id — compose 491 characters each, so the block
 * measured 983 characters of lines under a 114-character header: 1098 of
 * MAX_BRIEFING_CHARS, HALF the briefing, for two pointer lines. The five
 * sections below it (teammate contexts, contradictions, solved-before,
 * draft reminders, absences) give way whole to that, which is the ordering
 * appendSection enforces and not one anybody chose.
 *
 * 800 is where the measurements put it. Two REALISTIC monorepo rows — long
 * nested paths, a shared failure, a declared intent and a "+N more" tail —
 * compose 705 characters, and BOTH must survive: two teammates in the
 * reader's files is the case this feature exists for, and a bound that drops
 * the second would be the fix causing the failure. Two maximal rows do not
 * fit, and the second is reported by the section's own "+N more not shown".
 *
 * It is LARGER than the questions block's bound for one fewer item, and that
 * is deliberate rather than an oversight: a ghost line carries up to
 * GHOST_MAX_SHARED_SHOWN × GHOST_SHARED_VALUE_MAX_CHARS characters of the
 * READER'S OWN paths, which no question line carries, and there is no
 * `list_open_ghost_checks` to read a dropped row from — a question left out
 * is deferred, a ghost row left out is only counted. The ordering the budget
 * states is untouched by this number: appendSection fills the questions
 * block FIRST, so this bounds a section, it does not rank one.
 *
 * The two bounded blocks together can never fill the briefing, which is what
 * keeps the sections below reachable at all:
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");console.log(c.MAX_BRIEFING_GHOST_CHARS + c.MAX_BRIEFING_QUESTION_CHARS < c.MAX_BRIEFING_CHARS)'
 * PRINTS: true
 */
export const MAX_BRIEFING_GHOST_CHARS = 800;

/**
 * How much of a shared file path or symbol a ghost line prints. A path is a
 * BARE field on a line that already carries a name, an age and a framed
 * intent, and three of them share the line — the briefing budget, not the
 * value, is what this bounds.
 */
export const GHOST_SHARED_VALUE_MAX_CHARS = 60;

/**
 * Most questions the SessionStart briefing shows at once (roadmap R2).
 * Three, and the ceiling is not arbitrary: MAX_OPEN_QUESTIONS_PER_TARGET on
 * the hub is also three, so one teammate can fill this block exactly once and
 * a second teammate's question is what pushes theirs out — never one voice
 * holding the whole block against everyone else.
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");const s=await import("./packages/server/src/constants.ts");console.log(c.MAX_QUESTION_POINTERS === s.MAX_OPEN_QUESTIONS_PER_TARGET)'
 * PRINTS: true
 */
export const MAX_QUESTION_POINTERS = 3;

/**
 * The most CHARACTERS the questions block may take out of the briefing —
 * roughly a third of MAX_BRIEFING_CHARS. Bounded in items AND in characters,
 * because the item bound alone is not a bound: a question body may be 400
 * characters, and three of them plus their id lines ate the ENTIRE 2200-char
 * briefing in the saturation measurement — presence and teammate contexts
 * vanished completely.
 *
 * Entries are DROPPED, never truncated, and the block then says how many it
 * is not showing. A cut question is unanswerable, which is the one thing this
 * block exists to prevent; a question left for `list_open_questions` is not.
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");console.log(c.MAX_BRIEFING_QUESTION_CHARS * 3 <= c.MAX_BRIEFING_CHARS)'
 * PRINTS: true
 */
export const MAX_BRIEFING_QUESTION_CHARS = 700;

/**
 * When `doctor` starts calling an unanswered question a problem. A question
 * expires after QUESTION_TTL_DAYS = 14 on the hub, so half the window is the
 * point where "nobody has answered yet" stops being normal and starts being
 * the failure this channel is most likely to have: an open thread nobody acts
 * on, which is what every prior-art system warns about.
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");const s=await import("./packages/server/src/constants.ts");console.log(c.DOCTOR_QUESTION_OPEN_WARN_DAYS * 2 === s.QUESTION_TTL_DAYS)'
 * PRINTS: true
 */
export const DOCTOR_QUESTION_OPEN_WARN_DAYS = 7;

/**
 * How many solved pointers must have been SHOWN before `doctor` will call
 * "none of them was ever opened" a problem (hints/precision.ts). One or two
 * ignored pointers are a reader who was busy; at three the pattern is the
 * surface, not the day. Deliberately below MAX_HINTS_PER_SESSION, so a
 * single session that spent its whole allowance on solved pointers and
 * opened none of them is already enough evidence to say so:
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");console.log(c.DOCTOR_SOLVED_SHOWN_WARN < c.MAX_HINTS_PER_SESSION)'
 * PRINTS: true
 */
export const DOCTOR_SOLVED_SHOWN_WARN = 3;

/**
 * How long the hub keeps REPORTING a question of yours that expired
 * unanswered. Equal to the TTL: reported for one further fortnight, then
 * silent — nothing can clear an expired row (`withdrawn` is unreachable and
 * `questions` has no reaper), so an unwindowed count would make `doctor` WARN
 * and exit 1 for the rest of an install's life over one question nobody
 * answered last spring. Named here only so the sentence can say the window
 * out loud rather than reporting a number whose scope the reader must guess.
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");const s=await import("./packages/server/src/constants.ts");console.log(c.QUESTION_EXPIRY_REPORT_DAYS === s.QUESTION_TTL_DAYS)'
 * PRINTS: true
 */
export const QUESTION_EXPIRY_REPORT_DAYS = 14;

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
 * `crosscheck doctor` WARNs once this many well-formed answers have been
 * REFUSED with no draft kept (audit rows M16 / A3-4, summarizer/cost.ts
 * isSummarizerAlwaysRejected). The model is speaking and the developer's own
 * quota is being spent, so this is a different remedy from a dead runner — a
 * drifted prompt, a slice that lost its ask, a model that role-plays.
 *
 * 2 rather than the silence threshold's 3: one refusal is ordinary (a draft
 * that echoed a delivered teammate hint is the echo guard doing its job), two
 * with nothing kept is a pattern. Never a PASS-only counter.
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");console.log(c.DOCTOR_SUMMARIZER_REJECTED_WARN, c.DOCTOR_SUMMARIZER_REJECTED_WARN < c.DOCTOR_SUMMARIZER_SILENT_FIRES_WARN)'
 * PRINTS: 2 true
 */
export const DOCTOR_SUMMARIZER_REJECTED_WARN = 2;
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
 * The longest body a DERIVED draft may claim (DESIGN.md §3).
 *
 * DERIVED STAYS DERIVED. A draft is a machine's guess at what a turn was
 * about, capped at DERIVED_CONFIDENCE_CAP because nobody vouched for it; the
 * wire cap rose so that a HUMAN can write a long, careful root cause, and a
 * summarizer inheriting that would let the least trustworthy producer in the
 * system emit the longest records. It parsed against MAX_CLAIM_BODY_LENGTH
 * before this constant existed, so the inheritance was one edit away in a file
 * that has no reason to think about wire caps at all.
 *
 * IT ALSO KEEPS THE OUTPUT ARITHMETIC TRUE: stdout is captured up to
 * SUMMARIZER_OUTPUT_MAX_BYTES, and a body allowed to approach that leaves no
 * room for the JSON around it, so a long draft would be cut into unparseable
 * garbage and discarded — a silent failure dressed as a shrug.
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");const s=await import("./packages/schema/src/index.ts");console.log(c.SUMMARIZER_DRAFT_BODY_MAX_CHARS < s.MAX_CLAIM_BODY_LENGTH, 4 * c.SUMMARIZER_DRAFT_BODY_MAX_CHARS < c.SUMMARIZER_OUTPUT_MAX_BYTES)'
 * PRINTS: true true
 */
export const SUMMARIZER_DRAFT_BODY_MAX_CHARS = 400;
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
/** Most candidate processes whose cwd is probed — one spawn each on macOS. */
export const DOCTOR_AGENT_MAX_CWD_PROBES = 8;
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
 * WHAT IT HOLDS, at the wire cap the schema now allows: about four
 * maximum-length findings, or about a hundred and twenty of the 400-character
 * width every claim was written to before the raise — past which the tool says
 * what it dropped instead of truncating in silence.
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");const s=await import("./packages/schema/src/index.ts");console.log(Math.floor(c.MAX_DIAGNOSIS_CHARS/s.MAX_CLAIM_BODY_LENGTH), Math.floor(c.MAX_DIAGNOSIS_CHARS/c.UNSOLICITED_CLAIM_BODY_MAX_CHARS))'
 * PRINTS: 4 120
 *
 * WHY NOT LARGER, WHICH IS THE HONEST LIMIT ON NICK'S "ALL FINDINGS VISIBLE".
 * The binding ceiling is not ours: an MCP client truncates a tool result on
 * its own side, outside every honesty mechanism in this file — a harness-side
 * cut lands mid-line and can sever a « » frame, and the reader is told nothing.
 * Our "(+N claims not shown)" line has to remain the only truncation anybody
 * ever sees, so this stays under the default output limit of the client this
 * product is built against rather than growing to fit ten long findings. A
 * tree of ten maximum-length findings therefore shows four and counts six.
 * Raising this further requires knowing the harness limit it will run under;
 * that limit is user-configurable and is not ours to assume.
 */
export const MAX_DIAGNOSIS_CHARS = 48_000;

/**
 * A claim body's room on an UNSOLICITED surface — a briefing, a hint, a
 * report, a statusline — whatever the wire allows.
 *
 * THIS IS THE ANCHORING ASYMMETRY AS A NUMBER (DESIGN.md §4). What a reader
 * did not ask for arrives as a POINTER; substance appears on a deliberate
 * pull. Body room may therefore be generous on `get_diagnosis` and must not
 * follow it here: one maximum-length finding pushed into a SessionStart
 * briefing would eat the whole budget and push every other teammate out of
 * it, which is precisely backwards — the reader wanted the OTHERS, and the
 * long one is a click away.
 *
 * IT IS A SEPARATE CONSTANT RATHER THAN A REUSE OF THE SCHEMA'S, and that is
 * the entire point. hints/render.ts passed MAX_CLAIM_BODY_LENGTH to
 * `quotedBody` on both hint surfaces, so the tight cap was not a decision but
 * a coincidence of the wire cap being small — and the moment the wire cap
 * moved, two unsolicited surfaces would have inherited it silently. Nothing
 * about a hint changed when this constant appeared except that its width is
 * now stated where a reader can see it.
 *
 * 400 IS THE OLD WIRE CAP, kept deliberately: every unsolicited surface was
 * built and measured against exactly this width, so pinning it here changes
 * no rendering that exists today.
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");const s=await import("./packages/schema/src/index.ts");console.log(c.UNSOLICITED_CLAIM_BODY_MAX_CHARS < s.MAX_CLAIM_BODY_LENGTH, c.UNSOLICITED_CLAIM_BODY_MAX_CHARS < s.MAX_HINT_TEXT_LENGTH)'
 * PRINTS: true true
 */
export const UNSOLICITED_CLAIM_BODY_MAX_CHARS = 400;

/**
 * A body quoted back to the AUTHOR who just wrote it — the receipt on
 * `review_draft` and `answer_question`.
 *
 * AN ECHO IS A RECEIPT, NOT THE ANSWER. It exists so the writer can see WHICH
 * text was accepted, and the first line of it settles that; the writer already
 * holds the rest, having typed it. Echoing ten thousand characters back into
 * the context of the session that just sent them spends the reader's window on
 * something they own, so this stays where it was rather than following the
 * wire cap up.
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");const s=await import("./packages/schema/src/index.ts");console.log(c.CLAIM_ECHO_MAX_CHARS === c.UNSOLICITED_CLAIM_BODY_MAX_CHARS, c.CLAIM_ECHO_MAX_CHARS <= s.MAX_CLAIM_BODY_LENGTH)'
 * PRINTS: true true
 */
export const CLAIM_ECHO_MAX_CHARS = 400;
export const MAX_SEARCH_RESULTS = 10;
export const MAX_SEARCH_CHARS = 2400;

/**
 * Mirrors the hub's DIAGNOSIS_MAX_TARGETS (server services/diagnosis.ts): the
 * LIMIT it puts on the targets it returns with a tree.
 *
 * Mirrored rather than sent, the same way MAX_INGEST_BATCH is, because the
 * hub's cut is SILENT — a response holding exactly this many rows looks
 * identical to a complete one. This client counts, and says so; a wire field
 * would be cleaner and is not worth a schema change for one sentence.
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");const d=await import("./packages/server/src/services/diagnosis.ts");console.log(c.HUB_MAX_DIAGNOSIS_TARGETS === d.DIAGNOSIS_MAX_TARGETS)'
 * PRINTS: true
 */
export const HUB_MAX_DIAGNOSIS_TARGETS = 100;

/**
 * Target rows one diagnosis SHOWS, of however many the hub sent.
 *
 * The section exists so a reader about to edit the same corner sees the
 * overlap; twenty paths is more than enough to recognise a corner, and the
 * rest are counted by the section's own "(+N targets not shown)" line rather
 * than dropped in silence. Kept well under HUB_MAX_DIAGNOSIS_TARGETS on
 * purpose: this section must never be the reason a CLAIM line falls off the
 * document, and its worst case is bounded by
 * MAX_DIAGNOSIS_TARGETS_SHOWN × (kind + value width).
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");console.log(c.MAX_DIAGNOSIS_TARGETS_SHOWN < c.HUB_MAX_DIAGNOSIS_TARGETS, c.MAX_DIAGNOSIS_TARGETS_SHOWN * (c.MAX_WORK_CONTEXT_TITLE_CHARS + c.MAX_TITLE_CHARS))'
 * PRINTS: true 4000
 */
export const MAX_DIAGNOSIS_TARGETS_SHOWN = 20;

/**
 * Rendering caps for `get_referee_brief` — PER SECTION, not one document cap,
 * and that is the neutrality mechanism: a single document budget spends itself
 * on whichever position renders first, so the later side would truncate
 * earlier exactly when the case file is fullest. Equal per-position budgets
 * keep the A/B swap invariance (test/mcp-referee-render.test.ts) true even
 * under truncation. A position is one claim line plus up to ten evidence and
 * ten ruled-out lines (hub caps, server referee.ts), each line bounded by the
 * claim-body cap — the budget covers the common case and the "(+N lines not
 * shown)" line says when it did not.
 *
 * SIZED SO ONE MAXIMUM-LENGTH BODY STILL FITS. The claim line is paid first
 * inside a position's budget, so a position holding one full-length root cause
 * would otherwise spend its entire allowance on that line and drop every
 * evidence line under it — on the one surface whose whole purpose is showing
 * two cases side by side. Equal-per-position is untouched, which is what keeps
 * the swap invariance byte-exact; both sides simply got the same larger room.
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");const s=await import("./packages/schema/src/index.ts");console.log(c.MAX_REFEREE_POSITION_CHARS > s.MAX_CLAIM_BODY_LENGTH, 2*c.MAX_REFEREE_POSITION_CHARS + c.MAX_REFEREE_SHARED_CHARS + c.MAX_REFEREE_TIMELINE_CHARS)'
 * PRINTS: true 26400
 */
export const MAX_REFEREE_POSITION_CHARS = 12_000;
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

// ── Agent conferences (VISION.md §2) ────────────────────────────────────────

/**
 * Shared-cause findings ONE report may carry. Three, and the bound is about
 * trust rather than space: a synthesis that names three things a human can
 * check is a briefing, and one that names fifteen is a wall of text nobody
 * reads to the end — which is how a warning system stops being read at all.
 * The deterministic sections beside it are bounded by the hub.
 */
export const CONFERENCE_MAX_FINDINGS = 3;

/**
 * One finding's sentence. The ghost check's bound, because it is the same
 * kind of sentence — one claim about where two pieces of work meet — and a
 * published finding becomes a claim body the same way.
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");const s=await import("./packages/schema/src/index.ts");console.log(c.CONFERENCE_SENTENCE_MAX_CHARS === c.GHOST_SENTENCE_MAX_CHARS, c.CONFERENCE_SENTENCE_MAX_CHARS < s.MAX_CLAIM_BODY_LENGTH)'
 * PRINTS: true true
 */
export const CONFERENCE_SENTENCE_MAX_CHARS = 200;

/**
 * Claims quoted UNDER one finding, per context. Two: enough to show why the
 * model said what it said — VISION §2's own requirement that a conference is
 * formatted as a referee brief (evidence for each position) rather than as a
 * verdict — without turning one finding into a page.
 */
export const CONFERENCE_MAX_EVIDENCE_PER_CONTEXT = 2;

/**
 * A quoted claim body in the report. The hub already cuts at its own
 * CONFERENCE_CLAIM_BODY_MAX_CHARS, so this is the reader's second bound
 * rather than the first — the posture every consumer of a tolerant wire field
 * takes here.
 */
export const CONFERENCE_BODY_MAX_CHARS = 300;

/**
 * How long a whole `crosscheck conference` may take, model call included.
 * A hard ceiling rather than a hint: the run prints its estimate first and
 * this is the promise that goes with it, in the shape the LLM cost literature
 * calls quote-as-ceiling — estimate, cap, absorb the overrun. Ninety seconds
 * is one bounded hub read plus one lean local model call
 * (SUMMARIZER_TIMEOUT_MS) with room for a slow machine, and it is short
 * enough that a human waits for it rather than walking away.
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");console.log(c.CONFERENCE_MAX_WALL_MS > c.SUMMARIZER_TIMEOUT_MS)'
 * PRINTS: true
 */
export const CONFERENCE_MAX_WALL_MS = 90_000;

/**
 * The characters-per-token rule of thumb the pre-run estimate uses. It is an
 * ESTIMATE and the line says so: no tokenizer runs on this machine, and a
 * figure printed as if it were measured would be the kind of false precision
 * this project keeps out of its telemetry.
 */
export const CONFERENCE_CHARS_PER_TOKEN = 4;

/**
 * The model input's own ceiling, applied after every per-context bound. The
 * hub's caps already make the input small; this is what holds when a hub is
 * modified or hostile, and it is what the printed estimate can never exceed.
 */
export const CONFERENCE_MAX_INPUT_CHARS = 12_000;

/**
 * A published conference finding is a Tier-1 DRAFT like every other model
 * sentence in this product: derived, proposed, under the cap, pointer-only
 * until a human promotes it with review_draft.
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");const s=await import("./packages/schema/src/index.ts");console.log(c.CONFERENCE_DERIVED_CONFIDENCE === c.GHOST_DERIVED_CONFIDENCE, c.CONFERENCE_DERIVED_CONFIDENCE < s.DERIVED_CONFIDENCE_CAP)'
 * PRINTS: true true
 */
export const CONFERENCE_DERIVED_CONFIDENCE = 0.4;

/**
 * Runs whose model answer this machine could not read at all before `doctor`
 * WARNs. Not a count of NONEs — a NONE is a legitimate answer and the usual
 * one — but of answers in a shape the parser does not know, which is what a
 * drifted prompt or a changed binary looks like from here and is invisible
 * otherwise (the finding-#14 lesson).
 */
export const DOCTOR_CONFERENCE_UNREADABLE_WARN = 1;

/**
 * The reader's OWN item bounds on the three deterministic report sections.
 *
 * They mirror the hub's caps (server/src/constants.ts) rather than trusting
 * them, for the reason fitSessions exists one module over: the hub's caps are
 * what holds when the hub is this version, and CONFERENCE_MAX_INPUT_CHARS is
 * what holds when it is modified, older, newer or hostile. Without them a hub
 * answering with five thousand questions turns "one page a human reads in a
 * minute" into 1,375,379 bytes and 10,615 lines, measured — and nothing in
 * the run notices or says so. The cut is always STATED on its own line, the
 * way the coverage line already states a capped context count.
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");const s=await import("./packages/server/src/constants.ts");console.log(c.CONFERENCE_MAX_QUESTIONS_SHOWN===s.CONFERENCE_MAX_QUESTIONS, c.CONFERENCE_MAX_CONTRADICTIONS_SHOWN===s.CONFERENCE_MAX_CONTRADICTIONS, c.CONFERENCE_MAX_OVERLAP_PAIRS_SHOWN===s.CONFERENCE_MAX_OVERLAP_PAIRS, c.CONFERENCE_ACTIVE_WINDOW_DAYS===s.CONFERENCE_ACTIVE_WINDOW_DAYS)'
 * PRINTS: true true true true
 */
export const CONFERENCE_MAX_QUESTIONS_SHOWN = 10;
export const CONFERENCE_MAX_CONTRADICTIONS_SHOWN = 5;
export const CONFERENCE_MAX_OVERLAP_PAIRS_SHOWN = 5;

/**
 * The activity window this connector ASSUMES when a hub will not state its
 * own. The wire field falls back to this rather than to zero: the coverage
 * line prints it directly, and "active in the last 0 days" is a sentence that
 * asserts a window nobody could have been active in — on the one line whose
 * whole job is telling the reader what was NOT read.
 */
export const CONFERENCE_ACTIVE_WINDOW_DAYS = 14;
