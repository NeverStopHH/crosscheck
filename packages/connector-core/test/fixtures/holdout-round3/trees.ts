/**
 * THE ROUND-3 HOLD-OUT'S TREES, NOW TRAINING DATA (hold-out review round 3,
 * decision 12). Copied verbatim from the reviewer's review-hints3/
 * holdout-trees.ts; only this paragraph is new. The reviewer's own header
 * follows, unchanged. SYNTHETIC TEXT ONLY.
 *
 * FRESH HOLD-OUT (review-hints3), written 2026-10-06T15:28Z BEFORE reading
 * review-hints2/, holdout-corpus.ts or prompt-corpus-gate.test.ts rows.
 * 35 teammate trees on repo github.com/acme/platform. Reader is "Nick".
 * Deliberate META collisions: rate limits, sessions, tokens, usage, quota,
 * context, restart, reset; operation collisions: commit, push, review, test,
 * build, main. Some drafts (derived), refuted claims, a retraction, a
 * self-cite, an intent-only context, and one tree of the reader's own.
 */

export interface HTarget { readonly kind: "file" | "symbol" | "component" | "error_fingerprint"; readonly value: string }
export interface HClaim {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly provenance: "declared" | "derived";
  readonly body: string;
  readonly evidenceRefs?: readonly string[];
  /** Claim this one supersedes (same author). */
  readonly supersedes?: string;
}
export interface HTree {
  readonly id: string;
  readonly developer: string;
  readonly title: string;
  readonly description?: string;
  readonly intent?: string;
  readonly targets?: readonly HTarget[];
  readonly claims: readonly HClaim[];
}

const d = (id: string, kind: string, status: string, body: string, evidenceRefs: readonly string[] = []): HClaim => ({
  id, kind, status, provenance: "declared", body, evidenceRefs,
});
const draft = (id: string, kind: string, body: string): HClaim => ({ id, kind, status: "proposed", provenance: "derived", body });

export const READER = "Nick";
export const DEVELOPERS = ["Nick", "Ken", "Can", "Mike", "Tobi", "Lena", "Sara"] as const;

export const TREES: readonly HTree[] = [
  { id: "wc_sb_rate", developer: "Ken", title: "StatsBomb API rate limit 429 on bulk extraction",
    description: "Bulk extraction of La Liga matches stops with HTTP 429 from the StatsBomb API",
    intent: "Make bulk StatsBomb extraction respect the API rate limit",
    targets: [{ kind: "file", value: "packages/extraction-worker/src/statsbomb/client.ts" }, { kind: "symbol", value: "retryWithBackoff" }],
    claims: [
      d("c_sb_obs", "observation", "proposed", "The StatsBomb API returns HTTP 429 after about 60 requests per minute during bulk extraction."),
      d("c_sb_rc", "root_cause", "likely_root_cause", "The extraction worker ignores the Retry-After header and retries immediately, which exhausts the rate limit window.", ["c_sb_obs"]),
    ] },
  { id: "wc_session_timeout", developer: "Can", title: "Session timeout logs users out after 15 minutes",
    description: "Workbench users are logged out mid-edit",
    targets: [{ kind: "file", value: "packages/api/src/auth/session.ts" }],
    claims: [
      d("c_st_obs", "observation", "proposed", "Users are logged out after 15 minutes even while they are actively editing in the workbench."),
      d("c_st_hyp", "hypothesis", "proposed", "The session cookie maxAge is never refreshed on API activity."),
    ] },
  { id: "wc_jwt_refresh", developer: "Mike", title: "JWT token refresh fails after signing key rotation",
    targets: [{ kind: "file", value: "packages/api/src/auth/jwks.ts" }, { kind: "symbol", value: "refreshAccessToken" }],
    claims: [
      d("c_jwt_obs", "observation", "proposed", "Every access token refresh fails with invalid signature for ten minutes after a key rotation."),
      d("c_jwt_rc", "root_cause", "proposed", "The JWKS cache drops the previous signing key immediately on rotation.", ["c_jwt_obs"]),
      d("c_jwt_dec", "decision", "proposed", "Keep the previous signing key in the JWKS for 24 hours after every rotation.", ["c_jwt_obs"]),
    ] },
  { id: "wc_usage_dashboard", developer: "Tobi", title: "Usage dashboard shows wrong monthly totals",
    claims: [
      d("c_ud_obs", "observation", "proposed", "The usage dashboard sums tracked minutes across all organizations instead of the selected organization."),
      d("c_ud_rc", "root_cause", "likely_root_cause", "The monthly totals query has no organization filter, so the dashboard aggregates every tenant.", ["c_ud_obs"]),
    ] },
  { id: "wc_ci_timeout", developer: "Lena", title: "CI flaky functional tests time out at 5 seconds",
    targets: [{ kind: "file", value: ".github/workflows/ci.yml" }],
    claims: [
      d("c_ci_obs", "observation", "proposed", "The functional suite fails with a five second timeout on cold PGlite starts in CI runners."),
      d("c_ci_dec", "decision", "proposed", "Raise the functional test timeout to 20 seconds in CI only, keeping 5 seconds locally.", ["c_ci_obs"]),
    ] },
  { id: "wc_limit_banner", developer: "Sara", title: "Usage limit banner shows wrong remaining quota",
    description: "The in-app banner tells customers they have quota left when they do not",
    claims: [
      draft("c_lb_draft", "observation", "The banner reads the weekly quota from a stale cache entry."),
      d("c_lb_hyp", "hypothesis", "proposed", "The banner computes remaining quota from the plan limit instead of the remaining balance."),
    ] },
  { id: "wc_context_overflow", developer: "Ken", title: "Context window overflow in agent deferred composition",
    claims: [
      d("c_co_obs", "observation", "proposed", "Deferred composition prompts exceed 200k context tokens on leagues with more than 400 players."),
      d("c_co_rc", "root_cause", "partially_confirmed", "Deferred composition inlines every player row into the prompt instead of the aggregated columns.", ["c_co_obs"]),
    ] },
  { id: "wc_retry_storm", developer: "Can", title: "Retry storm in import worker after restart",
    claims: [
      d("c_rs_obs", "observation", "proposed", "After a restart the import worker retries every failed job at once and saturates the database connection pool."),
      d("c_rs_rc", "root_cause", "likely_root_cause", "The import worker requeues failed jobs without jitter, so every retry after a restart lands at the same instant.", ["c_rs_rc"]),
    ] },
  { id: "wc_cube_future", developer: "Mike", title: "Cube pipeline crash on scheduled future games with no events",
    claims: [
      d("c_cf_obs", "observation", "proposed", "The cube run fails when a scheduled match has no events and writes an empty Parquet file."),
      d("c_cf_rc", "root_cause", "likely_root_cause", "Matches that have not been played yet are passed into the match filter, and an empty event table kills the cube run.", ["c_cf_obs"]),
    ] },
  { id: "wc_video_upload", developer: "Tobi", title: "Practice video upload fails above gateway body limit",
    targets: [{ kind: "file", value: "packages/api/src/routes/video-upload.ts" }],
    claims: [
      d("c_vu_obs", "observation", "proposed", "Practice video uploads above 100 MB fail at the gateway with 413 request entity too large."),
      d("c_vu_dec", "decision", "proposed", "Upload practice videos directly to S3 with presigned multipart URLs instead of through the API gateway.", ["c_vu_obs"]),
    ] },
  { id: "wc_leaderboard_load", developer: "Lena", title: "Leaderboard first load slow because of rollup storm",
    claims: [d("c_ll_obs", "observation", "proposed", "The first leaderboard load triggers one rollup query per metric node, about 300 queries.")] },
  { id: "wc_pass_options", developer: "Sara", title: "Pass options toggle not persisted between sessions",
    claims: [d("c_po_obs", "observation", "proposed", "The pass options toggle resets to off whenever the workbench is reopened.")] },
  { id: "wc_heatmap", developer: "Ken", title: "Heatmap homography misaligned on wide angle cameras",
    claims: [d("c_hm_obs", "observation", "proposed", "Heatmap points drift up to four meters near the corner flags on wide angle footage.")] },
  { id: "wc_prismic", developer: "Can", title: "Prismic website preview broken",
    claims: [d("c_pr_obs", "observation", "proposed", "The Prismic preview link returns 404 because the preview route is not deployed.")] },
  { id: "wc_import_oom", developer: "Mike", title: "Import worker OOM under backpressure",
    claims: [d("c_oom_obs", "observation", "proposed", "The import worker runs out of memory when the tracking queue grows beyond 50 matches.")] },
  { id: "wc_epl_id", developer: "Tobi", title: "EPL competition id missing in staging env",
    claims: [d("c_epl_obs", "observation", "proposed", "Extract All for EPL returns HTTP 500 because DVMS_COMPETITION is not set on the staging API.")] },
  { id: "wc_glossary", developer: "Lena", title: "Metric glossary not wired into leaderboard UI",
    claims: [d("c_gl_obs", "observation", "proposed", "Leaderboard column headers show raw metric keys instead of glossary names.")] },
  { id: "wc_whatsapp", developer: "Sara", title: "WhatsApp bot status line duplicates",
    claims: [d("c_wa_obs", "observation", "proposed", "The WhatsApp bot posts its status line twice when a deferred answer arrives.")] },
  { id: "wc_redis", developer: "Ken", title: "Redis cache eviction drops scouting feed entries",
    claims: [d("c_rd_obs", "observation", "proposed", "Scouting feed entries disappear after deploys because redis evicts keys under the allkeys-lru policy.")] },
  { id: "wc_render_env", developer: "Can", title: "Render env change needs restart after terraform apply",
    claims: [d("c_re_obs", "observation", "proposed", "Terraform apply updates Render environment variables, but running services keep the old values until restart.")] },
  { id: "wc_rate_mw", developer: "Mike", title: "Rate limiting middleware for the public API",
    intent: "Add per-key rate limiting to the public API",
    claims: [
      d("c_rm_obs", "observation", "proposed", "Public API traffic spikes to 2000 requests per minute from a single key."),
      d("c_rm_dec", "decision", "proposed", "Use a token bucket per API key with 100 requests per minute.", ["c_rm_obs"]),
    ] },
  { id: "wc_token_usage", developer: "Tobi", title: "Token usage accounting for the agent bot",
    claims: [d("c_tu_obs", "observation", "proposed", "The agent bot counts prompt tokens twice when a deferred job is retried.")] },
  { id: "wc_session_resume", developer: "Lena", title: "Claude session resume after usage limit reset loses context",
    description: "Our harness wrapper: after the usage limit resets, resuming the session drops the earlier context",
    claims: [
      d("c_sr_obs", "observation", "proposed", "Resuming a session after the usage limit reset starts with an empty context window."),
      draft("c_sr_draft", "observation", "continue resume session limit reset context tokens back again now"),
    ] },
  { id: "wc_quota_cron", developer: "Sara", title: "Daily quota reset cron runs twice",
    claims: [d("c_qc_obs", "observation", "proposed", "The daily quota reset job fires at 00:00 UTC and again at 00:00 local time.")] },
  { id: "wc_weekly_report", developer: "Ken", title: "Weekly report email shows yesterday's numbers",
    claims: [d("c_wr_obs", "observation", "proposed", "The weekly report email is rendered from the snapshot taken before the nightly import finishes.")] },
  { id: "wc_commit_hook", developer: "Can", title: "Pre-commit hook blocks push on large files",
    claims: [d("c_ch_obs", "observation", "proposed", "The pre-commit hook rejects any commit with a file above 5 MB, including generated fixtures.")] },
  { id: "wc_review_checklist", developer: "Mike", title: "PR review checklist for merges is outdated",
    claims: [d("c_rc_obs", "observation", "proposed", "The review checklist still asks for a changelog entry that the release script now writes.")] },
  { id: "wc_test_runner", developer: "Tobi", title: "Test runner reruns failed tests forever",
    claims: [d("c_tr_obs", "observation", "proposed", "The test runner retries failed tests without a cap when the flaky flag is set.")] },
  { id: "wc_build_cache", developer: "Lena", title: "Build cache invalidated on every push to main",
    claims: [d("c_bc_obs", "observation", "proposed", "Every push to main invalidates the build cache because the lockfile hash includes timestamps.")] },
  { id: "wc_pglite_pool", developer: "Sara", title: "PGlite timeouts in functional tests",
    claims: [d("c_pp_rej", "rejected_approach", "rejected", "Increasing the PGlite pool size did not fix the functional test timeouts.", [])] },
  { id: "wc_draft_only", developer: "Ken", title: "Scratch notes",
    claims: [
      draft("c_do_1", "observation", "Usage limit reset, continue the session after the limit was reset and resume the context."),
      draft("c_do_2", "root_cause", "The session limit reset loses the context tokens window."),
    ] },
  { id: "wc_refuted", developer: "Can", title: "Investigation notes",
    claims: [d("c_rf_hyp", "hypothesis", "rejected", "The session limit reset bug is caused by the token context window.")] },
  { id: "wc_retracted", developer: "Mike", title: "Old observations",
    claims: [
      d("c_rt_old", "observation", "proposed", "Session tokens expire after the limit window resets."),
      { ...d("c_rt_new", "observation", "proposed", "Corrected: session tokens do not expire, the limit window was unrelated."), supersedes: "c_rt_old" },
    ] },
  { id: "wc_own", developer: "Nick", title: "Session limit reset and continue logic",
    claims: [d("c_own_obs", "observation", "proposed", "The session limit reset continue logic resumes the context after a usage reset.")] },
  { id: "wc_intent_only", developer: "Sara", title: "Agent continue behaviour",
    intent: "Make the agent continue after a usage limit reset without losing the session context",
    claims: [] },
];
