# 07 — Pilot instrumentation for the five proofs

**Tier 1** — `00-cut-line.md` lists *"Pilot instrumentation for the five proofs"* in the 1.0
foundation. Baseline `main@e9aab82` + PR #50 + PR #49 merged (00 §9.4); paths repo-relative under
`packages/`; `crosscheck-pins:` marks a line that exists only on #50. This spec owns the
**counting**, never the behaviour counted: where 03, 05, the event model or the fence/verdict spec
owns a behaviour, I consume its names and say so in §9.

---

## 1. Problem

**All five proofs are unknown, and four of the five cannot be computed from any row in the tree.**
**What already counts:** `hint_deliveries` (`server/src/db/schema.ts:401-427`): refs only, never
text (`capture/records.ts:85`), deterministic id (`:75-82`), `pulled_at` set when the reader opens
the ref through the diagnosis route (`services/hint-deliveries.ts:195-212`, from
`routes/work-contexts.ts:92`). `readHintStats` (`:76-109`) serves `delivered / pulled / claims`
over `HINT_STATS_MAX_WINDOW_DAYS = 90` (`:46`) and `countSolvedDeliveries`
(`services/solved-counts.ts:71-108`) serves `shown / pulled` over `SOLVED_COUNT_WINDOW_DAYS = 30`;
both print at `cli/src/cli/status.ts:117-130`. Connector-side: `state/capture-health.ts`, #50's
`state/git-lane-cost.ts`. **What is missing, proof by proof:**

1. **Duplicate investigations.** `delivered/pulled` is one number over two very different channels
   — the briefing (`flows/briefing.ts:260`) and the mid-prompt hint (`hints/delivery.ts:73`) both
   write `hint_delivery` rows and nothing tells them apart. No counterfactual is recorded: the row
   names a `ref_id`, never what the reader would otherwise have re-investigated.
2. **Collisions.** The tripwire's ask is booked only in local session state (`withTripwireAsked`,
   `connector-claude/src/hooks/pre-tool-use.ts:55`) and never reaches the hub — and a state file
   lives until SessionEnd deletes it, while *"the trial found 104 of 127 sessions never closed and
   no reaper"* (`state/capture-health.ts:23-26`). The count is lost, not stored.
3. **Attribution accuracy.** `services/suspect.ts` persists nothing, and its window is
   `SUSPECT_WINDOW_DAYS = 14` ending *now*, so an answer cannot be reconstructed later. Nothing
   records a fix either — `markPinBroke` (`crosscheck-pins:services/pins.ts:225-248`) has no
   repair half.
4. **Proactive precision.** No human mark of any kind exists. `pulled_at` is set by
   `get_diagnosis`, which **the model calls**, not the human.
5. **Coverage integrity in the wild.** 03 makes every answer surface carry the qualifier; nothing
   counts whether it did. `capture-health.ts:5-8` names this failure in its own domain: *"a count
   nobody reads keeps nothing honest: 371 worktree edits produced 0 targets across the trial and
   no surface said so."*

## 2. Principles served

> **1. "Only judge when you know you were watching."** An attribution emitted under a coverage gap
> should not have been emitted (AT-5); counting it as a hit or a miss launders that failure into a
> precision statistic. PIL-5 excludes it and counts the exclusion.
>
> **Non-negotiable 4 — fail, never silently.** Every counter has a denominator separating *nothing
> happened* from *nothing ran* — #50 learned this measured: the first git-lane verdict weighed
> `skipped` turns against `recorded` files and *"could not tell a starved lane from a lane that
> ran perfectly and had nothing to find"* (`crosscheck-pins:state/git-lane-cost.ts:76-88`).
>
> **Non-negotiable 6 — data minimisation.** No prompt, diff body, transcript or free-text mark
> reaches disk. Every column below is an id, an enum, an integer or an ISO timestamp.

## 3. Target model

### 3.1 `hint_deliveries.channel` — the split every proof needs

`packages/schema/src/enums.ts`, beside #50's `TARGET_SOURCES`:

```ts
export const DELIVERY_CHANNELS = [
  "unknown", "briefing", "prompt_hint", "tripwire", "suspect",
] as const;
```

Column `channel text NOT NULL DEFAULT 'unknown'`; `HintDeliverySchema`
(`schema/src/hint.ts:46-55`) gains `channel` optional, defaulting `"unknown"` — #50's
forward-compat shape for `TargetSchema.source` (`crosscheck-pins:schema/src/session.ts`, 00 §9.1).
**`unknown` is the honest default, not a placeholder:** two writers exist today and a stored row
cannot be attributed to either, so it is never back-filled and the report prints it as its own
bucket, the way `absences.ts:23-30` keeps `inactive` and `unconnected` apart. **The tripwire
channel costs PreToolUse nothing:** the ask is already booked in session state by
`withTripwireAsked`, and the record is appended by the **next** hook that already appends — the
record-then-act order `stop.ts:9-15` states as a contract.

### 3.2 `pilot_marks` — the only human input, and it is never a question

```
id PK · repo · ref_kind ("hint_delivery" | "pin") · ref_id
mark enum PILOT_MARKS = ["off_target","surface_ok"]
marked_by FK→developers · capture_mode enum (hub-stamped) · created_at
UNIQUE (ref_kind, ref_id, marked_by)
```

Two gestures, each riding something a human does anyway; **no survey exists and adding one is
refused (§8.3)**:

- **`crosscheck noise [refId]`** — one word, typed beside the session that got a bad intervention.
  With no argument it resolves the most recent unsolicited delivery to a live session of this repo
  on this machine within `NOISE_MARK_WINDOW_MINUTES = 60`; on more than one candidate it prints
  them and takes the id. No free text, no prompt, no question.
- **`crosscheck pin ok <id>`** — the missing symmetric half of #50's `crosscheck pin break`.
  Whoever ran the recipe and watched it **pass** gets the same one-line gesture as whoever watched
  it fail, which is what makes a pin notice falsifiable in both directions.

`capture_mode` is **stamped by the hub and may never be carried by the body**
(`crosscheck-pins:services/pins.ts:185-189`, stamped `"human"` at `:112`) — 00 §8.3's answer to
AT-3, inherited rather than restated.

### 3.3 `pilot_attributions` — the suspect answer, as it was given

Append-only, written when `GET /api/suspect` answers. `outcome` and `falsifier` are #50's enums
verbatim (`crosscheck-pins:services/suspect.ts:69-87`), not a parallel set; `coverage_judgeable`
is `isJudgeable(readCoverage(repo))` (03 §3.1) at answer time — the AT-5 gate and PIL-5's key.

```
id PK · repo · pin_id FK→pins · outcome enum SuspectOutcome
falsifier enum SuspectFalsifierKind · top_session_id FK→agent_sessions NULL
top_lift double NULL · candidates int · coverage_judgeable bool · answered_at
```

### 3.4 `pins.repairs_pin_id` — how the eventual fix is named

Nullable self-FK on #50's `pins`, set by `crosscheck pin add` when a broken pin exists for the
same `(repo, surface)` — looked up, never asked. The **fix range** is
`brokenPin.verified_at_commit .. repairPin.verified_at_commit` and the **fix diff** is `git diff
--name-only` over it, run inside `crosscheck pilot`, bounded by `PILOT_FIX_DIFF_MAX_FILES = 200`
and `GIT_TIMEOUT_MS = 1500` (`connector-core/src/constants.ts:117`). The hub never runs git.

### 3.5 `pilot_counters` — proof 5 only, because proof 5 alone cannot be re-derived

`PK (repo, day, surface, counter) · value bigint · updated_at`. UPSERT-only, never append —
`schema.ts:370-373`'s bounding argument for `commit_evidence`: bounded by repos × days × surfaces
× counters, not by traffic. `surface` is a **registered render-surface name**, controlled, not
author-written; `counter` is an enum, machine-derived, never prose:

```
answers_emitted · qualifier_required · qualifier_emitted · judgeable · not_judgeable
coverage_<source>_<state>        // COVERAGE_SOURCES × COVERAGE_STATES = 20
```

The twenty per-source tallies exist **instead of** a qualified-answer percentage: 00 §8.1 forbids
a scalar collapsing the five sources, and this storage makes the collapse unrepresentable.
**Proofs 1–4 get no counter table** — they are joins over `hint_deliveries`, `agent_sessions`,
`work_context_targets`, `pilot_marks` and `pilot_attributions` at report time, and a stored
aggregate for a re-derivable number is a second definition waiting to disagree with the first (00
§1.7a).

### 3.6 `pilot_sessions` — the 50-session measurement, reduced to its residue

The handover's per-session record is *initial intent, event sequence, diff, changed surfaces, CI
delta, coverage*. **Five of the six are already stored or recomputable and are therefore not
copied:** initial intent → `work_contexts.intent` (`IntentSchema`, `INTENT_MAX_CHARS = 120`); diff
→ `work_context_targets` with #50's `source` label; changed surfaces → `pin_files.path` ∩ this
session's targets; CI delta → `readCiCoverage(repo, commitSha)` (05 §3.6) at report time; sequence
→ the event model's `seq`. Two things cannot be recomputed later, and those are the whole table:

```
session_id PK FK→agent_sessions · observed_at · end_reason ("reported"|"reaped")
coverage jsonb   -- FIVE {source,state,reason} triples, enums only
seq_first · seq_last · seq_gaps · seq_null_records   int NULL
```

`coverage` is a **snapshot of what the hub said at `observed_at`**, never read back as current
coverage (§9 states the collision with 03 §3.2 and its bound). Enrolment is per repo, **off by
default**, via `team_settings`. At `PILOT_MAX_SESSIONS = 50` the 51st write is **refused and
counted** (`pilot_sessions_refused`), never dropped silently.

### 3.7 Constants

Hub (`server/src/constants.ts`, appended below #50's `SUSPECT_*` block): `PILOT_MAX_SESSIONS = 50`
· `PILOT_RETENTION_DAYS = 90` · `PILOT_REPORT_DEFAULT_WINDOW_DAYS = 56` ·
`PILOT_CONVERGENCE_WINDOW_HOURS = 48` · `PILOT_TARGET_HELPFUL_PER_100_SESSIONS = 8` ·
`PILOT_TARGET_FALSE_PROACTIVE_MAX_PER_100 = 20` · `PILOT_FIX_DIFF_MAX_FILES = 200`. Connector
(below #50's `PIN_SWEEP_*` block): `NOISE_MARK_WINDOW_MINUTES = 60`. **Inherited by name, per 00
§10 Q10, not silently:** `HINT_STATS_MAX_WINDOW_DAYS = 90` is what `PILOT_RETENTION_DAYS` matches;
`GHOST_MIN_SHARED_TARGETS = 2` (`server/src/constants.ts:370`) is the shared-target threshold for
*"a duplicate investigation was opened anyway"*; `SUSPECT_WINDOW_DAYS = 14` bounds proof 3;
`PIN_SWEEP_MAX_PATHS = 200` is `PILOT_FIX_DIFF_MAX_FILES`. **The two targets are declared intent,
set today, before any measurement**, under the corpora's floor rule verbatim
(`connector-core/test/precision-corpus.test.ts:9-16`: *"THE FLOORS ENCODE TODAY'S INTENT, NOT
MEASURED TRUTH"*). Eight helpful per 100 sessions is about one session in twelve receiving
something it opened, against ceilings of `MAX_HINTS_PER_SESSION = 5` (`constants.ts:85`) and
`MAX_HINTS_PER_PROMPT = 1` (`:84`). **Neither is lowered to make a measurement pass.**

## 4. Migration

Nothing existing is redefined. Every `hint_deliveries` row becomes `channel = 'unknown'` —
truthful, because the two writers are indistinguishable in the row. `pins` gains one nullable
column; nothing is repaired retroactively, so proof 3's denominator starts at the first repair
after this lands. Four new tables, `CREATE TABLE IF NOT EXISTS` mirrored in
`server/src/db/bootstrap.sql` with every index — `server/test/ddl-sync.test.ts` enforces it.
`pilot_counters` and `pilot_attributions` prune past `PILOT_RETENTION_DAYS` and clamp future-dated
rows on write as `commit_evidence` does (`services/commit-evidence.ts:34-42`), or a forged
timestamp outruns retention. `pilot_sessions` is capped by count, not time — fifty rows **are**
the measurement.

## 5. Where it renders / who consumes it

**One command, no dashboard.** `crosscheck pilot [--days N] [--json]` — one hub read, one bounded
`git diff` per repaired pin, to stdout.

```
repo: <repoId> · 2026-07-20..2026-09-14 · 1,208 sessions · 50-session set 31/50, 0 refused
1. duplicate work surfaced            (never "prevented" — §8.1)
   surfaced 312 · opened 74 · converged 31
   by channel: briefing 208 · prompt_hint 96 · tripwire 8 · suspect 0 · unknown 0
   each opened pointer names its prior work: «<title>» wc_8f21 · opened by 2 sessions
   opened anyway: 19 contexts sharing >=2 targets with an UNopened pointer
2. collisions flagged before merge    (sensor: file overlap only — §8.2)
   flagged 41 (tripwire 8 · ghost 33) · both landed 17 · ci regressed: unavailable
3. attribution accuracy   ranked answers on recorded-break pins 6 · repaired 4
   hit 3 · miss 1 · excluded (coverage gap at answer time) 1 · no repair pin yet 2
4. proactive precision   helpful per 100 sessions 6.1 (target 8, declared first)
   off-target marks per 100 0.9 (target max 20) — FLOOR: marks voluntary (§8.3)
5. coverage integrity in the wild
   answers 4,102 · qualifier required 388 · emitted 388 · missed 0
   judgeable 3,540 · not judgeable 562
   agent_event complete 3,901 · incomplete 190 · unknown 11 · unavailable 0
   git / ci / runtime / human_edit — one line each, never one number
```

**Registry obligation.** `packages/cli/src/render-surfaces.ts` gains `cli-pilot` below #50's
`cli-suspect` (`crosscheck-pins:cli/src/render-surfaces.ts:164-175`) — 00 §9.1 corrects the claim
that this file is free ground; #50 takes it 3 → 6.

```ts
{ kind: "corpus", name: "cli-pilot", delivery: "pulled",
  module: "src/cli/pilot-render.ts", framing: "framed",
  render: (payload) => renderPilot(pilotWith(payload), NOW) }
```

`corpus`, not composite: proof 1's counterfactual **names the prior work**, so a teammate's title
and declared intent reach the line, with the payload planted in the title slot — the most exposed
one. `delivery: "pulled"`: a human typed it and is waiting (`render-surfaces.ts:71-95`).
`crosscheck noise` and `pin ok` print enums, ids and counts only — one `kind: "composite"` entry
for `src/cli/pilot-mark.ts` whose `corpusCoveredBy` names a test file that really runs the corpus
(`"corpus-covered"` is banned from `note`, `render-surfaces.ts:119`). **Doctor obligation
(non-negotiable 4):** `checkPilot` in `cli/src/cli/doctor.ts` after #50's `checkPins`: enrolment
state, slots used of 50, records refused at the cap, and **one PASS line per rung that cannot
exist here**. **Platform refusals go into the manifest that already exists**, not a new list:
`DeriveCapabilityManifest.refusals` (`connector-core/src/derive/capabilities.ts:62-67`), whose
meta-test makes an undeclared rung a red build
(`connector-core/test/derive-capability-registry.test.ts:11-23`). Cursor already declares
*"pre-edit ask … not possible"* (`connector-cursor/src/capabilities.ts:46-49`) and ACP its own
(`:70-74`); each gains one further refusal entry naming the channels it cannot feed.

## 6. Budget

**The 800 ms rule is untouched: no hook gains work on its critical path.**
`USER_PROMPT_SUBMIT_BUDGET_RATIO × HTTP_TIMEOUT_MS` and `PRE_TOOL_USE_BUDGET_RATIO ×
HTTP_TIMEOUT_MS` both stay 800 (`connector-core/src/constants.ts:56-57`, `PRINTS: 800 800`).

- **PreToolUse (800 ms): zero added.** The ask is already booked in session state; its record is
  appended by the next hook that already appends (§3.1), so nothing new spends `spareMs`
  (`config/hook-budget.ts:48-55`).
- **UserPromptSubmit (800 ms): one enum field** on a record it already builds
  (`capture/records.ts:85`), plus the drain of booked tripwire asks — spool appends, which take no
  lock (`spool/append.ts:1-27`).
- **Stop: zero.** #50 already spends Stop's `spareMs` on the git lane
  (`crosscheck-pins:connector-claude/src/hooks/stop.ts`, +62/−1). **SessionStart / SessionEnd:
  zero new round trips** — `pilot_sessions` is written **hub-side** from data the hub already has,
  at session end and at reap.
- **`noise` / `pin ok` / `pilot`: not hooks** — a human typed them, and the fix diff is the only
  unbounded-looking work, bounded twice. **Hub job cost:** one UPSERT into `pilot_counters` per
  answer on a coverage-bearing surface, the only write this spec adds to a read path.

**Measurement refusal:** I have run no benchmark and state no millisecond figure; PIL-9 requires
one before merge, on the harness that exists (`connector-claude/test/capture-latency.test.ts`).

## 7. Acceptance tests

I own **AT-10** for these surfaces, *measure* AT-1, AT-5 and AT-9 without owning their behaviour
(03 does), and hold shut the holes AT-3 and AT-4 would open here. Each can fail; each names its
mutation anchor in `connector-core/scripts/mutation-check.ts` (00 §7.2).

**PIL-1 — a channel split that cannot collapse, and `unknown` is not a guess.** One bucket per
`DELIVERY_CHANNELS` value including `unknown`, and a row written before the column existed reports
`unknown`. *Fails if* a bucket is dropped or folded, or a heuristic attributes a pre-migration
row. *Mutations:* `channels.filter(c => c !== "unknown")`; default the column to `"prompt_hint"`.
A `VERIFY:` re-derives the count from `DELIVERY_CHANNELS`.

**PIL-2 — the counterfactual is named or the line is not printed.** Proof 1 prints, per opened
pointer, the work-context id and title it named. *Fails if* an `opened` count prints with no named
prior work — a bare number is the counterfactual claim without the counterfactual. *Mutation:*
drop the title, keep the count.

**PIL-3 — a ran-denominator on every WARN.** Every `checkPilot` WARN divides turns by turns, never
events by files. *Fails if* a gate compares one unit against another — #50's measured regression
(`crosscheck-pins:state/git-lane-cost.ts:76-88`). *Mutation:* restore the mixed-unit compare.

**PIL-4 — a zero meaning "not measured" is impossible (AT-9, measured).** With `pilot_counters`
empty for a surface that answered, the report prints `not instrumented`, never `missed 0`. *Fails
if* an uninstrumented surface looks like a perfect one. *Mutation:* `value ?? 0` at the read.

**PIL-5 — an attribution made under a gap is excluded, not scored (AT-5).** Two
`pilot_attributions` rows identical but for `coverage_judgeable`: the `false` row appears under
`excluded`, never under `hit` or `miss`. *Fails if* a verdict that should have been
`INDETERMINATE` is scored either way. *Mutation:* drop `coverage_judgeable` from the denominator.

**PIL-6 — no agent writes a human mark (AT-3, inherited).** No MCP tool and no agent-reachable
route writes `pilot_marks`; the attempt is **refused**, not downgraded — silent coercion is AT-3's
second "fails if". *Mutation:* take `capture_mode` from the body.

**PIL-7 — sequence is consumed, never fabricated (AT-4).** With no `seq` on the records,
`pilot_sessions.seq_*` are null and the report prints `sequence not recorded`. *Fails if* an order
is derived from envelope `ts`. *Mutation:* sort by `ts` and populate `seq_first`/`seq_last`.

**PIL-8 — every rung that cannot exist is a doctor refusal (AT-10).** On Cursor or ACP,
`checkPilot` names the tripwire channel unavailable with the platform reason from that connector's
`DeriveCapabilityManifest.refusals`; `ci regressed` prints `unavailable` until 05 lands. *Fails
if* any rung is silently absent, zero, or fake-passed. *Mutation:* return `0` for the tripwire
channel on Cursor.

**PIL-9 — the budget is measured, not asserted.** SessionStart and UserPromptSubmit p95 on
`capture-latency.test.ts` against the pre-change baseline, with a named allowance. *Fails if* none
exists.

These entries bump `MUTATIONS.length` and add per-file `PRINTS:` lines in
`.github/workflows/ci.yml`. **No post-merge total is written here** — the `VERIFY:` directive is
written and CI prints the number (00 §9.2).

## 8. Refusals

1. **"Prevented" is not measurable and the word never appears in the output.** A counterfactual
   cannot be observed; the report prints `surfaced / opened / converged` and names the prior work.
   **A pull is not a human judgement either:** `pulled_at` is set by `get_diagnosis`
   (`routes/work-contexts.ts:92`), which the model calls, so reporting it as "a human found this
   helpful" is the calibration lie; the column is `opened`.
2. **The true/false collision split is not derived.** The sensor is file overlap and semantic
   collision detection is cut (00 §8.6, Tier 3). `flagged − both_landed` is *did not both land*,
   not *false*. With 05 the report prints `ci regressed`; without it, `unavailable`.
3. **Unopened is never counted as off-target, and there is no survey, now or later.** Silence
   means not useful, not read, or already known, and no row tells them apart. The false-proactive
   rate counts explicit marks only, is a **floor**, and prints as one (`solved-counts.ts:20-23`
   says the same about its own cap); under-reporting is not a gap to close with a prompt.
4. **Mutes never enter a counter, and there is no per-developer breakdown.** `developer_mutes` is
   a strong negative signal about a **person**, and "score"/"ranking" applied to a person is
   banned (00 §8.5; `crosscheck-pins:services/suspect.ts:21-25`). Counters are per repo and
   `--by-developer` is refused by name: this is reliability infrastructure, not employee
   measurement, and a silent absence would invite someone to build one.
5. **No content on disk, and no export.** No prompt, diff body, transcript or free-text mark;
   `pilot_sessions` stores references and enums, and the intent it points at is the one already
   stored under `INTENT_MAX_CHARS = 120`. `--json` writes to stdout; nothing uploads a report
   anywhere.
6. **Platform rungs that cannot exist**, each a doctor line from the connector manifest, never a
   zero. **Tripwire channel — `off` on Cursor** (ask is advisory only,
   `connector-cursor/src/capabilities.ts:46-49`) **and on ACP** (permission traffic forwarded
   untouched, `:70-74`): proof 2's tripwire bucket reads `unavailable` there, never `0`. **`ci
   regressed` — `unavailable`** without a CI reporter (05 §3.6). **`runtime` —
   `out_of_scope_1_0`**, **`human_edit` — `no_platform_rung`**, 03's reasons verbatim. And **proof
   3 is not measurable without a repair**: on a repo with breaks and no repair pin the report
   prints `no repair pin yet N`, never `0%`.

## 9. Collisions

**PR #50** (assume merged, 00 §9.1) — extended in five places, contradicted nowhere: `pins` gains
`repairs_pin_id`; `services/pins.ts` gains `markPinOk` beside `markPinBroke` (`:225-248`);
`services/suspect.ts` appends at answer time; `cli/src/render-surfaces.ts` gains `cli-pilot` after
`cli-suspect`; `cli/src/cli/doctor.ts` gains `checkPilot` after `checkPins`. Constants append
below the `SUSPECT_*` and `PIN_SWEEP_*` blocks, never renumbered. **Sequencing: #50 lands first**
— every input to proofs 2 and 3 is its ground. **PR #49** (merged): shared file
`server/src/constants.ts`, which #49 edits near the head and #50 at the tail: low textual risk,
real merge-order risk. I deliberately do **not** consume `listDevelopers` / `readDeveloperPage`
(`services/developers.ts`) — see §8.4. **`.github/workflows/ci.yml`**: PIL-1…PIL-8 add `MUTATIONS`
entries, so this spec bumps the count and adds its own per-file `PRINTS:` lines, and writes no
post-merge total (00 §9.2).

**03 — coverage integrity:** I consume `readCoverage`, `CoverageRecord`, `isJudgeable`,
`COVERAGE_SOURCES`, `COVERAGE_STATES` and `CoverageReason` unchanged and mint no second coverage
type. **One divergence, stated rather than quiet:** 03 §3.2 refuses a coverage table because *"a
stored verdict would outlive its evidence"* — `reaped_at` is revocable. `pilot_sessions.coverage`
stores five triples anyway, because *what the hub said at `observed_at`* is the only proof-5 input
that cannot be recomputed. Bounded so the refusal holds: at most 50 sessions on an enrolled repo,
never read by an answer surface, never a fallback for `readCoverage`, labelled `as observed`. If
03's owner rejects the bound, the field goes and proof 5 keeps only its `pilot_counters` half.
**05 — CI ingestion:** I consume `readCiCoverage(deps, repo, commitSha)` and add no second CI
table, route or auth; proof 2's `ci regressed` and `pilot_sessions`' CI delta are `unavailable`
until 05 lands — a printed state, not a delay. **The event-model spec (`seq`, 00 §10 Q2):** I
consume `seq`, do not own it, and do not decide the worker/subagent question; PIL-7 holds the
fabrication path shut either way. **The claim-binding spec (`stale_at`, 00 §10 Q11):** Proof 1
counts an opened pointer at a **claim** as much as at a work context; if claim binding lands, a
pointer at a claim that is no longer current is a different event and proof 1 gains a third
bucket. Until then there is one bucket, because nothing marks a claim stale (00 §1.7a). **The
fence / verdict spec:** `pilot_attributions.outcome` and `.falsifier` are #50's enums today; if
the verdict spec renames or widens them my columns follow, I do not fork the enum. **The
human-authority spec:** `pilot_marks.capture_mode` uses whatever writer it produces; until it
exists the mark route stamps `"human"` hub-side exactly as `pins.ts:112` does, and PIL-6 keeps the
agent path out.

## 10. Decisions for Nick

**D1 — the two targets, set before measuring.** `PILOT_TARGET_HELPFUL_PER_100_SESSIONS = 8` and
`PILOT_TARGET_FALSE_PROACTIVE_MAX_PER_100 = 20`. Nobody has run this; both are declared intent
under the corpora's floor rule and neither may be lowered to pass. *Default: adopt.*

**D2 — is the pilot on by default?** *Default: off, opt-in per repo via `team_settings`* —
measuring a repo nobody enrolled is surveillance-shaped, and the counters cost a write on a read
path. **D3 — does `crosscheck noise` get an MCP tool so an agent can mark noise?** *Default: no* —
an agent marking its own interventions off-target is the AT-3 shape in a new place, and the number
would measure the model's taste.

**D4 — ship proofs 1, 3, 4, 5 before 05 lands?** *Default: yes*, with proof 2's CI half printing
`unavailable`; waiting for 05 costs eight weeks of the other four. **D5 — `crosscheck pin ok` is a
new human gesture.** One word, typed only by someone who ran the recipe, and the only way a pin
notice becomes falsifiable in both directions. *Default: ship it*; without it proof 4's pin half
has no denominator and only the hint half survives.
