# Research Digest — 2026-07-24

Condensed from a 10-agent research/design workflow (5 research passes, 3 independent architects, 2 adversarial judges). Full raw output: [research/raw-workflow-output.json](research/raw-workflow-output.json).

## 1. Prior art — the five clusters

Nobody combines cross-user diagnosis sharing with proactive injection. The landscape:

| Cluster | Representatives | What they have | What they lack |
|---|---|---|---|
| File-collision coordinators | Overlap (overlap.dev), Drift (SaaS), asynkor, mcp_agent_mail (2k★), ai-team-sync, Parachute | Cross-user presence, file/glob leases, block/warn before edit | Knowledge stops at file paths; no hypotheses, no evidence, no semantic matching |
| Team memory layers | omem/ourmem, ByteRover/Cipher (4.9k★), Mem0 org-scope (61k★), Letta, Zep, Cognee, ~12 tiny team-memory MCPs | Cross-user persistent memory, semantic search; omem even does session-start push-injection | Generic facts/decisions — no in-flight work model, no hypothesis lifecycle, no conflict detection |
| Session sharers | Entire CLI ($60M seed, 4.8k★), Lore (Tanagram), Amp workspaces, Claude Code native share | Cross-user visibility of what an agent did; fork/handoff | Retrospective (keyed to commits/manual share) — exactly the "too late" point we attack |
| Git-synced work graphs | beads (25k★), Backlog.md, CCPM (8k★) | Team-shared issue/task graphs via git — proven distribution model | Issue granularity, git-sync latency, no semantic layer, no injection |
| Single-user orchestrators | claude-flow/ruflo (65k★), claude-swarm, vibe-kanban (27k★), Conductor, Gas Town (17k★), Agent Teams | One dev's many agents; shared blackboards work when tools make them trivial | Nothing crosses machines/users |

**Market signal:** every true cross-user coordination attempt is <100 stars and stalled within ~2 months (Overlap, asynkor, tempo-agents, Parachute, ai-team-sync) — demand validated by repeated independent invention plus Drift/Entire raising money on adjacent theses, but no open-source project has credibly landed it. The >4k-star projects all sit in other clusters. A bare "team memory MCP" is commoditized — never position as that.

**Borrow list:** Overlap/.track's passive hooks/JSONL capture (zero agent compliance) · asynkor's MCP tool vocabulary (briefing/start/check/park/ask) · omem's reconciliation verbs (SUPERSEDE/SUPPORT/CONTRADICT) · mcp_agent_mail's advisory leases + pre-commit guard spectrum · tempo-agents' escalation ladder + local intent fingerprints · beads/Entire's git-as-transport (as optional export) · Lore's "fork with distilled handoff" UX · ai-team-sync's decision-record schema (choice/considered/reason).

## 2. Protocols & industry

- **Google A2A** (Linux Foundation, 150+ orgs): service-to-service task delegation between network-addressable agents — wrong topology for laptop CLI sessions. **Ignore for MVP**; keep question/answer payloads self-contained JSON so they could ride an A2A extension later.
- **IBM ACP**: merged into A2A Aug 2025. Dead — ignore.
- **AGNTCY** (Cisco→LF): enterprise agent service mesh. Ignore; at most crib OASF-style capability metadata.
- **Zed's Agent Client Protocol (ACP)** — the sleeper hit: editor↔agent JSON-RPC adopted by JetBrains, Zed, 25+ agents (Claude Code, Gemini CLI, Codex, Copilot, Goose; Devin Desktop June 2026). One ACP **proxy connector** = agent-agnostic observation for every ACP agent. Phase-2 bet.
- **MCP** (2026-07-28 spec goes stateless): an MCP server **cannot push unsolicited context** into a session — MCP is the pull channel (tools/resources/elicitation for approval gates). Push must ride per-agent adapters: Claude Code hooks (`additionalContext`) are the only reliable unsolicited-injection path. Claude Code's experimental `claude/channel` capability (preview-gated) may become a push option later.
- **Commercial team context** (Cursor team rules/memories, Copilot Spaces, Devin Knowledge/Spaces, Sourcegraph): all share *curated or learned* knowledge; none shares *live in-flight* work state. Devin Desktop is the closest competitor trajectory. Demand evidence: anthropics/claude-code#38536 "Shared Team Memory".
- **OTel GenAI semconv**: still unstable; align observation-event *attributes* (`gen_ai.*`, pinned version) for free exportability, but never model the diagnosis graph on telemetry conventions.

## 3. Claude Code integration surface (verified locally + docs, 2026-07-24)

- **Hooks**: rich event set; injection-capable (`additionalContext`): SessionStart, UserPromptSubmit, PreToolUse, PostToolUse(+Failure/Batch), Stop, SubagentStop, SubagentStart, Setup. Blocking-capable: UserPromptSubmit, PreToolUse (`permissionDecision: allow|deny|ask` + `updatedInput`), Stop, PreCompact. `async: true` runs hooks non-blocking with output delivered next turn. HTTP hooks can call a remote service directly. Hooks distribute via committable `.claude/settings.json` — the team install vector.
- **Transcripts**: `~/.claude/projects/<slug>/<session>.jsonl`, append-only, per-record `cwd` + `gitBranch`; subagent transcripts nested. Tailable but privacy-hot and schema-unstable → not the MVP capture path.
- **MCP**: project-scope `.mcp.json` (committable), stdio/HTTP/SSE/WS transports; tools pull-only (channels push is preview-gated).
- **Behavior shaping reliability**: hook-injected system reminders > skills > CLAUDE.md.
- **Statusline**: arbitrary script fed rich session JSON — ideal zero-token teammate-presence + health display. Headless `claude -p` enables a summarizer that reuses the dev's existing auth.
- **Capture/injection verdict**: ship **B+C+D then E** — Stop-hook summarization (S effort), SessionStart/UserPromptSubmit injection (S/M), MCP tool suite (M), PreToolUse tripwire (S); skip transcript-tailing daemon (privacy blast radius, unstable schema).

## 4. Storage / search / realtime

- **Postgres 17 + pgvector as the only store.** No Redis (LISTEN/NOTIFY + outbox covers 50-dev realtime with durability Redis pub/sub lacks), no second datastore, no graph DB (edges-as-rows + recursive CTE). Drizzle over Prisma (native vector/tsvector support, SQL escape hatch for RRF/CTEs). SSE over WebSockets (auto-reconnect via `Last-Event-Id` = outbox cursor; polling as degraded mode). Per-dev API keys, not shared team tokens.
- **Architect A's amendment (judge-endorsed): PGlite + pgvector embedded** in the server process for the zero-Docker `npx` install, `DATABASE_URL` flip to real Postgres — one dialect, two runtimes. Needs a concurrency load-test (single-connection WASM) before it's confirmed as default.
- **Hybrid search from day one**: exact entity overlap (files/symbols/error fingerprints — highest precision, free) + Postgres FTS + optional pgvector, RRF-fused. Embeddings over a **normalized doc** (title/symptoms/components/hypothesis summaries), never raw transcript — raw-session embeddings collapse into boilerplate similarity. Pluggable models: OpenAI text-embedding-3-small @768d (hosted) / Ollama nomic-embed-text (local); keyless degrades to FTS + exact.
- **Do not build in v0**: Redis, WS, graph DB, ParadeDB/BM25, rerankers, multi-model embedding columns, multi-tenancy, SSO, approval workflow UI, Python server, K8s.

## 5. Design synthesis (how DESIGN.md §2–4 was chosen)

Three architects (A adoption-first, B protocol-first, C capture-quality-first) scored by two judges (adoption lens: A 41, C 41, B 38; technical lens: C 40, A 39, B 38). Converged verdict:

- **Shell from A**: npx + PGlite, no daemon, no Docker, no new API keys, statusline wow, one-PR install, fail-open + spool.
- **Capture/injection machinery from C**: three-tier trust ladder, gated summarizer, ingest dedup gate ("never auto-merge across authors"), hint_deliveries precision telemetry, pointers-proactive/substance-pulled, contradiction candidates.
- **Schema discipline from B**: declared/derived provenance with 0.5 confidence cap on derived claims, commit-drift labels vs the reader's HEAD, forward-compat versioned envelope, evidence-required `likely_root_cause` — but **no frozen public spec until a second adapter exists** (LSP won via a dominant implementation, not a spec repo).
- **Judge-found gaps now mandatory in v0/v0.5**: summarizer echo-loop exclusion, claim-body sanitization at injection (cross-user prompt injection), self-session/worktree exclusion, hot-file denylist, `doctor` + last-sync health surface, idempotent event ordering (closed sessions reject late spool writes), summarizer quota caps, presence-visibility opt-out (surveillance/works-council), golden-fixture eval corpus for cold-start thresholds, retention policy for unbounded growth.

## 6. Naming trail

German round (all registries checked): lagebild (all free — recommended), schwarmgeist, flurfunk, myzel. Nick wanted English. English round: most single words taken (stigmergy, understory, hivemind, murmuration, crosstalk, partyline, waggle — all claimed, several by adjacent projects). Free on npm: shoptalk, **crosscheck**, commonground, teamsense, fieldreport, backbrief, hivewire. **Chosen: crosscheck** (npm free; GitHub org `crosscheck` exists but tiny/4 repos → use an org variant or scoped packages; aviation mutual-verification metaphor matches the product). Trademark check (EUIPO/USPTO) still open before going public.

## 7. Which hook output a PERSON sees, per host (primary sources, fetched 2026-10-07)

Why it was asked: in the 2026-10 pilot two teammates edited 11 of the same files on different branches over three days; crosscheck delivered 2 tripwire asks and 155 prompt pointers, all into an AGENT's context, and no agent relayed one. 91% of the owner's edits were made by subagents. DESIGN.md §4 ("Collisions reach the person") is what was built from these findings.

**Claude Code** — [hooks reference](https://code.claude.com/docs/en/hooks), [statusline](https://code.claude.com/docs/en/statusline), [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md):

- `systemMessage` is a universal JSON output field: *"Warning message shown to the user. In Agent SDK and `--output-format stream-json` output, it can arrive as an `SDKInformationalMessage`"*; *"To surface a message to the user on any platform, return `systemMessage`"*. *"Every event accepts them, but some events discard them"* — the discarding events are Setup, InstructionsLoaded, Notification, MessageDisplay, ConfigChange and WorktreeRemove; **PreToolUse, PostToolUse, UserPromptSubmit and SessionStart are not among them**. Added in 1.0.64 (*"Hooks: Added systemMessage field to hook JSON output for displaying warnings and context"*). Capped at 10,000 characters like `additionalContext`.
- `additionalContext` *"doesn't appear as a chat message in the interface"* — at the start of the conversation (SessionStart), *"alongside the submitted prompt"* (UserPromptSubmit, where *"Neither channel produces a visible transcript entry"*), *"next to the tool result"* (PreToolUse/PostToolUse). This is why every collision crosscheck had stayed agent-only.
- PreToolUse `permissionDecisionReason`: *"For `"ask"`, shown to the user in the permission prompt… For `"deny"`, shown to Claude"*; a `-p` run auto-denies the ask and Claude reads the reason. In `CROSSCHECK_TRIPWIRE=notice` mode there is no prompt at all, so before `systemMessage` the person saw nothing in either case that matters.
- **Async hooks never reach the person**: *"Claude Code delivers the `additionalContext` and `systemMessage` fields from the hook's JSON response to Claude on the next conversation turn. Unlike a synchronous hook's `systemMessage`, neither field is shown to you."* crosscheck's PostToolUse and Stop are registered async, so the notice rides the SYNC hooks only: PreToolUse, SessionStart, UserPromptSubmit.
- **Subagents**: tool events *"fire the same configured hooks as in the main conversation, and the input carries the `agent_id` and `agent_type` common input fields"*; `agent_id` is *"Present only when the hook fires inside a subagent call"*, and the session id is the parent's. **NOT CONFIRMED**: no page says where a subagent hook's `systemMessage` renders, and subagents run in the background by default. So a subagent's hit is also queued for the main thread's next UserPromptSubmit — which *"also runs them on … A background subagent reporting back to the session that started it"*.
- **Terminal vs VS Code**: *"Claude Code fires the same hook events wherever it runs: sessions in the terminal, IDE extensions, the Desktop app…"*. **NOT CONFIRMED**: neither the hooks page nor [the VS Code page](https://code.claude.com/docs/en/vs-code) documents how `systemMessage` renders in the extension's panel — verify by hand on the next pilot install.
- **Statusline**: stdin carries `session_id` (*"Unique session identifier"*), `cwd` and `transcript_path`; it re-runs on a new assistant message, `/compact`, a permission-mode change and similar, and *"Claude Code debounces updates at 300ms"*. Not documented for the graphical VS Code panel (the README already states: no statusline in VS Code-extension or headless sessions).

**Cursor** — [cursor.com/docs/hooks](https://cursor.com/docs/hooks): no event this connector registers has an output field shown to the person WITHOUT blocking. `user_message` is *"Message shown to the user when the action is denied"* (preToolUse, beforeReadFile, subagentStart), *"shown to the user when the prompt is blocked"* (beforeSubmitPrompt), part of a permission prompt that pauses the action (beforeShellExecution / beforeMCPExecution with `ask`), or *"Message to show to the user when compaction occurs"* (preCompact — the wrong moment). sessionStart: *"The schema also accepts `continue` and `user_message` fields, but current callers do not enforce them."* afterFileEdit has no output at all. **Gap**: printed by `crosscheck doctor` as a refusal in the Cursor capability manifest; the ghost rows still reach the agent through `additional_context`.

**ACP** — [v1 schema](https://agentclientprotocol.com/protocol/v1/schema), [Session Notices RFD](https://agentclientprotocol.com/rfds/session-notices): the stable `SessionUpdate` kinds are `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update` and `usage_update` — no notice kind. The only universally visible text is `agent_message_chunk`, which the RFD itself calls a fallback that would *"pollute conversation history"* and which the proxy refuses to forge (DESIGN-agent-agnostic.md §2.5). The proposed `notice` update is Preview: *"The feature remains behind `unstable_session_notices` and is not included in the stable schemas"*, and agents *"MUST NOT send `notice` updates to a v1 Client unless it advertises"* `clientCapabilities.session.notices`. **Gap** until that stabilizes: printed as a refusal in the ACP capability manifest.
