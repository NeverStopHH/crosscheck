# @crosscheck/connector-core

The agent-agnostic core every crosscheck connector is built on: offline spool, hub client, capture primitives, session state, the render + sanitize discipline, and the MCP server. Extracted from `@crosscheck/connector-claude` (design: `docs/adapters/DESIGN-agent-agnostic.md` §1); this README is the **kit contract** §1.3 demands — the narrow surface a new connector programs against.

Everything here **fails open**, same bar as the Claude connector: any error, timeout, or unreachable hub degrades to silence, never to a broken session.

## The kit

```ts
import { loadConfig, registerSession, appendRecords /* … */ } from "@crosscheck/connector-core/kit.ts";
```

`src/kit.ts` is a facade — re-exports and types only, each binding reference-identical to its home module (`test/kit.test.ts` pins that). Deep imports keep working; the kit is the *documented* subset a connector should need.

## What a connector must provide

A connector is the host-specific shell. It owns exactly four things:

1. **A host session key** — the host's own id for the session, minted once and used everywhere:
   - Claude Code: the **raw** `session_id`, unprefixed (pre-rename compat: every existing spool slug, state filename and `cc_<uuid>` derives from it, byte-identically).
   - ACP proxy: `acpHostSessionKey(agentName, acpSessionId)` → `acp-<agentSlug>--<acpSessionId>` (the `--` marks the slug/id boundary — a slug can never contain it, so keys parse back uniquely).
   - Cursor IDE: `cursorHostSessionKey(conversationId)` → `cur-<conversation_id>`.

   Prefixes are what keep two hosts from ever minting the same key. Never invent a fourth shape without reserving its prefix here (`state/host-session-key.ts`).

2. **An agent kind** — declared at config load: `loadConfig({ env, repoRoot, defaultAgentKind })`. Claude omits it (default `claude-code`); ACP uses `acpAgentKind(agentInfo.name)` (`acp:<slug>`, fallback `acp:unknown`); Cursor uses `CURSOR_AGENT_KIND` (`cursor-ide`). `CROSSCHECK_AGENT_KIND` in the env outranks every declaration. The kind rides on session registration and on every record's `producer` — the hub's `agent_kind` column is free-form, no server change per connector.

3. **Host event parsing** — turning the host's payloads (hook stdin, ACP frames, Cursor hooks) into calls on the flows below. This is the part that stays in the connector package, the way `HookPayloadSchema` stays in `connector-claude`.

4. **Registered render surfaces** — every module of the connector that composes text shown to an agent must appear in its `RENDER_SURFACES` registration (see *Render discipline*). An unregistered render module is a **red build** (`test/render-surface-registry.test.ts`).

## What core gives back

| Capability | Kit exports | Guarantee |
|---|---|---|
| Config | `loadConfig`, `isDisabled`, `rememberDeveloper`, `crosscheckHome`, `repoKey`, `mergeMcpConfig` | env > repo `.crosscheck.json` > `~/.crosscheck`; `null` config = connector no-ops silently |
| Repo identity | `resolveRepoIdentity`, `normalizeRemoteUrl` | the repo decides where a session reports; per-session `cwd` resolution |
| Identity | `crosscheckSessionIdFor` (`cc_<hostSessionKey>`), `workContextIdFor` (`wc_<cc id>`), `sessionSlug` | deterministic — recovery re-derives the same ids after any crash |
| State | `readSessionState`, `writeSessionState`, `updateSessionState` (locked read-transform-write), `deriveSessionState`, `with*` transforms | tolerant schema: files with the legacy `claudeSessionId` key parse forever; new writes carry `hostSessionKey` only |
| Spool | `appendRecords`, `flushSpool`, `reapSpool` | append-only JSONL per (hub, repo); on disk, delivered, or **counted** — no fourth outcome |
| Hub client | `registerSession`, `heartbeatSession`, `endSession`, `getPresence`, `getWorkContexts`, `getHintCandidates`, … | typed, budgeted, fail-open `HubResult` |
| Capture | `buildEnvelope`, `workContextRecord`, `targetRecord`, `hintDeliveryRecord`, `fingerprint`, `containsSecret`, `resolveDenylist`/`isDenied`, `collectCommitEvidence`, `toRepoRelative` | `fingerprint()` and `toRepoRelative()` are the cross-agent match signals — one implementation each, so the same failure text and the same file hash/derive identically from every host (symlinked worktrees included) |
| Render | `sanitizeUntrusted`, `bareUntrusted`, `safeId`, `quoted`, `QUOTED_DATA_NOTICE`, `renderBriefing`, `renderClaimHint`, `renderPointerHint`, `renderTripwireReason` | the three classes and the finished renderers — see *Render discipline* |
| Hints | `selectHint`, `hintBodyHash`, `isEchoOfDeliveredHint` | seen-set, session cap, echo-loop exclusion |
| MCP | `runMcpServer`, `resolveOwnWorkContext` | stdio MCP; session resolution reads the state files — any connector that writes state gets the whole Tier-2 tool surface for free |

## The five flows

The design (§1.3) names flow helpers; they are **documented recipes today** and become extracted functions when the first non-Claude connector lands (extraction, not invention). **Scheduling note:** that extraction is the ENTRY STEP of whichever connector block (3-7) starts first — two parallel connector builders must not each hand-roll these flows or both extract them concurrently. Reference implementation for each: the Claude hooks named below.

| Flow | Recipe | Reference |
|---|---|---|
| `registerSessionFlow` | `registerSession` with `cc_<hostSessionKey>` (+ `~r1`/`~r2` retry on 409) → `writeSessionState` **before any append** (reap infers "writer alive" from state) → spool a `workContextRecord` | `connector-claude/src/hooks/session-start.ts` |
| `captureFileTargets` | `toRepoRelative` → `isDenied` → seen-set (`withSeenTargets`) → `containsSecret` → spool `targetRecord`s | `hooks/post-tool-use.ts` |
| `captureFailure` | extract failure text → `fingerprint()` → spool an `error_fingerprint` target | `hooks/post-tool-use.ts` |
| `heartbeatMaybe` | `HEARTBEAT_MIN_INTERVAL_MS` throttle off `lastHeartbeatAt` → `heartbeatSession` | `hooks/post-tool-use.ts` |
| `assembleBriefing` / `selectAndRenderHint` | parallel hub GETs → `renderBriefing` / `selectHint` → `renderClaimHint`·`renderPointerHint` → record `hintDeliveryRecord` | `hooks/session-start.ts`, `hooks/user-prompt-submit.ts` |
| `endSessionFlow` | `endSession` → `flushSpool` on the spare budget → `reapSpool` (deferred end if the backlog outlives the budget) | `hooks/session-end.ts` |

### Cross-connector invariants (single-implementation once extracted)

Until the flows are extracted, these live here as WORDS, and every connector must hold them:

- **State before spool**: `writeSessionState` runs before the first `appendRecords` — the reaper decides "writer alive" by the state file's existence, so a spool without state is an orphan on sight.
- **409 retry suffix**: a session-id conflict on register retries with the `~r1`, then `~r2` suffix — deterministic, so recovery after a crash re-derives the same retried id.
- **Heartbeat throttle**: at most one `heartbeatSession` per `HEARTBEAT_MIN_INTERVAL_MS` (kit export — never copy the number), measured off state's `lastHeartbeatAt`.
- **Tripwire**: candidates come from `getTripwireSessions` (kit export), rendered ONLY through `renderTripwireReason`, one ask per file (`withTripwireAsked`).

## Render discipline — non-negotiable

Every string a connector emits into any agent's context goes through exactly three classes, **imported, never re-typed**:

- **PROSE** — `sanitizeUntrusted` / `quoted`: « »-framed, under `QUOTED_DATA_NOTICE`;
- **BARE** — `bareUntrusted`: short fields outside the frame (names, kinds, statuses);
- **ID** — `safeId`: allowlisted, printable bare because agents pass ids back.

There is no fourth path, and new connectors reuse the finished renderers rather than composing their own lines. Enforcement is structural: each package exports its render surfaces as data (`src/render-surfaces.ts`, `RENDER_SURFACES`), the injection corpus runs against every registered surface, and a meta-test fails the build on any module that touches the render layer without being registered.

## Compatibility

- State files written before the `hostSessionKey` rename (legacy `claudeSessionId` key) parse forever; write-backs upgrade the key in place, same filename.
- Claude session ids stay raw: slugs, spool paths, `cc_`/`wc_` ids are byte-identical across the upgrade — pinned against fixtures frozen from pre-rename code in `test/identity-compat.test.ts` + `test/fixtures/compat/`.
