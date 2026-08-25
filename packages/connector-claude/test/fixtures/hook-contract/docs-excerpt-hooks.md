<!--
  Offline stand-in for https://code.claude.com/docs/en/hooks.md, reconstructed
  2026-07-27 — NOT a verbatim copy. It reproduces only the section structure and
  the field names this connector consumes, which is precisely the surface
  scripts/hook-contract-watch.ts extracts.

  It exists so the extractor and the differ can be tested without a network:
  extracting from this file must produce exactly docs-snapshot.json. That the
  snapshot also matches the LIVE reference is what the weekly workflow verifies.

  Anything below can be edited by a test to simulate drift. Do not add fields
  here to "fix" a drift failure — re-record the snapshot from the live docs with
  `--write` instead, and review the diff.
-->

## Hook input and output

### Common input fields

| Field             | Description                                    |
| :---------------- | :--------------------------------------------- |
| `session_id`      | Current session identifier                     |
| `transcript_path` | Path to conversation JSON                      |
| `cwd`             | Current working directory                      |
| `permission_mode` | Current permission mode                        |
| `hook_event_name` | Name of the event that fired                   |

### Exit code output

Exit 0 means success.

## Hook events

### SessionStart

Runs when Claude Code starts a new session or resumes an existing session.

#### SessionStart input

| Field           | Description                              |
| :-------------- | :--------------------------------------- |
| `source`        | How the session started                  |
| `model`         | The active model identifier              |
| `session_title` | The current session title, if one is set |

```json
{
  "session_id": "abc123",
  "cwd": "/home/dev/acme/api",
  "hook_event_name": "SessionStart",
  "source": "startup"
}
```

#### SessionStart decision control

| Field               | Description                      |
| :------------------ | :------------------------------- |
| `additionalContext` | String added to Claude's context |
| `sessionTitle`      | Sets the session title           |

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "Current branch: feat/auth-refactor"
  }
}
```

### PreToolUse

Runs after Claude creates tool parameters and before processing the tool call.

#### PreToolUse decision control

| Field                      | Description                                                        |
| :------------------------- | :----------------------------------------------------------------- |
| `permissionDecision`       | `"allow"`, `"deny"`, `"ask"` or `"defer"`                           |
| `permissionDecisionReason` | For `"allow"` and `"ask"`, shown to the user but not Claude         |
| `additionalContext`        | String added to Claude's context alongside the tool result         |

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "permissionDecisionReason": "My reason here",
    "additionalContext": "Current environment: production."
  }
}
```

### PostToolUse

Runs immediately after a tool completes successfully.

#### PostToolUse input

```json
{
  "session_id": "abc123",
  "cwd": "/home/dev/acme/api",
  "hook_event_name": "PostToolUse",
  "tool_name": "Write",
  "tool_input": {
    "file_path": "/home/dev/acme/api/src/rate-limit.ts",
    "content": "file content"
  },
  "tool_response": {
    "filePath": "/home/dev/acme/api/src/rate-limit.ts",
    "success": true
  }
}
```

### SessionEnd

Runs when a Claude Code session ends.

#### SessionEnd input

| Field    | Description           |
| :------- | :-------------------- |
| `reason` | Why the session ended |

```json
{
  "session_id": "abc123",
  "cwd": "/home/dev/acme/api",
  "hook_event_name": "SessionEnd",
  "reason": "other"
}
```
### PreToolUse

Runs before a tool call is executed.

#### PreToolUse input

```json
{
  "session_id": "abc123",
  "cwd": "/home/dev/acme/api",
  "hook_event_name": "PreToolUse",
  "tool_name": "Edit",
  "tool_input": {
    "file_path": "/home/dev/acme/api/src/rate-limit.ts"
  }
}
```

#### PreToolUse decision control

| Field                      | Description                                    |
| :------------------------- | :--------------------------------------------- |
| `permissionDecision`       | One of `allow`, `deny` or `ask`                 |
| `permissionDecisionReason` | Shown to the user when the decision is `ask`    |

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "permissionDecisionReason": "Robin is editing this file right now"
  }
}
```

### UserPromptSubmit

Runs when the user submits a prompt, before Claude processes it.

#### UserPromptSubmit input

| Field    | Description               |
| :------- | :------------------------ |
| `prompt` | The prompt the user typed |

```json
{
  "session_id": "abc123",
  "cwd": "/home/dev/acme/api",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "why does the rate limiter drop bursts"
}
```

#### UserPromptSubmit decision control

| Field               | Description                      |
| :------------------ | :------------------------------- |
| `additionalContext` | String added to Claude's context |

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "Robin diagnosed this last week"
  }
}
```

### Stop

Runs when the main Claude Code agent has finished responding.

#### Stop input

| Field              | Description                                            |
| :----------------- | :----------------------------------------------------- |
| `transcript_path`  | Path to the conversation JSON                           |
| `stop_hook_active` | True when Claude is already continuing from a stop hook |

```json
{
  "session_id": "abc123",
  "cwd": "/home/dev/acme/api",
  "hook_event_name": "Stop",
  "transcript_path": "/home/dev/.claude/projects/acme-api/abc123.jsonl",
  "stop_hook_active": false
}
```
