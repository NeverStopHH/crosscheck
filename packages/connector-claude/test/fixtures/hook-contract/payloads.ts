/**
 * Recorded shapes of the hook contract we depend on but do not own.
 *
 * MOST payloads below are the JSON example published in Claude Code's own
 * reference, with absolute paths replaced by synthetic ones. Three are not, and
 * each says so where it is defined. They are listed here as well, because the
 * header used to claim "every payload" while a payload underneath it said
 * otherwise:
 *
 *   SESSION_START_INPUT_WITH_TITLE  the published SessionStart example plus
 *                                   `session_title`, which the reference
 *                                   documents in a table but does not show in
 *                                   any JSON block
 *   POST_TOOL_USE_INPUT_FAILURE     `tool_response` is TOOL-SPECIFIC and is not
 *                                   part of the hooks reference at all; this
 *                                   shape is recorded from what the Bash tool
 *                                   returns, and it is the input to the error
 *                                   fingerprint
 *   STATUSLINE_INPUT                the published schema with the cost and
 *                                   context-window blocks removed, keeping the
 *                                   nesting
 *
 * Each carries where it came from and when it was recorded. They exist so that
 * WE breaking the contract — a parser tightened, a field dropped, an output key
 * renamed — fails on the pull request that does it. Whether CLAUDE CODE changed
 * the contract is a different question, watched weekly by
 * scripts/hook-contract-watch.ts.
 *
 * Deliberately kept as recorded, including fields we ignore (`transcript_path`,
 * `permission_mode`, `tool_use_id`, `duration_ms`, `model`): tolerating unknown
 * fields is itself part of the contract we rely on (HookPayloadSchema is a
 * `z.looseObject`), and a fixture trimmed to what we read could not prove it.
 */

/**
 * Source: https://code.claude.com/docs/en/hooks.md — "SessionStart input".
 * Recorded 2026-07-27.
 */
export const SESSION_START_INPUT = {
  session_id: "abc123",
  transcript_path: "/home/dev/.claude/projects/acme-api/session.jsonl",
  cwd: "/home/dev/acme/api",
  hook_event_name: "SessionStart",
  source: "startup",
  model: "claude-sonnet-5",
} as const;

/**
 * Same section, `session_title` variant: documented as "the current session
 * title if one is already set, for example via `--name` or `/rename`". It is
 * the only field of the briefing pipeline that Claude Code authors for us.
 * Recorded 2026-07-27.
 */
export const SESSION_START_INPUT_WITH_TITLE = {
  ...SESSION_START_INPUT,
  source: "resume",
  session_title: "Rate limiter drops burst traffic",
} as const;

/**
 * Source: https://code.claude.com/docs/en/hooks.md — "PostToolUse input".
 * Recorded 2026-07-27.
 */
export const POST_TOOL_USE_INPUT = {
  session_id: "abc123",
  transcript_path: "/home/dev/.claude/projects/acme-api/session.jsonl",
  cwd: "/home/dev/acme/api",
  permission_mode: "default",
  hook_event_name: "PostToolUse",
  tool_name: "Write",
  tool_input: {
    file_path: "/home/dev/acme/api/src/rate-limit.ts",
    content: "file content",
  },
  tool_response: {
    filePath: "/home/dev/acme/api/src/rate-limit.ts",
    success: true,
  },
  tool_use_id: "toolu_01ABC123",
  duration_ms: 12,
} as const;

/**
 * Same event for a Bash call that failed. The tool_response schema is
 * tool-specific and NOT part of the hooks reference, so this shape is recorded
 * from what the Bash tool returns; it is the input to the error fingerprint.
 * Recorded 2026-07-27.
 */
export const POST_TOOL_USE_INPUT_FAILURE = {
  session_id: "abc123",
  cwd: "/home/dev/acme/api",
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command: "bun test" },
  tool_response: {
    exit_code: 1,
    stdout: "",
    stderr: "error: expected 200, got 429 at src/rate-limit.test.ts:41",
  },
} as const;

/**
 * Source: https://code.claude.com/docs/en/hooks.md — "SessionEnd input".
 * Recorded 2026-07-27.
 */
export const SESSION_END_INPUT = {
  session_id: "abc123",
  transcript_path: "/home/dev/.claude/projects/acme-api/session.jsonl",
  cwd: "/home/dev/acme/api",
  hook_event_name: "SessionEnd",
  reason: "other",
} as const;

/**
 * Source: https://code.claude.com/docs/en/statusline.md — "Full JSON schema",
 * trimmed of the cost/context-window blocks we never read but keeping the
 * nesting, so a parser that started requiring flat input would fail here.
 * Recorded 2026-07-27.
 */
export const STATUSLINE_INPUT = {
  cwd: "/home/dev/acme/api",
  session_id: "abc123",
  session_name: "rate-limit",
  transcript_path: "/home/dev/.claude/projects/acme-api/session.jsonl",
  model: { id: "claude-opus-5", display_name: "Opus" },
  workspace: {
    current_dir: "/home/dev/acme/api",
    project_dir: "/home/dev/acme/api",
    added_dirs: [],
  },
  version: "2.1.90",
  output_style: { name: "default" },
  exceeds_200k_tokens: false,
} as const;

/**
 * Source: https://code.claude.com/docs/en/hooks.md — "SessionStart decision
 * control". This is the shape WE emit; `additionalContext` is the field that
 * carries the briefing into the reader's context. Recorded 2026-07-27.
 */
export const SESSION_START_OUTPUT = {
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: "Current branch: feat/auth-refactor",
  },
} as const;

/**
 * Source: https://code.claude.com/docs/en/hooks.md — "PreToolUse decision
 * control". This is the shape WE emit from the tripwire (hooks/pre-tool-use.ts)
 * and it was unwatched until M17: the contract watcher's event list named three
 * events where the installer registers six, so `permissionDecision`,
 * `permissionDecisionReason` and the literal `ask` were outside the watched
 * surface for as long as the tripwire has existed. A rename there would have
 * shown up only as tripwires that quietly stopped asking. Recorded 2026-08-25.
 */
export const PRE_TOOL_USE_OUTPUT = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason: "Robin is editing this file right now",
  },
} as const;
