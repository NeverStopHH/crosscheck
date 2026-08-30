<!--
  Offline stand-in for https://cursor.com/docs/hooks, recorded 2026-08-18
  (design research pass), re-read 2026-08-19 (Block 6 build) and re-read
  again 2026-08-28 (the derive rungs — beforeSubmitPrompt, transcript_path
  and the cloud-agent table below all come from that read) — NOT a
  verbatim copy. It reproduces only the section structure and the field names
  this connector consumes, which is the surface payloads.ts encodes and
  test/contract.test.ts pins the fixtures against.

  Do not add fields here to "fix" a contract failure — re-read the live docs,
  update payloads.ts and this excerpt together, and review the diff. Where
  the live contract and this excerpt disagree, the LIVE page wins and the
  divergence is a contract drift worth a commit of its own.
-->

## Configuration

`hooks.json` — project level at `<project-root>/.cursor/hooks.json` (runs from
the project root, checked into version control, trusted workspaces only; Cursor
watches the file and hot-reloads on save). Shape:

```json
{ "version": 1, "hooks": { "<event>": [{ "command": "…" }] } }
```

Per-script options: `command` (required), `timeout` (number, SECONDS),
`failClosed` (boolean, default false — true makes hook failures block),
`matcher`, `loop_limit`. Command hooks receive JSON on stdin, answer JSON on
stdout. Exit 0 = use the JSON output; exit 2 = block the action; other exit
codes = hook failed, action proceeds (fail-open by default).

## Common input (all agent hooks)

`conversation_id` (stable across turns), `generation_id` (changes per user
message), `model`, `model_id`, `model_params`, `hook_event_name`,
`cursor_version` (e.g. "1.7.2"), `workspace_roots` (string[]), `user_email`
(string | null), `transcript_path` (string | null — "Path to the main
conversation transcript file (null if transcripts disabled)").

Environment: `CURSOR_PROJECT_DIR` (workspace root, always present),
`CURSOR_VERSION`, `CURSOR_USER_EMAIL`, `CURSOR_TRANSCRIPT_PATH` ("If
transcripts enabled"), `CURSOR_CODE_REMOTE`, `CLAUDE_PROJECT_DIR`.

The transcript FILE FORMAT is documented nowhere on this page: there is no
schema, no example and no extension for the main transcript. The connector's
reader (src/derive/transcript.ts) is shape-tolerant for that reason and
reports which shape it found.

## Cloud agents (recorded 2026-08-28)

Hooks that run in cloud agents include `beforeSubmitPrompt`, `postToolUse`,
`postToolUseFailure`, `afterFileEdit`, `beforeShellExecution` /
`afterShellExecution` and `stop`. `sessionStart` and `sessionEnd` do NOT:
"Deferred while cloud agents can still start in a read-only environment" and
"Cloud agents have no editor-lifetime session boundary" respectively.

WHICH CONFIGURATION A CLOUD AGENT READS — a separate rule from the table
above, and the one that decides whether ANY of those hooks load. Verbatim
(re-fetched 2026-08-30, HTTP 200, 64,429 bytes):

> **Project hooks** (`.cursor/hooks.json` in your repo): Loaded and run
> during cloud agent work.

> User-level hooks (`~/.cursor/hooks.json`) are not available in cloud
> agents. Cloud agent VMs don't have access to your local home directory
> configuration.

This matters because crosscheck ships BOTH installs (`crosscheck init
--cursor` writes the repo file, `crosscheck init --global --cursor` writes
the user one), so the cloud-agent refusal sentence has to say which install
it is talking about.

## Events this connector registers

### sessionStart

Fire-and-forget on new composer conversation. Input: `session_id` (same as
conversation_id), `is_background_agent`, `composer_mode`. Output: `env`,
`additional_context` (injected into initial context). Not available in cloud
agents (deferred upstream).

### beforeSubmitPrompt

"Called right after user hits send but before backend request. Can prevent
submission." Input: `prompt` ("<user prompt text>"), `attachments`
([{`type`: "file" | "rule", `file_path`}]). Output: `continue`
(boolean — whether to allow the submission), `user_message` (string,
optional — shown to the user when blocked). Matcher: matched against the
value `UserPromptSubmit`.

THERE IS NO CONTEXT-INJECTION OUTPUT on this event: `additional_context` is
not among its output fields, and the only power the output has is to block.
This connector registers it CAPTURE-ONLY and answers `{}` on every path.

### afterFileEdit

Input: `file_path` (absolute), `edits` [{`old_string`, `new_string`}]. No
output fields.

### afterShellExecution

Input: `command`, `output` (full terminal output), `duration` (ms),
`sandbox`. No exit code of any spelling is documented. No output fields.

### postToolUse

After SUCCESSFUL tool execution. Input: `tool_name`, `tool_input`,
`tool_output` (JSON-stringified result payload, e.g.
`"{\"exitCode\":0,\"stdout\":\"All tests passed\"}"`), `tool_use_id`, `cwd`,
`duration`. Output: `updated_mcp_tool_output` (MCP only),
`additional_context` (injected after the tool result).

### postToolUseFailure

When a tool fails, times out, or is denied. Input: `tool_name`, `tool_input`,
`tool_use_id`, `cwd`, `error_message`, `failure_type`
("error" | "timeout" | "permission_denied"), `duration`, `is_interrupt`.
No output fields.

### stop

When the agent loop ends. Input: `status` ("completed" | "aborted" |
"error"), `loop_count`. Output: `followup_message` (auto-submits as next user
message — this connector NEVER emits it).

### sessionEnd

Fire-and-forget when a composer conversation ends; response logged, not used.
Input: `session_id`, `reason` ("completed" | "aborted" | "error" |
"window_close" | "user_close"), `duration_ms`, `is_background_agent`,
`final_status`, `error_message` (optional). Not available in cloud agents.

## Events deliberately NOT registered (design §3.2)

`beforeReadFile` (payload carries full file content), `beforeTabFileRead` /
`afterTabFileEdit` (Tab is not agent work), `subagentStart` / `subagentStop`
(v1.5 candidate), `preCompact`, `beforeShellExecution` / `beforeMCPExecution`
(permission surface — we never block), `afterMCPExecution`,
`afterAgentResponse` / `afterAgentThought` (response content),
`workspaceOpen` (app lifecycle, no conversation).
