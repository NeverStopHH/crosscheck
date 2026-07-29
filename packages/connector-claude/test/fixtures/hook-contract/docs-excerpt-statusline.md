<!--
  Offline stand-in for https://code.claude.com/docs/en/statusline.md,
  reconstructed 2026-07-27 — NOT a verbatim copy. The statusline reads exactly
  two fields off stdin, so the whole page is the search space and this excerpt
  only has to carry those two the way the reference does.
-->

# Status line

## Available data

| Field                          | Description               |
| :----------------------------- | :------------------------ |
| `cwd`, `workspace.current_dir` | Current working directory |
| `session_id`                   | Unique session identifier |

Your status line command receives this JSON structure via stdin:

```json
{
  "cwd": "/home/dev/acme/api",
  "session_id": "abc123",
  "workspace": {
    "current_dir": "/home/dev/acme/api",
    "project_dir": "/home/dev/acme/api"
  }
}
```