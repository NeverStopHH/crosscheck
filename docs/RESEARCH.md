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
