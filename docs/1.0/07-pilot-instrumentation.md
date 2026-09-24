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
channel costs PreToolUse one spool append.** *Corrected in the build (§11.1): this line said the record
is appended by the **next** hook that already appends. That hook may never fire — a denied edit fires no
PostToolUse, and a closed session fires nothing (104 of 127 trial sessions never closed) — so the record is
appended in PreToolUse itself, right after the atomic claim, in its own delivery-id namespace. Measured:
0.11 ms p95 for the append, 34 ms for the whole tripping path against the 800 ms budget.*

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
  them and takes the id. No free text, no prompt, no question. *Corrected (§11.2): the id it takes is a
  delivery id **or the work-context / claim id the hint printed** — hints print ref ids, never `hd_` ids,
  so an argument named `refId` that accepted only delivery ids named something nobody ever sees.*
- **`crosscheck pin --ok <id>`** — the missing symmetric half of #50's `crosscheck pin --broke`.
  *Corrected (§11.2): #50 shipped the retraction as the flag `--broke`, not a `break` subcommand, so the
  symmetric half is a flag too.*
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

**Two nullable columns on #50's `pins`, and they stack on 04's, which lands first.** `repairs_pin_id`
is a self-FK set by `crosscheck pin add` when a broken pin exists for the same `(repo, surface)` —
looked up, never asked — and `repairs_pin_version int NULL` records **which version of that invariant
was repaired**, read at the moment the lookup resolves.

**The second column closes an ambiguity neither spec had noticed.** 04 §3.5 adds `pins.version` and
bumps it inside `applyPinSweep` (`crosscheck-pins:services/pins.ts:526`) *"once per sweep request per
pin … before the first path moves"*; this spec adds `markPinOk` beside `markPinBroke` (`:225`). So
**both specs add a column to the same #50 table and both write `services/pins.ts`** — two
`ALTER TABLE pins`, two `bootstrap.sql` edits, two `ddl-sync.test.ts` blocks — and neither §9 named
the other on this file (04 talked to this spec only about `pilot_attributions`, this spec to 04 only
about the outcome enums). Worse, the write paths interact: a repair recorded *after* a sweep had no
stated version, so **a repair after a rename was ambiguous by construction** — proof 3 asks whether the
fix touched what the answer named, and "the invariant" had silently become a different file set in
between. `repairs_pin_version` is the answer, and **04 sequences first** (00 §9.7), so this migration
stacks on its column rather than racing it. The **fix range** is
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
seq_epoch text NULL                                 -- 01 §3.1: positions compare only inside one epoch
seq_first · seq_last · seq_gaps · seq_null_records  int NULL
seq_epochs int NULL                                 -- >1 means the counter restarted; the span is refused
```

**`seq` is a `{ epoch, n }` PAIR, not a scalar** (01 §3.1) — corrected here and in 06 §3.1, both of which
had stored a bare integer. A session whose counter restarted (a SessionStart re-fire, a busy-lock
fallback, two homes on one `hostSessionKey` — 01 §3.4 lists all three) has more than one epoch, and
`seq_first .. seq_last` across two epochs is not a span at all. So `seq_epochs > 1` makes the report print
`sequence restarted (N epochs)` and **no span**, which is 01 SEQ-5's epoch-split refusal reaching the
counting layer. PIL-7 tests it.

`coverage` is a **snapshot of what the hub said at `observed_at`**, never read back as current
coverage (§9 states the collision with 03 §3.2 and its bound). At `PILOT_MAX_SESSIONS = 50` the 51st
write is **refused and counted** (`pilot_sessions_refused`), never dropped silently.

**Enrolment is per repo, off by default, and it needs a column this spec had never created.**
`team_settings` (`crosscheck-pins:server/src/db/schema.ts:675-683`) has exactly `repo` (PK), `pin_policy`,
`suspect_attribution`, `updated_at`, `updated_by` — measured. §4's migration list named four new tables
and one `pins` column and **no `team_settings` alteration at all**, so the flag this whole section depends
on had no migration, no `bootstrap.sql` mirror and no `ddl-sync` case; meanwhile 04 §4 recorded
`team_settings` as untouched in 1.0, giving a reader two contradictory accounts of whether #50's
two-column table grows. It grows by one:

```
pilot_enrolled boolean NOT NULL DEFAULT false
```

**And the default story is explicit, because #50's own comment makes an absent row mean defaults**
(`crosscheck-pins:schema.ts:670-674`): **no row ⇒ not enrolled**, exactly as `DEFAULT false` ⇒ not
enrolled, so the two paths cannot disagree. Enrolment is a mutable team decision, which is what a mutable
settings table is for — and is precisely why 04 §3.6 refuses to put a **waiver** there. Both specs now say
so. §4 carries the migration.

### 3.7 Constants

Hub (`server/src/constants.ts`, appended below #50's `SUSPECT_*` block): `PILOT_MAX_SESSIONS = 50`
· `PILOT_RETENTION_DAYS = 90` · `PILOT_REPORT_DEFAULT_WINDOW_DAYS = 56` ·
`PILOT_CONVERGENCE_WINDOW_HOURS = 48` · `PILOT_TARGET_HELPFUL_PER_100_SESSIONS = 8` ·
`PILOT_TARGET_FALSE_PROACTIVE_MAX_PER_100 = 20`. Connector (below #50's `PIN_SWEEP_*` block):
`NOISE_MARK_WINDOW_MINUTES = 60` · `PILOT_FIX_DIFF_MAX_FILES = PIN_SWEEP_MAX_PATHS`. *Corrected (§11.3):
`PILOT_FIX_DIFF_MAX_FILES` was listed as a hub constant, but the diff runs in the CLI and the hub never read
it; it now lives beside the sweep bound it equals, derived rather than restated.* **Inherited by name, per 00
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
truthful, because the two writers are indistinguishable in the row. **`pins` gains two nullable columns**
(`repairs_pin_id`, `repairs_pin_version` — §3.4), stacked on 04's `pins.version`, which lands first
(00 §9.7); nothing is repaired retroactively, so proof 3's denominator starts at the first repair after
this lands. **`team_settings` gains `pilot_enrolled boolean NOT NULL DEFAULT false`** — *added: §3.6 gates
the whole pilot on it and this list did not create it, so the design depended on a column with no
migration.* Every existing row becomes `false` and an absent row still means defaults, i.e. not enrolled
(§3.6), so the two paths agree; 04 §4's *"`team_settings` untouched"* is corrected to *untouched by that
spec*. Four new tables, `CREATE TABLE IF NOT EXISTS` mirrored in `server/src/db/bootstrap.sql` with every
index, and the three column additions mirrored there too — `server/test/ddl-sync.test.ts` enforces all of
it, with one case per added column.
`pilot_counters` and `pilot_attributions` prune past `PILOT_RETENTION_DAYS` and clamp future-dated
rows on write as `commit_evidence` does (`services/commit-evidence.ts:34-42`), or a forged
timestamp outruns retention. `pilot_sessions` is capped by count, not time — fifty rows **are**
the measurement.

## 5. Where it renders / who consumes it

**One command, no dashboard.** `crosscheck pilot [--days N] [--json]` — one hub read, one bounded
`git diff` per repaired pin, to stdout.

```
repo: <repoId> · 2026-07-20..2026-09-14 · 1,208 sessions · 50-session set 31/50, 0 refused
1. duplicate work surfaced — what a pointer stopped cannot be observed, so it is never claimed
   surfaced 312 · opened 74 · converged 31
   by channel: briefing 208 · prompt_hint 96 · tripwire 8 · suspect 0 · unknown 0
   each opened pointer names its prior work: «<title>» wc_8f21 · opened by 2 sessions
   opened anyway: 19 contexts sharing >=2 targets with an UNopened pointer
2. collisions flagged before merge    (sensor: file overlap only — §8.2)
   flagged 41 (tripwire 8 · ghost 33) · both landed 17 · ci regressed: unavailable
3. attribution accuracy   ranked answers on recorded-break pins 6 · repaired 4
   hit 3 · miss 1 · excluded (coverage gap at answer time) 1 · no repair pin yet 2
4. proactive precision   opened per 100 sessions 6.1 (target 8, declared before measuring)
   off-target marks per 100 0.9 (target max 20) — FLOOR: marks voluntary (§8.3)
5. coverage integrity in the wild
   answers 4,102 · qualifier required 388 · emitted 388 · missed 0
   judgeable 3,540 · not judgeable 562
   agent_event complete 3,901 · incomplete 190 · unknown 11 · unavailable 0
   git / ci / runtime / human_edit — one line each, never one number
```

**Registry obligation.** `packages/cli/src/render-surfaces.ts` gains `cli-pilot` at the **array tail,
after `cli-status` (`crosscheck-pins:192`)** — 00 §9.1a. *Corrected: this line said "below #50's
`cli-suspect` (`:164-175`)", which is six lines above the tail — #50 **prepended** its three surfaces, so
`cli-suspect` sits at `:166` and main's original three at `:178`, `:185`, `:192`. Three specs named that
same insertion point while a fourth called it the tail, so four new surfaces would have conflicted on one
line; all four now append at the tail in build order, and this spec is **last** of them (00 §9.7).* #50
takes the file 3 → 6.

```ts
{ kind: "corpus", name: "cli-pilot", delivery: "pulled",
  module: "src/cli/pilot-render.ts", framing: "framed",
  render: (payload) => renderPilot(pilotWith(payload), NOW) }
```

*Corrected (§11.4): the mockup above printed the word "prevented" and the label "helpful", both of which
§8.1 refuses — the word may not appear at all, and a pull is the model's call, not a human verdict. The
shipped report says what the refusal says.*

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

- **PreToolUse (800 ms): one spool append, measured.** *Corrected (§11.1): this line said zero, on the
  premise that a later hook would append the record. The record is appended at the claim instead, because a
  later hook may never fire; the append takes no lock, and PIL-9 measures it (0.11 ms p95, named allowance
  5 ms) on the tripping path the dead-hub latency runs could not reach.*
- **UserPromptSubmit (800 ms): one enum field** on a record it already builds
  (`capture/records.ts:85`). *Corrected (§11.1): there is no drain of booked tripwire asks — the
  ask's record is written where the ask is claimed.*
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

**I own no acceptance test outright, and say so rather than claim one.** *Corrected: this line read "I
own **AT-10** for these surfaces" while 05 claimed AT-10 "for its provider refusals", 03 anchored COV-5 to
"AT-10's refusal clause" and 08 claimed "an AT-10 half" — four partial owners, no single failing test.*
**AT-10 is 03's**, whole; this spec discharges an *instance* of its rule for the rungs that cannot exist
here (PIL-8, §8.6). It *measures* AT-1, AT-5 and AT-9 without owning their behaviour (03 does), and holds
shut the holes AT-3 and AT-4 would open here — **AT-3's owner is 08** (§9), AT-4's is 01. Each can fail; each names its
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

**PIL-7 — sequence is consumed, never fabricated, and a restarted counter is not a span (AT-4).** (a)
With no `seq` on the records, `pilot_sessions.seq_*` are null and the report prints `sequence not
recorded`. (b) **With two `seq_epoch`s in one session, `seq_epochs = 2` and the report prints `sequence
restarted (2 epochs)` and NO `seq_first .. seq_last` span** — 01 SEQ-5's epoch-split refusal at the
counting layer; a span across two epochs is two unrelated counters subtracted from each other. *Fails if*
an order is derived from envelope `ts`, or if (b) prints a span. *Mutations:* sort by `ts` and populate
`seq_first`/`seq_last`; ignore `seq_epoch` when computing the span.

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
   zero — **03's AT-10 rule applied here, not a share of AT-10 claimed here**. **Tripwire channel — `off` on Cursor** (ask is advisory only,
   `connector-cursor/src/capabilities.ts:46-49`) **and on ACP** (permission traffic forwarded
   untouched, `:70-74`): proof 2's tripwire bucket reads `unavailable` there, never `0`. **`ci
   regressed` — `unavailable`** without a CI reporter (05 §3.6). **`runtime` —
   `out_of_scope_1_0`**, **`human_edit` — `no_platform_rung`**, 03's reasons verbatim. And **proof
   3 is not measurable without a repair**: on a repo with breaks and no repair pin the report
   prints `no repair pin yet N`, never `0%`.

## 9. Collisions

**PR #50** (assume merged, 00 §9.1) — extended in **six** places, contradicted nowhere: `pins` gains
`repairs_pin_id` **and `repairs_pin_version`** (§3.4); **`team_settings` gains `pilot_enrolled`** (§3.6,
§4); `services/pins.ts` gains `markPinOk` beside `markPinBroke` (`crosscheck-pins:225-248`);
`services/suspect.ts` appends at answer time; `cli/src/render-surfaces.ts` gains `cli-pilot` at the
**array tail after `cli-status` (`crosscheck-pins:192`)**, not after `cli-suspect` (00 §9.1a);
`cli/src/cli/doctor.ts` gains `checkPilot` after `checkPins`. Constants append
below the `SUSPECT_*` and `PIN_SWEEP_*` blocks, never renumbered. **Sequencing: #50 lands first**
— every input to proofs 2 and 3 is its ground, and this spec is **last of the eight** (00 §9.7).

**04 (verdict / fence) — a hard collision on #50's ground that neither spec had named, now sequenced.**
We **both add a column to `pins` and both write `services/pins.ts`**: 04 §3.5 adds `pins.version` and the
bump inside `applyPinSweep` (`crosscheck-pins:services/pins.ts:526`), this spec adds two columns and
`markPinOk` (`:225`). Two `ALTER TABLE pins`, two `bootstrap.sql` edits and two `ddl-sync.test.ts` blocks
on one table, with no stated order — and each §9 discussed the other about something else entirely (04
about `pilot_attributions`, this spec about the outcome and falsifier enums). **04 first, this spec
appends**, so `repairs_pin_version` stacks on the column 04 introduces rather than racing it. The write
paths interact semantically too, and that is why the second column exists: `applyPinSweep` bumps
`version`, `markPinOk` records a repair, and **nothing said which version a repair was recorded against**,
so a repair after a sweep was ambiguous by construction — proof 3 asks whether the eventual fix touched
what the answer named, and "the invariant" may have become a different file set in between (§3.4).

**PR #49** (merged): shared file
`server/src/constants.ts`, which #49 edits near the head and #50 at the tail: low textual risk,
real merge-order risk. I deliberately do **not** consume `listDevelopers` / `readDeveloperPage`
(`services/developers.ts`) — see §8.4. **`.github/workflows/ci.yml`**: PIL-1…PIL-9 add `MUTATIONS`
entries, so this spec bumps the count at `ci.yml:119-120` and adds its lines in **all three listings, not
two** — the count (`:119`), the per-file block (`:127`) and the **per-basename block** (`:246` on
`crosscheck-pins`, `:239` on main), which the first draft did not name; a spec that updates two of three
leaves the guard stale and CI red. New per-file lines for `cli/src/cli/pilot-render.ts` and
`cli/src/cli/pilot-mark.ts`, both new basenames too. It writes **no post-merge total** (00 §9.2), and on
`mutation-check.ts` it is **editor 10**, the last of the eight.

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
bucket. Until then there is one bucket, because nothing marks a claim stale (00 §1.7a). **04 — the
fence / verdict spec:** `pilot_attributions.outcome` and `.falsifier` are #50's enums today; **04 §3.3a
mints `VerdictFalsifier` at the verdict level rather than widening `SuspectFalsifierKind`**, so #50's enum
stays closed and my columns keep storing suspect's four values — a CI-lane verdict carries
`ci_confirmed_regression`, which this spec stores as the verdict's falsifier when proof 3 counts a CI-lane
answer. I do not fork the enum. 04 also suggests `pilot_attributions` add `attribution` and `basis`, since
proof 3 is about the verdict rather than the outcome: **adopted**, two enum columns, no new table.

**08 — AT-3's owner, which is the spec this section used to hand it to by a name that did not exist.**
`pilot_marks.capture_mode` is stamped `"human"` hub-side exactly as `pins.ts:112` does, and PIL-6 keeps the
agent path out. Until this revision that paragraph read *"the human-authority spec: `pilot_marks.capture_mode`
uses whatever writer it produces"* — and **no such spec is in `docs/1.0/`**; three specs deferred AT-3 to
it and it was never commissioned, so Tier 1's *"a production writer for human authority"* was owned by
nobody. **08 §3.2 now owns AT-3**, including the claims write path, and this spec's mark route follows the
pattern it lands rather than inventing a second one. PIL-6's mutation (*take `capture_mode` from the
body*) is the same defect 08's EV-9 guards one table over.

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

## 11. Corrections from the build

What building this spec found, recorded here so the text above stays readable and every correction
names its reason. Each is also marked inline where the old sentence stood.

**11.1 — The tripwire record is written at the claim, not by a later hook.** §3.1 and §6 deferred the
record to "the next hook that already appends" so PreToolUse would add nothing. That hook may never fire:
a denied edit fires no PostToolUse, and a session that is simply closed fires nothing at all — the trial
measured 104 of 127 sessions that never closed. Deferral would lose exactly the asks proof 2 counts. The
record is appended in PreToolUse right after the atomic claim (a racing sibling that lost the claim records
nothing), costs one lock-free spool append, and is measured under PIL-9: 0.11 ms p95 over 50 runs against a
named 5 ms allowance, and 34 ms for the whole tripping path against the 800 ms budget. **The tripwire takes
its own delivery-id namespace:** the seen-set that makes (session, ref) unique covers briefing and hint only,
so a session hinted about a context and later tripped on its file is two deliveries, and one id would make
the hub keep the first and answer the second `duplicate`. Briefing and hint ids are unchanged, so rows
already stored and records already spooled replay as themselves.

**11.2 — The gestures, as a person can actually make them.** `pin ok` is `pin --ok` (#50's retraction is
the flag `--broke`). `crosscheck noise <id>` takes a delivery id **or the work-context / claim id the hint
printed**, which is the only id a person ever sees; with no id it asks the hub for the caller's own unasked
deliveries to the sessions live on this machine within the hour (`GET /api/pilot-marks/candidates`, bounded
at five with one row read past the bound so the cut is said). The mark route refuses four things the text
did not name: a delivery somebody **else** received (`not_yours` — proof 4 counts people interrupted, and
only the recipient was), a **crossed pair** such as `off_target` about a pin (each ref kind takes exactly one
word, `PILOT_MARK_BY_REF_KIND`, because the report counts marks by their word), "ok" about a pin recorded
**broken** (`pin_broken` — a repair needs the commit and files only a re-pin records), and a mark on a
**pulled** answer (`not_unsolicited` — a disliked `suspect` answer is a verdict on the answer, and counting it
would make asking a question the way to inflate the noise figure).

**11.3 — Where the constants live.** `PILOT_FIX_DIFF_MAX_FILES` moved to connector-core, derived from
`PIN_SWEEP_MAX_PATHS`, with `PILOT_FIX_DIFF_CONCURRENCY = 4` (25 diffs one after another would keep somebody
waiting over half a minute). The hub gained `PILOT_REPORT_MAX_PRIOR_WORK = 10`, `PILOT_REPORT_MAX_REPAIRS =
25`, `NOISE_MARK_MAX_CANDIDATES = 5` and `NOISE_MARK_MAX_SESSIONS = 50` (the connector's
`STATUS_MAX_SESSION_STATES`, checked by a VERIFY). `PILOT_UNAVAILABLE_REASONS`, `PILOT_RUNG_REFUSALS`,
`PILOT_MARK_BY_REF_KIND` and `PULLED_DELIVERY_CHANNEL` are in `@crosscheck/schema`, because the hub picks
the reason and the CLI writes its sentence.

**11.4 — The report.** §5's mockup printed "prevented" and "helpful", both refused by §8.1; the shipped
report says surfaced / opened / converged and "opened per 100". An opened count whose prior work cannot be
listed is **withheld**, not printed bare (PIL-2 applied to the edge the text did not cover). Proof 2's ghost
figure is `unavailable (ghost_lines_not_recorded)`: a ghost line repeats for as long as the overlap lasts and
is never booked as a delivery, so the mockup's `ghost 33` had no writer. The fix diff (§3.4) has **five**
outcomes, not two — `hit`, `miss`, and three that are not verdicts and are never folded into a miss: `empty`
(nothing changed between the two verifications), `too_broad` (past the bound a fix touches the named file by
accident) and `unresolvable` (a range this clone never fetched, an id that is not a commit id). It runs with
renames off, so a fix that moved the named file is still a hit, and NUL-separated, so a named file with a
non-ASCII name is matched as written. The client parse is **strict** — a count that did not arrive must not
read as zero. `--json` is not the raw wire: every string is cleaned, `"` becomes `'` so the output needs no
backslash escape, and it is its own corpus surface. The registry therefore gains three surfaces, not one:
`cli-pilot` (framed), `cli-pilot-json` (sanitized) and `cli-pilot-mark` (bare — the marks print ids,
channel words, ages and the hub's sentence, so a corpus surface replaced the composite this spec named).

**11.5 — `doctor`.** `checkPilot` follows the ladder every other hub-read line uses: 404, unreachable and
unparseable are "not measured"; only a hub that answered with an error is a WARN. The one WARN divides
answers by answers (PIL-3). The rungs that cannot exist are the two reasons in `PILOT_RUNG_REFUSALS`; an
empty day (`nothing_flagged`, `no_sessions`) gets no line.

**11.6 — Retention (§4).** Counters and attributions prune from the reaper, before its early return, and
keep the boundary day the report's widest window still reads. It is not the withdrawn `session_events`
sweep: these rows are tallies and ranked guesses, not the causal skeleton. There is no future-dated clamp —
both timestamps are the hub's own clock, unlike `commit_evidence`'s. Two indexes (`pilot_counters_day_idx`,
`pilot_attributions_answered_idx`) keep both deletes index ranges across every repo.

**11.7 — What is still not measured.** The `suspect` channel has no writer; it is reserved. The ghost half
of proof 2 has none by design. `ci regressed` waits for 05's reporter. None of these reads as a zero.

