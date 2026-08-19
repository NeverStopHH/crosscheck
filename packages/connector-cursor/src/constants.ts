/** Every Cursor-specific name and bound — no magic values elsewhere. */

/** Where Cursor's project-level config lives: `<repo>/.cursor/…`. */
export const CURSOR_DIR = ".cursor";
export const CURSOR_HOOKS_FILE = "hooks.json";
export const CURSOR_MCP_FILE = "mcp.json";

/** The one documented hooks.json schema version (cursor.com/docs/hooks). */
export const CURSOR_HOOKS_VERSION = 1;

/**
 * Per-hook `timeout` in the hooks.json entries init writes — SECONDS, per the
 * documented per-script options. Far above the connector's own internal
 * budget (POST_TOOL_USE_BUDGET_RATIO × the request timeout ≈ 1.6 s at
 * defaults), so Cursor never kills a healthy hook mid-flush — and bounded, so
 * a wedged runtime dies instead of accumulating.
 */
export const CURSOR_HOOK_TIMEOUT_SECONDS = 10;

/**
 * What every Block-6 handler answers on stdout: valid JSON carrying no
 * directives — no `permission`, no `followup_message`, no `continue`. Exit 0
 * with parseable output keeps the connector out of Cursor's hook-failure
 * logs; the injection fields arrive in Block 7.
 */
export const CURSOR_NO_OP_OUTPUT = "{}";

/**
 * Hooks exist since Cursor 1.7 (design §3.1) — doctor warns below this when
 * a sessionStart has reported a `cursor_version`.
 */
export const MIN_CURSOR_HOOKS_MAJOR = 1;
export const MIN_CURSOR_HOOKS_MINOR = 7;

/**
 * Size cap on the contract-drift ledger (state/cursor-drift.jsonl): one
 * append-only line per drifted payload. 64 KiB holds ~500 entries — far more
 * than anyone needs to see the pattern; past it the detail stops and doctor
 * reports the count as a floor.
 */
export const MAX_DRIFT_LEDGER_BYTES = 65_536;

/** The ledger file, under the home's state/ dir beside the sync states. */
export const DRIFT_LEDGER_FILE = "cursor-drift.jsonl";
