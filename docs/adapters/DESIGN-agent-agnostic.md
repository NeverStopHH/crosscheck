# Agent-agnostic connectors — ACP proxy + Cursor adapter (DESIGN.md §8 v1)

Status: implementation design, 2026-08-18. Extends [DESIGN.md](../DESIGN.md) §8's v1 line
("ACP proxy connector … Cursor rules adapter") with the concrete plan, informed by two
research passes fetched 2026-08-18 (sources at the end). All protocol claims below carry
their source; everything about our own code was read from the tree, not remembered.

**Verdicts up front:**

1. Extract a shared `@crosscheck/connector-core` package by *mechanical move first,
   semantic generalization second* — never both in one change.
2. The ACP proxy is `crosscheck acp -- <agent command>`: a transparent NDJSON pipe that
   forwards bytes verbatim, captures from a parsed *copy*, and touches exactly two
   messages on the write path (`session/new` and `session/prompt`). It must never be able
   to kill a session: every failure degrades to a pure pipe.
3. §8's "Cursor rules adapter" is **re-scoped**. Cursor CLI natively speaks ACP as an
   agent ([cursor.com/docs/cli/acp](https://cursor.com/docs/cli/acp), fetched 2026-08-18),
   so the proxy covers it for free. Cursor *IDE* has no ACP seam — but since Cursor 1.7 it
   has a hooks API near-isomorphic to Claude Code's
   ([cursor.com/docs/hooks](https://cursor.com/docs/hooks), fetched 2026-08-18). The
   dedicated adapter targets **hooks + MCP**, not rules files. Rules files are explicitly
   rejected as an injection channel (see §3.3).
4. The three-classes injection discipline — PROSE through `sanitizeUntrusted` + « » frame
   + notice, BARE through `bareUntrusted`, IDs through `safeId` — is **non-negotiable in
   every new render path**. Both new connectors render exclusively through the existing
   core renderers; a meta-test makes an unregistered render surface a red build (§4.4).

---

## 1. Shared core: `@crosscheck/connector-core`

### 1.1 The decision: extract, in two separated steps

Two options were on the table:

- **Import-from-connector-claude**: `connector-acp` and `connector-cursor` declare a
  dependency on `@crosscheck/connector-claude` and import its modules directly. Zero
  migration cost today; permanent wrong shape tomorrow. The package would carry hooks,
  statusline and the `claude -p` summarizer into every connector's dependency graph, its
  name would lie, and every Claude-specific change would be a potential break for two
  packages that never asked for it. Three connectors importing from one misnamed grab-bag
  is exactly how drift starts: the next person "fixes" a hook-payload assumption inside a
  shared module because the file lives in the Claude package.
- **Extract `connector-core`**: move the agent-agnostic modules into a new package,
  rewrite imports. Real migration cost, paid once, bounded and mechanical.

**Verdict: extract.** The migration cost, weighed honestly:

- ~45 source modules move; `connector-claude` keeps ~15 (hooks, statusline, summarizer,
  Claude-specific init). All packages are `private: true` workspace packages — no
  published-API compatibility to preserve.
- 60+ test files import via relative `../src/…` paths and must be rewritten. This is
  `sed`-shaped work, but it is the bulk of the diff and the review must confirm **zero
  assertion changes** — the extraction bar is "same product, new layout".
- The dangerous part is not moving files, it is *renaming things while moving them*.
  `claudeSessionId` appears in the on-disk session-state schema
  (`state/session-state.ts`), and the spool/reap correctness argument depends on
  state-file and spool-file names deriving from one function
  (`config/paths.ts sessionSlug`). Therefore: **Block 1 moves with zero renames** —
  `claudeSessionId` stays `claudeSessionId` even in core, ugly for one block — and
  **Block 2 does the rename** as its own reviewable change with a tolerant schema
  (see §1.3). A moved-and-renamed module in one diff is where a review misses the one
  behavioral change hiding in 4,000 mechanical lines.

### 1.2 What moves, what stays

Moves to `packages/connector-core` (all read from the tree; none of these imports
anything Claude-specific today):

| Area | Modules | Note |
|---|---|---|
| Spool | `spool/*` (append, write, flush, cursor, files, lock, reap, drops, lines, identity, unclosed) | Already agent-agnostic: append-only JSONL per (hub, repo), cursor + reap + at-least-once with server-side dedup. |
| Hub client | `http/client.ts`, `http/hub.ts` | Typed API surface; zero host coupling. |
| Envelope + capture primitives | `capture/records.ts`, `fingerprint.ts`, `secret-scan.ts`, `denylist.ts`, `commit-evidence.ts`, `landed.ts` | `fingerprint()` is the cross-agent match signal — one implementation is the point: the same failure text must hash identically from Claude Code, an ACP agent and Cursor, or cross-agent matching silently dies. |
| Render + sanitize | `briefing/sanitize.ts`, `briefing/render.ts`, `hints/render.ts`, `hints/select.ts`, `hints/echo.ts`, `hints/delivered-store.ts`, `mcp/render.ts`, `mcp/render-referee.ts` | The three classes and every renderer built on them. One copy, three consumers. |
| MCP server | `mcp/server.ts`, `mcp/tools/*`, `mcp/session.ts`, `mcp/protocol.ts`, `mcp/context.ts`, `mcp/violations.ts` | Fully host-agnostic: stdio MCP, and session resolution reads local session-state files by (hub match, repo match, worktree root, newest `startedAt`) — `mcp/session.ts`. Any connector that writes state files gets the whole Tier-2 tool surface for free. This is the single biggest reuse lever in the codebase. |
| State | `state/session-state.ts`, `presence-cache.ts`, `sync-state.ts` | Generalized in Block 2 (§1.3). |
| Git | `git/*` (repo-identity, commit-drift, default-branch, solved-staleness, git) | |
| Config | `config/paths.ts`, `config.ts`, `repo-config.ts`, `constants.ts` | `agentKind` is already a config value (`DEFAULT_AGENT_KIND = "claude-code"`, overridable); each connector supplies its own default. |
| Cross-cutting tests | `injection-corpus.test.ts`, `precision-corpus`, `scripts/mutation-check.ts`, `scripts/default-ignorable-sweep.ts` | The corpus moves with the sanitizer it tests (§4.4). |

Stays in `packages/connector-claude` (now honest about its name):

- `hooks/*` — Claude Code hook payload parsing (`capture/tool-events.ts`'s
  `HookPayloadSchema` and the Edit/Write/Bash tool-name mapping move here too: they
  parse *Claude Code's* payloads) and the `hookSpecificOutput` response shapes.
- `statusline/` — a Claude Code surface.
- `summarizer/*` — Tier-1 rides headless `claude -p` on the developer's existing Claude
  auth (DESIGN.md §2). It is Claude-specific by construction. `summarizer/gate.ts` and
  `parse.ts` are generalizable later; not now (YAGNI — no second summarizer exists).
- `cli/init.ts`, `settings-merge.ts` — the `.claude/settings.json` + `.mcp.json`
  installer. The non-destructive-merge *pattern* is shared knowledge; the file shapes are
  host-specific. `cli/mcp-config.ts`'s `mergeMcpConfig` moves to core: Cursor's
  `.cursor/mcp.json` uses the identical `{"mcpServers": {…}}` shape
  ([cursor.com/docs/mcp](https://cursor.com/docs/mcp), fetched 2026-08-18).

The `crosscheck` bin (`src/bin/crosscheck.ts`) stays in `connector-claude` through
Block 2 and gains `acp` / `cursor-hook` subcommands by importing the new connector
packages when they land. That is a wrong-direction dependency (the Claude package's bin
fronting three connectors) and it is accepted **as named debt**: extracting
`packages/cli` in the same window as the core extraction doubles Block 1's blast radius
for zero user-visible gain. DESIGN.md §7 already reserves `packages/cli`; it gets
extracted in Block 8 when the third connector proves the shape (one npm artifact, one
`bin`, three connectors + server behind it).

### 1.3 Identity generalization (Block 2, the only semantic change)

- `claudeSessionId` → `hostSessionKey`. The schema accepts both keys on read
  (zod preprocess: `hostSessionKey ?? claudeSessionId`) and writes only the new one:
  a session upgraded mid-flight parses fine, and `deriveSessionState` +
  `recoverState` (post-tool-use.ts) already cover the corner where it doesn't —
  recovery re-registers the same deterministic ids. Spool slugs keep deriving from
  `sessionSlug(hostSessionKey)`; **for Claude Code the key stays the raw
  `session_id`**, so existing spools, state files and `cc_<uuid>` session ids are
  byte-identical across the upgrade. No user-visible migration.
- Connector prefixes prevent cross-host collisions without touching Claude's compat:
  ACP uses `acp-<agentSlug>--<acpSessionId>`, Cursor uses `cur-<conversation_id>`.
  The `--` between slug and id is the boundary marker: a slug joins alphanumeric
  runs with single dashes and never carries an edge dash, so `--` cannot occur
  inside it and every key parses back to exactly one (slug, id) pair — without
  it, ("Gemini", "cli-x") and ("Gemini CLI", "x") both mint `acp-gemini-cli-x`
  and merge two sessions. Decided in Block 2, while zero ACP keys exist on any
  disk; after Block 4 it would be an on-disk migration.
  `crosscheckSessionIdFor` stays `cc_${hostSessionKey}` — e.g.
  `cc_acp-gemini-cli--sess_abc123`.
- Rollout note (one-way upgrade window): the write path emits ONLY
  `hostSessionKey` — by design, so a file never carries both keys. The cost is
  that a state file the NEW code has touched no longer parses under OLD-era
  builds (they fail open and can silently resolve a different same-root session
  for MCP attribution). Old files under new code are flawless; new files under
  old code are not. Do not run pre-Block-2 and post-Block-2 builds against the
  same `~/.crosscheck` concurrently — upgrade every install in one step.
- `agent_kind` on the wire (already free-form in `@crosscheck/schema`'s
  `AgentSessionSchema`): `claude-code` (unchanged), `acp:<agentInfo.name>` (from the
  `initialize` response, e.g. `acp:gemini-cli`, `acp:cursor-agent`; fallback
  `acp:unknown`), `cursor-ide`. Hub needs zero changes — `agent_kind` was designed for
  this day.
- Block 2 also names the facade the new connectors program against —
  `connector-core`'s `kit`: `registerSessionFlow` (register + retry-on-409 + state file
  + work-context record, the session-start.ts shape), `captureFileTargets` (repo-relative
  + denylist + seen-set + secret-scan, the post-tool-use.ts shape), `captureFailure`
  (extract text → `fingerprint()`), `heartbeatMaybe` (20 s throttle), `assembleBriefing`,
  `selectAndRenderHint`, `endSessionFlow` (end + flush + reap). These are today's
  hook-handler bodies with the Claude payload parsing peeled off — extraction, not
  invention.

### 1.4 The non-negotiable

Every string a new connector emits into any agent's context goes through exactly the
existing classes: `sanitizeUntrusted`/`quoted` (PROSE, « »-framed, under
`QUOTED_DATA_NOTICE`), `bareUntrusted` (BARE short fields), `safeId` (ID allowlist).
There is no fourth path, and both new connectors reuse the finished renderers
(`renderBriefing`, `renderClaimHint`, `renderPointerHint`) rather than composing their
own lines. New connector-specific framing text (e.g. the ACP block header) is
renderer-owned literal text, never interpolated untrusted input. Enforcement is
structural, not conventional: §4.4's surface-registration meta-test.

---

## 2. ACP proxy connector — `packages/connector-acp`

### 2.1 Why a transparent proxy is the right shape

The protocol's own RFD track converged on exactly this architecture: the
["Agent Extensions via ACP Proxies" RFD](https://agentclientprotocol.com/rfds/proxy-chains)
(Draft since 2025-12-31) names *context injection, tool coordination, response filtering*
as intended proxy use cases and argues MCP servers cannot do this because they sit behind
the agent. A plain transparent proxy needs none of the RFD's conductor machinery: the
client simply configures crosscheck's binary as the agent command; the proxy spawns the
real agent and passes NDJSON through. One binary then covers every ACP client
(Zed, JetBrains, Neovim, Emacs, …) × every ACP agent (~39 listed on
[agentclientprotocol.com/get-started/agents](https://agentclientprotocol.com/get-started/agents)
as of 2026-08-18, including Gemini CLI, Goose, Copilot CLI, Cursor CLI, and Claude
Code/Codex via Zed's adapters).

### 2.2 Process model

```
Zed / JetBrains / nvim          crosscheck acp                    real agent
        │   stdio NDJSON   ┌──────────────────────┐   stdio NDJSON   │
        ├──────────────────►  forward verbatim     ├─────────────────►
        ◄──────────────────┤  (parse a COPY)       ◄─────────────────┤
        │                  │  capture → spool/hub  │                 │
        │                  │  inject: 2 messages   │  stderr ────────► proxy stderr
        └                  └──────────┬───────────┘                  ┘
                                      ▼ HTTPS (fail-open, budgeted)
                                  crosscheck hub
```

- Invocation: `crosscheck acp [--agent-kind <slug>] [--record <file>] [--no-inject] -- <agent command…>`.
  Everything after `--` is spawned as the agent, argv untouched, environment inherited
  (the agent's own auth keeps working).
- Proxy stdin/stdout face the client; the child's stdio is piped. **stdout carries
  nothing but forwarded ACP** — the spec kills sessions on stray output
  ([transports](https://agentclientprotocol.com/protocol/v1/transports)). Proxy logging
  goes to `~/.crosscheck/logs/acp-<pid>.log`; child stderr is piped through to proxy
  stderr unmodified.
- Lifecycle: child exit → budgeted spool flush + `endSession` for every live session →
  proxy exits with the child's exit code. SIGINT/SIGTERM are forwarded to the child and
  the same drain runs. Client-side stdin EOF → close child stdin, same drain on child
  exit.
- One proxy process can host many sessions (ACP allows it); repo identity and hub are
  resolved **per session from its `cwd`** exactly as hooks resolve them per invocation —
  a session in an unconnected directory is a pure pipe that talks to nobody
  (DESIGN.md §2.1's "the repo decides where a session reports").

### 2.3 Wire discipline — the seven rules

The proxy must NEVER break a session. These rules are the contract, in priority order:

1. **Forward original bytes.** Each newline-delimited line is forwarded verbatim —
   never re-serialized from a parse. The only exception is the two injection edits
   (rule 6), each of which re-serializes *that one message* and only after a successful
   parse + validation — and the edit must be VALUE-preserving: JSON.parse reads every
   number as a double, so a raw integer past 2^53 (a 64-bit request id from a JVM/Rust
   JSON-RPC stack) or a magnitude past double range would be silently rewritten on the
   wire, and the agent's response would never correlate. Such a message is uneditable:
   the injector skips (`lossy-reserialize`) and forwards the original bytes
   (Block-5 fixer round; `connector-acp/src/inject/json-guard.ts`). Value-equal
   respelling (`1.0` → `1`) is accepted on the one edited message.
2. **Forward first, capture after.** Capture parses a copy *after* the line is on its
   way. Added latency on the hot path is parse cost only; hub I/O never blocks
   forwarding. `session/cancel` and `$/cancel_request` therefore pass with zero added
   await — a blocking proxy turns cancel into a hang (research brief pitfall; the spec
   requires pending permission requests to resolve as `cancelled` on turn cancel and the
   proxy must not sit in that path).
3. **Never reorder, never buffer.** One line in, one line out, flushed immediately.
   Chunk ordering is semantic — v2 makes it patch-by-ID
   ([v2 draft](https://agentclientprotocol.com/announcements/acp-v2-draft)).
4. **Anything unparseable is forwarded anyway.** Non-JSON, oversized, unknown method,
   extension method (`cursor/update_todos`, `_meta`-bearing) — forward verbatim, skip
   capture, count in a local drop stat surfaced by `crosscheck status`.
5. **No proxy-originated JSON-RPC.** In v1 the proxy never injects its own requests
   toward either side, so the two id spaces need no rewriting map — pure pass-through is
   collision-free by construction. This is a load-bearing simplification; the moment we
   want proxy-originated calls we adopt the RFD's `proxy/successor` envelope instead of
   inventing id-mapping.
6. **Exactly two write points** (§2.5), both fail-open: any parse failure, budget
   overrun, or hub error forwards the original bytes unmodified.
7. **Version gate.** The proxy reads `protocolVersion` from `initialize`
   request/response, forwards both verbatim, never negotiates on its own behalf.
   Negotiated version ≠ 1 → injection OFF for the connection, capture stays
   opportunistic (each message individually schema-validated, skipped on mismatch), one
   log line + one stderr notice. Never disconnect, never downgrade.

### 2.4 Tier-0 capture mapping

All shapes per [protocol v1 docs](https://agentclientprotocol.com/protocol/v1/overview),
fetched 2026-08-18. Request/response pairing needs a small bounded pending-map
(id → method) per direction; that map is the only protocol state the proxy keeps beyond
per-session capture state.

| Wire event | Crosscheck action |
|---|---|
| `initialize` response → `agentInfo.name/version` | `agent_kind = acp:<name>` for every session on this connection (stabilized field, 2025-10-24). `--agent-kind` overrides. |
| `session/new` request (`cwd`, `mcpServers`) + response (`sessionId`) | Resolve repo identity from `cwd` → `registerSessionFlow` with `hostSessionKey = acpHostSessionKey(agentSlug, sessionId)` (the `acp--<agentSlug>--<sessionId>` double-dash shape from §1.3 — call the helper, never invent the string); work-context title from branch @ repo (ACP has no session title; we do not synthesize one from prompt text — same privacy posture as the Claude connector's fallback). State file written before first append, preserving reap's invariant. Kick off async briefing prefetch (§2.5). |
| `session/load` / `session/resume` request + response | Re-register (idempotent — deterministic ids, hub answers duplicate). A session already live in the SAME proxy skips the re-register outright (no counter inflation, no re-appended work context, no seen-set reset); the cold path — a load/resume this proxy never saw born — registers at request time and is both pinned and mutation-checked. History replays as `session/update` notifications: **capture during replay is safe by construction** because every Tier-0 record dedups on a natural key server-side (`target` on (work_context, kind, value); `work_context` on id) and the injection point (`session/prompt`, client→agent) never fires during replay. Pinned by a test, not assumed (§4.2). |
| `session/prompt` request | Heartbeat; hint fast path (§2.5). Prompt text is used as an ephemeral search query against the hub — exact parity with the Claude connector's UserPromptSubmit; never stored, never uploaded as content. |
| `session/update`: `tool_call` / `tool_call_update` with `locations[].path`, `content` diff paths | File targets through `captureFileTargets` (repo-relative, denylist, seen-set, secret-scan). `kind: edit` additionally drives status → `implementing` (same heuristic as the Claude connector's edit-tool heartbeat). Caveat honestly: tool-call reporting is a SHOULD; agents doing internal file I/O without reporting locations capture nothing here — `fs/write_text_file` and terminals below are the backstop. |
| `tool_call_update` with `status: failed` → `rawOutput` | Failure text extraction (string fields joined, tail-sliced) → `fingerprint()` → `error_fingerprint` target. Identical normalizer as Claude Code = cross-agent fingerprint matching, which is the product. |
| `terminal/create` request (`command`) correlated with `terminal/wait_for_exit` response (`exitCode ≠ 0`) + `terminal/output` | Failure fingerprint from output; command text itself is NOT uploaded (parity: the Claude connector uploads no command text either). |
| `fs/write_text_file` request (`path`) | File target. |
| `session/prompt` response `stopReason` | Turn counter tick (future Tier-1 gate); `cancelled`/`refusal` capture nothing in v1. |
| `session/close` request, connection EOF, child exit | `endSessionFlow` (end + budgeted flush + reap). |
| JSON-RPC error responses on captured methods | Counted locally; no record (a client-side error is not a build failure). |

Not captured, deliberately: prompt/response content, `rawInput` bodies, diff `oldText`/
`newText` contents (paths only), permission outcomes. Tier-0 stays metadata + hashes,
exactly like the Claude connector.

Hostile-identifier discipline (fixer round): every identifier on this wire is
agent-controlled, so session ids are shaped at the wire-parse boundary
(`safeAcpSessionId` — control/format/separator strip, overlong ids fold to a
deterministic sha256) and agent names slug through a length-capped `agentSlug`
before either may enter log lines, state filenames, or `cc_`/`wc_` ids. Only
`--record` keeps the verbatim wire — that is its documented purpose. The
in-memory per-session seen-set carries the same FIFO bound as its persisted
copy (`MAX_SEEN_TARGETS`), so a hostile path stream costs bounded memory.

### 2.5 Injection — clean per protocol, and where v1 stays read-only

Two write points, both sanctioned shapes:

1. **MCP server injection** (`session/new` and `session/load` params). Append one entry
   to the `mcpServers` array —
   `{"name": "crosscheck", "command": "<abs launcher>", "args": ["mcp"], "env": []}`
   (array-of-EnvVariable shape per
   [session-setup](https://agentclientprotocol.com/protocol/v1/session-setup), verified
   2026-08-18). The agent connects to it like any team MCP server and gets the full
   Tier-2 tool surface (`publish_claim`, `extend_diagnosis`, `search_related_work`,
   `get_diagnosis`, `get_referee_brief`) with **zero client cooperation**, because
   `mcp/session.ts` resolves the calling session from local state files — which the
   proxy wrote at `session/new` time, before any tool call can exist. Launcher path
   resolution reuses init.ts's rule: PATH-installed `crosscheck` preferred, the running
   entry script's absolute path as fallback, and an npx/bunx cache path refuses injection
   (log + skip) rather than wiring a command that dies with the cache.
2. **Prompt-block append** (`session/prompt` params). Append **one** clearly-attributed
   `text` ContentBlock at the end of the user's block array — never edit or reorder the
   user's own blocks (append-don't-edit is the abuse line; forging
   `agent_message_chunk`/`user_message_chunk` is off the table, and v2's required message
   IDs would make such forgery detectably inconsistent anyway). Content comes from the
   existing renderers only:
   - *First prompt of a session*: the briefing (`renderBriefing` output, ≤600 tokens).
     Assembled **asynchronously at `session/new` capture time** and served from cache, so
     the user's first keystroke-to-forward latency stays parse-only; briefing not ready →
     skipped (fail open), its facts surface as later hints.
   - *Subsequent prompts*: the hint path (`selectAndRenderHint` — entity overlap + FTS,
     1/prompt, 5/session, seen-set, echo-exclusion, `hint_deliveries` telemetry), under a
     hard wall-clock budget (reusing the UserPromptSubmit budget constants); budget blown
     → forward unmodified.
   - Plain `text` blocks, not `resource` blocks: `embeddedContext` is capability-gated
     and inconsistently rendered across agents; text works everywhere. Known cosmetic
     cost, stated: on `session/load` replay some agents may echo the appended block in
     user-voice history. The block's header sentence self-identifies as crosscheck data
     (`QUOTED_DATA_NOTICE` discipline) precisely so a replayed copy stays honest.

Read-only in v1, deliberately:

- **`session/update` toward the client: never synthesized.** There is no notice channel
  in stable v1; the [Session Notices RFD](https://agentclientprotocol.com/rfds/session-notices)
  is the clean future path and we track it. A synthetic "Crosscheck" `tool_call` is
  defensible per the research, but it is UI spoofing risk for zero capture value — not
  worth it before dogfooding demands it.
- **`session/request_permission`: never touched, never answered.** The PreToolUse
  tripwire has no clean ACP seam in v1 (permission requests originate agent-side); it
  waits for the proxy-chains RFD's interposition model rather than faking one.
- **No `_meta`, no `_crosscheck/*` extension methods** in v1 — nothing needs the
  correlation yet (rule 5's no-proxy-originated-traffic simplification is worth more).
- **v1→v2**: the diff overhaul and patch-by-ID land behind `connector-acp`'s internal
  wire-schema module (`wire/v1.ts`), so the v2 migration is a contained new module +
  version switch, not a rewrite. Until it exists, version ≠ 1 → §2.3 rule 7.

### 2.6 Install story per client

The proxy is configured wherever the client configures a custom ACP agent — always the
same shape: wrap the agent command.

- **Zed** (verified against [zed.dev/docs/ai/external-agents](https://zed.dev/docs/ai/external-agents),
  fetched 2026-08-18): Agent Settings → Add Custom Agent, or directly in settings.json:

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

- **JetBrains IDEs** (verified: [jetbrains.com/help/ai-assistant/acp.html](https://www.jetbrains.com/help/ai-assistant/acp.html),
  2026-08-18): `~/.jetbrains/acp.json`, same `agent_servers` entry shape (command/args/env).
- **Neovim** (avante.nvim / CodeCompanion ACP adapters) and **Emacs** (agent-shell):
  command-array config; snippets ship in docs.
- **Cursor CLI as agent**: `crosscheck acp -- cursor-agent acp` (per
  [cursor.com/docs/cli/acp](https://cursor.com/docs/cli/acp)) — Cursor-in-Zed/JetBrains
  is covered by the proxy with zero Cursor-specific code.
- `crosscheck acp setup [zed|jetbrains|nvim|emacs]` **prints** the ready-to-paste snippet
  with the resolved absolute launcher — it does not edit user-global editor settings
  (unlike repo-committed `.claude/`/`.cursor/` files, these are outside the repo's trust
  story; DESIGN.md §2's "install = one PR" does not apply to per-user editor config).
  `crosscheck doctor` learns an `acp` section: launcher resolvable, wrapped agent
  spawnable, hub reachable.
- Per-agent ACP flags (`--experimental-acp` etc.) drift; `setup` snippets are
  best-effort and `doctor` probes the wrapped command with `initialize` to verify it
  actually speaks ACP.

---

## 3. Cursor adapter — `packages/connector-cursor`

### 3.1 Shape

The Claude connector's shape with renamed events: short-lived hook processes
(`crosscheck cursor-hook <event>` reading JSON on stdin, emitting JSON on stdout), the
same spool, the same budgets, the same fail-open-everywhere. No daemon. All hook facts
below from [cursor.com/docs/hooks](https://cursor.com/docs/hooks), fetched 2026-08-18;
hooks exist since Cursor 1.7 (Oct 2025) — `doctor` warns below that.

### 3.2 Capture path — exact events

Registered in `.cursor/hooks.json` (`version: 1`), each with an explicit `timeout` and
**never** `failClosed` (fail-open is non-negotiable):

| Cursor event | Handler behavior |
|---|---|
| `sessionStart` | `registerSessionFlow` with `hostSessionKey = cur-<conversation_id>`; repo identity from `workspace_roots[0]` (fallback `CURSOR_PROJECT_DIR`); `agent_kind = cursor-ide`. Returns `additional_context` = briefing (§3.3). Records `cursor_version` into local sync-state for `doctor`. `is_background_agent: true` → register with agent_kind `cursor-background`, no injection output. |
| `afterFileEdit` | `file_path` → `captureFileTargets`. The `edits[]` old/new strings are **never uploaded** — path only, Tier-0 discipline. Heartbeat (throttled), status → `implementing`. |
| `afterShellExecution` | Failure detection from exit/output fields → `captureFailure` → `error_fingerprint`. Command text not uploaded. |
| `postToolUseFailure` | Same fingerprint path for non-shell tool failures. |
| `postToolUse` | Heartbeat; spool flush on spare budget; hint delivery via `additional_context` (§3.3). |
| `stop` | Turn counter (future Tier-1 gate); spool flush. Never emits `followup_message` — auto-continuing the user's session is not ours to do. |
| `sessionEnd` | `endSessionFlow`. |

Deliberately **not** registered: `beforeReadFile` (payload carries full file content —
a privacy surface Tier-0 has no use for), `beforeSubmitPrompt` (it can block but has no
context-injection output; we never block), `beforeTabFileRead`/`afterTabFileEdit`
(autocomplete-grade noise; Tab is not agent work), `subagentStart/Stop` (v1.5 candidate
once flat capture is proven), `preCompact`.

Payload hygiene: `user_email` arrives in every payload and is **ignored** — identity is
the crosscheck API key from `crosscheck login`, never host-asserted identity.
`conversation_id`/`generation_id` map to session/turn. Cloud agents run project hooks on
machines with no `~/.crosscheck` login; the connector resolves no hub there and stays
silent — the same "unconnected directory talks to nobody" rule, no special-casing needed.

### 3.3 Injection path — hooks + MCP, rules files rejected

- **Briefing**: `sessionStart` → `additional_context` (documented as injected into
  initial context — the exact analog of Claude's `additionalContext`). Same
  `renderBriefing`, same ≤600-token budget.
- **In-session hints**: `postToolUse` → `additional_context`, injected into the
  conversation after the tool result. This anchors better than a prompt-time hint in one
  real case: a failing command whose fingerprint matches a teammate's recorded failure
  gets the hint delivered at the failure, not next prompt. Same selector, caps, seen-set,
  echo-exclusion, telemetry as everywhere else.
- **PULL**: `.cursor/mcp.json` gets the same `crosscheck mcp` server via the shared
  `mergeMcpConfig` (identical file shape, verified). Zero new MCP code; keep the tool
  count lean (community guidance caps combined tools ~40).
- **Rules files: rejected as an injection channel.** DESIGN.md §8 said "Cursor rules
  adapter"; the research says rules load is filesystem-based but git-exclusion leaks
  into it across versions/platforms (Cursor 2.1.50 dropping `.git/info/exclude`-listed
  rules on macOS: [forum thread](https://forum.cursor.com/t/cursor-2-1-50-ignores-rules-in-git-info-exclude-on-mac-not-on-windows-wsl/145695);
  earlier gitignore-skipping reports). A locally-generated, non-committed hints file is
  exactly the artifact that breaks there, hints would go stale between prompts, and two
  injection channels means two sanitize surfaces to audit. Hooks' `additional_context`
  is fresher, per-event, and already flows through the render pipeline. No rules file in
  v1 — not even as fallback.

### 3.4 Install story

`crosscheck init --cursor` (composable with the default Claude init):

- Non-destructively merges `.cursor/hooks.json` (preserving foreign hooks, filtering
  owned entries by launcher pattern — the settings-merge.ts discipline, new file shape)
  and `.cursor/mcp.json` (shared `mergeMcpConfig`). Timestamped backups beside both,
  like init does today.
- Both files are repo-committed → **install = the same one PR** as the Claude connector;
  teammates connect on `git pull` + existing `crosscheck login`. Cursor requires a
  trusted workspace for project hooks and hot-reloads both configs — no restart step.
- `crosscheck doctor` gains a Cursor section: hooks.json present + entries owned +
  launcher not in an ephemeral cache, mcp.json entry owned, last-seen `cursor_version`
  ≥ 1.7, hub liveness.

### 3.5 Uncovered, said out loud

- **No async push into a live session.** Context lands only when a hook fires. A
  teammate's finding recorded mid-turn arrives at the next `postToolUse`, not instantly.
- **No tripwire.** `preToolUse` accepts `"ask"` in schema but does not enforce it, and
  hooks fail open by default — a soft gate must not impersonate a hard one. When Cursor
  enforces ask, the escalation ladder is ready.
- **No statusline equivalent** — presence lives in the briefing and the hub `/ui`.
- **Composer context is a black box**: no API exposes what context the model actually
  received; we cannot verify our `additional_context` survived compaction.
- **Tab/Inline Edit invisible** (by our choice + platform rules: rules/hooks don't
  cover Tab meaningfully).
- **Cursor CLI hook gaps**: the CLI reportedly does not emit all hook events
  ([forum](https://forum.cursor.com/t/cursor-cli-doesnt-send-all-events-defined-in-hooks/148316)) —
  the adapter targets the IDE; Cursor CLI users get the ACP proxy instead, which is the
  better seam anyway.
- **Tier-1 summarizer deferred**: `transcript_path` exists and is the sanctioned read
  channel, but the summarizer is `claude -p`-shaped today; generalizing it is post-v1
  and consent-gated.
- **state.vscdb is never read.** Undocumented schema, version drift, full-transcript
  privacy blast radius; hooks provide everything Tier-0 needs.

---

## 4. Test strategy

### 4.1 Extraction safety (Blocks 1–2)

The bar for Block 1 is *zero assertion changes*: the existing 60+ test files pass with
only import paths rewritten. Block 2's rename adds: old-key state file parses through the
tolerant schema; new writes carry the new key; Claude `hostSessionKey` equals the raw
session id (byte-compat pin so the upgrade migration stays a no-op).

### 4.2 ACP proxy — fake client + fake agent around the real proxy

Three layers, cheapest first:

1. **Pure transform tests.** The proxy loop is built as a pure core:
   (chunk stream in) → (bytes to forward, capture actions out). Torture: chunk
   boundaries mid-JSON, many-messages-per-chunk, 10 MB single line, CRLF, invalid UTF-8,
   unknown methods, malformed JSON-RPC — all must forward byte-identically (hash both
   sides) with capture skipped and drops counted.
2. **Scripted-peer harness against a real in-process hub.** A fake ACP client and fake
   ACP agent (scripted NDJSON peers) drive the real proxy loop; the hub is the real
   server started in-process (existing `test/helpers.ts` pattern). Pinned:
   - session registered with `agent_kind` from `initialize`; targets from
     `tool_call.locations` and `fs/write_text_file`; fingerprints from failed tool calls
     and non-zero terminal exits;
   - **fingerprint parity**: the same failure text through the ACP path and the Claude
     hook path yields the identical `sha256:` value (cross-agent matching is the
     product; this test makes normalizer drift impossible);
   - injection: exactly one appended `mcpServers` entry / one appended prompt block,
     original user blocks byte-identical; `--no-inject` and version-≠1 negotiation →
     byte-identical passthrough (hash);
   - `session/load` replay → hub duplicate counters, zero new rows;
   - hint budget blown (hub answering slowly) → prompt forwarded unmodified within
     budget + margin;
   - `session/cancel` forwarded with no hub await on its path (assert forwarded-before
     any capture I/O completes).
3. **One subprocess E2E.** `Bun.spawn` the real binary wrapping a scripted fake-agent
   binary: child exit code mirrored, stderr forwarded, SIGTERM propagation, drain-on-exit
   flushes the spool. Plus `--record` (the proxy's own transcript recorder) replayed as
   golden fixtures — and used in the field to capture real Gemini/Cursor-CLI transcripts
   that become fixtures without hand-writing them.

### 4.3 Cursor — fake hook invocations against the real hub

- **Docs-excerpt contract fixtures**: snapshot the relevant Cursor hooks docs into
  `test/fixtures/cursor-contract/` (the existing `hook-contract/docs-excerpt-*.md`
  pattern) and pin payload parsing against fixture payloads derived from them; when
  Cursor renames a field, the contract test names the drift instead of hints silently
  dying (§10 risk 5's silent-death rule).
- Handler tests: stdin JSON → stdout JSON per event against the real in-process hub —
  register/targets/fingerprints/heartbeat/end, `additional_context` present exactly when
  a hint qualifies, **no `permission` field ever emitted**, `followup_message` never
  emitted, exit 0 always. Budget tests reuse the hook-budget clock-injection pattern.
- Init tests: hooks.json/mcp.json merges preserve foreign entries (settings-merge test
  shape), backups written, idempotent re-run.

### 4.4 The injection corpus on every new surface — enforced, not promised

The corpus (`injection-corpus.test.ts` + `scripts/mutation-check.ts`) moves to core with
the sanitizer. Two additions:

1. Each connector exports its render surfaces as data
   (`RENDER_SURFACES: {name, render(untrusted…): string}[]` — ACP briefing block, ACP
   hint block, Cursor `additional_context` briefing + hint; the ACP mcpServers `name`
   field is renderer-owned literal, listed as such). The corpus iterates every registered
   surface with every payload: framed output must carry the notice, sanitized text, and
   at most one « » pair per line; unframed output must be BARE- or ID-class.
2. A meta-test greps each connector for calls into the render layer outside its
   registered surfaces (the `BRANCH_PINS` pattern): a new render path that skips
   registration is a red build, which is what "non-negotiable" means mechanically.

### 4.5 Cross-connector E2E (Block 8)

One real hub; a Claude-connector session (fixture-driven hooks), a fake-agent ACP
session, and a fake Cursor session, all three live: presence lists three agent kinds;
an error fingerprint recorded by the ACP session surfaces in the Cursor session's hint
and the Claude session's briefing; `hint_deliveries` rows carry the right receiving
sessions; mute/presence-off visibility rules hold across connectors (the §2.1
visibility tests re-run with mixed agent kinds).

---

## 5. Block plan

Sized like the intelligence-layer blocks: each lands alone, green, reviewable, and
leaves the product shippable.

| # | Block | Contents | Done means |
|---|---|---|---|
| 1 | **Core extraction (mechanical)** | Create `packages/connector-core`; move spool, http, capture primitives, render+sanitize, MCP server+tools, state, git, config, constants; corpus + mutation-check move along; import rewrites in connector-claude and tests. Zero renames, zero behavior change. | Full existing suite green with zero assertion changes; `crosscheck doctor` output byte-identical. |
| 2 | **Identity generalization + kit** | `hostSessionKey` (tolerant schema, Claude byte-compat), connector prefixes, `agent_kind` threading, the `kit` facade (§1.3), surface-registration meta-test scaffold. | Compat pins green (old state files parse; Claude ids unchanged); kit documented in core README. |
| 3 | **ACP proxy skeleton** | `packages/connector-acp`; `crosscheck acp -- <cmd>`: transparent pipe, NDJSON splitter, stderr/exit/signal forwarding, log file, `--record`, drop counters. No capture, no injection. | Torture tests (§4.2 layer 1) + subprocess E2E green; usable today as a no-op wrapper in Zed. |
| 4 | **ACP Tier-0 capture** | Pending-map, wire schemas (`wire/v1.ts`), the §2.4 mapping: register/targets/fingerprints/terminal/fs-write/heartbeat/end+flush; per-session repo+hub resolution; replay idempotency. | Harness pins (§4.2 layer 2, capture half) incl. fingerprint parity; a wrapped real agent produces presence + targets on a live hub. |
| 5 | **ACP injection** | mcpServers append + launcher resolution; async-prefetched first-prompt briefing; per-prompt hints under budget; version gate + `--no-inject`; telemetry. | Injection pins + corpus on both new surfaces green; byte-identical passthrough proof when disabled. |
| 6 | **Cursor capture** | `packages/connector-cursor`; `cursor-hook` handlers for the §3.2 events; payload schemas; docs-excerpt contract fixtures; `init --cursor` merges + doctor section. | Handler + contract + init tests green against real hub; dogfood install in a real Cursor workspace produces presence + targets. |
| 7 | **Cursor injection** | `sessionStart`/`postToolUse` `additional_context` briefing + hints; caps/seen-set/echo-exclusion parity; corpus registration. | Corpus + handler pins green; live Cursor session shows the briefing (manual verify recorded). |
| 8 | **Cross-connector E2E + CLI extraction + docs** | §4.5 E2E; extract `packages/cli` (bin fronting three connectors + server, ending Block 1's named debt); per-editor install docs + `acp setup` snippets; DESIGN.md §7/§8 updated to match reality. | E2E green; npm artifact ships one `crosscheck` bin; docs merged in the same PR as the code they describe. |

Blocks 3–5 (ACP) and 6–7 (Cursor) are parallelizable after Block 2 if two people build —
with ONE serialization point Block 2 added: the §1.3 flow helpers shipped as documented
recipes, not extracted functions (extraction, not invention — no consumer existed yet), so
**extracting them from the Claude hooks is the entry step of whichever connector block
starts first**. Two parallel builders must not both extract (conflict) or both hand-roll
(drift); after that first extraction lands, the remaining blocks parallelize as stated.
Status note (2026-08-19, updated in Block 4): the entry step is DISCHARGED — Block 4
extracted `registerSessionFlow`, `captureFileTargets`, `captureFailure`,
`heartbeatMaybe` and `endSessionFlow` into `connector-core/src/flows/` (plus the shared
`extractFailureText` into `capture/failure-text.ts`), rewired the Claude hooks onto
them, and consumed them from the ACP capture engine.
Status note (2026-08-19, updated in Block 5): the REMAINING serialization point is
discharged too — Block 5 extracted `assembleBriefing` (+ `recordBriefingDeliveries`)
and `selectAndRenderHint` into `connector-core/src/flows/briefing.ts` / `flows/hint.ts`,
rewired `session-start.ts` and `user-prompt-submit.ts` onto them, and consumed them from
the ACP injector. The launcher-resolution rules moved from `cli/init.ts` to
`connector-core/src/config/launcher.ts` for the same reason (the mcpServers entry needs
them; connector-claude re-exports). Blocks 6–7 now parallelize freely.
Status note (2026-08-19, updated in Block 6): row 6 LANDED — `packages/connector-cursor`
with the seven §3.2 handlers over the kit flows, docs-excerpt contract fixtures
(source + fetch date in the headers), the contract-drift ledger + doctor section,
`init --cursor` (all-or-nothing with the Claude pair), and the `cursor-hook` bin
subcommand per the §1.2 named-debt arrangement. Two more mechanical extractions rode
ahead of it, same move-first rule: the hook budget family
(`connector-core/config/hook-budget.ts`) and the launcher health probes
(`config/launcher-check.ts`), both re-exported/wrapped by connector-claude with zero
assertion changes. Block 6 renders nothing (§4.4: no registered surfaces — the
registry meta-test verifies the claim); injection is Block 7. The §6 q4/q5 manual
dogfood on a real Cursor build remains OPEN and is a human's duty — checklist in the
package README.

---

## 6. Open questions only real-world testing can answer

1. **Do the majors emit `locations`/diff paths well enough?** Tool-call reporting is a
   SHOULD. Zed's UX depends on it so quality is reportedly high, but per-agent coverage
   (Gemini CLI, Copilot CLI, cursor-agent, claude-agent-acp) must be measured with
   `--record` in Block 4 — if an agent reports edits without paths, its Tier-0 capture
   degrades to fs/terminal signals and the doc for that agent should say so. The same
   `--record` pass must answer a resume question: cold `session/resume` WITH a `cwd` is
   pinned at the wire level (capture-hardening.test.ts), but an agent whose resume
   request omits `cwd` registers nothing — if any major does that, its doc must say so
   and the parser needs a fallback decision.
2. **Prompt-block append tolerance.** Spec-legal, but do any agents choke on an extra
   trailing text block, and how do Zed/JetBrains render the replayed history? Block 5
   dogfood decides whether briefing stays on the prompt path or moves MCP-only.
   *Block 5 implementation (2026-08-19), conservative until dogfood answers:* the
   appended block is a plain `text` ContentBlock, ALWAYS trailing, carrying the
   renderer output verbatim (the renderers' own self-identifying headers under
   QUOTED_DATA_NOTICE are the replay-honesty story — no second ACP-specific header
   was added). The single composition point is `connector-acp/src/inject/blocks.ts`
   (`acpPromptBlockText`, identity today), a registered §4.4 surface, so moving to
   MCP-only or adding framing later is one module + its corpus, not a hunt.
3. **mcpServers append vs agent MCP quirks.** Cursor-agent reads `.cursor/mcp.json` and
   team-level MCP is unsupported in its ACP mode — does a param-injected server register
   cleanly across agents, and does tool-count bloat degrade any of them?
   *Block 5 implementation (2026-08-19), conservative until dogfood answers:* the
   proxy only APPENDS to an `mcpServers` ARRAY the client already sent — a missing or
   non-array field is never invented (skip + log `no-mcpservers-array`); an existing
   entry named `crosscheck` is never clobbered or shadowed, whether owned
   (`already-present`) or foreign (`foreign-crosscheck-entry`); and only a cwd that
   resolves to a crosscheck-connected repo gets the entry at all. Every skip is one
   proxy-log line with its reason.
4. **Cursor `postToolUse.additional_context` semantics.** Documented as injected after
   the tool result — verify it reaches the model mid-turn (not next turn), and whether
   `postToolUse` fires on failed tools or only `postToolUseFailure` does (determines
   where the fingerprint-matched hint attaches). Verify on the teammate's exact build.
   *Block 6 implementation (2026-08-19), conservative until dogfood answers:* capture
   fingerprints failures on EVERY documented signal — `postToolUseFailure`'s
   `error_message`, a non-zero `exitCode` inside `postToolUse`'s stringified
   `tool_output`, and a TOLERATED (undocumented) numeric exit field on
   `afterShellExecution` — all through the one shared extractor, so whichever event
   reality fires produces the same hash and the hub's natural-key dedup absorbs
   overlap. The manual checklist a human must run on a real build is in
   `packages/connector-cursor/README.md` ("Manual dogfood"); a green CI is NOT that
   verification.
5. **Cursor event completeness per surface** (IDE vs cloud agents): the docs claim
   near-full cloud support; the six §3.2 events need a per-surface checklist run.
   *Block 6 note (2026-08-19):* the per-surface run is step 5 of the README
   checklist; the contract-drift ledger (`state/cursor-drift.jsonl`, doctor-visible)
   is the instrument — a payload lacking a mapped field degrades silently AND
   counts, so the checklist reads facts instead of impressions.
6. **Zed project-scoped `agent_servers`**: if `.zed/settings.json` honors it, the ACP
   proxy gains a committed-to-repo install path ("install = one PR") for Zed teams —
   test in Block 3, and if it works, `init --zed` becomes a cheap follow-up.
7. **Proxy under long sessions**: pending-map growth, spool size, and log rotation over
   a week of real use (bounded by design; measured before v1 ships). Two facts from the
   fixer round belong to this question: (a) the in-memory seen-set now carries the same
   `MAX_SEEN_TARGETS` FIFO bound as the persisted state, so it no longer grows with the
   session; (b) MEASURED 2026-08-19 — a hard-killed proxy (SIGKILL, no shutdown drain)
   leaves one immortal residue per live session: the session-state file makes
   `isSessionLive` true forever, which gates reap out of both its delivered-removal and
   age-expiry branches, so the state+spool+cursor triple and the open hub session are
   never reclaimed. Inherited core behavior (latent for the Claude connector too), far
   more reachable from a long-lived proxy. Not data loss — the spool was flushed live —
   but the fix (a liveness token in `SessionState`, or an age sweep of the sessions
   dir) must land before v1 ships.

---

## 7. Sources

Protocol/state-of-world (all fetched 2026-08-18 unless dated): ACP
[overview](https://agentclientprotocol.com/protocol/v1/overview) ·
[initialization](https://agentclientprotocol.com/protocol/v1/initialization) ·
[session-setup](https://agentclientprotocol.com/protocol/v1/session-setup) (mcpServers +
session/load shapes re-verified directly) ·
[prompt-turn](https://agentclientprotocol.com/protocol/v1/prompt-turn) ·
[tool-calls](https://agentclientprotocol.com/protocol/v1/tool-calls) ·
[transports](https://agentclientprotocol.com/protocol/v1/transports) ·
[extensibility](https://agentclientprotocol.com/protocol/v1/extensibility) ·
[terminals](https://agentclientprotocol.com/protocol/v1/terminals) ·
[v2 draft](https://agentclientprotocol.com/announcements/acp-v2-draft) (2026-07-20) ·
[proxy-chains RFD](https://agentclientprotocol.com/rfds/proxy-chains) (Draft 2025-12-31) ·
[session-notices RFD](https://agentclientprotocol.com/rfds/session-notices) ·
[agents list](https://agentclientprotocol.com/get-started/agents) ·
[governance](https://agentclientprotocol.com/community/governance). Zed:
[external agents](https://zed.dev/docs/ai/external-agents) (`agent_servers` custom shape
re-verified directly). JetBrains: [ACP docs](https://www.jetbrains.com/help/ai-assistant/acp.html) ·
[blog](https://blog.jetbrains.com/idea/2026/08/how-to-use-ai-agents-in-intellij-idea-with-acp/).
Cursor: [hooks](https://cursor.com/docs/hooks) · [rules](https://cursor.com/docs/rules) ·
[MCP](https://cursor.com/docs/mcp) · [CLI ACP](https://cursor.com/docs/cli/acp) ·
[JetBrains launch](https://cursor.com/blog/jetbrains-acp) (2026-03-04) · forum evidence on
rules/gitignore drift and CLI hook gaps (links inline above). Internal: DESIGN.md §2–§5,
`packages/connector-claude/src` (session-start, post-tool-use, spool, hub client,
sanitize/render, session-state, mcp/session), `packages/schema/src` (envelope, session)
— read 2026-08-18.
