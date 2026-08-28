/**
 * Recorded shapes of the Cursor hooks contract we depend on but do not own
 * (the connector-claude `hook-contract` pattern, new host).
 *
 * Source: https://cursor.com/docs/hooks — fetched 2026-08-18 (the design's
 * research pass, DESIGN-agent-agnostic.md §7), re-read 2026-08-19 while
 * building Block 6. Each payload below is the documented JSON example for its
 * event, spread over the documented "Input (all hooks)" common schema, with
 * absolute paths and ids replaced by synthetic ones. Where a payload is NOT
 * the published example, it says so where it is defined:
 *
 *   AFTER_SHELL_EXECUTION_WITH_EXIT   the documented example carries NO exit
 *                                     field at all — this variant records the
 *                                     TOLERATED shape (a numeric exit_code)
 *                                     the handler accepts if a real build
 *                                     sends one; §6 open question 5's manual
 *                                     dogfood must answer whether it ever does
 *   POST_TOOL_USE_FAILING_COMMAND     the documented example's tool_output
 *                                     encoding (a JSON-stringified result with
 *                                     exitCode/stdout) with a non-zero
 *                                     exitCode and stderr — the documented
 *                                     encoding, a failing value
 *
 * They exist so that WE breaking the contract — a parser tightened, a field
 * dropped — fails on the pull request that does it, and so that Cursor
 * renaming a field turns into a NAMED contract-drift count (src/drift.ts)
 * instead of capture silently dying (§10 risk 5). Fields we deliberately
 * ignore (user_email, transcript_path, model, edits' content) are kept as
 * recorded: tolerating unknown fields is part of the contract we rely on,
 * and a fixture trimmed to what we read could not prove it.
 */

/**
 * The documented base every agent hook receives ("Input (all hooks)" —
 * conversation_id, generation_id, model, model_id, model_params,
 * hook_event_name, cursor_version, workspace_roots, user_email,
 * transcript_path). Recorded 2026-08-19.
 */
export const COMMON_INPUT = {
  conversation_id: "conv-1234abcd",
  generation_id: "gen-5678efgh",
  model: "claude-opus-4-7-thinking-max",
  model_id: "claude-opus-4-7",
  model_params: [{ id: "thinking", value: "true" }],
  cursor_version: "1.7.2",
  workspace_roots: ["/home/dev/acme/api"],
  user_email: "dev@example.com",
  transcript_path: "/home/dev/.cursor/transcripts/conv-1234abcd.jsonl",
} as const;

/**
 * Source: cursor.com/docs/hooks — "sessionStart". Input documented as
 * {session_id, is_background_agent, composer_mode}; session_id "same as
 * conversation_id". Recorded 2026-08-19.
 */
export const SESSION_START_INPUT = {
  ...COMMON_INPUT,
  hook_event_name: "sessionStart",
  session_id: "conv-1234abcd",
  is_background_agent: false,
  composer_mode: "agent",
} as const;

/** Same event, the background-agent variant (design §3.2's cursor-background). */
export const SESSION_START_INPUT_BACKGROUND = {
  ...SESSION_START_INPUT,
  is_background_agent: true,
} as const;

/**
 * Source: cursor.com/docs/hooks — "beforeSubmitPrompt": "Called right after
 * user hits send but before backend request. Can prevent submission."
 * Input `{prompt, attachments}`, output `{continue, user_message}`.
 * Recorded 2026-08-28 (the re-read that opened this event for the
 * derived-intent rung).
 *
 * `attachments` is recorded and NEVER parsed — the connector's schema has no
 * entry for it and the privacy suite keeps the name on its banned list. It is
 * here for the same reason `user_email` is: tolerating unknown fields is part
 * of the contract, and a fixture trimmed to what we read could not prove it.
 */
export const BEFORE_SUBMIT_PROMPT_INPUT = {
  ...COMMON_INPUT,
  hook_event_name: "beforeSubmitPrompt",
  prompt: "Fix the rate limiter so the refresh endpoint stops 500ing",
  attachments: [
    { type: "file", file_path: "/home/dev/acme/api/src/rate-limit.ts" },
  ],
} as const;

/**
 * The same event with an EMPTY prompt — a submit carrying only attachments.
 * NOT a published example: it is the shape that decides why `prompt` is a
 * presence-only drift field rather than a mapped one (src/payload.ts). An
 * empty prompt is ordinary use and must not be counted as contract drift; a
 * MISSING `prompt` key is a rename and must be.
 */
export const BEFORE_SUBMIT_PROMPT_EMPTY = {
  ...BEFORE_SUBMIT_PROMPT_INPUT,
  prompt: "",
} as const;

/**
 * Source: cursor.com/docs/hooks — "afterFileEdit": {file_path, edits:
 * [{old_string, new_string}]}. The edit strings are file CONTENT and are
 * never parsed past tolerance, never uploaded (Tier-0: paths only) — the
 * privacy suite plants sentinels here and asserts they reach no disk
 * artifact. Recorded 2026-08-19.
 */
export const AFTER_FILE_EDIT_INPUT = {
  ...COMMON_INPUT,
  hook_event_name: "afterFileEdit",
  file_path: "/home/dev/acme/api/src/rate-limit.ts",
  edits: [
    {
      old_string: "const limit = 100;",
      new_string: "const limit = 250;",
    },
  ],
} as const;

/**
 * Source: cursor.com/docs/hooks — "afterShellExecution": {command, output,
 * duration, sandbox}. NOTE THE ABSENCE: the documented input carries no exit
 * code of any spelling, so on the documented contract alone this event can
 * never prove a failure — the conservative rule ("no such field means not a
 * failure") makes it capture nothing, and postToolUseFailure is the reliable
 * failure signal. Recorded 2026-08-19.
 */
export const AFTER_SHELL_EXECUTION_INPUT = {
  ...COMMON_INPUT,
  hook_event_name: "afterShellExecution",
  command: "bun test",
  output: "error: expected 200, got 429 at src/rate-limit.test.ts:41",
  duration: 1234,
  sandbox: false,
} as const;

/**
 * NOT the published example (none exists with an exit field): the TOLERATED
 * shape — a numeric `exit_code` beside the documented fields — that the
 * handler treats as an explicit failure marker if a real Cursor build sends
 * one. §6 open question 5's manual dogfood on a real install must answer
 * whether it ever does; until then this fixture documents the tolerance,
 * not the contract. Recorded 2026-08-19.
 */
export const AFTER_SHELL_EXECUTION_WITH_EXIT = {
  ...AFTER_SHELL_EXECUTION_INPUT,
  exit_code: 1,
} as const;

/**
 * Source: cursor.com/docs/hooks — "postToolUse": tool_output is documented as
 * a JSON-STRINGIFIED result payload ("not raw terminal text"), example
 * '{"exitCode":0,"stdout":"All tests passed"}'. Recorded 2026-08-19.
 */
export const POST_TOOL_USE_INPUT = {
  ...COMMON_INPUT,
  hook_event_name: "postToolUse",
  tool_name: "Shell",
  tool_input: { command: "npm test" },
  tool_output: '{"exitCode":0,"stdout":"All tests passed"}',
  tool_use_id: "abc123",
  cwd: "/home/dev/acme/api",
  duration: 5432,
} as const;

/**
 * The documented tool_output ENCODING with a failing value: exitCode non-zero
 * plus stderr. postToolUse is documented as firing on successful TOOL
 * execution — a shell tool that ran a command which itself failed lands here,
 * and the embedded exitCode is the explicit failure marker the fingerprint
 * path requires. Whether failed commands land here or only in
 * postToolUseFailure is §6 open question 4 — the dogfood checklist names it.
 * Recorded 2026-08-19.
 */
export const POST_TOOL_USE_FAILING_COMMAND = {
  ...POST_TOOL_USE_INPUT,
  tool_output:
    '{"exitCode":1,"stdout":"","stderr":"error: expected 200, got 429 at src/rate-limit.test.ts:41"}',
} as const;

/**
 * Source: cursor.com/docs/hooks — "postToolUseFailure": {tool_name,
 * tool_input, tool_use_id, cwd, error_message, failure_type
 * ("timeout"|"error"|"permission_denied"), duration, is_interrupt}.
 * Recorded 2026-08-19.
 */
export const POST_TOOL_USE_FAILURE_INPUT = {
  ...COMMON_INPUT,
  hook_event_name: "postToolUseFailure",
  tool_name: "Shell",
  tool_input: { command: "bun test" },
  tool_use_id: "abc123",
  cwd: "/home/dev/acme/api",
  error_message: "error: expected 200, got 429 at src/rate-limit.test.ts:41",
  failure_type: "error",
  duration: 5000,
  is_interrupt: false,
} as const;

/**
 * Same event, a user interrupt — not a build failure, captures nothing.
 * NOT a published example (ours): the error_message DELIBERATELY carries
 * fingerprintable signal — a user interrupting a hanging command gets its
 * real stderr tail in error_message — because a no-signal text here would
 * fingerprint to null with or without the `is_interrupt` guard, making the
 * guard untestable (handlers.test.ts pins the signal stays non-null;
 * mutation-check re-proves the guard is load-bearing).
 */
export const POST_TOOL_USE_FAILURE_INTERRUPT = {
  ...POST_TOOL_USE_FAILURE_INPUT,
  error_message:
    "error: connect ETIMEDOUT 10.0.0.7:5432 while waiting for the database container to accept connections",
  failure_type: "error",
  is_interrupt: true,
} as const;

/**
 * Same event, a permission denial — a policy outcome, not a build failure.
 * Signal-carrying for the same reason as the interrupt variant above: the
 * `failure_type` guard must be provable, so the text must be one that WOULD
 * fingerprint if the guard were dropped.
 */
export const POST_TOOL_USE_FAILURE_DENIED = {
  ...POST_TOOL_USE_FAILURE_INPUT,
  error_message:
    "error: EACCES: permission denied, open /var/log/app/deploy.log — the agent hook denied the write",
  failure_type: "permission_denied",
} as const;

/**
 * Source: cursor.com/docs/hooks — "stop": {status:
 * "completed"|"aborted"|"error", loop_count}. Output MAY carry
 * followup_message — this connector never emits it (§3.2: auto-continuing
 * the user's session is not ours to do). Recorded 2026-08-19.
 */
export const STOP_INPUT = {
  ...COMMON_INPUT,
  hook_event_name: "stop",
  status: "completed",
  loop_count: 0,
} as const;

/**
 * Source: cursor.com/docs/hooks — "sessionEnd": {session_id, reason,
 * duration_ms, is_background_agent, final_status, error_message?}; documented
 * fire-and-forget, response logged but not used. Recorded 2026-08-19.
 */
export const SESSION_END_INPUT = {
  ...COMMON_INPUT,
  hook_event_name: "sessionEnd",
  session_id: "conv-1234abcd",
  reason: "completed",
  duration_ms: 45000,
  is_background_agent: false,
  final_status: "completed",
} as const;

/**
 * Source: cursor.com/docs/hooks — "Configuration file" + "Per-Script
 * Configuration Options": hooks.json is {version: 1, hooks: {<event>:
 * [{command, timeout?, failClosed?, matcher?, loop_limit?}]}} at
 * `<project-root>/.cursor/hooks.json` for project hooks; `timeout` is in
 * SECONDS; `failClosed` defaults false. Recorded 2026-08-19 — the init
 * merge tests pin against this shape.
 */
export const HOOKS_JSON_EXAMPLE = {
  version: 1,
  hooks: {
    sessionStart: [{ command: "./hooks/session-init.sh" }],
    beforeShellExecution: [
      {
        command: "./scripts/approve-network.sh",
        timeout: 30,
        matcher: "curl|wget|nc",
      },
    ],
  },
} as const;
