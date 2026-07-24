# Crosscheck — Design v0.1

Status: draft, 2026-07-24. Synthesized from three independent architecture passes (adoption-first, protocol-first, capture-quality-first) and two adversarial reviews. See [RESEARCH.md](RESEARCH.md) for the evidence behind every verdict referenced here.

## 1. Problem and wedge

Developers on the same team each run their own coding agent. Most work happens locally — uncommitted, unpushed, often unfinished — so neither teammates nor their agents know what is being investigated, planned, or changed in parallel. Git surfaces overlap only at merge time, only at file granularity. The expensive collisions are semantic: two people debugging the same symptom with different root-cause theories, contradictory fixes in different files, duplicated investigation.

The prior-art sweep (RESEARCH.md §1) shows the landscape splits into five clusters — file-collision coordinators, team-memory layers, session sharers, git-synced work graphs, single-user orchestrators — and **nobody occupies the intersection we target**:

1. A **living diagnosis graph**: observation → hypotheses (with status) → evidence → root-cause chain → rejected approaches, which agents of *different* developers can extend and contradict rather than overwrite.
2. **Semantic matching of in-flight work** across different vocabulary ("login 500s" ≈ "JWT validation regression").
3. **Proactive injection** of a teammate's relevant findings into a live session (hook-driven push, not inbox-checking).
4. **Diagnostic conflict surfacing**: two open, contradictory root-cause theories for the same symptom.

Positioning: *"GitHub sees the past; crosscheck sees the present."* We are explicitly **not** another team-memory MCP (commoditized, 0–30-star graveyard), not an orchestrator for one developer's agents, and not a session-transcript sharer.

## 2. Architecture

Hub-and-spoke. No peer-to-peer agent messaging (wrong topology per protocol research). One TypeScript monorepo.

```
 Dev A machine                                Dev B machine
┌───────────────────────────┐               ┌─────────────────────┐
│ Claude Code               │               │ Claude Code         │
│ ├ hooks: capture + inject │               │ ├ hooks             │
│ ├ MCP tools (diagnosis)   │               │ ├ MCP tools         │
│ ├ statusline: presence    │               │ └ statusline        │
│ └ spool ~/.crosscheck/    │               │                     │
└──────────┬────────────────┘               └─────────┬───────────┘
      HTTPS + SSE (Last-Event-Id cursor)         HTTPS + SSE
           └───────────────┬──────────────────────────┘
                 ┌─────────▼──────────────────────┐
                 │ `npx crosscheck serve`         │
                 │ Hono API · SSE · outbox events │
                 │ PGlite+pgvector │ or Postgres  │
                 │ presence · claims · hybrid RRF │
                 └────────────────────────────────┘
```

Key shell decisions (adoption-first pass, confirmed by both judges):

- **Server**: single process, `npx crosscheck serve`, with **PGlite + pgvector embedded** — no Docker, no DB install. `DATABASE_URL` flips the same Drizzle code to real Postgres for larger teams. One Postgres dialect, two runtimes. *Open validation item: PGlite is single-connection WASM — load-test concurrent ingest + SSE + vector search before v0 ships; if it can't hold the hook latency budget, docker-compose Postgres becomes the default and PGlite the solo-trial mode.*
- **No local daemon.** The connector is hook scripts + an MCP server — short-lived processes only. Offline writes spool to `~/.crosscheck/` and flush on the next hook invocation.
- **Realtime**: SSE with `Last-Event-Id` cursor over an **events outbox table** (durable replay; NOTIFY/in-process emitter is only a latency optimization). No Redis, no WebSockets, no queues.
- **Auth**: per-developer API keys (provenance is a core feature; shared team tokens destroy attribution and revocability). TLS via reverse proxy or Tailscale — documented, not built.
- **Install** = one PR: `crosscheck init` writes `.claude/settings.json` (hooks, statusline) + `.mcp.json` (project scope) into the team repo. Every teammate is connected on next `git pull` + one `crosscheck login <url>`.
- **Summarizer auth**: reuses the developer's existing Claude Code auth via headless `claude -p` (Haiku-class). No new API key — a silent adoption killer removed.

### 2.1 Scoping & trust boundaries

Who can talk to whom is decided by infrastructure, not by a toggle someone can misconfigure:

- **Agents never talk to each other directly.** Everything flows through a hub. There is no global agent network and deliberately no "talk to anyone" mode — that would be the trust disaster this section exists to prevent.
- **One hub = one trust space.** A hub is started per project or group (`npx crosscheck serve` on any teammate's machine + Tailscale, or a small VPS). Company affiliation is irrelevant: a "team" is exactly the set of people holding keys to a hub. A developer can be in any number of hubs (work team, side project with a friend) — those spaces are separate infrastructure and know nothing of each other.
- **The repo decides where a session reports.** The connector is enabled per repository: `crosscheck init` writes the hub URL into the repo's committed config. A session in the work monorepo talks to the work hub, a session in the side-project repo talks to the side-project hub, a session in any unconnected directory talks to nobody. Nothing runs 24/7 on the developer's machine — hooks only execute while a session is active; only the hub is long-running.
- **People join by invitation only.** Per-developer API keys (`crosscheck invite` on the hub, one-time `crosscheck login <hub-url> <key>` per developer), individually revocable.
- **Within a hub, sharing has defaults and gates:** only structured claims, file paths, and hashed error fingerprints by default — never raw transcripts or full diffs; artifacts default to `needs_approval` (owner-only until released); per-developer presence opt-out and `mute`; local secret-scan before every upload. v0 exposes these controls via CLI, v0.5 adds the web UI (feed, member list, click-to-approve).
- **Later, not v0: per-repo ACLs within one hub.** Until then the rule is simple: different trust requirements → different hubs.

## 3. Capture pipeline (knowledge OUT)

Three-tier trust ladder (capture-first pass — "tier = trust"):

**Tier 0 — deterministic signals.** Zero LLM, zero tokens:
- `SessionStart` hook → register session: repo (by remote URL, not path), branch, base commit, developer, agent kind. Fails open in 400 ms.
- `PostToolUse` (async) on Edit/Write → record file targets; symbols via a cheap tree-sitter pass. Doubles as heartbeat.
- `PostToolUse` on Bash → failing output becomes an **error fingerprint** (stack trace with line numbers/UUIDs/paths stripped, SHA-256). Highest-precision cross-session match signal, costs nothing.

**Tier 1 — draft claims (v0.5).** A **gated** Stop-hook summarizer: fires only when the turn matches diagnosis-moment heuristics (test ran, error output, hypothesis language), debounced ≥2 turns apart, capped at 6/session. Headless `claude -p` over the turn's transcript slice emits schema-validated claim JSON or `NONE`. Drafts get `capture_mode='auto'`, `provenance='derived'`, **confidence hard-capped at 0.5**, and are **never proactively injected** to teammates — only surfaced as pull-able pointers. A promotion loop (SessionStart reminds the agent of its own unreviewed drafts → confirm/edit/discard) turns passive capture into agent-verified knowledge without developer effort.

**Tier 2 — published claims.** MCP tools, the authoritative record (`provenance='declared'`):
`publish_claim`, `extend_diagnosis` (add a claim + typed edge to *someone else's* tree — "your root cause is my symptom" = new claim + `deeper_cause_of` edge), `search_related_work`, `get_diagnosis` (full tree as markdown), `share_artifact` (sensitivity-gated). MCP invocation is unreliable on its own, so hook-injected reminders nudge at diagnosis moments.

**Ingest gate (server-side):**
- Same context, same entities, cosine > ~0.93 → no new row; bump `dedup_count` + `last_seen` (15 re-observations of one error = one weighted claim, not 15 rows).
- Cross-session near-duplicate → keep both, auto-add `relates_to` edge. **Never auto-merge across authors — provenance is the product.**
- High similarity + opposite status → flag as **contradiction candidate** for briefings (the deterministic version of "diagnostic conflict detection").
- Secret-scan (gitleaks-style patterns) on all bodies **locally before upload**; schema-reject malformed records.
- **Echo-loop exclusion** (judge-found, mandatory): content injected as teammate hints is marked and excluded from summarizer capture, so Robin's hypothesis can never be re-captured as Nick's independent observation.

Raw transcripts and full diffs never auto-upload. Artifacts (logs, stack traces, diff summaries) default to `needs_approval` — owner-only until released via CLI/elicitation.

## 4. Injection pipeline (knowledge IN)

Principle: **pointers proactive, substance pulled, negatives privileged.** Anchoring a healthy agent on a teammate's wrong hypothesis is worse than silence.

- **SessionStart briefing** (`additionalContext`, ≤600 tokens): active teammates on this repo, top related work contexts (entity overlap ≻ error-fingerprint match ≻ hybrid FTS+vector RRF), open contradictions in this area, recently landed outcomes.
- **UserPromptSubmit** (≤1 hint, ≤300 tokens, <800 ms sync budget, fail-open): fast path is entity overlap + FTS; vector results arriving late are delivered next turn via an async hook. Below the precision threshold: **silence**.
- **Anchoring asymmetry**: proactively inject only (a) `rejected_approach` with evidence — negative knowledge cannot anchor a wrong theory, only save a dead end — and (b) `likely_root_cause`/confirmed claims (which require ≥1 evidence link to reach that status). Bare `proposed` hypotheses and Tier-1 drafts appear only as one-line pointers the agent must deliberately pull via `get_diagnosis`.
- **Trust labels on every hint, normative**: author, age, hypothesis status, confidence, provenance (declared/derived), and **commit drift computed against the reader's HEAD** ("based on a commit 14 behind yours"). Phrased as factual statements, never imperatives (matches Claude Code prompt-injection guidance).
- **Sanitization at render time** (judge-found, mandatory): claim bodies are teammate-authored/LLM-derived text and therefore untrusted input in the reader's context — length-cap, strip imperative/injection patterns, render inside a clearly delimited quote frame.
- **Self-session exclusion + hot-file denylist** (judge-found): a developer's own parallel sessions/worktrees never trigger their presence hints or tripwires; lockfiles, generated clients, and schema files are denylisted/down-weighted for overlap detection.
- **Statusline** = human-facing presence ("Robin → handler.ts · debugging active-seat column") **plus a `last sync 2m ago` health indicator** — fail-open must never mean silently dead.
- **PreToolUse tripwire** (v0.5): file+symbol overlap with an *active* teammate session → `permissionDecision: "ask"` with reason. Escalation ladder: silence → notice → ask. Never hard-deny.
- **Telemetry from day one**: `hint_deliveries` records every injected hint; a subsequent `get_diagnosis` pull marks it useful. This is the measurable precision loop that tunes thresholds — plus a pre-launch golden-fixture corpus, because a 2-dev team will not generate tuning volume for months.

## 5. Data model

Postgres (PGlite or real), Drizzle as the single migration authority. Append-only where knowledge lives.

- `developers` (id, name, email, api_key_hash)
- `agent_sessions` (developer, agent_kind, repo, branch, base_commit, status: analyzing|planning|implementing|testing|blocked|done, last_heartbeat_at) — presence = heartbeat < 90 s, TTL by query; closed sessions reject late writes (idempotency keys on spool replay)
- `work_contexts` (session, title, intent jsonb, status, normalized_doc, tsv generated, embedding vector(768) nullable)
- `work_context_targets` (kind: file|symbol|component|error_fingerprint, value) — the deterministic overlap index
- `claims` (work_context, author_session, kind: observation|hypothesis|evidence|root_cause|decision|rejected_approach, body ≤400 chars, status: proposed|partially_confirmed|likely_root_cause|rejected|superseded, confidence, capture_mode: auto|agent|human, provenance: declared|derived, dedup_count, last_seen_at, stale_at, tsv, embedding) — append-only; revision = new claim + `supersedes` edge
- `claim_edges` (from, to, kind: supports|contradicts|deeper_cause_of|supersedes|relates_to, author, note) — recursive CTE walks root-cause chains; no graph DB
- `artifacts` (claim, kind: log|stack_trace|diff_summary, content, sensitivity: team_visible|needs_approval, approved_by)
- `events` (bigserial, kind, payload) — outbox; SSE replays by cursor
- `hint_deliveries` (session, claim/work_context, delivered_at, pulled_at) — dedup + precision telemetry

Wire format discipline (protocol-first pass, internal for now): every record in a versioned envelope `{cx: "0.1", id, ts, producer, kind, body}`; consumers must ignore unknown fields and kinds. Published as zod schemas in `packages/schema` from day one so the protocol is *extractable* later — but **no frozen public spec and no conformance suite until a second adapter exists** (both judges: premature standardization is the protocol-first trap; LSP won because VS Code shipped, not because the spec existed).

Staleness model: heartbeat TTL kills ghost presence; time-decay ranking (half-life ~14 days); merged-branch detection (base_commit reachable from main ⇒ context marked *landed*); claims marked stale when their referenced files change on main afterward; commit drift shown on every hint. Nothing is deleted — rejected and stale claims remain queryable history (the long-term team-memory byproduct) but stop being hints. Retention/compaction policy is an open item before public launch.

## 6. Semantic search

Hybrid from day one, but with honest degradation:
- Exact matching on files, symbols, error fingerprints (no embeddings needed — highest precision).
- Postgres FTS (`websearch_to_tsquery`) over the **normalized doc** (title + symptom phrases + components + hypothesis summaries — never raw transcript).
- Optional vector layer, RRF-fused: OpenAI `text-embedding-3-small` truncated to 768d (hosted default) or Ollama `nomic-embed-text` (local default), pluggable; model change = re-embed migration. **With no key configured, matching degrades to FTS + exact targets and still works** — no mandatory external dependency in the default install.

## 7. Repo layout

```
crosscheck/
  packages/
    schema/             zod types + versioned record envelope = the wire contract
    server/             Hono API · SSE · outbox · hybrid search · hint ranker
                        (PGlite embedded | DATABASE_URL → Postgres)
    connector-claude/   hook scripts · MCP server · summarizer runner · spool
    cli/                crosscheck: serve|init|login|status|approve|mute|doctor
  apps/
    web/                v0.5: read-only feed + approvals UI
  docs/
  examples/
```

TypeScript-only (Bun). Python appears only ever as a generated HTTP client, later.

## 8. Roadmap

**v0 (≈2 weeks, ruthless):** `crosscheck serve` (embedded PGlite) · `init`/`login` · session registration + heartbeat presence · statusline with presence + last-sync health · Tier-0 capture (targets, fingerprints) · Tier-2 MCP tools (publish/extend/search/get_diagnosis) · SessionStart briefing · UserPromptSubmit injection (FTS + exact targets; vectors if key present) · exact-overlap warnings · ingest dedup gate · hint_deliveries · spool + fail-open everywhere · `approve` + `doctor` CLI. **No** web UI, no PreToolUse gating, no LLM summarizer.

**v0.5:** Tier-1 gated draft summarizer + promotion loop · PreToolUse tripwire (ask-mode) · contradiction surfacing in briefings · web feed + approval UI · threshold tuning from telemetry + golden fixtures · **go public**.

**v1:** **ACP proxy connector** (one connector for all Agent-Client-Protocol agents — Zed, JetBrains, Gemini CLI, 25+; the agent-agnostic bet) · Cursor rules adapter · MCP channels push (when out of preview) · OTel `gen_ai.*` export of observation events · git-JSONL transport export for server-averse teams · extracted public spec + conformance fixtures (now that a second adapter exists).

## 9. Non-goals (v1)

- Automatic semantic/architectural conflict **inference** — deterministic overlap + explicit `contradicts` edges + contradiction candidates deliver most of the value; inference is a research project (tempo-agents died trying).
- Agent-to-agent chat/questions — wrong topology; payloads stay A2A-extension-shaped for later.
- Transcript-tailing daemon — Stop-hook capture dominates; raw-transcript privacy blast radius not worth crash-capture.
- General team memory as headline; Redis/queues/WebSockets/graph DB; multi-team tenancy, SSO, per-repo ACLs; auto-merged "team truth" across authors; shared cloud workspaces; hosted SaaS.

## 10. Top risks

1. **Noise → trust collapse → uninstall.** Hard budgets (1 hint/prompt, 5/session), silence-when-unsure, negatives-first, seen-set dedup, telemetry-tuned thresholds, per-dev mute, ask-never-deny.
2. **Cross-user prompt injection via the claim store.** Claim bodies are untrusted input: sanitize + length-cap at render, quote-frame, factual-statement wrapper; never render imperatives.
3. **Privacy.** Summarization and entity extraction run locally; only structured claims + hashed fingerprints + paths upload; secret-scan before POST; artifacts owner-gated; per-dev revocable keys; fully self-hosted. Presence is also a surveillance surface — per-dev visibility opt-out is a v0.5 requirement, not an afterthought (EU works-council reality).
4. **Capture quality.** Tier ladder, derived-confidence cap 0.5, ingest validation + dedup, promotion loop, golden-transcript CI fixtures.
5. **Silent death.** Fail-open everywhere + a sleeping-laptop host means hints can stop invisibly: statusline last-sync indicator + `crosscheck doctor` (verifies hook contract against the installed Claude Code version + hub liveness) are v0 features.
6. **Staleness/drift.** TTL presence, decay, landed detection, commit drift vs the reader's HEAD — including the inverse case where the teammate's fix already reached your branch via rebase.
7. **Summarizer cost on the dev's own quota.** Gating, debounce, per-session caps, and a visible per-day token estimate.

## 11. Open questions

- License (MIT vs Apache-2.0) before going public.
- PGlite concurrency validation outcome (see §2) — may flip the default deploy story.
- Embedding default: ship keyless-degraded as default, or prompt for a key during `init`?
- First dogfood team and success metric (proposal: hint-precision ≥ 0.5 pulled/delivered and ≥1 documented prevented collision per week).