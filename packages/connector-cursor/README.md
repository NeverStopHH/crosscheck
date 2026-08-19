# @crosscheck/connector-cursor

The Cursor IDE connector (design: `docs/adapters/DESIGN-agent-agnostic.md` §3): short-lived `crosscheck cursor-hook <event>` processes over Cursor's **documented** hooks API — the same spool, the same budgets, the same fail-open-everywhere as the Claude connector. Hooks + MCP, **not** rules files (§3.3 rejects rules as an injection channel: gitignore-interplay drift and a second sanitize surface).

**This package is Block 6: capture.** The injection surfaces — the `sessionStart` briefing and per-`postToolUse` hints via `additional_context` — arrive in **Block 7**. Until then every handler answers `{}`: valid JSON, no directives, exit 0. Nothing here renders untrusted text, which is why this package registers **no** §4.4 render surfaces (the registry meta-test verifies that claim on every build).

## What works today

| Cursor event | Tier-0 mapping (§3.2) |
|---|---|
| `sessionStart` | `registerSessionFlow` with `cur-<conversation_id>` (state **before** any append), `agent_kind` `cursor-ide` / `cursor-background`, honest `branch @ repo` title, `cursor_version` → sync-state for doctor, spool flush + reap on the spare budget |
| `afterFileEdit` | `file_path` → shared target flow (repo-relative, denylist, seen-set, secret-scan, cap); heartbeat (throttled), status → `implementing`; edit **content is never parsed** |
| `afterShellExecution` | failure fingerprint **only on an explicit exit marker** — see the honesty note below |
| `postToolUse` | heartbeat, spool flush; failure fingerprint from the documented JSON-stringified `tool_output` when it carries a non-zero `exitCode` |
| `postToolUseFailure` | `error_message` → shared extractor → `fingerprint()`; interrupts and `permission_denied` are **not** failures |
| `stop` | turn counter (future Tier-1 gate), spool flush; **never** `followup_message` |
| `sessionEnd` | shared `endSessionFlow` (flush → marker → state delete → `end` or deferred) |

Not registered, deliberately (§3.2): `beforeReadFile` (full file content), `beforeSubmitPrompt` (blocks, no injection output), Tab hooks, subagent hooks, `preCompact`, `afterAgentResponse`/`afterAgentThought`, `workspaceOpen`.

**Install**: `crosscheck init --cursor` — composes with the default Claude init; merges `.cursor/hooks.json` (non-destructive, explicit `timeout`, **never** `failClosed`) and `.cursor/mcp.json` (the shared `mergeMcpConfig` — same five diagnosis tools). Both files are repo-committed: install = the same one PR, teammates connect on `git pull` + `crosscheck login`. **Gitignore interplay** (the reason rules files were rejected, and it applies here too): if your repo gitignores `.cursor/`, un-ignore `hooks.json` and `mcp.json` — an ignored install silently works for exactly one person. Cursor hot-reloads both files in trusted workspaces; no restart.

**Doctor**: `crosscheck doctor` gains a cursor section — hooks registered (all seven, none `failClosed`), launcher resolves *and* executes, mcp entry owned, last-observed `cursor_version` ≥ 1.7, and the **contract-drift counters**.

**Contract honesty**: the payload schemas encode Cursor's *documented* hook API — the examples from [cursor.com/docs/hooks](https://cursor.com/docs/hooks) are checked in as fixtures with source + fetch date (`test/fixtures/cursor-contract/`, fetched 2026-08-18, re-read 2026-08-19). Where reality may differ, the code tolerates unknowns and **counts** what it cannot map: a payload missing a mapped field degrades silently (fail-open) and lands one line in `~/.crosscheck/state/cursor-drift.jsonl`, which doctor surfaces. Capture can degrade; it is never allowed to die silently.

## The afterShellExecution honesty note

The documented `afterShellExecution` input is `{command, output, duration, sandbox}` — **no exit code of any spelling**. Under the connector's conservative rule (an explicit failure marker must be present; "no such field" means "not a failure"), the documented shape can never prove a failure, so on paper this event captures nothing. The handler tolerates a numeric `exit_code`/`exitCode` as the marker if a real build sends one. The reliable documented failure signal is `postToolUseFailure` (`error_message`), plus a non-zero `exitCode` embedded in `postToolUse`'s `tool_output`.

## Manual dogfood — what only a real Cursor install can answer

Design §6 open questions 4 + 5 defer to verification on a real build. **The suites here pin the documented contract; they cannot pin Cursor's reality. Do not treat a green CI as that verification.** On a real Cursor (≥ 1.7) install, a human must run:

1. **Install**: `crosscheck login <hub>`, then `crosscheck init --cursor` in a hub-connected repo; open the repo in Cursor as a trusted workspace. Run `crosscheck doctor` — the cursor section must be all PASS.
2. **One session + one edit**: start an agent conversation, have it edit a file. Verify on the hub (`/ui` or `crosscheck status`): presence shows a `cursor-ide` session; the edited path appears as a target.
3. **One failing command**: have the agent run a failing build/test. Then check `crosscheck status`/the hub for an `error_fingerprint` target, and note **which event carried it** — this answers open question 4's neighbor: does the failure surface via `postToolUseFailure`, via `postToolUse` `tool_output`, or (if payloads carry an undocumented exit field) via `afterShellExecution`? Record the answer in the design doc.
4. **Feed + doctor**: `crosscheck doctor` again — `cursor version` must now show the observed build; `cursor contract drift` must be `none`. **Any drift WARN here means Cursor's real payloads differ from the documented contract** — that finding is the whole point of the tripwire; file it against the fixtures.
5. **Per-surface checklist (open question 5)**: repeat 2–3 once in the IDE and once with a background/cloud agent on the same repo, and tick off which of the seven events actually fired (the drift ledger plus hub records tell you). The docs claim near-full cloud support with `sessionStart`/`sessionEnd` deferred — verify, and update §3.2's table with reality.
6. **Injection readiness (for Block 7, open question 4 proper)**: while on the real build, confirm with a trivial echo hook whether `postToolUse.additional_context` reaches the model mid-turn or next turn, and whether `postToolUse` fires on failed tools. Block 7's hint-attachment decision depends on the answer.

## Not covered (v1, said out loud — §3.5)

No async push into a live session; no tripwire (Cursor's `preToolUse` "ask" is unenforced and hooks fail open — a soft gate must not impersonate a hard one); no statusline; Composer context is a black box; Tab/Inline edits invisible; Cursor **CLI** users get the ACP proxy instead (`crosscheck acp -- cursor-agent acp`); Tier-1 summarizer deferred; `state.vscdb` is never read.

## Privacy (Tier-0, pinned)

Paths and fingerprints travel; content never does. The `edits[]` old/new strings, terminal `output`, `tool_output` bodies, `error_message` detail, `user_email` and `transcript_path` are never stored, spooled, or logged — failure text leaves only as its `sha256:` fingerprint, computed by the same extractor + normalizer as every other connector (`test/parity.test.ts` closes the cursor == claude == acp triangle). Enforced twice: a sentinel sweep over every file the connector writes, and a structural pin that the source never names the content-field accessors.
