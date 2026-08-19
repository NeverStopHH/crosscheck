# Installing crosscheck per editor / agent

One bin covers every host: `crosscheck` (shipped by `packages/cli`, published
as `crosscheck-hub` — the bin name stays `crosscheck`). Three connectors sit
behind it:

| Host | Connector | Install mechanism |
|---|---|---|
| Claude Code | `connector-claude` | `crosscheck init` (repo-committed `.claude/settings.json` + `.mcp.json`) |
| Cursor IDE | `connector-cursor` | `crosscheck init --cursor` (repo-committed `.cursor/hooks.json` + `.cursor/mcp.json`) |
| Any ACP client × any ACP agent (Zed, JetBrains, Neovim, Emacs × Gemini CLI, cursor-agent, Goose, …) | `connector-acp` | wrap the agent command: `crosscheck acp -- <agent cmd…>` (per-user editor config) |

Everything below assumes a reachable hub and a login:

```sh
# operator, once (or: npx crosscheck-hub serve)
crosscheck serve

# each developer, once per hub
crosscheck login https://hub.example.com   # key read from stdin
```

`crosscheck doctor` is the answer to "is it working" on every host: it checks
launcher health, hook registration (Claude + Cursor sections), hub liveness,
spool depth, contract drift and injection counts.

## Claude Code

```sh
cd your-repo
crosscheck init
```

Non-destructive merge into `.claude/settings.json` (hooks + statusline) and
`.mcp.json` (the diagnosis tools). Both files are repo-committed: install is
one PR, teammates connect on `git pull` + `crosscheck login`.

Two operational notes:

- **Hooks load at process start** — a Claude Code session already running
  when `init` writes the settings keeps running WITHOUT them; restart it
  (`init` prints this, and `doctor` warns about running agents in the repo
  that predate the settings file).
- **Start sessions inside the repo.** A session started in a PARENT folder
  of the repo only becomes visible on its first edit of a file inside the
  repo (the connector derives the repo from the touched file's path);
  briefing and presence are missing until then. `crosscheck doctor` in the
  parent folder names this state.

## Cursor IDE (≥ 1.7)

```sh
cd your-repo
crosscheck init --cursor      # composes with the default Claude init
```

Merges `.cursor/hooks.json` and `.cursor/mcp.json`, non-destructively, with
timestamped backups. Same one-PR install story. Three things to know:

- **Open the repo itself as your workspace, not a parent folder.** A
  workspace rooted at `~/dev` above `~/dev/monorepo` starts panel sessions
  OUTSIDE the repo: the session only becomes visible on its first edit of a
  file inside the repo (the connector derives the repo from the touched
  file's path), and the session-start briefing and presence are missing
  until then. `crosscheck doctor`, run in the parent folder, names this
  state ("you are above the connected repo").
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
