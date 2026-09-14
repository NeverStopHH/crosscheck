# 00 — Ground truth for the 1.0 specs

**What this is.** One shared map of what the code *is* today, so that eight
parallel spec writers build on the same event model, the same table shapes and
the same names. It designs nothing. Every claim carries a `file:line` that was
read; every number was run, not remembered.

**Baseline.** `origin/main` at `e9aab82` (v0.9.0), read at
`/Users/nicknouschirvan/worktrees/crosscheck-main`. Two open PRs are read but
not merged:

| PR | branch | head read | measured |
|---|---|---|---|
| **#50** `feat/knowledge-layer-pins` | `/Users/nicknouschirvan/worktrees/crosscheck-pins` | **`bc88b8b`** | 66 files, +8787/−28 |
| **#49** `fix/developer-listing` | `/Users/nicknouschirvan/worktrees/crosscheck-dev-listing` | `2642640` | 9 files, +746/−23 |

Paths are repo-relative. Everything under `packages/` unless said otherwise.

---

## 0. Revision note — what changed since the first draft of this map

This document was first written 2026-09-09 against PR #50 at `1f1f6d6`. Four
things have changed and every writer needs all four.

**0.1 — Q1 is ANSWERED. The old §0 refusal is withdrawn.**
The first draft opened with a refusal: the cut line and the German handover were
lost with `/private/tmp`, so no spec could cite an acceptance test and no spec
could assert its own component was in 1.0. **The cut line was recovered on
2026-09-14** from the published artifact and now lives in the repo at
`docs/1.0/00-cut-line.md`. It carries the three tiers, **AT-1…AT-10 each with
its "fails if" line**, the five proofs and the two decisions reserved for Nick.

> **Cite AT numbers from `00-cut-line.md`.** State your component's tier from
> its Tier 1 / Tier 2 / Tier 3 lists. The earlier instruction to treat scope as
> unknowable is dead.

The German handover at `/private/tmp/crosscheck-handover.md` is still gone and
is **not** recoverable. Its §6 normative content survives in the orchestration
brief and is restated in §8 below. Do not go looking for the file.

Consequence for the two specs already written: **03-coverage-integrity.md** and
**05-ci-ingestion.md** each open with a refusal about the missing cut line and
number their tests `COV-1…COV-8` / `CI-1…` "fresh, without pretending to restate
AT-1 and AT-9". Those tests are good and stay. What changes is that they can now
be *mapped* onto AT-1, AT-9 and AT-10, which exist again. That mapping is
§10, Q1′.

**0.2 — PR #50 moved two commits.** `1f1f6d6` → `2bc416d` → `bc88b8b`, +339/−32
across 24 files. New material the first draft could not see:
- a new module `connector-core/src/state/git-lane-cost.ts` (117 lines);
- three new `SessionState` fields and a new transform (§2.1);
- `MUTATIONS` on #50 went 298 → **308** (measured, §9.2);
- CLI registered render surfaces went 3 → **6** (measured, §6.1). This
  invalidated 05 §9's line calling `cli/src/render-surfaces.ts` free ground.
  **Closed 2026-09-14:** 05 §9.4 carries that correction with its own
  measurement, and §9.1 below now states the one insertion convention all four
  CLI-surface-adding specs follow.

**0.3 — `claims.stale_at` has no writer. It is a dead column.** This is the
single most consequential correction in this revision and it changes the shape
of the claim-binding work. See §1.7a.

**0.4 — 05-ci-ingestion.md contradicts §8.4 of the first draft**, deliberately
and correctly. `ci.result` is **not** an envelope kind. §8.4 is corrected below.

---

## 1. Current schema — `packages/server/src/db/schema.ts` (540 lines on main)

Drizzle is the source of truth; `db/bootstrap.sql` mirrors every index (the
schema comments say so repeatedly, e.g. `schema.ts:64`, `:156`, `:204`).
`packages/server/test/ddl-sync.test.ts` is what keeps the two in step.

### 1.1 `developers` — `schema.ts:46-66`

| column | type | note |
|---|---|---|
| `id` | text PK | `dev_` prefix (`services/developers.ts:14`) |
| `name` | text NOT NULL | |
| `email` | text NOT NULL UNIQUE | the **primary**; auth reads it |
| `api_key_hash` | text NOT NULL UNIQUE | |
| `presence_opt_out` | bool NOT NULL default false | `schema.ts:58`; enforced in `services/visibility.ts` |
| `created_at` | timestamptz NOT NULL defaultNow | |

Index `developers_name_idx (name, email)` — `schema.ts:65`.

### 1.2 `developer_emails` — `schema.ts:84-99`

PK on **`email`** (`schema.ts:87`) — "an email belongs to AT MOST one developer"
is a *database* fact, not a service promise (`schema.ts:74-78`). Columns:
`email` PK, `developer_id` FK→developers, `is_primary` bool, `created_at`.
Index `developer_emails_developer_idx (developer_id)` — `schema.ts:97`.
Emails stored lowercased via `normalizeEmail` (`services/commit-evidence.ts:20`).

### 1.3 `developer_mutes` — `schema.ts:107-121`

PK `(reader_developer_id, muted_developer_id)`. Reader-side only: filters the
**reader's unasked surfaces** (`schema.ts:102-105`).

### 1.4 `agent_sessions` — `schema.ts:123-159`

| column | type | note |
|---|---|---|
| `id` | text PK | |
| `developer_id` | text FK | |
| `agent_kind` | text | e.g. `claude-code` (`connector-core/src/constants.ts:3`) |
| `repo` | text | normalised remote identity |
| `branch` | text | |
| `base_commit` | text | drift is rendered against this |
| `status` | text enum `SESSION_STATUSES` | |
| `started_at` / `last_heartbeat_at` / `ended_at` | timestamptz | |
| `reaped_at` | timestamptz NULL | `schema.ts:146` — **set only when the HUB guessed**; a connector-requested end leaves it null |

`reaped_at` is load-bearing for coverage. `schema.ts:138-145` states a SessionEnd
is *a fact reported by the session* while a reap is *an inference from silence*,
and the inference is revocable — `services/records.ts:71-79` revives a reaped
session when a record from it arrives.

**Read `records.ts:72-74` before you build coverage on the reap.** It records,
measured, *why* the reap over-fires: the heartbeat it reads **only moves on an
Edit or a Bash PostToolUse**, "so an afternoon of reading and planning looks like
a killed terminal." A reap is therefore a conservative `incomplete` signal, never
evidence that work stopped. 03 §3.2 already treats it that way.

Indexes: `agent_sessions_repo_idx`, `agent_sessions_heartbeat_idx`,
`agent_sessions_developer_repo_idx (developer_id, repo)` — `schema.ts:149-157`.

### 1.5 `work_contexts` — `schema.ts:161-208`

`id` PK · `session_id` FK · `title` · `description` · `intent` jsonb ·
`status` · `normalized_doc` · `tsv` GENERATED (`to_tsvector('english',
coalesce(normalized_doc,''))`, `schema.ts:171-173`) · `embedding` vector(768) ·
`embedding_model` · **`landed_at`** timestamptz NULL · `created_at` ·
`updated_at`.

`landed_at` (`schema.ts:184`) is monotonic and a *column, not a status
transition*: "git ancestry never un-happens" (`schema.ts:177-183`).

`EMBEDDING_DIMENSIONS = 768` — `schema.ts:41`.

Indexes: `work_contexts_session_created_idx (session_id, created_at DESC)`
(`:194`) and `work_contexts_activity_idx` on
`coalesce(updated_at, created_at) DESC` (`:205`). **The activity expression is
the canonical "age" of a row** — every surface renders it and time decay is
computed from it (`schema.ts:198-204`).

**The `intent` jsonb has a wire shape already** — `IntentSchema`,
`packages/schema/src/session.ts`: `{ summary (≤ MAX_INTENT_SUMMARY_CHARS),
provenance, confidence, capturedAt }`, with a `.check` refusing
`provenance === "derived" && confidence > DERIVED_CONFIDENCE_CAP`. It is
`.optional()` on `WorkContextSchema` (`session.ts:67`) and **an absent field says
nothing about the intent** — the hub keeps what it has, so a SessionStart re-fire
or a recovery can never wipe a captured intent (`session.ts:62-66`). Any intent
ledger spec extends this object; it does not mint a second one.

### 1.6 `work_context_targets` — `schema.ts:210-235`

PK `(work_context_id, kind, value)` (`:229`). `kind` enum `TARGET_KINDS`.
`created_at` **NULLABLE** and never bumped on a duplicate touch — "first-seen is
the honest age"; a pre-column row reads null and the pointer says *age unknown*
rather than fabricating `now()` (`schema.ts:218-225`).
Index `work_context_targets_kind_value_idx (kind, value)` (`:233`) — this is the
index the suspect intersection in PR #50 rides.

### 1.7 `claims` — `schema.ts:237-291`

| column | type | note |
|---|---|---|
| `id` | text PK | |
| `work_context_id` | FK | |
| `author_session_id` | FK→agent_sessions | |
| `kind` | enum `CLAIM_KINDS` | |
| `body` | text, CHECK ≤ `MAX_CLAIM_BODY_LENGTH` (`:269-272`) | |
| `status` | enum `CLAIM_STATUSES` | |
| `confidence` | double NOT NULL | |
| `capture_mode` | enum `CAPTURE_MODES` = `auto \| agent \| human` | |
| `provenance` | enum `PROVENANCES` = `declared \| derived` | |
| `dedup_count` | int default 1 | |
| `last_seen_at` | timestamptz NULL | |
| **`stale_at`** | timestamptz NULL | `schema.ts:255` — **see 1.7a** |
| `evidence_refs` | jsonb `readonly string[]` default `[]` | `:258-261`; wire refs, supports-edges not yet materialised |
| `tsv` | GENERATED on `body` | `:262` |
| `embedding` / `embedding_model` | vector(768) | written once at ingest, append-only (`:263`) |
| `created_at` | timestamptz | |

Indexes: `claims_work_context_created_idx (work_context_id, created_at DESC)`
(`:280`) and `claims_embedding_hnsw_idx` HNSW cosine (`:286`).

**Claims are append-only; revision means a NEW claim** —
`services/hints.ts:68-70` states this and relies on it.

### 1.7a `stale_at` is a DEAD COLUMN — the AT-2 premise needs correcting

**Measured.** `grep -rn 'staleAt\|stale_at' packages` on `main@e9aab82` returns
**five** hits and no sixth, and the same five on `crosscheck-pins@bc88b8b`:

| hit | what it is |
|---|---|
| `server/src/db/schema.ts:255` | the column declaration |
| `server/src/db/bootstrap.sql:92` | the mirror |
| `server/test/fixtures/pre-search-block-bootstrap.sql:69` | a frozen fixture |
| `server/src/services/diagnosis.ts:128` | `readonly staleAt: string \| null` on `ClaimView` |
| `server/src/services/diagnosis.ts:211` | `staleAt: toIsoOrNull(row.staleAt)` — a pass-through |

**There is no writer.** No `INSERT`, no `UPDATE`, no service, no migration, no
job sets it. It is also **not on the wire**: `ClaimSchema`
(`packages/schema/src/claim.ts:18-31`) has no `staleAt` field, so no connector
can send one. The column is `NULL` for every claim that exists, and the only
thing it does today is travel to `get_diagnosis` as a permanent `null`.

**Why this matters.** `00-cut-line.md` Tier 1 says: *"Resolve the collision with
the existing clock-based `stale_at` — one authoritative definition, not two
silent ones."* **That collision does not exist.** There is one column and
**zero** definitions. AT-2's "fails if" line — *"a claim can be surfaced as
current with no commit binding, or two staleness definitions disagree without one
being authoritative"* — is currently satisfied by the first clause alone: every
claim is surfaced as current, because nothing ever marks one stale.

The claim-binding writer's job is therefore **easier than the cut line implies
and differently shaped**: define the first authority for a column that already
exists, is already mirrored in `bootstrap.sql`, and already has a rendering path
through `diagnosis.ts`. There is nothing to reconcile and nothing to deprecate.
Say so in the spec, and cite these five lines, because a reviewer reading the cut
line alone will expect a reconciliation section.

### 1.8 `claim_edges` — `schema.ts:293-320`

`id` PK, `from_claim_id`/`to_claim_id` FK→claims, `kind` enum `EDGE_KINDS`,
`author_session_id` FK, `note`, `created_at`. Unique `(from, to, kind)` (`:311`);
index `(to_claim_id, kind)` (`:318`).

### 1.9 `commit_evidence` — `schema.ts:368-399` — **AGGREGATE, NO HASHES**

**PK `(repo, author_email)`** (`schema.ts:398`). Columns: `repo`, `author_email`
(lowercased), `author_name`, `latest_commit_at`, `commit_count`, `window_days`,
`collected_at`, `reported_by` FK→developers.

There is **no commit hash column and no per-commit row**. UPSERT-only, never
append: "the table is bounded by how many people commit, not by how often
connectors report" (`schema.ts:370-373`). `author_email` **never leaves the hub**
— absence responses carry names only (`schema.ts:381-382`,
`services/absences.ts:34` "NEVER an email").

Cut line Tier 1 asks for **"Individual commit identity. Hashes, not just counts
and a latest timestamp."** That is a **new table**, not a column addition — see
§10 Q4 for what it collides with.

### 1.10 `hint_deliveries` — `schema.ts:401-427`

`id` PK, `session_id` FK, `ref_kind` enum `["claim","work_context"]`, `ref_id`,
`delivered_at`, `pulled_at` NULL. Indexes
`hint_deliveries_ref_session_idx (ref_id, session_id)` (`:417`) and
`hint_deliveries_session_delivered_idx (session_id, delivered_at DESC)` (`:423`).
**Refs only, never rendered text** (`connector-core/src/capture/records.ts:85`) —
non-negotiable #6 already implemented.

The id is deterministic — `hintDeliveryId` at `capture/records.ts:75-82`:
`hd_` + first 32 hex of `sha256(receiverSessionId \n refId)`,
`HINT_DELIVERY_ID_HASH_CHARS = 32` (`:67`). **This is the pattern 05 copies for
`ci_runs.id`**, and the pattern any 1.0 spec should copy when it needs a replay
of the same fact to be a `duplicate` rather than a second row (`:69-73`).

### 1.11 Remaining tables (touched less often but real)

- `artifacts` — `schema.ts:322-332`; `sensitivity` enum `team_visible |
  needs_approval`, `approved_by` FK.
- `events` — `schema.ts:335-340`; **outbox**, `bigserial id` **is the SSE replay
  cursor**. Kinds in `server/src/constants.ts:450-465` (§8.4b).
- `contradiction_candidates` — `schema.ts:348-367`; similarity-detected pairs
  **only**. Deterministic contradictions (shared target + opposite status) are
  derived fresh per read and are *not rows* (`schema.ts:342-346`).
- `questions` — `schema.ts:442-504`; CHECK `questions_addressee_check` makes
  "never a broadcast" a database fact (`:468-471`).
- `question_answers` — `schema.ts:519-541`; PK `(question_id, claim_id)`.

---

## 2. What the two open PRs add

### 2.1 PR #50 `feat/knowledge-layer-pins` @ `bc88b8b` — 66 files, +8787/−28

**PR #50 is the garden fence.** Measured: `grep -rln 'fence\|Fence' packages/*/src`
on main returns ten files and **every hit is the substring in "defence"**
(`briefing/sanitize.ts:185,192,261,336,350`, `mcp/tools/shared.ts:43`, …).
There is **no fence concept on main**. When `00-cut-line.md` Tier 1 says *"Extend
the garden fence already in flight; do not restart it"*, the thing in flight is
`pins` + `suspect` + `team_settings`, and nothing else.

**New tables** (`crosscheck-pins:packages/server/src/db/schema.ts`, +143/−1,
appended after `question_answers`):

- **`pins`** — `id` PK, `repo`, `surface`, `verified_by` FK, `verified_at_commit`,
  `verified_at`, `check_recipe` NULL, `capture_mode` enum, `broke_at`,
  `broke_by` FK, `renamed_paths` int default 0, `renamed_at`, `renamed_by` FK,
  `created_at`. CHECKs on surface/check length; index
  `pins_repo_created_idx (repo, created_at DESC)`.
  `capture_mode` is **stamped by the hub, never carried by the body**
  (`services/pins.ts:185-189`), always the literal `"human"`
  (`services/pins.ts:112`). **This is the AT-3 pattern** — see §8.3.
- **`pin_files`** — PK `(pin_id, path)`, plus **denormalised `repo`** and
  `status` enum `PIN_FILE_STATUSES = ["present","missing"]`. Index
  `pin_files_repo_path_idx (repo, path)`.
- **`team_settings`** — PK `repo`; `pin_policy` enum
  `TEAM_PIN_POLICIES = ["anyone","touched_files"]`, `suspect_attribution` enum
  `TEAM_SUSPECT_ATTRIBUTIONS = ["sessions","counts_only"]`, `updated_at`,
  `updated_by`. **Absent row means defaults** — nothing bootstraps rows here.
  It is **mutable**, which is why it is not the waiver pattern (§10 Q7).

**Altered table:** `work_context_targets` gains
**`source` text NOT NULL default `"tool_edit"`**, enum `STORED_TARGET_SOURCES`
(`schema/src/enums.ts` +22: `TARGET_SOURCES = ["tool_edit","git_diff"]`, and
`STORED_TARGET_SOURCES = [...TARGET_SOURCES, "both"]`). `"both"` is **derived on
ingest, never sent** — `services/record-handlers.ts` (+19) upgrades the label on
a PK collision from the other lane.

**The second evidence lane:** `connector-core/src/flows/capture-git-touches.ts` —
a bounded `git diff --name-only HEAD` at **Stop**, mtime-filtered to the session
window, recorded as `git_diff` targets. Its stated blind spots
(`capture-git-touches.ts:22-25`): **changes already committed during the session,
and untracked new files**. It distinguishes "nothing" from "no answer" (`:27-33`)
— the unanswered case is flagged and Stop counts it as a skip.

**NEW since `1f1f6d6` — `connector-core/src/state/git-lane-cost.ts` (117 lines).**
The lane's telemetry, summed across live sessions for `status` and `doctor`.
Read its header; it is non-negotiable #4 written out in one number
(`git-lane-cost.ts:12-21`):

> *"A LANE THAT NEVER RUNS LOOKS EXACTLY LIKE A QUIET ONE, which is why both
> halves are counted and both are printed. … Reporting only what the lane FOUND
> would make a lane skipped on every turn indistinguishable from one watching a
> tidy repo, and `suspect` would then answer 'no session touched this surface'
> out of a blind spot nobody could see."*

`GitLaneCost` is `{ sessions, recorded, skipped, ran }` (`:34-49`). The fix in
`2bc416d` is itself the lesson: the doctor verdict used to weigh `skipped`
**turns** against `recorded` **files** and was red forever on a healthy install;
`gitLaneRan` is the denominator that repaired it. **Any 1.0 counter that gates a
WARN needs its own ran-denominator for the same reason.**

**NEW since `1f1f6d6` — three `SessionState` fields** (`state/session-state.ts`
+39): `gitTouchCount`, `gitLaneSkipped`, `gitLaneRan`, each
`z.number().int().min(0).default(0)`, plus the transform
`withGitTouches(state, {captured, skipped})`. **Defaults keep every older state
file parsing** — that sentence is in the field comment and is the forward-compat
contract for the state file, exactly as `unknownKind` is for the envelope (§4.1).

**New services/routes:** `services/pins.ts` (620), `services/suspect.ts` (565),
`services/team-settings.ts` (132); `routes/pins.ts`, `routes/suspect.ts`,
`routes/team-settings.ts`. **New CLI:** `cli/pin.ts`, `cli/pin-render.ts`,
`cli/pin-observability.ts`, `cli/suspect.ts`, `cli/suspect-render.ts`.
**New git:** `git/pin-sweep.ts`.

**`suspect` is prior art every attribution spec must read** —
`services/suspect.ts:1-37` states four non-negotiable rules: (1) nothing is named
until the pin's check was run and failed; (2) ranking is by **lift** (overlap over
that author's own touches in the window), never raw overlap; (3) **sessions and
intents, never people** — no developer name, no developer id in a row; (4) the
reader's own sessions count. Its outcome enum (`suspect.ts:79-87`) is
`ranked | no_separation | no_touch | withheld`, and its falsifier enum (`:69-77`)
is `recorded_break | not_recorded_broken | no_check_recipe | reader_named_files`.

### 2.2 PR #49 `fix/developer-listing` @ `2642640` — 9 files, +746/−23

Unchanged since the first draft (re-verified). `GET /api/developers` (admin) —
`routes/developers.ts` (+5). Adds `DEVELOPERS_MAX_LISTED = 200`
(`server/src/constants.ts` +9), `listDevelopers` and `readDeveloperPage` in
`services/developers.ts` (+185/−18). Two separate truncation flags:
`DeveloperListing.truncated` (more developers than the page) **and**
per-developer `emailsTruncated` — because "silence there reads as *those are all
their addresses* while absence matching goes on attributing commits from the ones
it hid". Also fixes a race where concurrent alias links walk past the ten-email
cap. **No new tables. No schema change.**

---

## 3. Existing constants a spec must respect

### 3.1 Hub — `packages/server/src/constants.ts` (532 lines on main)

`PRESENCE_TTL_SECONDS = 90` (`:2`) · `POLL_INTERVAL_MS = 1000` (`:5`) ·
`SSE_KEEPALIVE_INTERVAL_MS = 15_000` (`:8`) · `EVENTS_DEFAULT_LIMIT = 100`,
`EVENTS_MAX_LIMIT = 500` (`:10-11`) · `WORK_CONTEXT_LIST_MAX = 600` (`:45`) ·
`SESSION_REAP_STALE_HOURS = 6` (`:79`) · `SESSION_REAP_MAX_PER_PASS = 100`
(`:81`) · `SESSION_REAP_INTERVAL_MS = 15 min` (`:83`) ·
`OPEN_SESSIONS_MAX = 200` (`:85`) · `MAX_INGEST_BATCH = 100` (`:88`) ·
`DEFAULT_PORT = 7100` (`:90`).

**Coverage-relevant:** `COMMIT_EVIDENCE_RETENTION_DAYS = 30` (`:98`) ·
`ABSENCE_EVIDENCE_MAX_AGE_DAYS = 7` (`:106`) ·
`ABSENCE_COMMIT_MAX_AGE_DAYS = 14` (`:108`) · `ABSENCE_MIN_GAP_HOURS = 24`
(`:115`) · `ABSENCE_MAX_FINDINGS = 20` (`:117`) ·
`ABSENCE_MAX_EVIDENCE_ROWS = 200` (`:119`).

Solved matcher: `SOLVED_MATCH_ACTIVE_WINDOW_DAYS = 14` (`:128`),
`SOLVED_COUNT_WINDOW_DAYS = 30` (`:203`), plus per-tier caps `:130-208`.
Questions: `QUESTION_TTL_DAYS = 14` (`:230`), `MAX_OPEN_QUESTIONS_PER_AUTHOR = 5`
/ `PER_TARGET = 3` / `PER_AUTHOR_PER_DAY = 20` (`:245-247`),
`QUESTION_ANSWER_WINDOW_DAYS = 28` (`:270`).
Ghost: `GHOST_ACTIVE_WINDOW_DAYS = 7` (`:301`), `GHOST_MIN_SHARED_TARGETS = 2`
(`:370`), `GHOST_MAX_FINDINGS = 3` (`:422`), `GHOST_MAX_SHARED_SHOWN = 3` (`:448`).
Conference: `CONFERENCE_ACTIVE_WINDOW_DAYS = 14` (`:477`) and caps `:489-532`.
Search: `SEARCH_DEFAULT_LIMIT = 10`, `SEARCH_MAX_LIMIT = 25`,
`SEARCH_MIN_TOKEN_CHARS = 3`, `SEARCH_MAX_QUERY_CHARS = 2000`
(`services/search.ts:48-67`).
Diagnosis: `DIAGNOSIS_MAX_CLAIMS = 500`, `DIAGNOSIS_MAX_EDGES = 1000`,
`DIAGNOSIS_MAX_TARGETS = 100` (`services/diagnosis.ts:17-27`).
Refusals: `MAX_REFUSAL_CHARS = 200` (`services/refusal.ts:27`), pinned by a
`VERIFY:` directive to the connector's `MAX_HUB_MESSAGE_CHARS = 200`
(`connector-core/src/constants.ts:1555`).

**Auth is two middlewares and no more** — `middleware/auth.ts`: `requireAdmin`
(`:19-36`, a single hub-level token compared with `isTokenEqual`) and
`developerAuth` (`:38-…`, bearer → `hashApiKey` → `developers.api_key_hash`).
**There is no machine identity and no third token.** Anything that posts without
a developer API key needs a new middleware; 05 proposes `requireCiToken` and says
why it is not the admin token (§10 Q5).

### 3.2 Connector — `packages/connector-core/src/constants.ts` (1668 lines on main)

Header at `:1`: *"Every budget, cap and TTL the connector obeys — no magic
numbers elsewhere."* A 1.0 spec introducing a number puts it **here**.

**The hook budget family — non-negotiable #5.** `HTTP_TIMEOUT_MS = 400` (`:6`).
Budgets are **ratios** so a raised `CROSSCHECK_TIMEOUT_MS` widens them
consistently (`:8-12`):

| ratio | value | ms at default |
|---|---|---|
| `SESSION_START_BUDGET_RATIO` (`:13`) | 2.5 | 1000 |
| `SESSION_END_BUDGET_RATIO` (`:14`) | 2 | 800 |
| `POST_TOOL_USE_BUDGET_RATIO` (`:15`) | 4 | 1600 |
| `USER_PROMPT_SUBMIT_BUDGET_RATIO` (`:65`) | 2 | **800** |
| `PRE_TOOL_USE_BUDGET_RATIO` (`:67`) | 2 | **800** |
| `POST_TOOL_USE_FAILURE_BUDGET_RATIO` (`:77`) | 2 | 800 |

The **2 × 400 ms = 800 ms** of the non-negotiable is machine-checked at
`constants.ts:56-57`:

```
VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");console.log(c.USER_PROMPT_SUBMIT_BUDGET_RATIO*c.HTTP_TIMEOUT_MS, c.PRE_TOOL_USE_BUDGET_RATIO*c.HTTP_TIMEOUT_MS)'
PRINTS: 800 800
```

and guarded twice (`:60-63`): `test/hint-budget.test.ts` is the arithmetic
detector and what `mutation-check.ts` re-breaks; `test/hint-hook-latency.test.ts`
is the measured consequence through the real `runHook`. **Non-negotiable #5 says
"measured and binding" — this pair is what discharges both halves, and a 1.0 spec
that adds hook work adds to both.**

`HOOK_RESERVE_RATIO = 1` (`:47`) — what a hook holds back from its own maintenance
so the thing it exists for still fits. The reserve arithmetic is `hookBudget()` at
`config/hook-budget.ts:48-55`:
`spareMs = max(0, deadlineMs − now − timeoutMs × HOOK_RESERVE_RATIO)`.
`spareMs` is the **sole accessor** on `HookBudget` (`hook-budget.ts:31-33`) —
there is deliberately no accessor for the raw remainder. `withBudget`
(`hook-budget.ts:58-71`) races the work against the budget and **resolves to
`""`** on timeout: a hook that overruns emits nothing, it never throws.

**Anything a 1.0 spec adds to a hook spends `spareMs`, not the remainder.**

Other caps a spec will meet: `MAX_HINTS_PER_PROMPT = 1` (`:84`),
`MAX_HINTS_PER_SESSION = 5` (`:85`), `GIT_TIMEOUT_MS = 1500` (`:117`),
`HEARTBEAT_MIN_INTERVAL_MS = 20_000` (`:233`),
`MAX_TARGETS_PER_INVOCATION = 20` (`:235`), `MAX_SEEN_TARGETS = 500` (`:236`),
`MAX_SPOOL_BYTES = 2_000_000` (`:312`), `MAX_SPOOL_AGE_DAYS = 7` (`:342`),
`MAX_INGEST_BATCH = 100` (`:363`), `MAX_FLUSH_BATCHES_PER_HOOK = 20` (`:370`),
`SPOOL_LOCK_STALE_MS = 5000` (`:371`), `MAX_BRIEFING_CHARS = 2200` (`:387`),
`CONTEXT_MAX_AGE_DAYS = 14` (`:396`), `WORK_CONTEXT_LIST_LIMIT = 600` (`:416`),
`INTENT_MAX_CHARS = 120` (`:464`), **`INTENT_DERIVED_CONFIDENCE = 0.4`** (`:496`),
**`GHOST_DERIVED_CONFIDENCE = 0.4`** (`:538`),
`COMMIT_EVIDENCE_WINDOW_DAYS = 14` (`:591`),
`COMMIT_EVIDENCE_MAX_COMMITS = 400` (`:593`), `MAX_ABSENCE_LINES = 3` (`:613`),
`POST_TOOL_USE_MATCHER` (`:1270`), `PRE_TOOL_USE_MATCHER` (`:1272`),
`TRIPWIRE_MODE_ENV = "CROSSCHECK_TRIPWIRE"` (`:1298`),
`MAX_HUB_MESSAGE_CHARS = 200` (`:1555`).

### 3.3 Schema package

`MAX_CLAIM_BODY_LENGTH = 10_000` (`schema/src/claim.ts:11`) ·
**`DERIVED_CONFIDENCE_CAP = 0.5`** (`schema/src/claim.ts:14`) ·
`PROTOCOL_VERSION = "0.1"` (`schema/src/envelope.ts:15`) ·
`MAX_COMMIT_CLOCK_SKEW_MS = 120_000` (`schema/src/commit-evidence.ts`, exported
and reused by 05) · `COMMIT_SHA_PATTERN`
(`connector-core/src/git/commit-drift.ts:17`).

**Non-negotiable #3 is already enforced at the wire, in two places.**
`ClaimSchema.check` (`claim.ts:32-44`) rejects
`provenance === "derived" && confidence > DERIVED_CONFIDENCE_CAP`, and (`:45-55`)
rejects `status === "likely_root_cause"` with zero `evidenceRefs`.
`IntentSchema.check` (`session.ts:40-52`) enforces the identical cap on intents.
The two connector-side derived confidences are **0.4**, under the 0.5 cap — a
spec proposing a derived confidence picks a value ≤ 0.5 and says which.

PR #50 adds: `MAX_PIN_SURFACE_CHARS = 120`, `MAX_PIN_CHECK_CHARS = 200`,
`MAX_PIN_FILES = 30`, `MAX_SPEAKING_PIN_FILES = 5`, `MAX_PIN_PATH_CHARS = 300`,
`MAX_PIN_SWEEP_UPDATES = 200` (`schema/src/pin.ts`), and hub-side
`SUSPECT_WINDOW_DAYS = 14`, `SUSPECT_MAX_PATHS = 30`,
`SUSPECT_MAX_CANDIDATES = 50`, `SUSPECT_TOP_CANDIDATES = 3`,
`SUSPECT_SEPARATION_RATIO = 1.5` (`server/src/constants.ts` +38), plus connector
`PIN_SWEEP_MAX_PATHS = 200`, `PIN_SWEEP_MAX_HOPS = 3`,
`PIN_SWEEP_MAX_GIT_CALLS = 40`, `GIT_TOUCHES_TIMEOUT_MS = 250`
(`connector-core/src/constants.ts` +62).

---

## 4. The capture pipeline, end to end

**The event model must be layered ON this pipeline, not beside it.** There is
already an envelope, a spool, a batch endpoint and a handler table. A 1.0 event
that is not an envelope is a second pipeline — and 05 shows the one honest way to
*refuse* the envelope rather than fake it (§8.4a).

### 4.1 The envelope — `packages/schema/src/envelope.ts`

```
{ cx, id, ts, producer: { developerId, agentKind, sessionId }, kind, body }
```

`EnvelopeSchema` at `:30-37`, `ProducerSchema` at `:19-23`. `cx` must share the
major version of `PROTOCOL_VERSION = "0.1"` (`:75-81`).

**Forward compatibility is a protocol rule, not a convenience** (`:26-28`): an
**unknown `kind` parses successfully** with `unknownKind: true` and an untouched
body (`:102-104`), and `services/records.ts` ignores it. This is exactly the seam
a new 1.0 event kind travels through — old connectors and old hubs do not choke
on it. Unstorable text (NUL etc.) is refused **after** the kind check, never
before (`envelope.ts:111-120`), so the forward-compat rule survives.

Known kinds — `RECORD_BODY_SCHEMAS`, `envelope.ts:42-54`, **eleven**:
`claim`, `claim_edge`, `commit_evidence`, `landed_evidence`, `session`,
`work_context`, `target`, `hint`, `hint_delivery`, `question`, `question_answer`.

Two are **parseable but never ingestable** over `/api/records`
(`services/records.ts:57-65`): `session` (registered via `/api/sessions`) and
`hint` (server-emitted).

**The envelope's hard requirement, and why it is a design constraint, not a
formality:** `producer` requires all three of `developerId`, `agentKind`,
`sessionId` (`envelope.ts:19-23`). Anything with no agent session cannot be an
envelope without minting a synthetic session — which surfaces as a **phantom
teammate** in presence, in every briefing and in the tripwire (§10 Q9).

### 4.2 Builders — `connector-core/src/capture/records.ts` (133 lines on main)

`buildEnvelope(kind, body, producer, now)` at `:16`; envelope ids are
`env_${crypto.randomUUID()}` (`:14`). `UNKNOWN_DEVELOPER_ID = "unknown"` (`:12`)
is the placeholder until the hub says who we are — **rewritten on flush** by
`withProducer` (`:115-133`).

`workContextRecord` (`:43`) — note `intent` is **omitted unless it is an update**,
so a registration or recovery re-send can never wipe an intent (`:35-40`).
`targetRecord` (`:105`). `hintDeliveryRecord` (`:85`) — refs only.
`hintDeliveryId` (`:75-82`) — the deterministic-id pattern (§1.10).

### 4.3 Which hook emits what (Claude connector; Cursor/ACP mirror it)

Handler table: `connector-claude/src/hooks/index.ts:12-20` — seven hooks:
`session-start`, `post-tool-use`, `post-tool-use-failure`, `session-end`,
`user-prompt-submit`, `pre-tool-use`, `stop`. Single entry point `runHook`
(`:26`), which **returns stdout text and never throws** (`:25`).

| hook | emits | reads / renders | file:line |
|---|---|---|---|
| **SessionStart** | `session` register (`registerSessionFlow`), `work_context`, `commit_evidence`, `landed_evidence`; drains spool | the briefing (unsolicited) | `session-start.ts:219`, `:241`, `:323`, `:350`; flow at `flows/register-session.ts:156,223` |
| **PostToolUse** | `work_context` on recovery registration, `target` (file) via `captureFileTargets`, heartbeat | — | `post-tool-use.ts:105-110`, `:144`; `flows/capture-targets.ts:65,97-102` |
| **PostToolUseFailure** | `target` kind `error_fingerprint` via `captureFailure` | injects the failure hint **after** capture | `post-tool-use-failure.ts:84`, `:30`; `flows/capture-targets.ts:126,136-141` |
| **UserPromptSubmit** | `hint_delivery` | deferred briefing **or** one hint (briefing outranks) | `user-prompt-submit.ts:6-11`, `:207-221` |
| **PreToolUse** | — | the tripwire ask | `hooks/pre-tool-use.ts` (181 lines) |
| **Stop** | summarizer fire recorded under the state lock, then the **detached** worker spawned; **#50 adds the git-touch lane here** | — | `stop.ts:9-15`, `:52-60`; #50 `stop.ts` +62/−1 |
| **SessionEnd** | flush, then `end` | — | `session-end.ts:25`; `flows/end-session.ts:53,58,91` |

`collectCommitEvidence` runs **only at SessionStart** (`session-start.ts:241`),
bounded by `COMMIT_EVIDENCE_WINDOW_DAYS = 14` and
`COMMIT_EVIDENCE_MAX_COMMITS = 400` (`capture/commit-evidence.ts:122-126`). This
is why hub commit evidence can be up to a session-gap stale, and why
`ABSENCE_EVIDENCE_MAX_AGE_DAYS = 7` exists — and why 03 §3.2 reads a stale
`collected_at` as `incomplete` rather than ignoring it.

**Stop's order of operations is a stated contract** (`stop.ts:9-15`): the
summarizer fire is recorded in state **before** the worker is spawned, and the
transform re-checks cap and debounce on the freshest state **inside the lock**. A
crash between record and spawn costs one unspent fire slot — the honest direction;
the reverse order could spawn twice against one slot. **Any 1.0 work added to Stop
adopts this order.** Note that #50 has already spent part of Stop's `spareMs` on
the git lane.

### 4.4 The spool — `connector-core/src/spool/` (11 modules, 2427 lines)

- **`append.ts`** (`:1-27`) — the hot path. **Takes no lock**, repairs nothing,
  truncates nothing; writes to the file of its own session. **Over the cap an
  append REFUSES rather than making room**, and refusing is a *visible* outcome:
  a line in the `.drops` ledger plus `persisted: false` (`:23-26`, `AppendResult`
  at `:36-41`). This is non-negotiable #4 already implemented.
  **A session's spool file has more than one writer** (`append.ts:7-13`):
  recovery appends to files it does not own, `rescueTail` puts rescued bytes back
  onto another session's path (`reap.ts`), and `appendThroughHandle` recreates a
  file reap unlinked (`write.ts`). Every one is an `O_APPEND` write. **This is why
  a spool line offset is not a per-session sequence** — see §10 Q2.
- **`flush.ts`** (`:1-30`) — delivery only; never touches the bytes of a data
  file. **Oldest backlog first** (`:5-8`). The budget comes **from the caller** in
  wall-clock ms — a hook passes `spareMs` (`:10-13`). Lock failure is "skip this
  time" (`:16-19`).
- `drops.ts` (380), `lock.ts` (399), `reap.ts` (588), `cursor.ts`, `files.ts`,
  `identity.ts`, `lines.ts`, `unclosed.ts`, `write.ts`.

A malformed line produces **one** non-JSON line, which flush counts in `.drops`
before moving the cursor past it — "the record is then counted, never silently
gone" (`append.ts:51-55`).

### 4.4a Session state — the one lock-protected per-session writer

`connector-core/src/state/session-state.ts`. Relevant to `seq` (§10 Q2):

- The state file is keyed by **`hostSessionKey`** (schema field at `:74`; path
  `sessionStatePath(home, hostSessionKey)` at `:415`, `:425`).
  `crosscheckSessionIdFor(hostSessionKey)` (`:404`) derives the crosscheck id.
- **`updateSessionState(home, hostSessionKey, transform)`** (`:460-475`) is a
  **lock-protected read-modify-write**: `withLock(sessionStateLockPath(...),
  false, …)` → `readSessionState` → `transform(fresh)` → `writeSessionState`.
  A counter incremented inside `transform` is monotonic per `hostSessionKey`.
  `writeSessionState` stays for the CREATE paths (SessionStart, recovery) "which
  run before any sibling exists" (`:455-459`).
- The object is a `z.looseObject` where **every field carries a `.default()`**,
  and `deriveSessionState` (`:940+`) seeds them — this is the forward-compat
  contract for state files, mirrored by #50's three new fields.
- **The detached summarizer worker does not update session state.** Measured:
  `worker-entry.ts` imports only `runSummarizeWorker`; `worker.ts` imports
  `readSessionState` (`worker.ts:25`) and nothing that writes. It **appends to the
  spool** and the next hook flushes it (`worker.ts:3-4`).

### 4.5 Hub ingest — `services/records.ts` → `services/record-handlers.ts`

`records.ts` parses, gates the **producer session only** (`:67-79`), dispatches.
Author sessions referenced in bodies **may already be ended** — a spool flush from
a successor session is legitimate (`:67-69`, `record-handlers.ts:85-89`).

**A reaped end is not an end** (`records.ts:71-79`): a record arriving from a
reaped session revokes the reap rather than rejecting the record, *because the
connector's flush advances its cursor on any 2xx — so a rejected batch is a
delivered batch as far as the spool is concerned, and the work is gone.*
**Every 1.0 ingest path inherits this rule.** A 1.0 route that rejects a
well-formed record for a policy reason destroys it.

Outcomes: `RecordStatus = "accepted" | "duplicate" | "ignored" | "rejected"`
(`record-handlers.ts:37`).

Handlers: `ingestWorkContext` (`:198`), `ingestTarget` (`:246`), `ingestClaim`
(`:540`) / `ingestClaimWithin` (`:416`), `ingestClaimEdge` (`:599`); plus
`ingestCommitEvidence` (`services/commit-evidence.ts:51`), `ingestLandedEvidence`,
`ingestHintDelivery`, `askQuestionFromRecord`, `answerQuestion`.

`ingestCommitEvidence` is worth reading whole (109 lines): `setWhere` keeps replay
honest, `greatest()` keeps the newest commit timestamp, and **both timestamps are
clamped to the hub clock plus skew** because both are sender-controlled and both
mechanisms turn a future value into a ratchet (`commit-evidence.ts:34-42`).
**Targets and commit evidence emit no outbox event** — per-report events would
drown the signals SSE consumers care about (`:47-49`).

---

## 5. Coverage today — and every surface that ignores it

### 5.1 What exists

**`services/absences.ts` (191 lines) is the only coverage-shaped service.**
Two kinds, deliberately distinct (`:23-30`): `inactive` — a hub member whose
commits postdate their last reported agent session on this repo; `unconnected` —
a commit author no hub member's email matches at all. *"Conflating them would send
half the readers to the wrong fix (a dead connector vs. a missing invitation)."*

`AbsenceFinding` (`:32-41`) carries `kind`, `name` (**never an email**, `:34`),
`latestCommitAt`, `lastSessionAt` (null when no session at all),
`evidenceCollectedAt` — *"When the evidence behind this line was read from git —
staleness surface"* (`:39`).

The **phrasing contract** (`:88-99`) is binding on any 1.0 renderer:

> *"every finding is a factual observation — 'newest commit at X, last reported
> session at Y' — never an inference about what somebody did or did not do. We see
> agent sessions, not keystrokes … this is a surveillance-adjacent surface,
> renderers must keep the phrasing factual."*

Coverage is currently **per developer per repo**, computed as an outer join of
`commit_evidence` against `developer_emails` (`:140-144`), windowed by
`ABSENCE_EVIDENCE_MAX_AGE_DAYS` / `ABSENCE_COMMIT_MAX_AGE_DAYS`, bounded by
`ABSENCE_MAX_EVIDENCE_ROWS` and `ABSENCE_MAX_FINDINGS`, with an
`ABSENCE_MIN_GAP_HOURS = 24` grace so the normal commit-after-session workflow
stays silent (`:163-180`).

**Other coverage-adjacent signals:**

- **Connector liveness** — `PRESENCE_TTL_SECONDS = 90`; `presenceCutoff` at
  `services/presence.ts:31-33` (*"active = last_heartbeat_at > now − TTL"*).
- **Reap** — `SESSION_REAP_STALE_HOURS = 6`, `agent_sessions.reaped_at`. An
  inference from silence (`schema.ts:138-145`), and an over-firing one
  (`records.ts:72-74`, §1.4).
- **`state/capture-health.ts` (326 lines)** — the connector-side counters, and the
  closest thing to an honest coverage report that exists. `:1-9`: *"a count nobody
  reads keeps nothing honest: 371 worktree edits produced 0 targets across the
  trial and no surface said so."* It refuses two failure modes explicitly
  (`:13-31`): the bound must **not** be spent at random (newest-first sort before
  the cap, with `statesRead` / `statesTotal` so the surface can say the cut
  happened) and it must **not claim more than it measured** (`sessionSilentForMs`,
  `isStale` for doctor gates, `isIdle` for the 24 h `status` line).
  `statesUnparsed` counts files read that did not parse.
- **`state/git-lane-cost.ts`** (#50, §2.1) — the same discipline for the git lane,
  with the ran-denominator lesson.
- **`cli/doctor.ts` (2851 lines on main, +105 in #50)** — a
  `check(level, name, detail)` ladder with `PASS` / `WARN` / `FAIL`, including
  `spool depth` (`:1169`), `spool age` (`:1179`), `hooks registered` (`:415`),
  `capture` and `hints`. Doctor is where non-negotiable #4 is discharged today.

### 5.2 Every answer surface that does **NOT** consult coverage

This is the gap 03 exists to close, re-verified on `main@e9aab82`. Outside
`services/absences.ts`, `services/commit-evidence.ts`, `routes/absences.ts` and
`app.ts:35`, the **only** consumer of coverage is the briefing, and only as
pre-rendered lines it was handed.

| surface | file | consults coverage? |
|---|---|---|
| **search** | `services/search.ts` (761) | **No.** Imports only `agentSessions, claims, developers, workContextTargets, workContexts` (`:24-46`). No `commit_evidence`, no absence, no liveness. Ranks by RRF × time decay (`:4-22`). |
| **hint candidates / tripwire** | `services/hints.ts` (465) | **No.** Same table set (`:28-46`). Uses `presenceCutoff` for *liveness of the other session*, which is not coverage. |
| **diagnosis** | `services/diagnosis.ts` (466) | **No.** `:1-14`. Also the one place `stale_at` reaches a reader — as a permanent `null` (§1.7a). |
| **MCP render** | `connector-core/src/mcp/render.ts` | **No** coverage input in the payload. `:1157` emits *"No work context on this repo matched that query."* with no knowledge of whether anything was being recorded — 03 §1 calls this the concrete defect, at one line. |
| **briefing** | `connector-core/src/briefing/render.ts` | **Partially** — takes `absences?: readonly AbsenceEntry[]` (`:105-106`) already computed by `GET /api/absences`, renders it as lines (`:843-846`); it does not *gate* any other line on coverage. Ordering is explicit: contradictions → solved → drafts → absences (`:450-453`, `:685-688`, `:745-749`) — *"absences give way before pointers"*. |
| **conference** | `services/conference.ts` | **No.** |
| **solved matcher** | `services/solved-matches.ts` | **No.** |

**Therefore:** today the hub can answer "here is the related work" from a repo
whose connectors have been dead for a week, with no annotation at all. That is the
concrete, file:line-backed statement of the coverage gap, and it is what **AT-1**
and **AT-9** fail on. Nothing in the current tree carries a per-source coverage
record; the five sources named in §8.2 do not exist as a data structure anywhere
on main.

---

## 6. The render-surface registry and the injection corpora

### 6.1 The registry — `connector-core/src/render-surfaces.ts` (998 lines)

**Non-negotiable #2 is mechanically enforced, and a spec that adds a surface
inherits the obligation.** `render-surfaces.ts:1-19` names both halves:

1. every registered `corpus` surface is rendered against the whole injection
   corpus under class-appropriate invariants;
2. a **meta-test walks every `src` module of every workspace package** for calls
   into the render layer and **fails the build** on any module that is not the
   render layer itself, a barrel, or registered. *"A new render file that skips
   registration is a RED BUILD."*

Packages are **discovered from the filesystem, not enumerated**
(`test/render-surface-registry.test.ts:25-28`) — a new connector package is
enforced the day its directory appears, by exporting `RENDER_SURFACES` from its
own `src/render-surfaces.ts`.

Two surface kinds:

- **`CorpusRenderSurface`** (`:98-107`) — `kind: "corpus"`, `name`, `delivery`,
  `module` (package-relative, e.g. `"src/mcp/render.ts"`), `framing`, and
  `render: (untrusted: string) => string` which plants the payload in the
  surface's **most exposed slot**.
- **`CompositeRenderSurface`** (`:122-129`) — a module that renders untrusted text
  only through registered surfaces or render-layer primitives. Its
  `corpusCoveredBy` names package-relative test files, and **the registry test
  checks each named file exists and really runs the corpus** — a claim of coverage
  is machine-checked, never prose. The phrase `"corpus-covered"` is **banned** from
  `note` for that reason (`:119`).

**Two required classification fields.**

`RenderSurfaceFraming` (`:69`) = `framed | sanitized | bare | id` — `framed` output
carries `QUOTED_DATA_NOTICE`, passes the character invariants, and holds at most
one `« »` pair per line; `sanitized` additionally carries no frame characters at
all (`:61-68`).

`RenderSurfaceDelivery` (`:96`) = `pulled | unsolicited | outbound` (`:71-95`) —
the **anchoring asymmetry as data, not habit**: `pulled` is a thing the reader
asked for and is waiting for — *substance belongs here, at whatever length the
author wrote it*; `unsolicited` arrives unasked (a SessionStart briefing, a
mid-prompt hint, a statusline) and *anchors a session on somebody else's theory*,
so these stay tight; `outbound` is text on its way to the hub, held to the
unsolicited rule because a stored body is what a future briefing shows.
`test/anchoring-separation.test.ts` walks this field across every package — a
surface added without a classification is a **type error**.

**Exempt lists** (a spec adding to the render layer must edit these, and say so):
`RENDER_LAYER_MODULES` (`:138-147`) = `briefing/sanitize.ts`, `briefing/ghost.ts`,
`briefing/intent.ts`, `briefing/questions.ts`, `briefing/render.ts`,
`hints/render.ts`, `mcp/render.ts`, `mcp/render-referee.ts`;
`RENDER_BARREL_MODULES` (`:150-154`) = `src/index.ts`, `src/kit.ts`,
`src/render-surfaces.ts`.

**Registered surfaces — measured** (`grep -c '^    name: '`):

| package | main | with #50 |
|---|---|---|
| `connector-core/src/render-surfaces.ts` | **39** (`:493-993`) | 39 |
| `cli/src/render-surfaces.ts` | **3** — `cli-doctor`, `cli-conference`, `cli-status` (`:15,22,29`) | **6** — adds `cli-pin-observability` (`:128`), `cli-pin-list` (`:153`), `cli-suspect` (`:166`) |
| `connector-claude/src/render-surfaces.ts` | 4 — `claude-work-context-title`, `claude-summarizer-probe-line`, `claude-tripwire-ask`, `claude-statusline` (`:20-60`) | 4 |
| `connector-acp` (153 lines), `connector-cursor` (191 lines) | registered | registered |

(In core, `kind: "corpus"` greps 24 and `kind: "composite"` greps 17 = 41 > 39;
two of those hits are the interface declarations at `:100` and `:123`. **The
`name:` list is authoritative.**)

### 6.2 The corpora

There is **one attack corpus and two behaviour corpora**. Say which you mean.

- **`INJECTION_CORPUS`** — `connector-core/test/fixtures/injection-corpus.ts:164`.
  **Measured 61 cases**, by category:
  `invisible` 21 · `instruction` 12 · `self-mimicry` 7 · `oversize` 6 ·
  `frame-escape` 4 · `boundary-forgery` 4 · `structure` 4 · `homoglyph` 3.
  *(The file contains raw NUL bytes; `grep` needs `-a`.)*
  It also defines the MCP slot machinery: `MCP_DIAGNOSIS_SLOTS` (`:582`),
  `MCP_SEARCH_SLOTS` (`:611`), `MCP_REFEREE_SLOTS` (`:780`) — fifteen distinct
  untrusted fields with no counterpart in a presence roster (`:19-29`).
  It is **imported, never copied**, by at least seven test files:
  `render-surface-registry.test.ts:51`, `injection-corpus.test.ts`,
  `mcp-injection.test.ts:50`, `mcp-hostile-hub.test.ts:44`,
  `mcp-violations.test.ts:34`, `hint-flow.test.ts:39`,
  `solved-hint-flow.test.ts:38`.
- **`precision-corpus`** — `connector-core/test/precision-corpus.test.ts` +
  `fixtures/precision-corpus/`. The whole corpus through the **real** stack, every
  probe labelled `SUBSTANCE` / `POINTER` / `SILENCE`. Size is self-deriving:
  `VERIFY … PRINTS: 11 33 11 4 18` (`:19-20`) — 11 scenarios, 33 probes,
  11 substance / 4 pointer / 18 silence.
- **`conclusion-corpus`** — `connector-claude/test/conclusion-corpus.test.ts` +
  `fixtures/conclusion-corpus/`. `VERIFY … PRINTS: 20 7 13` (`:17-18`) — 20
  fixtures, 7 draft / 13 none.

Both behaviour corpora carry the same honesty rule, stated twice
(`precision-corpus.test.ts:9-16`, `conclusion-corpus.test.ts:9-14`):
**"THE FLOORS ENCODE TODAY'S INTENT, NOT MEASURED TRUTH."** A metric below its
floor is a regression against *declared intent*. Relabel a fixture with a
rationale when intent legitimately changes; **never tune a floor down to make one
pass.** A 1.0 spec proposing a threshold adopts this rule or argues against it
explicitly.

**Note for AT-7.** The injection corpus is a *framing* corpus — it proves text was
correctly quoted. AT-7's "fails if" line says framing is **not** behaviour, and the
counterfactual injection benchmark (control vs. treatment, comparing tool calls /
files / shell commands / plan changes) **does not exist in the tree**.
`INJECTION_CORPUS` is prior art for the payloads, not for the measurement (§10 Q12).

---

## 7. The mutation-check and verify-claims discipline

Two independent mechanisms. A 1.0 spec should say which anchors it needs from each.

### 7.1 `verify-claims` — prose that runs

`connector-claude/scripts/verify-claims.ts` (319 lines on main; #50 touches it).
The convention (`:17-20`): a comment block may carry `VERIFY:` naming **one
single-line shell command**, followed by one or more `PRINTS:` lines giving
**exactly** its stdout. `CONTAINS:` relaxes to substring for inherently noisy
output and every use must say at the call site why the command cannot be pinned
exactly (`:33-37`). Only **stdout** is compared, each line trimmed,
leading/trailing blanks dropped; **exit status is ignored deliberately** (`:39-47`).

**Measured: 149 `VERIFY:` directives across `packages/` on main.** Examples this
map relies on: the 800 ms budget (`connector-core/src/constants.ts:56-57`), the
refusal bound (`server/src/services/refusal.ts:24-25`), the corpus sizes (§6.2),
the mutation guard-count (`.github/workflows/ci.yml:119-120` — **re-measured 2026-09-14**; an earlier
draft of this map said `:117-118` and 05 §9.5 caught it, so the code wins and 03 §9 / 04 §9 are corrected).

Why it exists (`:4-15`): one branch produced eleven instances of one defect — a
comment stating behaviour its named command does not produce. What rotted were
**quantifiers and pointers**: "exactly one", "the ONLY", "2 of 8", "lines
312-321". **A count written into prose is the exact defect class this file exists
to kill. Write your spec's numbers as directives, not as sentences.**

What is deliberately **not** in it (`:49-60`): whole-suite mutation claims —
because they edit the tree they are checking, and a claim-checker that can corrupt
its own subject is worse than none.

### 7.2 `mutation-check` — proving the tests can fail

`connector-core/scripts/mutation-check.ts` (4794 lines on main), `MUTATIONS`
exported at `:50`.

Each entry is `{ label, file, from, to, test, because }` (`:38-47`): a single
textual edit re-introducing a real defect, the guarding test that must go **red**,
and the reason. **The mutation is a FAILURE of the script if that test stays
green** (`:8-10`). Every guard is run **unmutated first**, and an already-red guard
aborts the run (`:17-20`) — without that, `caught: exitCode !== 0` reports a defect
as detected when the guard was simply broken.

**Measured `MUTATIONS.length` on all three branches** (run, not remembered):

```
main@e9aab82          298
pins@bc88b8b          308   (+10)
dev-listing@2642640   304   (+6)
```

The count is **not** pinned inside `mutation-check.ts`. It is pinned in
**`.github/workflows/ci.yml:119-120`** as a `VERIFY:` / `PRINTS:` pair, together
with two further directives that print one line **per file** and one line **per
basename**. **THREE independent listings, not two** — measured on all three
branches: `:119` the count (`PRINTS:` at `:120`), `:127` the per-file block
(entries `:128-244` on `crosscheck-pins`), and `:246` on `crosscheck-pins` /
`:239` on `main` the per-**basename** block. A spec that updates the count and the
per-file block and forgets the third leaves the guard stale and CI red. **That
makes `ci.yml` the highest-traffic collision file in the tree — see §9.2.**

**How derived counts are pinned** — the pattern a 1.0 spec should copy:

1. the number lives as a named constant, not a literal;
2. the prose that quotes it carries a `VERIFY:` / `PRINTS:` directive that
   re-derives it *from the data*;
3. the behaviour that depends on it has a test, and that test appears in
   `MUTATIONS` with a one-line edit that must turn it red.

---

## 8. SHARED VOCABULARY — binding on all eight specs

Use these exact spellings. Do not invent synonyms; do not rename a dimension to
fit your component.

### 8.1 The decision model (five orthogonal dimensions)

```
behavior_delta:      confirmed | unconfirmed | flaky
coverage:            per SOURCE (see 8.2) — never one aggregate number
explanation_timing:  predeclared | post_hoc | absent
attribution:         ATTRIBUTED | UNATTRIBUTED | INDETERMINATE
protection:          unprotected | protected_ok | PROTECTED_CONFLICT
```

Binding consequences, restated from the four principles:

- **"Only judge when you know you were watching."** `UNATTRIBUTED` may be emitted
  **only under COMPLETE coverage**. Under a gap the value is `INDETERMINATE` —
  never "unexplained, low confidence". This is **AT-5**, whose "fails if" line is
  *"unattributed is reachable with a known coverage gap"*.
- **"Attribution is not permission."** The verdict is `ATTRIBUTED`, never
  `EXPLAINED` or `ALLOWED`. Attribution and protection are **orthogonal axes**:
  `attribution: ATTRIBUTED` + `protection: PROTECTED_CONFLICT` is a real,
  reachable state and every renderer must be able to show it.
- **"A reason written after a change is not evidence the reason existed before
  it."** `explanation_timing` is its **own dimension** and needs **causal order** —
  happens-before over a monotonic per-session event sequence. **Never wall-clock
  comparison** across machines, subagents, offline connectors or batch sync. This
  is **AT-4**, whose "fails if" line names wall-clock timestamps from two processes
  explicitly. (The tree already learned this in a smaller form:
  `commit-evidence.ts:34-42` clamps sender-controlled timestamps because they are
  a ratchet.)
- **"An agent cannot override human-protected behavior by broadening its own
  intent."** A fence invariant outranks any session widening. Changing one needs a
  **human waiver** — bounded, reasoned, append-only. **Never `amend_intent`.**
  This is **AT-6**; its "fails if" line also requires that **a waiver has an
  expiry**.

**`coverage = 87%` is FORBIDDEN.** So is any single scalar, badge or percentage
that collapses the five sources.

### 8.2 Coverage sources — exactly five, each with four states

```
sources: agent_event | git | ci | runtime | human_edit
state:   complete | incomplete | unknown | unavailable
```

`unavailable` is the honest answer for a rung that cannot exist on a platform —
write the refusal, do not sketch a design around it. **AT-10**'s "fails if" line
makes this binding: *"any silent absence, any fake pass, or any published score a
third party cannot reproduce."*

Mapping onto what exists today:

| source | closest existing signal | file:line | 03's verdict |
|---|---|---|---|
| `agent_event` | session liveness + capture counters | `presence.ts:31-33`, `state/capture-health.ts` | derived on read |
| `git` | `commit_evidence` (aggregate) + #50's `git_diff` target lane | `schema.ts:368-399`, `flows/capture-git-touches.ts` | derived on read |
| `ci` | **nothing on main** | — | `unavailable` / `no_emitter` until 05 lands |
| `runtime` | **nothing exists** | — | `unavailable` / `out_of_scope_1_0` |
| `human_edit` | `work_context_targets.source = tool_edit` (#50) | `schema/src/enums.ts` | **`unavailable` / `no_platform_rung`** |

**03 settled `human_edit` and every spec inherits the answer.** `tool_edit` records
the *agent's* edit tool; a human typing in vim with no session running fires no
hook on any platform we support, so the rung cannot exist. Calling the git-touch
lane `human_edit` would be *"the `coverage = 87%` lie in another shape"*
(03 §3.2). Human edits surface through `git`, via `listAbsences`' `inactive`
finding.

### 8.2a The coverage record — 03's names, binding

Do **not** mint a second coverage type. `packages/server/src/services/coverage.ts`
(03 §3.1) owns:

```ts
COVERAGE_SOURCES = ["agent_event","git","ci","runtime","human_edit"]
COVERAGE_STATES  = ["complete","incomplete","unknown","unavailable"]

interface CoverageSourceRecord { source; state; reason; gapSince; observedAt }
interface CoverageRecord       { repo; computedAt; sources /* EXACTLY five */ }

isJudgeable(record, scope?): boolean   // principle 1, as a function
```

**`isJudgeable` reads all five sources, not two — corrected 2026-09-14.** The
first shape tested `agent_event` and `git` only, which left `UNATTRIBUTED`
reachable while `ci` was known `incomplete` (05 §3.6's mid-flight or missing lane)
— **AT-5's own "fails if", live in the design**. The binding definition is now:

```ts
isJudgeable = (r, scope?) =>
  stateOf(r,"agent_event") === "complete" &&
  stateOf(r,"git")         === "complete" &&
  r.sources.every(s => s.state !== "incomplete");
```

`incomplete` is the only disqualifying state for the other three, deliberately: a
rung that **cannot exist** (`unavailable`) must not block judging, or no verdict is
ever reachable, and `unknown` on a rung nobody reports is the ordinary state of a
fresh install. A *known, positively observed* gap is what AT-5 names. 03 COV-10
enumerates all five.

Plus: `CoverageReason` is **an enum, never prose** — `sessions_reported ·
session_reaped · session_silent · no_session_in_window · commits_reported ·
commit_authors_unreported · evidence_stale · no_commit_evidence · no_emitter ·
out_of_scope_1_0 · no_platform_rung · hub_did_not_report` (03 §3.3). Consequence
every writer inherits: **a coverage line contains no author-written string**, so it
adds no untrusted slot to any surface it lands on.

And the parse rule, which **inverts** the tree's usual tolerant-parse convention:
**absent coverage is `unknown`, never silence and never `complete`** — a response
with no `coverage` block becomes `UNKNOWN_COVERAGE`, five rows, all `unknown`,
reason `hub_did_not_report` (03 §4). `MAX_COVERAGE_LINE_CHARS = 160`.

Coverage is **derived on read — no table, no migration, no retention** (03 §3.2),
because `reaped_at` is revocable and a stored verdict would outlive its evidence.

### 8.2b The CI lane — 05's names, binding

`lane = (repo, provider, workflow, job, leg, ref)` and **nothing is ever compared
across lanes** (05 §3.1). Tables `ci_runs` (one row per lane per attempt,
deterministic `cir_` id) and `ci_test_results` (**non-green rows only**).
`readCiCoverage(deps, repo, commitSha) → CiCoverage { state, lanesExpected,
lanesReported, truncatedLanes, awaitingRerun, collectedAt }`.
`lanesExpected` is **derived, not declared** — the lanes that reported in all of
the last `CI_LANE_QUORUM_COMMITS` distinct commits on this ref.
Constants: `CI_FLAKE_BASE_RUNS = 5`, `CI_BASE_WINDOW_DAYS = 14`,
`CI_LANE_QUORUM_COMMITS = 3`, `CI_RETENTION_DAYS = 30`.

**This is what discharges AT-8** (*"a red test alone is not a regression"* — the
same verification green at a named commit, and a re-run of the same commit to
separate flake from regression).

### 8.3 The two evidence axes — NOT a ladder

The advisor's L1–L4 ladder was **rejected and the rejection accepted**. There are
two independent axes:

```
WHO claims it:    human_declared | agent_derived
WHAT supports it: unsupported | tool_observed | repository_verified
```

**A profiler trace is EVIDENCE FOR a claim, not a higher rank of it.** Never write
"L3", "level 3", "tier 3" or "promoted to". Never collapse the two axes into one
score.

These map onto columns that already exist — a spec should reuse rather than
duplicate: `claims.provenance` (`declared | derived`) is the WHO axis;
`claims.capture_mode` (`auto | agent | human`) is how it was captured; and the hub
already refuses `derived` above `DERIVED_CONFIDENCE_CAP = 0.5`
(`claim.ts:32-44`, and `session.ts:40-52` for intents).

**The trustworthy-WHO pattern, already implemented in #50 and the answer to AT-3.**
`services/pins.ts:185-189` — the hub **stamps** `capture_mode` and the body may
**never** carry it; `services/pins.ts:112` stamps the literal `"human"` on the
human route. AT-3's "fails if" line has two halves — *"`publish_claim` or any agent
surface can produce human capture mode, **or** the attempt is silently downgraded
instead of refused"* — so the agent path must **refuse**, not coerce.

**Unknown provenance fails CLOSED to `derived`** (non-negotiable #3).

### 8.4 Canonical minimum event kinds — nine, and one refusal

Nine kinds that travel the existing envelope and spool (§4.1), each with the one
fact it carries. `ci.result` has been **removed from this list** — see §8.4a.

| kind | carries | feeds coverage source |
|---|---|---|
| `session.started` | session id, repo, branch, base_commit, agent_kind, **seq = 0** | `agent_event` |
| `intent.declared` | intent summary, provenance, confidence, capturedAt, **seq** | `agent_event`, `explanation_timing` |
| `intent.amended` | new intent, prior intent ref, **seq** | `explanation_timing` (never a fence override) |
| `tool.failed` | error fingerprint (hashed), tool name, **seq** | `agent_event` |
| `file.modified` | path, **`source`** (`tool_edit \| git_diff \| both`), **seq** | `git` (lane label; see note) |
| `claim.created` | claim id, kind, status, provenance, capture_mode, **seq** | `agent_event` |
| `claim.invalidated` | claim id, superseding claim id or null, **seq** | `agent_event` |
| `commit.observed` | repo, author, latest_commit_at, count, window (**aggregate — no hashes today**, §1.9) | `git` |
| `session.ended` | reason: `reported \| reaped`, **seq = last** | `agent_event` |

Note on `file.modified`: `human_edit` as a *coverage source* is `unavailable`
(§8.2). The event still carries `source` because **attribution** needs the lane
label — that is a different question from coverage, and 03 §3.2 explains why
conflating them is the scalar lie.

**Three properties that are not negotiable across specs.**

1. **`seq` is a monotonic per-session integer**, assigned by the emitting
   connector, and it — not `ts` — is what `explanation_timing` compares. `ts` stays
   in the envelope (`envelope.ts:33`) for display and retention only. This is
   principle 3 and AT-4 made mechanical. **Q2 names the one place it can live.**
2. **`file.modified` must carry `source`.** #50 already proved why: the tool lane
   cannot see `sed -i`, codemods, `prettier --write` or generators, and a ranking
   built on it alone *"names the session that used Edit with total confidence while
   the session that actually rewrote the file is invisible"*
   (`flows/capture-git-touches.ts:5-11`, restated in `state/git-lane-cost.ts:5-11`).
3. **`session.ended` must distinguish `reported` from `reaped`.** A reap is an
   inference from silence, is revocable (`schema.ts:138-145`, `records.ts:71-79`),
   and over-fires on read-and-plan sessions (`records.ts:72-74`). A coverage
   computation that reads a reap as a clean end will report `complete` over a gap —
   which is exactly the AT-5 failure.

### 8.4a `ci.result` is NOT an event kind — 05's refusal, adopted

The first draft of this map listed `ci.result` as a tenth envelope kind. **05 §3.7
refused it, correctly, and this map adopts the refusal:**

`EnvelopeSchema` requires `producer: { developerId, agentKind, sessionId }`
(`envelope.ts:19-23, 30-37`) and **CI has none of the three**. Minting a synthetic
session is the phantom teammate of Q9. So the CI reporter **is not a producer, it
does not spool, and it does not go through `/api/records`**. It posts to its own
route, `POST /api/ci-runs`, under its own middleware.

**The generalisable rule for the other seven writers:** the nine kinds above all
originate *inside an agent session*, which is what makes them envelopes. **A 1.0
record that can originate outside an agent session gets its own route, and says
so.** Do not widen `ProducerSchema` to make a non-session fact fit.

### 8.4b Three naming namespaces — which one, and why (Q3, answered)

| namespace | spelling | where |
|---|---|---|
| record kinds | snake, singular: `claim`, `target`, `work_context` | `envelope.ts:42-54`, 11 kinds |
| hub outbox | snake, past tense: `claim_added`, `session_started` | `server/src/constants.ts:450-465`, 7 kinds |
| **1.0 events** | **dotted: `claim.created`** | §8.4, 9 kinds |

They are three namespaces because they are three different things: a **record** is
a fact a connector ships, an **outbox event** is a notification the hub fans out
over SSE (`events.id` bigserial is the replay cursor, `schema.ts:335-340`), and a
**1.0 event** is a point in a causal sequence. Dotted is right *because* it is
visibly not the other two.

**The outbox deliberately omits kinds** — `constants.ts:456-464` refuses question
events because *"a question is addressed to ONE person and the outbox is a
team-wide feed"*. A 1.0 event kind is **not** automatically an outbox kind. Adding
one to `EVENT_KINDS` is a separate, argued decision per kind.

### 8.5 Words that are banned

`EXPLAINED`, `ALLOWED` (use `ATTRIBUTED`) · `L1`/`L2`/`L3`/`L4`, "rank",
"promoted" for evidence · a scalar `coverage` percentage, and any `overall` field ·
`amend_intent` as a route around a fence · "corpus-covered" in a registry `note`
(`render-surfaces.ts:119`) · "score" or "ranking" applied to a **person**
(`suspect.ts:21-25`: sessions and intents, never people) · prose in a
`CoverageReason` (03 §3.3).

### 8.6 Scope — cite `00-cut-line.md`, do not restate it

**Tier 1 (the 1.0 foundation):** claim ↔ code binding · individual commit
identity · coverage integrity at the answer layer · a per-session monotonic event
sequence · a production writer for human authority · verdict semantics · fence
authority and the human waiver · pilot instrumentation for the five proofs.

**Tier 2 (provisional, the pilot decides):** structured intent + amendments · CI
ingestion keyed to a commit · the fence ratchet · the counterfactual injection
benchmark · the two evidence axes + calibration measurement.

**Tier 3 (cut — name as out of scope, prepare the data model only where it costs
nothing):** conference · semantic collision detection · auto-generated behavioural
probes · runtime invariant mining · elaborate change envelopes · heavy intent
inference from agent prose · calibration scoring UI. Plus, from the closed
decisions: **the pre-edit ask rung** (it becomes a one-shot hard refusal in every
promptless session — and the tree already documents why, measured, at
`connector-core/src/constants.ts:1274-1296`).

**Order of work, from the cut line:** *"git and code-state binding move ahead of
the injection benchmark. They are the only item that pays into three problems at
once — staleness, ground truth, and coverage integrity."*

**Closed — do not reopen:** anyone may pin (team setting; #50 implements it as
`TEAM_PIN_POLICIES`) · recipe mandatory for a pin that speaks
(`MAX_SPEAKING_PIN_FILES = 5`) · suspect names **sessions** with no announcement ·
the "intent covers pin" predicate is **DEAD** · the pre-edit ask rung is out.

---

## 9. COLLISION LEDGER

Files a 1.0 spec will need that PR #50 or PR #49 also changes. **A spec that
contradicts what is about to merge is wrong on arrival.** Column *Assume* is what
your spec should treat as the baseline. All numbers measured by
`git diff --numstat e9aab82..HEAD` on each branch.

### 9.1 Hard collisions — PR #50 @ `bc88b8b`

| file | #50 delta | 1.0 components likely to collide | Assume |
|---|---|---|---|
| `server/src/db/schema.ts` | **+143/−1**: `pins`, `pin_files`, `team_settings`; `work_context_targets.source` | claim binding, event model, coverage, verdict, fence | **#50 merged.** Build on `source`; do not re-propose a lane label. `stale_at` is untouched by #50 (§1.7a). |
| `schema/src/enums.ts` | +22: `TARGET_SOURCES`, `STORED_TARGET_SOURCES`, `TargetSourceSchema` | event model (`file.modified.source`) | **#50 merged.** Reuse the enum; do not mint a parallel one. |
| `schema/src/session.ts` | +14/−1: `TargetSchema.source` optional, **defaults `tool_edit`** | event model, intent ledger | **#50 merged.** The default is the forward-compat contract for old spools. `IntentSchema` lives here too (§1.5). |
| `server/src/services/record-handlers.ts` | +19: the `"both"` upgrade on PK collision | event model, coverage | **#50 merged.** A second lane reporting the same path is a `duplicate` record that changes only the label. |
| `connector-core/src/constants.ts` | +62: `PIN_SWEEP_*`, `GIT_TOUCHES_TIMEOUT_MS = 250` | every spec that adds a budget | Append below #50's block; never renumber. |
| `server/src/constants.ts` | +38: `SUSPECT_*` block | verdict semantics, attribution, CI | **#50 merged.** `SUSPECT_WINDOW_DAYS = 14` is the attribution window; 05 matches `CI_BASE_WINDOW_DAYS` to it on purpose. **#49 also edits this file** (§9.4). |
| `connector-core/src/http/hub.ts` | **+357** | every spec adding a hub call | **#50 merged.** Largest single-file collision surface. |
| `connector-core/src/state/session-state.ts` | **+39** (was +30): `gitTouchCount`, `gitLaneSkipped`, `gitLaneRan`, `withGitTouches` | **event model — `seq` lives here** (Q2) | **#50 merged.** Copy the `.default(0)` + transform shape exactly. |
| `connector-core/src/state/git-lane-cost.ts` | **NEW, 117 lines** | coverage, pilot instrumentation, any WARN gate | **#50 merged.** New file, no textual conflict — but it is the counter *pattern* to copy (ran-denominator). |
| `connector-claude/src/hooks/stop.ts` | +62/−1: the git-touch lane inside Stop's spare budget | event model, pilot instrumentation | **#50 merged.** Stop's `spareMs` is **already partly spent**. Budget accordingly and keep the record-before-spawn order. |
| `connector-core/src/flows/capture-targets.ts` | +31 | event model, coverage | **#50 merged.** |
| `connector-core/src/flows/capture-touched-files.ts` | +13 | event model | **#50 merged.** |
| `connector-core/src/capture/records.ts` | +10 | event model | **#50 merged.** |
| `connector-core/src/git/git.ts` | +45 | coverage (`git` source), commit identity | **#50 merged.** |
| `cli/src/render-surfaces.ts` | **+163: 3 → 6 surfaces** | **any spec adding a CLI surface** | **#50 merged.** The first draft of this map and 05 §9 both called this free ground. **It is not.** See the insertion convention immediately below — it is one place, and it is the array tail. |
| `cli/src/cli/doctor.ts` | +105 | coverage, fence, every "visible in doctor" obligation | **#50 merged.** Non-negotiable #4 lands here; #50 already added `checkPins`. |
| `cli/src/cli/status.ts` | +34 | pilot instrumentation | **#50 merged.** |
| `server/src/app.ts` | +17: three route mounts | CI ingestion, any new route | Append; do not reorder. |
| `server/src/db/bootstrap.sql` | +92 | any spec adding a table or index | **Mirror every index here.** `test/ddl-sync.test.ts` (+27) enforces it. |
| `connector-claude/scripts/verify-claims.ts` | touched | any spec adding a `VERIFY:` | **#50 merged.** The first draft missed this file. |
| `connector-core/scripts/mutation-check.ts` | **+151** (was +103) | any spec adding a guarded predicate | **Both PRs edit this file.** See §9.4. |

**9.1a `cli/src/render-surfaces.ts` — ONE insertion convention, binding.**
Four specs add a CLI surface — 02 `cli-claim-revalidate`, 04 `cli-verdict`, 05
`cli-ci-report`, 07 `cli-pilot` — and before this revision three of them named
*"after `cli-suspect`"* while one named *"the array tail"*, as though those were
the same place. **They are six lines apart.** #50 **prepended** its three surfaces,
so the measured order on `crosscheck-pins` is `cli-pin-observability` (`:128`),
`cli-pin-list` (`:153`), `cli-suspect` (`:166`), `cli-doctor` (`:178`),
`cli-conference` (`:185`), `cli-status` (`:192`) — main's original three sit at the
**end**, and the array tail is `cli-status` at `:192`, not `cli-suspect` at `:166`.

> **A new CLI surface appends at the ARRAY TAIL, after `cli-status`.** Never
> "after `cli-suspect`". Inserting mid-array makes three specs conflict three ways
> on one line for no reason; appending makes each a one-line addition at a
> different offset.

**And the tail order is the build order** (§9.7), so each spec appends after the
last one that landed: `cli-claim-revalidate` (02) → `cli-ci-report` (05) →
`cli-verdict` (04) → `cli-pilot` (07), plus 07's `pilot-mark` composite entry.
The registry is machine-checked (`test/render-surface-registry.test.ts:25-28`), so
getting this wrong is a red build, not a cosmetic diff.

### 9.2 `.github/workflows/ci.yml` — the collision the first draft missed

**Both PRs edit the same line.** `ci.yml:119-120` (**re-measured**; this map
first said `:117-118`) carries

```
VERIFY: bun -e 'const {MUTATIONS}=await import("./packages/connector-core/scripts/mutation-check.ts");console.log(MUTATIONS.length)'
PRINTS: 298
```

- **#50** (+15/−4) rewrites `PRINTS: 298` → `PRINTS: 308` **and** adds eight
  per-file / per-basename `PRINTS:` lines (`pin-render.ts 1`, `pin-sweep.ts 1`,
  `git-lane-cost.ts 2`, `pins.ts 2`, `suspect.ts 2`, `hub.ts 2 → 3`, …).
- **#49** (+3/−3) rewrites the same line → `PRINTS: 304` and bumps
  `developers.ts 1 → 7` in both listings.

**Measured, so nobody has to guess:** main 298, #50 308, #49 304, and the additions
are disjoint (different files), so **after both merge the line reads
`PRINTS: 314`** — a number neither branch contains. This is a guaranteed textual
conflict and a semantic one: resolving it by taking one side leaves CI red.

**Instruction for whoever merges the second PR** — the first thing that happens
in the build order (§9.7), and previously written nowhere: `ci.yml:120` and the
`mutation-check.ts` array tail conflict between #50 and #49 themselves, before any
spec starts. **Take neither side.** Re-run the `VERIFY:` command on the merged tree
and write what it prints; the arithmetic (298 + 10 + 6 = 314) is the expectation,
not the source. The same applies to both further listings.

**Binding on all eight writers.** Any spec that adds a `MUTATIONS` entry — and by
§7.2 most should — **must name `ci.yml` in its own collision section**, state that
it bumps the count and **adds or bumps its lines in BOTH further listings — the
per-file block at `:127` and the per-basename block at `:246`** — and **must not
write a literal post-merge total into the spec**, because it cannot know how many
other specs land first. Write the `VERIFY:` directive; let CI print the number.

**Add versus bump, because the two listings key differently.** The per-file block
keys on the full path, so a new file is always a new line. The per-basename block
keys on the **basename**, so a new file whose basename already exists is a **BUMP
of an existing line, never a new one**. Measured on `crosscheck-pins`: `render.ts`
already stands at 26 (`ci.yml:312`) and `record-handlers.ts` at 1 (`:307`), so 03's
`coverage/render.ts` and 06's `mcp/render-intent-chain.ts` bump `render.ts`, and
06's `record-handlers.ts` entries bump a line that exists. Both specs are corrected.

**The same rule binds a second shared directive, discovered 2026-09-14.**
`MCP_DIAGNOSIS_SLOTS` (`connector-core/test/fixtures/injection-corpus.ts:582`)
carries a `VERIFY:` / `PRINTS:` pair over a list **two specs append to** — 06 adds
two slots, 08 adds one, today's measured length is 18, and each spec had written
its own absolute post-change total (`20` and `19`), so whichever landed second
would have reddened the other. Generalised: **no spec writes a literal total into
any `PRINTS:` whose command counts a list more than one spec appends to.** Write
the directive, name the fixture file and the other appender under *Collisions*, and
let CI print the number.

05 has a second reason to touch this file: the CI reporter step itself. `ci.yml`
also already documents, at `:10-12`, that the team keeps both matrix legs
*precisely because they disagree* — which is where 05's "nothing is ever compared
across lanes" comes from.

### 9.3 Hard collisions — PR #49 @ `2642640`

| file | #49 delta | 1.0 components likely to collide | Assume |
|---|---|---|---|
| `server/src/services/developers.ts` | **+185/−18**: `listDevelopers`, `readDeveloperPage`, `ListedDeveloperView`, `DeveloperListing`, alias-cap race fix | coverage (identity resolution), pilot instrumentation | **#49 merged.** Reuse `readDeveloperPage`'s bounded-read seam. |
| `server/src/routes/developers.ts` | +5: `GET /` | any admin surface | **#49 merged.** |
| `server/src/constants.ts` | +9: `DEVELOPERS_MAX_LISTED = 200` | — | **Both PRs edit this file**, #49 near the head and #50 at the tail. Low textual risk, real merge-order risk. |
| `connector-core/scripts/mutation-check.ts` | **+101/−1** | — | **Second editor.** #50 adds +151. Conflicts at the array tail. |
| `.github/workflows/ci.yml` | +3/−3 | **everything** | See §9.2. |
| `docs/DESIGN.md` | +1/−1 | any docs task | Trivial, but both branches touch docs. |

### 9.4 Files both PRs touch — sequence explicitly

1. **`.github/workflows/ci.yml`** — same line, both. Hardest. (§9.2)
2. `packages/connector-core/scripts/mutation-check.ts` — +151 and +101, both at the
   array tail.
3. `packages/server/src/constants.ts` — different regions, low textual risk.

**Sequencing rule for all eight writers:** write against **main + #50 + #49 both
merged**. Where you must reference a line that only exists on a PR branch, cite it
as `crosscheck-pins:<path>` or `crosscheck-dev-listing:<path>` so a reviewer can
tell a landed fact from a pending one. **PR #50 is being actively fixed** — re-read
`crosscheck-pins` before you cite a line number from it, and prefer citing a header
or a symbol name over a line number on that branch.

**9.4a CITATION CONVENTION — one, because the set had two and no way to tell them
apart.** Specs 04, 05 and 08 cited `origin/main` line numbers while declaring *"#50
assume merged"*; 03 and 07 used post-#50 numbers in the same document set. #50 adds
+105 lines to `doctor.ts`, +143/−1 to `schema.ts` and +19 to `record-handlers.ts`,
so every anchor below an insertion point moves and a builder who takes a stale cite
literally reads the wrong code. Measured pairs, so nobody re-derives them:

| anchor | `origin/main` | `crosscheck-pins@bc88b8b` |
|---|---|---|
| `const check = (level, name, detail)` — `cli/src/cli/doctor.ts` | `:190` | `:204` |
| `export const claims = pgTable(` — `server/src/db/schema.ts` | `:237` (block `:237-291`) | `:257` (block `:257-311`) |
| `.insert(claims)` — `services/record-handlers.ts` | `:492` | `:511` |
| `captureMode: body.captureMode` — `services/record-handlers.ts` | `:501` | `:520` |
| `commitEvidence.reportedBy` — `server/src/db/schema.ts` | `:394` | `:414` |
| `describe("bootstrap.sql DDL sync"` — `server/test/ddl-sync.test.ts` | `:16` | `:22` |
| `app.route(` mounts — `server/src/app.ts` | `:26-50`, 17 mounts | `:29-67`, 20 mounts |

> **A bare line number means `origin/main` at `e9aab82`. A post-#50 line number
> carries the `crosscheck-pins:` prefix, always — even when the file also exists on
> main.** Where an anchor moves, cite the **symbol** and give both numbers, as the
> table above does. This is the one convention; a cite without a prefix that names
> a post-#50 position is a defect, not a style choice.

### 9.5 Genuinely free ground — not touched by either PR

`services/absences.ts` · `services/search.ts` · `services/hints.ts` ·
`services/diagnosis.ts` · `services/commit-evidence.ts` · `services/visibility.ts` ·
`services/presence.ts` · `services/sessions.ts` · `briefing/render.ts` ·
`mcp/render.ts` · `middleware/auth.ts` · `schema/src/claim.ts` ·
`connector-core/src/render-surfaces.ts` · the corpora fixtures.

Note the asymmetry, unchanged: **the coverage gap (§5.2) and the `stale_at` vacancy
(§1.7a) are entirely in free ground; the attribution and fence machinery is
entirely in #50's ground.**

### 9.6 Collisions between the 1.0 specs themselves

Two specs already exist and their ground is taken:

| file | owner | everyone else |
|---|---|---|
| `server/src/services/coverage.ts` (new) | **03** | consume `CoverageRecord` / `isJudgeable`; do not redefine |
| `server/src/services/ci-delta.ts`, `ci_runs`, `ci_test_results`, `POST /api/ci-runs`, `schema/src/ci-run.ts` (new) | **05** | consume `readCiCoverage`; do not add a second CI table |
| `routes/absences.ts`, `routes/search.ts`, `routes/hints.ts`, the diagnosis route — each gains a `coverage` sibling field | **03 §3.5** | a spec adding a field to these responses coordinates with 03's shape |
| `middleware/auth.ts` — `requireCiToken` | **05 §3.7** | a spec needing machine auth reuses it or argues for a third |

**Every one of the eight specs appends to `MUTATIONS` in
`connector-core/scripts/mutation-check.ts`, so all eight conflict at the array
tail.** Three specs (03 §9, 05 §9.6, 06 §9) independently called themselves *"the
third editor"* of that file, which is direct evidence that none of them sequenced
against the others on it. **There is no third seat.** #50 is the first editor
(+151/−0, measured) and #49 the second (+101/−1); the eight specs are editors
**3 through 10**, in the build order below, and each states its own position rather
than a rank it shares with two others.

### 9.7 BUILD ORDER — binding, and where the gates come from

```
#50 → #49 → 03 → 01 → 06 → 02 → 08 → 05 → 04 → 07
```

**Step 0 is the two PRs against each other**, not a spec: they collide on
`ci.yml:120` and the `mutation-check.ts` tail before anything else starts (§9.2 now
carries the instruction).

**Six of the eight are hard-gated on #50** — they consume code or tables that exist
only on that branch, not merely text:

| spec | the #50-only ground it consumes |
|---|---|
| 01 | `work_context_targets.source` / `TARGET_SOURCES` for `seq_kind`; folds allocation into `withGitTouches`; appends to #50's `SessionState` fields |
| 02 | `runGitOutcome` (`crosscheck-pins:connector-core/src/git/git.ts:138`, **absent on main**), which `claim-drift.ts` requires |
| 03 | `GitTouchesOutcome` from `flows/capture-git-touches.ts` (**a file that does not exist on main**, imported only by `connector-claude/src/hooks/stop.ts:25`); mirrors #50's `checkGitLane` ladder (`doctor.ts:1660`) |
| 04 | every table and surface it extends is #50's — `pins`, `pin_files`, `suspect`, `cli-suspect`, `checkPins` |
| 06 | adds a clause to #50's `cli-suspect` intent line |
| 07 | extends #50's `pins`, `services/pins.ts`, suspect answer, doctor ladder and CLI surface list |

**Only two are gated textually rather than structurally:** 05 (it appends tables,
constants and mounts after #50's; no #50 code dependency) and 08 (its hard
dependency is 02, not #50).

**Why this order, clause by clause:**

- **03 first** — it owns `CoverageReason` and the COV-5 shape 05 must then edit,
  and both 04 and 07 consume `isJudgeable`. 04 §9 already declares
  *"#50 → #49 → 03 → 04"*; 05 §9.1 already declares *"Sequence 03 first"*.
- **01 next** — 04 consumes `isOrderable` and 06 consumes `seq`; 01 §9 calls the
  verdict spec *"the only hard dependency in the set … this spec first"*. 03 §9 and
  06 §9 both state no dependency either way with 01, so 03 may precede it.
- **06 next** — 04 consumes `explanationTimingFor`, and 01's two intent event kinds
  project into 06's ledger rather than `session_events` (01 §3.2, 06 §8.5).
- **02 before 08** — 08 §9 adopts *"02 first, 08 appends — one migration, one
  `bootstrap.sql` edit, one `ddl-sync.test.ts` block."*
- **05 late** — 05 §9.5 states it: *"Sequence last, after #50, #49 and the other
  … specs' entries"*, because it is the only spec editing `ci.yml` for **content**
  as well as counts.
- **04 second-to-last** — it is the only spec consuming all of 03, 01, 06, 05
  and 08.
- **07 last** — 07 §9 states *"if the verdict spec renames or widens them my
  columns follow, I do not fork the enum"*, and its `pins` column stacks on 04's
  `pins.version`.

**The one contradiction that had to be decided before this order could be
finalised** — 01 §3.7 forcing `attribution: INDETERMINATE` under unusable causal
order, against 04 §9's refusal — **is resolved in 04's favour** (01 §3.7 now
yields, 04 §10 D7 is retired). Had 01 landed as first written, every pre-`seq`
connector would silently lose attribution.

---

## 10. Open questions the writers must resolve

Ordered by how much downstream work each blocks. **Q1 is answered and retired.**

**Q1 — RETIRED.** The cut line is recovered (§0.1). Cite AT numbers and tiers from
`docs/1.0/00-cut-line.md`.

**Q1′ — Do 03 and 05 get a mapping note back to the acceptance tests?**
Both were written under the old refusal and say *"AT-1 and AT-9 do not exist as
text"*, which is now false. Their fresh `COV-*` / CI tests are good and should
stay. What is missing is one line in each saying which AT each test discharges:
**03 → AT-1, AT-9, AT-10**; **05 → AT-8**. This is an edit to two existing files,
not a rewrite.

**CLOSED 2026-09-14.** Both edits are made. 03 §7 names an AT per `COV-*` test and
its header now reads *"Owns AT-1, AT-9 and AT-10"*; 05 §7 maps `CI-1…CI-8` onto
AT-8 and its header now reads *"Owns AT-8"*. **The `cli/src/render-surfaces.ts`
half was already done** before this map was re-read — 05 §9.4 carries the
correction with its own measurement (*"main has exactly three `name:` entries
(`:15`, `:22`, `:29`), `crosscheck-pins` has six"*), which §9.1a above verifies as
accurate. A fixer working this list must not re-open it.

**One owner per AT, and the whole table now lives in `docs/1.0/README.md`.** Four
ATs had been claimed twice or half-claimed four ways (AT-4, AT-8, AT-10 and, worst,
AT-3, which no spec owned at all). The README is the authority; a spec header that
disagrees with it is the spec that is wrong.

**Q2 — Where does `seq` come from, and who guarantees monotonicity? STILL BLOCKING,
but narrowed to one mechanism.**
Principle 3 and **AT-4** need happens-before over a monotonic per-session sequence.
Three candidates, and two are now eliminated on measured grounds:

- **Spool line offset — ELIMINATED.** `spool/append.ts:7-13` states a session's
  spool file has **more than one writer**: recovery appends to files it does not
  own, `rescueTail` puts rescued bytes back onto another session's path, and
  `appendThroughHandle` recreates a file reap unlinked. Offsets are not a session
  sequence.
- **Envelope `ts` — ELIMINATED by AT-4's own "fails if" line.**
- **`SessionState` via `updateSessionState` — the only mechanism that works.**
  `session-state.ts:460-475` is a lock-protected read-modify-write keyed by
  `hostSessionKey`. A `seq` field added the way #50 added `gitTouchCount`
  (`z.number().int().min(0).default(0)` + a transform) is monotonic per host session
  by construction, and `.default(0)` keeps every older state file parsing.

**ANSWERED 2026-09-14 by 01 §3.6, on a measurement that corrects §4.4a.**

1. **The detached summarizer worker — NOT outside the lock after all.** The first
   reading measured `connector-claude/src/summarizer/worker.ts` and stopped there.
   The path it calls writes: `worker.ts:24` imports `deriveFromSlice`, and
   `derive/summarizer/derive.ts` imports `updateSessionState` (`:41`) and calls it
   at `:92`, `:154`, `:160`, `:168`, `:202`; `derive/ghost/worker.ts:378` likewise.
   So the three detached workers allocate inside the lock discipline (01 §3.6) and
   `seq: null` is reserved for **genuine allocation failure**, not made the default.
   **The residual, which 01 §3.6 now states rather than hides:** a worker summarises
   a slice from *earlier* in the session, so the position it allocates records when
   the row was **written**, not when the fact was observed — the same objection 02
   §6 makes against resolving `RepoIdentity` in those workers. A worker-authored
   record therefore carries `seq_kind = "observed"`, an **upper bound only**, and a
   "did X precede this" query against one refuses exactly as it does for a
   `git_diff`-sourced `file.modified`.
2. **Subagents.** `connector-core/src/constants.ts:1277-1296` records, measured,
   that *"orchestration subagents are spawned FROM a Claude Code session, so the
   parent's interactive value leaks into exactly the shape a detector exists for"*,
   and that there is **no trustworthy per-hook signal for headless**. If a subagent
   inherits the parent's `hostSessionKey` it shares the counter (fine); if it mints
   its own it is a separate sequence (also fine); **if it sometimes does each, `seq`
   comparison is silently wrong**. This must be measured, not assumed.

*One writer must own `seq` and every other spec consumes it. Decide before the
event-model spec is written, not after.*

**Q3 — ANSWERED in §8.4b.** Dotted for the 1.0 event stream, and a 1.0 event kind
is **not** automatically an outbox kind. Each spec that wants SSE fan-out argues for
that kind separately.

**Q4 — Individual commit identity: what table, and what does it cost?**
Cut line Tier 1 asks for hashes, not counts. `commit_evidence` is an **aggregate**
with PK `(repo, author_email)` and no hash column (§1.9), so this is a **new
table**, and it collides with three things at once: retention
(`COMMIT_EVIDENCE_RETENTION_DAYS = 30`), data minimisation (non-negotiable #6 — and
note `author_email` never leaves the hub today), and the unbounded-growth property
`commit_evidence` was explicitly designed to avoid (`schema.ts:370-373`). **AT-2**
needs it (a claim's downgrade must *name the commits*), and **03 §0 already
refused** the brief's example sentence *"coverage incomplete for commits A..F"* on
exactly this ground. Name the cost; do not assume the table. *Owner: the
claim-binding spec.*

**Q5 — PARTLY ANSWERED. `ci` is created by 05; `runtime` is refused.**
05 creates the `ci` source with its own tables, its own route and `requireCiToken`
(§8.2b). `runtime` stays `unavailable` / `out_of_scope_1_0` — runtime invariant
mining is Tier 3. **What is still open is Nick's, not a writer's:** 05 §10 asks
whether a hub-level `CROSSCHECK_CI_TOKEN` is acceptable given the hub has exactly
two middlewares today (`requireAdmin`, `developerAuth` — `middleware/auth.ts`) and
no machine identity at all.

**Q6 — Where does a `PROTECTED_CONFLICT` render, and inside whose budget?**
Non-negotiable #1 says inform/annotate/ask, never block. The only unsolicited
in-session channels are the 800 ms `UserPromptSubmit` and `PreToolUse` hooks, both
capped at `MAX_HINTS_PER_PROMPT = 1` (`constants.ts:84`), and `PreToolUse` already
carries the tripwire ask. A conflict notice **competes with a hint for the single
slot**. Who wins, and is it a new registered surface with `delivery: "unsolicited"`
(§6.1)? Note the tripwire's measured constraint: in a headless session an `ask`
becomes a **one-shot deny** (`constants.ts:1274-1296`), which is why the pre-edit
ask rung is cut — a `PROTECTED_CONFLICT` delivered as an `ask` inherits that
behaviour. *Owner: the verdict/fence spec, coordinating with whoever owns the hint
slot.*

**Q7 — Human waiver: what table, and how is append-only enforced?**
Principle 4 and **AT-6** require a bounded, reasoned, append-only waiver **with an
expiry**. #50's `team_settings` is the closest pattern — keyed by `repo`, absent row
means defaults — but it is **mutable** (`updated_at`, `updated_by`), so it is the
wrong shape. The right prior art in the tree is `claims`: **append-only, where
revision means a NEW row** (`services/hints.ts:68-70`). Open: is a waiver per repo,
per fence, or per fence-per-repo; and what writes it, given AT-3 says an agent may
not certify its own work and #50's hub-stamped `capture_mode` is the only
implemented human-authority pattern (§8.3). *Owner: the fence spec.*

**Q8 — Does `INDETERMINATE` reach the briefing at all?**
`briefing/render.ts` orders contradictions → solved → drafts → absences (`:450-453`,
`:685-688`, `:745-749`) and cuts at `MAX_BRIEFING_CHARS = 2200`. 03 §5.3 places the
coverage line; a verdict spec adding `INDETERMINATE` and `PROTECTED_CONFLICT` lines
is adding to the same cut. An `INDETERMINATE` line is honest but low-information and
may push out a `PROTECTED_CONFLICT`. **Ordering is one product decision, made once,
not per spec.** *Owner: Nick, via whoever writes the verdict spec.*

**Q9 — Do 1.0 records reuse `claims`, or get their own table and route?**
#50 answered this for pins and the reasoning generalises: a claim needs
`author_session_id` **and** `work_context_id` FKs, so a terminal-originated record
would have to mint a synthetic session — *which then surfaces as a **phantom
teammate** in presence, in every briefing and in the tripwire itself.* 05 hit the
identical wall from the CI side and refused the envelope (§8.4a). **The rule is now
general: anything that can originate outside an agent session gets its own table and
its own route.** What is still per-component is *which* of your records can do that.
Decide and state it.

**Q10 — Which existing thresholds does 1.0 inherit unchanged?**
`SUSPECT_SEPARATION_RATIO = 1.5` is documented as *"a DELIBERATE non-tuning … no
dataset here could justify a second decimal"*, and 05 explicitly copied that stance
for `CI_FLAKE_BASE_RUNS = 5`. `ABSENCE_MIN_GAP_HOURS = 24`,
`PRESENCE_TTL_SECONDS = 90` and `SESSION_REAP_STALE_HOURS = 6` all become inputs to
a coverage computation. Inheriting them is fine; **inheriting them silently is
not.** Each spec lists the constants it depends on by name, and adopts the corpora's
floor rule (§6.2) for any threshold it mints.

**Q11 — NEW. Who owns `stale_at`, and does AT-2 need its premise corrected?**
§1.7a: the column has **no writer**, is **not on the wire**, and is a permanent
`null` on the one surface that reads it. The cut line's Tier 1 wording assumes a
clock-based definition exists to be reconciled. **It does not.** Two consequences a
writer must decide: (a) does the claim-binding spec define `stale_at`'s first
authority, or does it add a commit-bound column and leave `stale_at` to be dropped —
dropping it touches `bootstrap.sql` and `ddl-sync.test.ts`; (b) the wire needs a new
field either way, since `ClaimSchema` has none. *Owner: the claim-binding spec. Flag
the premise correction to Nick — a reviewer reading the cut line alone will expect a
reconciliation section that should not exist.*

**Q12 — NEW. AT-7's counterfactual benchmark has no prior art in the tree.**
`INJECTION_CORPUS` (61 cases, measured) proves **framing** — that hostile text was
correctly quoted. AT-7's "fails if" line says framing is **not** behaviour, and
requires control-vs-treatment comparison of tool calls, files read and written,
shell commands, plan changes and final result, **per provider, attack success rate
zero, measured**. Nothing in the tree runs a task twice and diffs behaviour. The
corpora that *do* run the real stack (`precision-corpus`, `conclusion-corpus`) are
single-run fixture graders. This is Tier 2, and the cut line puts it **behind**
git/code-state binding in the order of work — but whoever owns it should state early
that it is net-new harness, not an extension of the corpus.

**ANSWERED 2026-09-14, and the answer is a refusal, not a deferral.** No ninth spec
was commissioned, and `grep -n "AT-7" docs/1.0/*.md` returns hits in this map and
`00-cut-line.md` only — **zero across 01…08**. Leaving it unnamed would have been
the silent absence §11.6 forbids, so it is named here, in the README's AT table and
in 08 §8:

> **AT-7 is the one acceptance test this set does not discharge.** It requires a
> net-new control-vs-treatment harness that runs a task twice per provider and
> diffs tool calls, files read and written, shell commands, plan changes and final
> result. `INJECTION_CORPUS` is prior art for the **payloads** and for framing —
> and AT-7's own "fails if" line says framing is not behaviour, so the corpus
> cannot be stretched into the measurement. **The eight specs discharge nine of ten
> acceptance tests.** Shipping 1.0 against ten is a scope decision for Nick, not an
> omission a writer can close.

*Owner: none. Commission a ninth spec, or ship nine of ten and say so.*

---

## 11. How to use this map

1. **Read `00-cut-line.md` first**, find your component in Tier 1 / 2 / 3, and name
   the AT numbers your spec discharges.
2. **Read 03 and 05** — their vocabulary wins over yours (§8.2a, §8.2b). If you must
   contradict one, say so under *Collisions*, the way 05 §3.7 contradicted §8.4 of
   this map. That worked; quiet divergence would not have.
3. **Cite `file:line` for every claim about current code**, and re-read
   `crosscheck-pins` before citing a line number from it (§9.4).
4. **Write your numbers as `VERIFY:` directives, not sentences** (§7.1).
5. **Name `ci.yml` in your collision section** if you add a `MUTATIONS` entry, and
   do not write a post-merge total (§9.2).
6. **Where a rung cannot exist, write the refusal** (§8.2, AT-10). A spec that
   pretends is worse than no spec.
