# Installing crosscheck per editor / agent

One bin covers every host: `crosscheck` (shipped by `packages/cli`, published
as `crosscheck-hub` — the bin name stays `crosscheck`). Three connectors sit
behind it:

| Host | Connector | Install mechanism |
|---|---|---|
| Claude Code | `connector-claude` | `crosscheck init --global` (once per machine: `~/.claude/settings.json` + user-scope mcp) or `crosscheck init` (repo-committed `.claude/settings.json` + `.mcp.json`) |
| Cursor IDE | `connector-cursor` | `crosscheck init --global --cursor` (`~/.cursor/hooks.json` + `~/.cursor/mcp.json`, local sessions) or `crosscheck init --cursor` (repo-committed `.cursor/hooks.json` + `.cursor/mcp.json`) |
| Any ACP client × any ACP agent (Zed, JetBrains, Neovim, Emacs × Gemini CLI, cursor-agent, Goose, …) | `connector-acp` | wrap the agent command: `crosscheck acp -- <agent cmd…>` (per-user editor config) |

## Per-connector parity — what each host actually supports

Capture is only worth what the *weakest* host does, so this table is the
promise, per connector, and it is kept honest by tests rather than by intent:
`packages/connector-{claude,cursor,acp}/test/worktree-capture.test.ts` pin rows
1-4 per host in that host's session state, and
`packages/cli/test/connector-capture-health.test.ts` pins how row 4 READS on
`crosscheck status` / `doctor` for both non-Claude hosts, in a PASS **and** in a
WARN state (row 5 is a limitation, not a behaviour: it is pinned on Claude by
`connector-claude/test/tripwire-hook.test.ts` and documented, with its vendor
source, in the two module headers named below). And
`packages/connector-core/src/capture/touched-root.ts` carries a `verify-claims`
directive that names the connectors going through the shared resolution — a
fourth one that forgets it fails CI rather than losing edits quietly.

| | Claude Code | Cursor IDE | ACP agents (Zed, JetBrains, Neovim, Emacs × Gemini CLI, cursor-agent, Goose, …) |
|---|---|---|---|
| **Capture** — what a target comes from | `PostToolUse` for `Edit`/`Write`/`MultiEdit`/`NotebookEdit` | `afterFileEdit`, the single capture row on this host | `session/update` `tool_call` locations and diff paths, plus the `fs/write_text_file` request |
| **Worktree resolution** — an edit in a linked worktree of the same repo | yes | yes | yes |
| **Drop counters** — a touch that could not be captured | `foreign-repo` and `outside-root`, split and counted | same | same |
| **Capture health** in `crosscheck status` / `doctor` | `N edit-tool fires → M targets`, last tool, last edited path + the root it resolved against, WARN at 3 fires with 0 targets on a session still being heard from | same, with the event name `afterFileEdit` as the tool | same, with the ACP tool-call `kind` (or `fs/write_text_file`) as the tool. One edit an agent signals BOTH ways reads `2 fires → 1 target`: both are honest edit signals, dropping either would leave some real agent permanently at `0 → 0` and unable to WARN, and the doubling can never cause a FALSE warn because the first signal captures the target (pinned in `connector-acp/test/worktree-capture.test.ts`) |
| **Before-edit tripwire** — telling the model about an overlap *before* it edits | yes — `PreToolUse`, `permissionDecision: "ask"` plus the facts as `additionalContext` | **not possible on this host today** | **not possible on this host today** |

The last row is a limitation we document rather than a gap we forgot, and each
of those two connectors' module headers carries the same sentences with its
source and fetch date (`connector-cursor/src/handlers/file-edit.ts`,
`connector-acp/src/capture/engine.ts`):

- **Cursor** — there is no `beforeFileEdit`/`beforeWrite` event
  (cursor.com/docs/hooks, read 2026-08-26). `preToolUse` does fire before a
  `Write`, but its outputs are `permission: "allow" | "deny"`, two messages the
  docs describe as shown *"when the action is denied"*, and `updated_input` —
  *"Modified tool input to use instead"*, which rewrites the edit rather than
  briefing the model, so it is past the same ceiling as a deny; of `"ask"` the
  same page says, verbatim, that it *"is accepted by the schema but not enforced
  for `preToolUse` today"*, and the event has no `additional_context`. So the only
  way to put words in front of the model before an edit is to **block** it —
  past the ceiling this ladder is built to respect. It is not wired.
  And it is not a docs caution that might quietly start working: on
  `beforeShellExecution`, an event whose documented output *does* include
  `"ask"`, users report it being ignored in the field — the command runs in
  the same turn (forum.cursor.com/t/beforeshellexecution-returns-permission-ask-but-sandboxed-agent-shell-still-runs-the-command-sandbox-true/155438
  and .../beforeshellexecution-hook-permissions-allow-ask-ignored-allow-list-takes-precedence/144244,
  both read 2026-08-26).
- **ACP** — the before-edit signals genuinely are on the wire
  (`session/request_permission` carries the whole `ToolCallUpdate` with its
  `locations`; a `tool_call` may arrive with `status: "pending"`,
  agentclientprotocol.com/protocol/schema, read 2026-08-26). None is usable
  without breaking the proxy's prime directive: the pump **forwards first and
  observes a copy**, the agent→client direction has no line-decision seam at
  all, the only client→agent message that follows a permission request is the
  human's own answer, and `_meta` is explicitly not a channel a client may be
  assumed to surface. Giving that direction a seam means parsing and re-emitting
  agent bytes on the forward path — exactly what
  `packages/connector-acp/test/transparency.test.ts` exists to forbid.

Both hosts *can* be told about an overlap **one beat late** — Cursor through
`postToolUse` `additional_context`, ACP through the existing `session/prompt`
injection point and the crosscheck MCP server the launcher already advertises.
That is a notice after the edit, not a tripwire before it, and it is deliberately
not shipped under the tripwire's name.

Measured cost of the new resolution, as the RANGE over five runs on one
machine (macOS arm64, Bun 1.3.13, warm APFS). Ranges rather than single figures
because that is what the commands actually print: the top of each is the first
run after a cold process, and every one of them is a fraction of its budget.
Reproduce with the commands; do not read the numbers as constants.

| Host | cold (first touch of a new worktree root) | warm (same root again) | budget · command |
|---|---|---|---|
| Claude Code | 94-302 ms (`PostToolUse`) · 91-132 ms (`PreToolUse`) | 42-109 ms · 40-60 ms | 1600 / 800 ms · `bun test packages/connector-claude/test/capture-latency.test.ts` |
| Cursor | 92-116 ms | 41-50 ms | 1600 ms · `bun test packages/connector-cursor/test/capture-latency.test.ts` |
| ACP | 61-69 ms | 6 ms | off the forward path — 200 worktree tool calls flooded through the real pump with the real engine attached forwarded byte-identically in 183-363 ms and dropped 0 capture lines · `bun test packages/connector-acp/test/capture-latency.test.ts` |

Inside CI's container (`oven/bun:1`, Bun 1.4.0) the same three commands print
6-8 / 5-7 ms and 6-7 / 3 ms for Claude, 7-8 / 4 ms for Cursor, and 9-11 / 6-9 ms
for ACP with the 200-call flood in 207-231 ms, 0 dropped — an order of magnitude
under the same budgets. That lane needs `apt-get install -y git` first: the
image ships without it, and these suites shell out to `git worktree add`.

The cache is what those warm numbers are: one `resolveRepoIdentity` per NEW
worktree root per session, never per edit, remembered in session state
(`knownWorktreeRoots`) across re-registrations. An unresolvable root is an
UNKNOWN rather than an answer and is retried a bounded number of times before it
stands, so one missed `git` deadline cannot exile a healthy worktree for the
session's life.

Everything below assumes a reachable hub and a login:

```sh
# operator, once (or: npx crosscheck-hub serve)
crosscheck serve

# each developer, once per hub
crosscheck login https://hub.example.com   # key read from stdin
```

`crosscheck doctor` is the answer to "is it working" on every host: it checks
launcher health, hook registration (Claude + Cursor sections), hub liveness,
spool depth, contract drift, injection counts — and the user-level install
state (present, absent, double-wired).

## The user-level ("global") install — once per machine

```sh
crosscheck init --global             # add --cursor for ~/.cursor too
```

Project-scoped init wires ONE checkout, and every new checkout, git worktree
or parent-workspace session starts deaf until someone re-runs it — two real
incidents in one week (a Cursor workspace rooted at the repo's PARENT folder
loaded no repo settings at session start; a fresh worktree carried the
committed `.crosscheck.json` but not the per-machine, gitignored
`.claude/settings.json`). `--global` wires the machine instead: hooks +
statusline into `~/.claude/settings.json`, the mcp tools into user-scope
`~/.claude.json` — the files Claude Code reads for EVERY session, wherever it
starts.

What it does NOT change: **where a session reports.** Trust stays per-repo
(DESIGN.md §2.1) — only a repo whose root carries the committed
`.crosscheck.json` ever reports; a session in any other directory produces
zero hub traffic, zero disk artifacts, zero errors, forever. Machine-wide
wiring, repo-scoped trust.

Operational notes:

- **Non-destructive, reversible.** Additive merge with timestamped backups
  and atomic writes; a re-run against an unchanged file is a byte-identical
  no-op; an existing statusline is never replaced without
  `--force-statusline`; `crosscheck init --global --remove` strips exactly
  the crosscheck entries from all four user-scope files (Cursor's included,
  no flag needed) and leaves every foreign entry content-identical. (JSON
  formatting is normalized to 2-space indentation on the first install and
  not restored, so a file you hand-indented differently is preserved in
  content, not byte-for-byte — the timestamped backup holds the exact
  original either way.)
- **Coexists with project installs.** A repo can carry committed project
  hooks while the machine carries the global ones: Claude Code runs an
  identical handler defined in both files once, and capture stays
  exactly-once even when differing launcher spellings make both fire.
  `doctor` flags the redundancy and names the cleanup command.
- **Cursor scope is narrower.** `--global --cursor` writes
  `~/.cursor/hooks.json` + `~/.cursor/mcp.json`, which cover LOCAL Cursor
  sessions only — Cursor cloud agents read the repo-committed
  `.cursor/hooks.json`, so teams using cloud agents still want the committed
  install too.

## Claude Code (per-repo alternative)

```sh
cd your-repo
crosscheck init
```

Non-destructive merge into `.claude/settings.json` (hooks + statusline) and
`.mcp.json` (the diagnosis tools). Both files are repo-committed: install is
one PR, teammates connect on `git pull` + `crosscheck login`. (Connecting the
repo — writing the committed `.crosscheck.json` — happens here in both
stories; `--global` only replaces the per-checkout hook wiring.)

Two operational notes:

- **Hooks load at process start** — a Claude Code session already running
  when `init` writes the settings keeps running WITHOUT them; restart it
  (`init` prints this, and `doctor` warns about running agents in the repo
  that predate the settings file).
- **Start sessions inside the repo.** A session started in a PARENT folder
  of the repo loads no project-scoped settings at all (Claude Code reads
  `<cwd>/.claude/settings.json` at session start) — with only a per-repo
  install it is deaf there. A user-level install closes this: the wiring is
  machine-wide, and the session becomes visible on its first edit of a file
  inside the repo (the connector derives the repo from the touched file's
  path); briefing and presence are missing until then. `crosscheck doctor`
  in the parent folder names whichever of the two states you are in.

### The Tier-1 draft summarizer (Claude Code only) — what it needs

The Stop hook's summarizer is a nested `claude -p` on a Haiku-class model,
run by a detached worker on the developer's own Claude auth. After trial
finding #14 (a whole trial in which it never answered) these are the facts
to check when `crosscheck status` shows `N runs (0 NONE, 0 drafts, N failed
…)`:

- **Login environment.** The worker inherits the hook's whole environment
  minus the parent session's own markers (`CLAUDECODE`, `CLAUDE_PID`, the
  `CLAUDE_CODE_SESSION_*`/child-session/messaging/task-list/SSE-port/
  remote/bridge/resume names, plugin and project-dir variables — the list
  is `PARENT_SESSION_MARKER_PATTERN` in
  `packages/connector-claude/src/summarizer/worker-env.ts`); the nested
  `claude` additionally never sees `CROSSCHECK_API_KEY`. `USER` must be in it (the macOS
  keychain lookup keys on it — `Not logged in · Please run /login` is what
  its absence looks like); API-key (`ANTHROPIC_API_KEY`), Bedrock/Vertex
  (`CLAUDE_CODE_USE_*` + `AWS_*`/`GOOGLE_*`), OAuth token, `CLAUDE_CONFIG_DIR`,
  proxy and CA variables all pass through. Keychain and API-key logins both
  work; `--bare` is not used because it disables keychain/OAuth auth.
- **Claude Code version.** The worker passes `--setting-sources ""
  --strict-mcp-config --mcp-config '{"mcpServers":{}}'
  --no-session-persistence --tools "" --max-turns 1` so the nested claude
  is a model call (~9 s) and not a full session (35–116 s measured, with
  hooks/plugins/MCP servers loaded). Verified on Claude Code 2.1.237; an
  older CLI that does not know a flag exits 1 with `error: unknown option`,
  which `doctor` prints — upgrade Claude Code. **Floor: Claude Code ≥
  2.1.101.** Below it `--setting-sources ""` (no `user` source) let Claude
  Code's background cleanup ignore `cleanupPeriodDays` and delete
  transcripts older than 30 days (Claude Code changelog 2.1.101); the
  `summarizer runner` check WARNs when the `claude --version` it reads is
  older, even when the probe answered.
- **`crosscheck doctor`** now has a `summarizer runner` check that runs the
  real argv with the real worker env on a fixed slice: `PASS answered NONE
  in 9 s (claude 2.1.237)`, or `FAIL exit 1: Not logged in Please run
  /login — log in once with claude in a terminal as this user`, or
  `timed out after 60 s — raise CROSSCHECK_SUMMARIZER_TIMEOUT_MS`. It spends
  one Haiku call per run; `CROSSCHECK_DOCTOR_NO_PROBE=1` skips it, and a
  PATH without `claude` skips it with a line that says so. The `summarizer
  cost` line WARNs once 3 or more fires have produced neither a NONE nor a
  draft.
- **Isolation.** The nested process carries `CROSSCHECK_SUMMARIZER_CHILD=1`;
  every crosscheck hook entry (Claude and Cursor) exits silently under it,
  so the summarizer can never register phantom sessions or fire itself. It
  runs from `~/.crosscheck/summarizer-cwd`, never from your repo, so no
  project `CLAUDE.md` rides into a fire.

## Cursor IDE (≥ 1.7)

```sh
cd your-repo
crosscheck init --cursor      # composes with the default Claude init
```

Merges `.cursor/hooks.json` and `.cursor/mcp.json`, non-destructively, with
timestamped backups. Same one-PR install story. The user-level variant
(`crosscheck init --global --cursor`, see above) writes `~/.cursor` instead
and covers every checkout for LOCAL sessions — cloud agents only read the
committed files, which is why the repo-scoped install stays the team
default here. Three things to know:

- **Open the repo itself as your workspace, not a parent folder.** A
  workspace rooted at `~/dev` above `~/dev/monorepo` starts panel sessions
  OUTSIDE the repo: the session only becomes visible on its first edit of a
  file inside the repo (the connector derives the repo from the touched
  file's path), and the session-start briefing and presence are missing
  until then. `crosscheck doctor`, run in the parent folder, names this
  state ("you are above the connected repo"). And a workspace spanning TWO
  connected repos binds each agent session to the repo it touches FIRST —
  edits to the other connected repo are dropped and counted, never recorded
  under the wrong repo; `crosscheck doctor` and `crosscheck status` surface
  the count as `foreign-repo drops`. One repo per workspace is the shape
  that records everything.
- **Gitignore interplay**: if your repo gitignores `.cursor/`, un-ignore
  `hooks.json` and `mcp.json` — an ignored install silently works for exactly
  one person.
- Cursor hot-reloads both files in trusted workspaces; no restart needed.

Details, capture mapping and privacy posture:
[`packages/connector-cursor/README.md`](../../packages/connector-cursor/README.md).

## Zed (any ACP agent)

Agent Settings → Add Custom Agent, or directly in `settings.json` — the
pattern is always *wrap the agent command with `crosscheck acp --`*:

```json
{
  "agent_servers": {
    "Gemini (crosscheck)": {
      "type": "custom",
      "command": "crosscheck",
      "args": ["acp", "--", "gemini", "--experimental-acp"],
      "env": {}
    }
  }
}
```

Swap the wrapped command per agent:

- **Gemini CLI**: `["acp", "--", "gemini", "--experimental-acp"]`
- **Cursor CLI as agent**: `["acp", "--", "cursor-agent", "acp"]`
- anything else that speaks ACP: `["acp", "--", "<agent>", "<its acp flag…>"]`

Per-agent ACP flags drift — if a wrapped agent fails to start, run the same
command in a terminal first; the proxy's pre-spawn refusals are loud
(exit 64/127) and its log lives at `~/.crosscheck/logs/acp-<pid>.log`.

In a crosscheck-connected repo the wrapped session reports presence, touched
files and failure fingerprints, gets the team briefing appended to its first
ready prompt, and gets crosscheck's MCP tools appended to its session setup.
Everywhere else the wrapper is a pure byte pipe — that is the prime
directive, and it is enforced structurally
([`packages/connector-acp/README.md`](../../packages/connector-acp/README.md)).

## JetBrains IDEs (AI Assistant)

`~/.jetbrains/acp.json`, same `agent_servers` entry shape as Zed
(command/args/env). Example:

```json
{
  "agent_servers": {
    "Gemini (crosscheck)": {
      "command": "crosscheck",
      "args": ["acp", "--", "gemini", "--experimental-acp"],
      "env": {}
    }
  }
}
```

## Neovim / Emacs

avante.nvim / CodeCompanion (Neovim) and agent-shell (Emacs) configure ACP
agents as a command array — use the same shape:
`{"crosscheck", "acp", "--", "gemini", "--experimental-acp"}`.

A `crosscheck acp setup [zed|jetbrains|nvim|emacs]` subcommand that PRINTS the
ready-to-paste snippet with the resolved absolute launcher (design §2.6) is
still future work — until it lands, copy the snippets above and replace
`"crosscheck"` with the absolute path `crosscheck doctor` reports if the bin
is not on the editor's PATH.

## Launcher note (all hosts)

`init` writes either the bare `crosscheck` (when on PATH) or the absolute
path of the entry that ran it — never a package name (an unpublished name is
a dependency-confusion vector), never an npx/bunx cache path (ephemeral
installs refuse; the doctor flags them). The ACP mcpServers injection uses
the same durable-install rules.

**Dev-checkout upgrade across Block 8**: installs written before the bin
moved may embed the old absolute entry path
(`packages/connector-claude/src/bin/crosscheck.ts`, gone since the move) —
hooks then fail silently until you rerun `crosscheck init`. `crosscheck
doctor` names the dead launcher ("does not exist — rerun crosscheck init").

---

# Dogfood checklists — what only real installs can answer

CI pins the documented contracts against fakes. The design's open questions
(§6) about REAL agent and editor behavior are a human's duty, after merge.
This is the one place to work through; record findings in
`docs/adapters/DESIGN-agent-agnostic.md` §6.

## ACP agents in the wild (design §6 q1/q2 — measure, then document)

Per agent — Gemini CLI, cursor-agent, Goose, claude-agent-acp, one per row of
the §2.6 client matrix you care about:

1. Wrap it with a recording: in the editor config, add `--record`:
   `["acp", "--record", "/tmp/<agent>.ndjson", "--", "<agent cmd…>"]`.
2. Run a REAL session in a crosscheck-connected repo: a few prompts, at least
   one edit, one failing build/test command, one session resume if the client
   supports it.
3. Analyze the transcript:

   ```sh
   crosscheck acp-report /tmp/<agent>.ndjson
   ```

   The report says which capture signals the agent actually emitted — tool
   calls with `locations`, diff paths, failures with output, terminals, fs
   writes — plus recording honesty (gaps/oversized/unparseable).
4. Decide + document that agent's capture level: an agent that reports edits
   without paths degrades to fs/terminal signals, and its doc must say so
   (§6 q1). If its `session/resume` omits `cwd`, that registers nothing —
   the doc must say that too, and the parser needs a fallback decision.
5. Prompt-block tolerance (§6 q2): with injection active, confirm the agent
   answers a prompt that carries the appended briefing block, and eyeball how
   the client renders replayed history after a resume.
6. `crosscheck doctor` + the proxy log's `capture sessions=… targets=…
   fingerprints=…` / `inject mcp=… briefings=… hints=… skips=…` summary lines
   are the ground truth for what flowed.

## Cursor on a real build (design §6 q4/q5)

The full eight-step checklist lives in
[`packages/connector-cursor/README.md`](../../packages/connector-cursor/README.md)
("Manual dogfood") — run it verbatim on a real Cursor ≥ 1.7 install. The
short form of what it answers:

1. Install + doctor all-PASS (`init --cursor`, trusted workspace).
2. One session + one edit → presence shows `cursor-ide`, the path lands as a
   target.
3. One failing command → an `error_fingerprint` lands; NOTE WHICH EVENT
   carried it (`postToolUseFailure` vs `postToolUse` vs an undocumented
   `afterShellExecution` exit field) — that is §6 q4's answer.
4. Doctor again: observed `cursor_version`, `contract drift: none` (any WARN
   here = Cursor's real payloads differ from the documented contract; file it
   against the fixtures).
5. Repeat with a background/cloud agent; tick off which of the seven events
   actually fired (§6 q5), expecting the documented `sessionStart`/`sessionEnd`
   deferral and its presence consequence.
6. Briefing delivery: fresh conversation with a live teammate → briefing in
   the composer context, `doctor` counts `briefings 1 delivered`.
7. Matched hint at a failure: teammate's fingerprint + claims on the hub,
   reproduce their failing command → hint arrives at the failure; doctor's
   per-event delivery count IS the q4 answer.
8. Negative space: repeated failure → no repeat hint (seen-set);
   presence-off/muted authors surface nothing; `CROSSCHECK_DISABLED=1` →
   instant `{}` everywhere.

## Cross-connector sanity (after any of the above)

With two hosts live on one repo (e.g. Claude Code + a wrapped ACP agent, or
Claude Code + Cursor), the CI-proven §4.5 scenario should reproduce by hand:
both sessions in presence under their own agent kinds, one hub fingerprint
for one shared failure, briefings naming the other developer, and
`presence off` / `mute` behaving per §2.1. The automated version runs in
`packages/cli/test/e2e/cross-connector.e2e.test.ts`.
