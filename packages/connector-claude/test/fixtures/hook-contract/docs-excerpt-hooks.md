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

### PostToolUseFailure

Runs when a tool that started executing fails.

#### PostToolUseFailure input

| Field          | Description                                        |
| :------------- | :------------------------------------------------- |
| `error`        | String describing what went wrong                  |
| `is_interrupt` | True when the failure reached Claude Code as an abort |

```json
{
  "session_id": "abc123",
  "cwd": "/home/dev/acme/api",
  "hook_event_name": "PostToolUseFailure",
  "tool_name": "Bash",
  "tool_input": {
    "command": "bun test",
    "description": "Run test suite"
  },
  "error": "Exit code 1\nerror: expected 3 to be 4",
  "is_interrupt": false
}
```

#### PostToolUseFailure decision control

| Field               | Description                                  |
| :------------------ | :------------------------------------------- |
| `additionalContext` | String added to Claude's context alongside the error |

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUseFailure",
    "additionalContext": "Additional information about the failure for Claude"
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