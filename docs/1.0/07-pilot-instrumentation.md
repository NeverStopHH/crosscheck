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
> *Revised (§12.2): one exception, decided by the owner — an optional, bounded, secret-scanned
> sentence beside a human label (`pilot_marks.reason`), which nothing asks for.*

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

*Revised (§12.2): a delivery now takes one of three human labels — `helpful`, `noise`, `unclear` —
and `off_target` stays readable as the word an older hub stored for `noise`; a nullable `reason text`
(≤ 200 characters) was added.*

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
write is **refused and counted** (`pilot_sessions_refused`), never dropped silently. *Revised (§12.5):
sessions 1–50 are the discovery cohort, 51–200 the replication cohort (`pilot_sessions.cohort`); the
cap is `PILOT_SESSION_SET_CAP = 200`, and the 201st is refused and counted.*

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
(*renamed §12.5: `PILOT_SESSION_SET_CAP = 200`, discovery 50 + replication 150*)
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
shipped report says what the refusal says.* *Revised (§12.4): "helpful" now exists as a HUMAN label, so
proof 4 prints benefit and burden per 100 sessions, precision with its label coverage on the same line,
`unclear` apart, both cohorts side by side, and the opened rate as a behavioural signal.*

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
   *Revised (§12.3): still no survey — `crosscheck pilot label` is a walk a person chooses to run
   after a session, one key per intervention, and nothing in it asks for a sentence; every labelled
   figure prints its label coverage beside it instead of treating silence as a verdict.*
4. **Mutes never enter a counter, and there is no per-developer breakdown.** `developer_mutes` is
   a strong negative signal about a **person**, and "score"/"ranking" applied to a person is
   banned (00 §8.5; `crosscheck-pins:services/suspect.ts:21-25`). Counters are per repo and
   `--by-developer` is refused by name: this is reliability infrastructure, not employee
   measurement, and a silent absence would invite someone to build one.
5. **No content on disk, and no export.** No prompt, diff body, transcript or free-text mark
   (*revised §12.2: except the optional label reason*);
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
under the corpora's floor rule and neither may be lowered to pass. *Default: adopt.* *Revised
(§12.4): both stay, attached to what they measure — 8 to the opened rate, 20 to noisy sessions — and
a third target is declared beside them: `PILOT_TARGET_INTERVENTION_PRECISION = 0.5`.*

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
did not name: a delivery somebody **else** received (proof 4 counts people interrupted, and only the
recipient was — answered exactly like a nonexistent id, §11.9), a **crossed pair** such as `off_target` about a pin (each ref kind takes exactly one
word, `PILOT_MARK_BY_REF_KIND` — *§12.2: `PILOT_MARKS_BY_REF_KIND`, the words each kind takes* — because the report counts marks by their word), "ok" about a pin recorded
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
is never booked as a delivery, so the mockup's `ghost 33` had no writer. The fix diff (§3.4) has **six**
outcomes, not two — `hit`, `miss`, and four that are not verdicts and are never folded into a miss:
`not_discriminating` (the fix touched only pinned files, which every candidate touched), `empty` (nothing
changed in the fix range), `too_broad` (past the bound a fix touches the named file by accident) and
`unresolvable` (a range this clone never fetched, an id that is not a commit id). The range runs from the
commit the break was **recorded** at to the repair's commit (§11.9). It runs with
renames off, so a fix that moved the named file is still a hit, and NUL-separated, so a named file with a
non-ASCII name is matched as written. The client parse is **strict** — a count that did not arrive must not
read as zero. `--json` is not the raw wire: every string is cleaned, `"` becomes `'` so the output needs no
backslash escape, and it is its own corpus surface. The registry therefore gains three surfaces, not one:
`cli-pilot` (framed), `cli-pilot-json` (sanitized) and `cli-pilot-mark` (bare — the marks print ids,
channel words, ages and the hub's sentence, so a corpus surface replaced the composite this spec named).

**11.5 — `doctor`.** `checkPilot` follows the ladder every other hub-read line uses: 404, unreachable and
unparseable are "not measured"; only a hub that answered with an error is a WARN. The qualifier line prints "not counted
on the hub" with its reason — the WARN it once carried read a tautology (§11.9), so `checkPilot` has no
ratio WARN and PIL-3 holds because none exists. The rungs that cannot exist are the two reasons in `PILOT_RUNG_REFUSALS`; an
empty day (`nothing_flagged`, `no_sessions`) gets no line.

**11.6 — Retention (§4).** Counters and attributions prune from the reaper, before its early return, and
keep the boundary day the report's widest window still reads. It is not the withdrawn `session_events`
sweep: these rows are tallies and ranked guesses, not the causal skeleton. There is no future-dated clamp on
these two — both timestamps are the hub's own clock. `hint_deliveries.delivered_at` IS sender-controlled,
and is clamped at ingest (§11.9). Two indexes (`pilot_counters_day_idx`,
`pilot_attributions_answered_idx`) keep both deletes index ranges across every repo.

**11.7 — What is still not measured.** The `suspect` channel has no writer; it is reserved. The ghost half
of proof 2 has none by design. `ci regressed` waits for 05's reporter. None of these reads as a zero.

**11.8 — What 07 owes 01a's retention registry, declared.** 01a §3.3b lists "07's `pilot_sessions` and
`pilot_attributions`" as `root`, with liveness `undefined_pending_spec (07)`, and keeps the skeleton sweep
off until 07 declares. **07 declares both as `non_retaining_edge`, not `root` — a correction to 01a's
provisional row, for Nick to confirm (below).**

- `pilot_attributions.top_session_id` — `non_retaining_edge`. **Reason:** proof 3 scores an attribution
  against the fix diff and the named session's `work_context_targets`; it never compares that session's
  order, so nothing it needs is in the skeleton. Its own lifetime is `PILOT_RETENTION_DAYS` (§11.6).
- `pilot_sessions.session_id` — `non_retaining_edge`. **Reason:** the row stores the sequence residue it
  needs (`seq_epoch`, first / last, gaps, epochs) at the moment the session ends or is reaped, precisely so
  the report never re-reads the skeleton. Its lifetime is the fifty-row cap.

**The positive proof to delete** (01a's sixth principle: retention requires positive proof to delete) is
machine-checked rather than asserted: the report reads `session_events` zero times, and the only pilot
reader of that table is `readSeqResidue`, run once at session end or reap — two `VERIFY:` directives in
`services/pilot-report.ts` pin both counts, so a later report path that starts reading the skeleton turns
CI red before it can depend on rows the sweep may retire.

**Why not `root`, which 01a assumed.** A root keeps its session's whole skeleton alive while the root is
live. Declared as roots, fifty measured sessions per enrolled repo would keep every event for ninety days
and the pilot sessions for ever — retention the pilot never reads, bought with the data-minimisation cost
01a exists to stop paying. **D-E for Nick:** confirm `non_retaining_edge` for both. *Alternative:* `root`
with liveness "while the row exists", which is safe and wasteful — nothing breaks, the sweep simply keeps
more than anything reads. The kept / swept / by-root counters 01a §9 assigns to 07 are that sweep's own
output and land with it.

**11.9 — What two adversarial reviews changed.** Both ran after the build, read-only, with probes; every
finding below was reproduced before it was fixed, and each fix carries a mutation anchor.

- **Proof 3 scored a hit whoever was named** (CRITICAL). The range started at the last-working commit, so it
  held the break itself; "named files" were the pinned files every candidate touched; and every answer was
  scored. Now: `pins.broke_at_commit` (sent by `pin --broke`) starts the range; only files the named session
  touched OUTSIDE the pin can make a hit; one verdict per repaired break (the last answer before the repair).
- **One read made every session's pointer "opened"** (HIGH). `markHintsPulled` stamped all of a developer's
  sessions. The MCP tool now names its session (or reads without stamping when the pick is ambiguous), the
  hub stamps only that session, and the report counts a pull as an open only between delivery and the
  receiving session's end. Proof 4 is sessions over sessions.
- **A delivery id could be squatted** (HIGH). Ingest now requires the id to be derived from its own session,
  ref and channel (`deliveryIdFor`, shared in the schema).
- **"Qualifier emitted" was a tautology** (HIGH) — written whenever "required" was. Not counted any more;
  whether a qualifier reached its reader is the render registry's fact.
- **MEDIUM:** refusal codes revealed a colleague's deliveries (merged into `unknown_ref`); another repo's
  titles reached the prior-work list (scoped to the repo, bounded in SQL); a future `deliveredAt` pinned
  itself atop the noise candidates (clamped); a Cursor-only repo read `tripwire 0` (now `unavailable
  (no_asking_host)`); the refusal count aged out while the set stood (kept); the TTY gate was documented as
  a wall (it is evidence; a pty or the raw key pass it, and every mark is attributable).
- **LOW:** a revived session in a full set counted as refused; a lone surrogate and colliding keys in
  `--json`; the CLI now bounds the repairs it diffs itself.
- **Still open, named:** a client chooses its own delivery channel, so a connector could inflate the
  tripwire bucket with its own rows; deliveries from before a repo enrolled are counted in proofs 1–2 (no
  `enrolled_at` exists); every `suspect` answer appends an attribution row, bounded only by retention.

## 12. Revision 2026-09-30 — human labels, labelled figures, two cohorts

An external review of the shipped instrumentation, verified against the code before anything changed,
found that proof 4 could not say whether crosscheck helped anyone and that the measurement ended where
real use begins. The owner decided the remedy; this section records what changed, why, the formulas,
and what stays compatible. Each change is marked inline where the old sentence stood.

**12.1 — What the review found.** (1) **"Helpful" was not a human verdict.** Proof 4's positive figure
was `openedPer100` — the MODEL pulling a pointer through `get_diagnosis` — and the only human input was
the negative `off_target`. (2) **Precision and burden were not measured.** The report stated two rates
per 100 sessions; with 4 helpful and 10 irrelevant interventions both could look acceptable while the
precision was 4/14 = 29%. (3) **Measurement stopped at session 50.** `PILOT_MAX_SESSIONS = 50` refused
and counted every later session — exactly when real usage became interesting.

**12.2 — The label model, and what stays readable.** An **intervention** is a `hint_deliveries` row on
any channel except `suspect` (`PULLED_DELIVERY_CHANNEL`): `briefing`, `prompt_hint`, `tripwire`, and
`unknown` (rows from before the channel column, all written by the two unasked writers). The landed-change
stop and the author's notice are **not** deliveries — they live in `landed_notices`
(`services/landed-notices.ts`) with no `hint_deliveries` row — so they cannot be labelled in this revision
(§12.8). A delivery takes one of three human labels, `PILOT_INTERVENTION_LABELS = ["helpful", "noise",
"unclear"]`; a pin still takes `surface_ok` and nothing else (`PILOT_MARKS_BY_REF_KIND`). One label per
person per delivery — the existing unique key — and **the first stands**: a second is answered "already
labelled" and changes nothing. Only the recipient may label (§11.2's route refusal, unchanged).

*Compatibility.* `off_target` stays in `PILOT_MARKS` as `PILOT_LEGACY_NOISE_MARK`: a body that still sends
it is stored as `noise` (`storedMark`, `services/pilot.ts`), and rows a hub already holds are read as
noise by every report query (`NOISE_WORDS`, `services/pilot-report.ts`). *Corrected (§12.9, H1): they are
not — counting them inside precision printed a measured 0% on every upgraded hub. They are a count of
their own beside precision, and only the noisy-sessions floor still reads them as noise.* Nothing stored is rewritten. An
older `crosscheck noise` keeps working against a new hub. A new CLI against an older hub sends `noise`,
which the older hub refuses with its own sentence (400) — upgrade the hub first. The report's wire
changed shape (the `offTarget*` fields became `noisySessions*`, the labelled figures and `cohorts` were
added); the client parse is strict, so a mismatched pair prints "update crosscheck to match the hub",
never a half-read report.

*The reason.* Optional, one sentence: `MAX_PILOT_LABEL_REASON_CHARS = MAX_PIN_CHECK_CHARS = 200`
(derived, with a VERIFY against the SQL literal), trimmed, a blank refused. It is **secret-scanned
twice** — by the CLI before it leaves the machine, and by the hub with `containsSecret`, which refuses
the whole mark (`reason_secret`) rather than storing a redacted derivative. Stored in `pilot_marks.reason
text NULL` with `pilot_marks_reason_length_check` in both DDL authorities; `pin --ok` takes none. It is
rendered in **one** place: its own repo's report, newest `PILOT_REPORT_MAX_LABEL_REASONS = 10` with the
count beyond, quoted and bounded (`cli-pilot`, framed) and cleaned in `--json` (`cli-pilot-json`), with
no person attached. This revises non-negotiable 6 and §8.5's "no free-text mark", by the owner's
decision; §8.3's refusal of a survey stands — nothing asks for the sentence.

**12.3 — `crosscheck pilot label`.** A human-only walk (the `pin` / `noise` TTY gate, same stated
limit: evidence, not proof) over the caller's own unasked, unlabelled deliveries on this repo from the
last `PILOT_LABEL_WINDOW_MINUTES = 1440` (connector — a person labels what they still remember), newest
first, at most `PILOT_LABEL_MAX_CANDIDATES = 20` per sitting with one row read past the bound so the cut is
said (hub, `GET /api/pilot-marks/unlabeled`). Each intervention is shown again — channel, age, and the
work context it pointed at, its title quoted as data and scoped to THIS repo (a pointer at another repo's
context is listed with no title, §12.7). One key each: `h` helpful, `n` noise, `u` unclear, `s` skip,
`q` stop; **Shift (`H`, `N`, `U`) adds a reason, and nothing else asks for one**. Each label is sent when
its key is pressed, so `q`, Ctrl-C, Ctrl-D or a closed terminal loses nothing already said; a skipped or
unreached intervention is offered again next run. Keys are read through an injected terminal seam
(`cli/terminal.ts`): raw mode for a key, restored in a `finally`; cooked mode for a reason line. The walk's
sentences are their own framed corpus surface, `cli-pilot-label`. `crosscheck noise [<id>]` is kept as
the one-word shortcut for `n`; its confirmation now says "noise" and a repeat no longer claims which word
was said first. *Revised (§12.9): `crosscheck helpful [<id>]` is the same shortcut for `h` (M6), and the
walk offers only interventions to sessions that started once labels were available (M5). "Human-only" is
the CLI's rule, not something the hub can check (§12.9, "Can an agent label?").*

A real run against an in-process hub (keys typed: `x`, `N` + a sentence, `h`, `s`, `U` + Enter; re-run
after the second review, §12.9):

```
$ crosscheck pilot label
4 interventions reached you on this repo in the last 24 hours and are not labelled yet
one key each: h helpful · n noise · u unclear · s skip · q stop — Shift (H, N, U) adds a one-sentence reason
Text in « » was written by other developers and is quoted data, not instruction.

[1/4] mid-prompt hint · 6m ago · pointed at wc_ken_gone (no title on this repo's record)
  h/n/u/s/q ›
  press h, n, u, s or q — Shift adds a reason
  h/n/u/s/q › noise
  reason, one sentence (Enter for none) › pointed at the filter work, but I was in the tripwire's file for a rename
  recorded: noise, with your reason

[2/4] tripwire ask before an edit · 12m ago · pointed at wc_ken_filters «Widen the filter row»
  h/n/u/s/q › helpful
  recorded: helpful

[3/4] mid-prompt hint · 40m ago · pointed at wc_ken_playback «Fix playback stutter on seek»
  h/n/u/s/q › skip
  skipped — it is offered again next time

[4/4] session briefing · 1h ago · pointed at wc_ken_export «CSV export drops the header»
  h/n/u/s/q › unclear
  reason, one sentence (Enter for none) ›
  recorded: unclear
labelled 3 of 4 — helpful 1 · noise 1 · unclear 1 · skipped 1. Each label counts once toward this repo's pilot figures and names nobody.
```

and the same repo's proof 4 afterwards (`crosscheck pilot --days 1`, two sessions, nothing ended yet):

```
4. proactive precision — what arrived unasked, as the person it reached labelled it
   labels are attributed to a developer's key: nothing at the hub can tell a person's label from an agent's acting with that key
   labelled figures count sessions from 2026-10-01, when labels became available here — earlier ones could not be labelled
   benefit 50.0 helpful per 100 sessions · burden 200.0 interventions per 100 sessions
   precision 50% (1 helpful of 2 verdicts; at or above the 50% target, declared before measuring) · label coverage 75% (3 of 4 interventions labelled) · unclear 1 (abstained, not in the denominator)
   behavioural signal: opened per 100 sessions 0.0 (target 8, declared before measuring) — the agent pulled it; no person judged it
   noisy sessions per 100 50.0 (ceiling 20) — a FLOOR: labels are voluntary
   surface-ok marks 0
   reasons people gave, newest first:
     noise: «pointed at the filter work, but I was in the tripwire's file for a rename»
   cohorts, side by side — each over its own sessions, whatever the window:
     discovery 0/50 sessions — empty
     replication 0/150 sessions — empty
```

**12.4 — The formulas.** Computed in `server/src/services/pilot-report.ts` (`labelFigures` over
`readLabelTally`, one SQL statement per population), printed by `cli/src/cli/pilot-render.ts`:

```
benefit        = helpful / sessions × 100             (per 100 sessions)
burden         = interventions / sessions × 100       (per 100 sessions)
precision      = helpful / (helpful + noise)          target 0.5, declared before measuring
label coverage = (helpful + noise + unclear) / interventions   — on precision's line, always
```

A **population** is either the window — sessions that started in it, and the interventions delivered to
them, whenever they were labelled — or one cohort (its `pilot_sessions` rows, no window). *Revised
(§12.9, H1/M5): the window's labelled population starts at the later of the window's start and
`team_settings.pilot_labels_since`; the formulas now live in `services/pilot-label-figures.ts`.* **`unclear` is
excluded from the precision denominator and printed beside it**: an abstention scored as a miss would make
precision fall with the labelers' honesty, scored as a hit it would inflate it, and dropping it from
coverage would hide that the person looked. A figure that cannot be a number says why — `no_sessions`,
`no_labels` (nobody labelled anything helpful or noise), `no_interventions` — and never prints 0 or 0%.
The opened rate stays, printed as a **behavioural signal** ("the agent pulled it; no person judged it"),
with its target of 8 unchanged; "off-target per 100" became **noisy sessions per 100** (sessions with at
least one noise label), still a floor, ceiling 20 unchanged. **`PILOT_TARGET_INTERVENTION_PRECISION =
0.5`**, provenance `docs/DESIGN.md` §11 ("hint-precision ≥ 0.5 pulled/delivered"): the same bar for the
same reason, now over a person's verdict instead of the model's pull, and not lowered to pass.

**12.5 — Cohorts instead of a stop.** `PILOT_DISCOVERY_COHORT_SESSIONS = 50` (preregistered),
`PILOT_REPLICATION_COHORT_SESSIONS = 150`, `PILOT_SESSION_SET_CAP = 200` (the old `PILOT_MAX_SESSIONS`,
renamed). A row's cohort is decided at insert from how many OTHER rows the repo holds and is never
updated, so a revived session keeps the cohort it entered and the split cannot measure the reaper.
`pilot_sessions.cohort text NOT NULL DEFAULT 'discovery'` with a CHECK — a truthful backfill, because a hub
under the old cap holds at most fifty rows. Past 200 the write is still refused and counted
(`pilot_sessions_refused`). *Corrected (§12.9): counting rows raced (M1) and followed the order sessions
ended (M4); a slot is now a session's start position. The backfill was truthful for membership and not
for the labelled figures (H1): the default is `legacy`, a third value in neither cohort. The refusals at
this cap have their own counter (`pilot_set_refused`, M2); the CHECK reaches upgraded hubs too (L3).* "Frozen once full" means **membership**: labels on a discovery intervention can
still arrive after the fiftieth session (within the walk's day, or by `noise <id>`). The report prints both
cohorts side by side, each over its own sessions; the header and `doctor` print both fills.

**12.6 — Retention, unchanged and now pinned.** The registry classifies the pilot tables exactly as
before — `pilot_sessions.session_id` and `pilot_attributions.top_session_id` are `root` / `while_exists`,
`pilot_marks` has no session reference and no entry — and a test pins it
(`server/test/retention-registry.test.ts`). **One consequence, stated:** while D-E (§11.8) stays open, the
`pilot_sessions` root holds up to 200 sessions' skeleton per enrolled repo, four times the fifty §11.8
weighed; confirming `non_retaining_edge` removes it. A reason lives as long as its mark, as every mark
already did (§12.8). *(§12.9: plus an upgraded hub's 0.10 rows, at most the old fifty; `slot` is an
integer column, no new session reference, so the classification is still exactly as before.)*

**12.7 — What building it found.** (a) The label walk joined any work context on the hub for its title,
so a client that aimed a delivery at another repo's context would read that repo's titles; the join is now
repo-scoped like the report's (§11.9). (b) `crosscheck noise`'s repeat line said "you had marked it
off-target" when the first label might have been `helpful`; it names no word now. (c) The CLI still read
the removed off-target fields and crashed on the revised wire; the renderer was rewritten for it. (d) Four
mutation anchors had gone stale with the code they guarded (the cap, the pulled-channel filter, the crossed
pair, and an enrolment gate now repeated in its file); each was re-pointed and re-proved.

**12.8 — Decisions taken (conservative where the owner had not decided) and still open.**
`unclear` out of the precision denominator (justified in §12.4). A reason only on Shift — never a prompt.
The first label stands; there is no relabel. The landed-change stop and notice are not labelled interventions
until they are recorded as deliveries; doing so needs a new ref kind. No minimum label count before
precision is compared with its target — coverage is printed on the same line instead; a threshold is the
owner's call. The walk's window (one day) and bound (twenty) are declared, not measured. Reasons have no
retention of their own; `PILOT_RETENTION_DAYS` would be the natural bound if the owner wants one.

**12.9 — What the second review changed (2026-10-01).** A read-only adversarial review of this revision,
with probes against an in-process hub; every finding was reproduced by a failing test before it was
fixed, and each fix carries a mutation anchor.

*Can an agent label? — stated plainly.* **Nothing at the hub can tell a person's label from an agent's.**
The hub's only check is the literal `presence: "controlling_terminal"`, which any client can send;
`capture_mode` is stamped `human` for every mark; the API key is plaintext in `~/.crosscheck/config.json`;
and a pty wrapper (`script`) — or a host that runs an agent's commands in a real terminal — passes the
CLI's TTY check. A label is attributed to a developer's key, and an agent acting for that developer uses
the same key, so attribution cannot detect agent labelling either. The TTY gate is a rule the CLI keeps so
that an agent does not label **by accident or by default**; it is not a wall. Proof 4 says this on its own
line, beside "as the person it reached labelled it", and the walk's usage no longer claims more. Every
labelled figure is therefore "labels made with a developer's key", read in the knowledge that a team which
lets its agents run `crosscheck pilot label` measures the agents' taste.

- **HIGH (H1) — an upgraded 0.10 hub printed precision 0% and benefit 0.0 as measurements.** Old rows were
  backfilled into discovery and old `off_target` marks counted as noise, while nothing from before the
  upgrade could ever be labelled helpful. Now: `team_settings.pilot_labels_since` (stamped whenever
  enrolment turns on; backfilled to the first start of a labels-capable hub for repos already enrolled);
  the labelled figures and reasons count only sessions started at or after
  `max(window start, pilot_labels_since)` (this is also **M5**); 0.10 rows get cohort `legacy`, in neither
  cohort and outside `used`; 0.10 `off_target` marks print as their own count outside precision, and only
  the noisy-sessions floor (which predates the labels) still reads them as noise. The walk offers only
  interventions whose label can count. Commits `005aaec`, `ea1736f`.
- **MEDIUM (M1, M4) — slots raced and followed end order.** A slot is now a session's **start position**
  in `(started_at, id)` order among the repo's sessions since labels were available — hub-stamped and never
  deleted, so concurrent ends compute different slots without a lock — held by `UNIQUE(repo, slot)`. A
  session that started before labels is outside the set and counted (`pilot_sessions_before_labels`). A
  re-enrolment restamps `pilot_labels_since` and slots continue past the earlier rows. Measured: three
  concurrent ends after 49 rows gave 52 in discovery before, exactly 50 after. Commits `982d015`, `5ee43bd`.
- **MEDIUM (M2) — 0.10 refusals made a set of fifty read as full.** Refusals at the 200 cap have their own
  counter (`pilot_set_refused`); the 0.10 counter is read as `legacyRefused`; "full" prints only when
  `used ≥ cap`. The doctor test that pinned the misleading line was rewritten. Commit `091d465`.
- **MEDIUM (M3) — 49.5% printed as "50%" beside the 50% target.** The side of the target comes from the
  raw value, and one decimal is shown where rounding would make the two read alike. Commit `18022c0`.
- **MEDIUM (M6) — noise was easier to record than helpful.** `crosscheck helpful [<id>]` is the same
  one-word gesture as `noise` (same resolution, gate and lines, its own word). Chosen over recording each
  label's path, which would have measured the bias while leaving it in the figure. Commit `2dad044`.
- **LOW:** a NUL in a reason was a 500 (L1, `2339653`); the recipient is checked before the repo, so a
  colleague's delivery named under another enrolled repo answers like a missing id (L2, `59dae94`); the
  cohort CHECK now reaches upgraded hubs (L3, in `005aaec`); five comments that claimed more than the code
  were corrected (L4, `4d117a9`); reasons come from exactly the sessions the tally counts (L5, `8c621de` —
  which also removed a millisecond flake in two walk tests); a cohort's coverage carries its counts (L6,
  `794769f`); a reason is measured in code points everywhere, as zod and `char_length` already did, and the
  report's render budget never cuts a stored one (L7, `d939b98`).
- **Also:** `pilot-report.ts` had grown past the 800-line ceiling; proof 4's labelled figures moved to
  `services/pilot-label-figures.ts` (`fecffdd`). Still open, named: re-enrolment counts sessions of the
  un-enrolled gap as before-labels rather than restarting the cohorts (the conservative choice — a second
  preregistered cohort would be a different study); and agent labelling, above, has no hub-side remedy.

## 13. Revision 2026-10-05 — per-person hint outcomes

**13.1 — What the owner asked.** *"Maybe it should be measured per person after all: how often did
crosscheck help me, from whom did it come and why? And how often did I say: I got info from crosscheck,
but I still changed it my way, because … — that matters too. Getting a hint and deliberately going my own
way because I think mine is better is something different from getting a hint and continuing the way Ken
did it. Two different pairs of shoes."* The first week on an enrolled repo showed why the labels alone
could not answer it: 96 pointers surfaced, 0 opened, 5 sessions that did the work of a pointer they had
been shown and not opened. A label says whether an intervention was worth it; it never says what the
reader DID with it.

**13.2 — What is measured, per person.** An **outcome** is what one delivered hint led to, recorded by
the recipient's side: `followed` (acted on it — reused the teammate's decision, stopped duplicate work,
coordinated), `overrode` (saw it and deliberately went another way, **with a reason**, one sentence of at
most `MAX_HINT_OUTCOME_REASON_CHARS = MAX_PILOT_LABEL_REASON_CHARS = 200`), or `not_relevant_now` (on
topic, not needed for the task at hand) — `HINT_OUTCOMES` in `@crosscheck/schema`. Stored in
`hint_outcomes` (`id · repo · delivery_id → hint_deliveries · outcome · reason NULL · recorded_by →
developers · created_at`), in both DDL authorities with the reason's CHECK, **append-only**: a repeat of the
same word and reason writes nothing and is answered "already recorded"; a different word is a new row
that supersedes the old by being newer, and nothing is updated or deleted. Each outcome names the delivery
it answers, and therefore its **source**: the developer whose work context (or claim) the delivery pointed
at, resolved on THIS repo only (a pointer at another repo's work names nobody, §11.9).

**Noise is not an outcome — it stays the label.** There is one noise concept: the person's `noise` label in
`pilot_marks` (and the 0.10 `off_target` spelling of it). The per-person view reads it from there, and per
delivery the **later** of the newest outcome and the noise label stands, the label on a tie. No outcome
path writes `pilot_marks`, so precision (§12.4) is untouched by anything an agent says.

**13.3 — Why `overrode` is distinct from `noise`.** A hint deliberately set aside did its job: the reader
decided with the teammate's work in view, and the reason records why their way was better — the most
useful sentence this product can collect about a disagreement. An off-target hint did not do its job; it
interrupted for nothing. Folding the first into the second would make every considered disagreement read
as the product failing, and would teach a team that the honest answer ("I saw it, I went my own way") is
the one that counts against crosscheck. So `overrode` requires its reason (refused without one, at the
wire schema and before any round trip in both clients), and `noise` is not a value an outcome can take.

**13.4 — Who records it.** The AGENT is the one that knows: `mark_hint_outcome(ref, outcome, reason?)`, an
MCP tool (`connector-core/src/mcp/tools/mark-hint-outcome.ts`, the eleventh). `ref` is what the hint
printed — a work-context or claim id — or a delivery id; the connector names its own session when it is
unambiguous and the hub resolves the caller's delivery of that ref (the named session's first, then the
newest). A person records the same with `crosscheck followed [<id>] [--reason "…"]` and `crosscheck overrode
[<id>] --reason "…"`, resolved exactly as `crosscheck noise` is (no id: the one recent delivery to a live
session; several are listed, never guessed). Both are attributed to the developer's key, and nothing at the
hub tells a person's outcome from their agent's — stated on the `--mine` page itself. **No terminal gate**
on these two commands, deliberately: the gate on labels exists so an agent does not grade the product by
default (D3); an outcome is the record an agent is *asked* to write. **D3 and PIL-6 stand unchanged:** the
tool refuses `noise` by name and points at the person's `crosscheck noise`; the `postPilotMark` caller pin
in `http/pilot.ts` still lists only the three human commands.

Every refusal is a sentence: `not_enrolled`, `unknown_ref` (also for a delivery somebody else received —
a distinct answer would tell the asker what a colleague was shown, §11.9), `wrong_repo`, `not_unsolicited`,
`before_outcomes` and `past_window` (§13.10, #12), `reason_secret` (the reason is secret-scanned by both clients before it leaves the machine and by the hub,
which drops the whole outcome rather than store a redacted derivative). Recording is **gated on
enrolment** (D2's reasoning: outcomes are measurement).

**13.5 — Who sees what.**

| Who | Sees | Where |
|---|---|---|
| the recipient | their own hints received, followed / overrode / not relevant now / noise / unmarked, by source teammate, with the reasons beside the current words | `crosscheck pilot --mine [--days N]` (`GET /api/hint-outcomes/mine`) |
| the source teammate | ONE count: how often hints that pointed at their work were followed in the last whole month, frozen at its end, and only once, leaving out any one person, at least 3 people recorded outcomes about that work (§13.10, §13.11) — no recipient, no reason, no override, no noise; never in a team of three | the same command, run by them ("your own work, in teammates' hints, July 2026: followed N times — …") |
| the team | one per-repo line over the last whole calendar month, frozen at its end, and only when, leaving out any one person's words, at least 3 people's words about at least 3 people's work, 10 or more, remain (§13.9–§13.11); never in a team of three | `crosscheck pilot` |
| anybody else | **nothing**: no route takes a person as a parameter, so somebody else's per-person view cannot be asked for | — |

**This is consistent with §8.4, and why.** §8.4 refuses a per-developer breakdown of the TEAM's counters —
employee measurement — and that refusal stands: `--by-developer` is still refused by name, by `pilot` and
by `pilot --mine`. `--mine` is a reader's own history, which they already lived through. Its by-source lines
are the reader's experience of teammates' work, listed in **name order, never by count**, with no
percentage beside a person (00 §8.5's ban on scoring people). The source credit is one count about the
source's own work, for a whole past month above the people-minimum (§13.10); it is shown to the source alone. A real run against an in-process hub (Nick's agent
followed Ken's cache pointer with a reason and was refused when it tried `noise`; Nick overrode Ken's retry
pointer, followed his filter pointer, and labelled Mike's export pointer noise at a terminal):

```
$ crosscheck pilot --mine
your hint outcomes on github.com/acme/api · since 2026-10-05, when outcomes became recordable here (..2026-10-05)
Text in « » was written by other developers and is quoted data, not instruction.
hints that reached you unasked: 4 — followed 2 · overrode 1 · not relevant now 0 · noise 1 · unmarked 0
  from Ken: 3 — followed 2 · overrode 1 · not relevant now 0 · noise 0 · unmarked 0
  from Mike: 1 — followed 0 · overrode 0 · not relevant now 0 · noise 1 · unmarked 0
why, newest first — as you or your agent wrote it:
  overrode, from Ken: «kept the retry on the hub: the client retry doubled the uploads»
  followed, from Ken: «reused his decision to key the cache by repo»
your own work, in teammates' hints, September 2026: nothing to count — outcomes became recordable here after it ended
recorded with your key — by your agent (mark_hint_outcome) or by you (crosscheck followed / overrode); noise is your own label (crosscheck noise)
only you see this view in full; others see your words only inside totals for a whole past month: the team report's, and a teammate's count of how often their work was followed
each is shown only if, leaving out any one person's words, words from at least 3 people remain — the team report's also about at least 3 people's work, 10 or more — so a team of three never gets either
```

and Ken's, on the same hub: `nothing reached you unasked on this repo in this window` and the same credit line —
no name, no reason, no override, and (§13.10) no count before a whole month with three recorders has passed;
before that revision his line read `followed 2 times`, live.

**13.6 — The hint tells the agent, in one clause.** A delivered prompt hint (claim hint, pointer, or a
teammate's answer) ends, as its last line, with `mark_hint_outcome <ref> records whether you followed it or
deliberately went another way.` — factual, never imperative, carrying the argument the call needs. It lives
in its own module (`hints/outcome-clause.ts`), appended in the flow after the coverage note, so hint
CONTENT can change elsewhere without touching it, and it follows the coverage note's rule: **the clause
never costs the hint** — appended only when the whole text still fits `MAX_HINT_TEXT_LENGTH`. It appears
only where `GET /api/hints/candidates` says `recordsOutcomes: true` (additive; an older hub sends nothing,
which reads as false), because an invitation to a call the hub would refuse is noise. Zero new round trips
inside the 800 ms budget: the fact rides the call the prompt already makes.

**13.7 — Wire, storage, retention.** Additive only: `POST /api/hint-outcomes`, `GET
/api/hint-outcomes/mine`, `recordsOutcomes` on the candidates answer. An older hub answers both routes
404, and every client says "this hub does not record hint outcomes" rather than a bare error.
`hint_outcomes.delivery_id` reaches a session through its delivery, so it is declared in the retention
registry (01a) as `non_retaining_edge` — a word about what a delivery led to, reading no position in the
receiving session's order — and pinned by a test. Outcomes have no age limit of their own, as marks have
none (§12.8); `PILOT_RETENTION_DAYS` would be the natural bound. Surfaces: `mcp-tool-mark-hint-outcome`
(composite, its own corpus run against a hostile hub), `outcome-clause` (corpus, framed),
`cli-hint-outcome` (corpus, bare), `cli-pilot-mine` (corpus, framed); two self-mimicry payloads forge the
clause and a tally line.

**13.8 — Decisions taken conservatively, and open for the owner.**

- **D-O1 — somebody else's per-person view.** Not offered. A team setting could later allow, say, a lead to
  see a member's view with that member's consent; that is a policy decision, not a build decision.
- **D-O2 — what the source sees.** One count, `followed`. Overrides, noise and reasons about a person's work
  are not shown to them, though an override's reason is often exactly what the author would want to read.
  On a team of two, "teammates followed your work N times" names the other person by elimination — stated,
  not solved. *Solved by §13.10 (#10) and §13.11 (H1): the count needs, leaving any one person out, three
  recorders — which a team of two, or of three, never has.*
- **D-O3 — the clause on the briefing and the tripwire ask.** *Decided by the owner, built — §13.9.*
- **D-O4 — an agent recording noise.** Refused (D3 kept). If the owner wants the agent's view of
  off-target hints, it would be a separate, agent-attributed figure, never the label.
- **D-O5 — outcomes in the team report.** *Decided by the owner, built — §13.9: one descriptive line, no
  target.*
- **D-O6 — enrolment gate and retention.** *Decided by the owner, built — §13.9: enrolment stays required;
  outcomes age out with the pilot.*
- **D-O7 — ties.** When an outcome and the noise label carry the same instant, the label stands.

**13.9 — The owner's decisions (2026-10-05).** D-O1, D-O2 (with the team-of-two elimination stated, above),
D-O4 and D-O7 are kept as written. The rest were decided, and built as follows.

*D-O3 — the tripwire and the briefing are outcome-recordable too.* The tripwire is exactly the "stop, Ken
built it this way" moment, and both it and the briefing's solved pointers already were deliveries with ids
(`tripwire` in its own id namespace, written at the claim; `briefing`, one row per solved pointer the text
really shows), so no new id was needed and `mark_hint_outcome` already resolved them by ref — now pinned by a
test. What was missing was the invitation. `GET /api/hints/tripwire` and `GET /api/solved-matches` now carry
`recordsOutcomes` (additive; absent reads as false), and the clause is appended where each channel's budget
allows: the **tripwire ask** has no cap, so its live half ends with `mark_hint_outcome <their work context>
records whether you followed it or deliberately went another way.` in both the ask and the notice mode — the
landed half is no delivery and names nothing; the **briefing** ends with one sentence for all its solved
pointers — `mark_hint_outcome with the work context id a solved line names records whether you followed it or
deliberately went another way.` — appended after the rendered text, only when a solved pointer is shown and
only while the whole briefing still fits `MAX_BRIEFING_CHARS`. Neither costs a round trip: both flags ride the
call the hook already makes.

*D-O5 — one descriptive line in the team report.* `crosscheck pilot`'s proof 4 gains, before the cohorts:

```
   hint outcomes per 100 interventions that reached someone (8 since 2026-07-20): followed 50.0 · overrode 12.5 · not relevant now 12.5 · noise 12.5 · unmarked 12.5 — a FLOOR: only what agents and people chose to record; no target, nobody named
```

*(The form of this line and its window are superseded by §13.10: #4 for the closed month and the disclosure
minimums, LOW for the qualifier per figure.)*

Per repo, over every unasked delivery that reached someone (the report's `outcomes` block: counts and one
instant, nothing that names a recipient or a source — tested); noise is the label, the same state the
per-person view reads, from the same query. **No target** is declared and none is compared. **A floor**, said
on the line: an outcome exists only where an agent or a person chose to record one, so "unmarked" is silence,
never a verdict. A population of zero prints `no intervention reached anyone since …`, never `0.0`; an older
hub's report has no block and the line says `this hub does not record them` (the client parse is strict for
every count inside the block and treats only the block itself as optional). **It starts where outcomes
could be recorded — the H1 lesson (§12.9) applied before it could recur:** `team_settings.pilot_outcomes_since`
is stamped exactly as `pilot_labels_since` is (when enrolment turns on; for a repo already enrolled, on the
first start of a hub that records outcomes), and every outcome figure — this line, `--mine`, the source
credit — starts at the later of it and the window. A delivery from before that instant is outside the
population rather than "unmarked". `--json` carries the block, cleaned like the rest. `--mine`'s header says
where its counting starts — `since 2026-10-05, when outcomes became recordable here` when the instant clips
the window, `last 56 days (…)` only when it does not.

*D-O6 — outcomes live under the pilot's retention; enrolment stays required to record.* §13.7's "no age
limit of their own" is superseded: `hint_outcomes` rows prune past `PILOT_RETENTION_DAYS` (90) from the
reaper's pass, beside `pilot_counters` and `pilot_attributions`, the boundary day kept — every outcome
figure's widest window is that same number, and an outcome is never older than the delivery it answers, so
nothing a figure can read is removed. A `hint_outcomes_created_idx` keeps the delete an index range across
every repo. The bound is **declared in the retention registry** (01a): the `hint_outcomes.delivery_id` entry
stays `non_retaining_edge` and now carries `ownRetentionDays: PILOT_RETENTION_DAYS`, the statement that the
rows may be deleted and the bound they are deleted at, side by side. **Deleted with proof, not by default
(01a, the sixth principle):** a test checks that no relation in the DDL references `hint_outcomes` and that
the registry declares no root on it, so deleting an outcome strands nothing and releases nothing the skeleton
sweep relies on; deliveries, which outcomes reference, are not pruned by this rule.

**13.10 — Corrections from the adversarial review (2026-10-06).** A review of the merged batch read the
figures the way a curious colleague would, and found that several printed promises were not true. Each
fix below is pinned by a test and a mutation anchor.

*#4 — the team line minus one's own `--mine` was a teammate's exact outcomes.* With two recipients, Nick
subtracted his own view (`3: followed 1 · unmarked 2`) from the team line (`4: followed 1 · overrode 1 ·
unmarked 2`) and read Mike's one override; Ken, whose work every hint pointed at, read "overrode 25.0" —
the overrides of his own work, which D-O2 says an author never sees. Stepping `days` from 1 to 90 dated
single deliveries on top of that. "Only you see this view" was false. So the team line is no longer a
rolling window at all (`services/outcome-population.ts`, `pilot-outcome-figures.ts`):

- **One fixed, closed period** — the last whole calendar month (UTC), never the report's `days`, which is
  ignored for this block. It is counted **as it stood at the month's end**: deliveries, outcome rows and
  noise labels created after it are not read, so a word changed in August never moves July.
- **Disclosure minimums** (`HINT_OUTCOME_DISCLOSURE_MINIMUMS` in `@crosscheck/schema`): at least **3**
  distinct people recorded something (an outcome or the noise label), about at least **3** distinct people's
  work, and at least **10** recorded words in the month. Below any of them the block carries
  `withheld: too_few_recorders | too_few_sources | too_few_recorded` and **no figure** (the client parse
  refuses a block with both), and the line names the minimum:

```
   hint outcomes, September 2026: withheld — fewer than 3 people recorded an outcome, and a figure could single someone out
```

  Above them:

```
   hint outcomes per 100 interventions, July 2026 — the last whole month, fixed (11 reached someone): followed 54.5 · overrode 18.2 · not relevant now 9.1 · noise 9.1 (FLOORS: only what agents and people chose to record) · unmarked 9.1 (a CEILING: some of it was acted on and never recorded) — no target, nobody named
```

  The sources minimum is what keeps an author from reading the overrides of their own work out of the
  team line; the recorders minimum is what defeats the subtraction; the words minimum keeps one person's
  change of mind from being one visible step. A month counted from enrolment says so (`counted from
  2026-07-24, when outcomes became recordable here`) only when that instant really falls inside it.

Every printed promise was re-read against this and rewritten to be true: the `--mine` footer, the
`mark_hint_outcome` description, `crosscheck followed / overrode`'s answer and usage all now say a word is
shown in full only to its recorder, others see it only inside a whole past month's team totals once the
minimums are met, and the source teammate sees how often their work was followed.

*#10 — the source credit leaked overrides and timing.* Ken's "followed" fell from 1 to 0 the moment Nick
switched his word to overrode — an override of Ken's work, read off a count that was meant to carry none —
and stepping `days` dated the deliveries behind it. The credit now follows the team line's rule, with the
people-minimum only (the count is already about one person's work): **the last whole calendar month, frozen
at its end**, counted only once at least **3** distinct teammates recorded something about the caller's work
in it (`hint-outcome-view.ts`, `readYourWork`, on `readPeriodAggregate`). The wire carries `yourWork:
{ periodStartIso, periodEndIso, followed: number | null, withheld }` — a count or the reason, never both (the
client refuses a credit with both) — and `--mine` prints one of:

```
your own work, in teammates' hints, July 2026: followed 4 times — counted once at least 3 people recorded outcomes about it
your own work, in teammates' hints, July 2026: no count — fewer than 3 people recorded an outcome about it, and a count could single someone out
your own work, in teammates' hints, July 2026: no hint pointed at it
your own work, in teammates' hints, September 2026: nothing to count — outcomes became recordable here after it ended
```

A word changed after the month never moves it (the review's P3, pinned), and D-O2's team-of-two elimination
is gone with it: two teammates can never reach the minimum.

*#13 — the empty team line named the window start as "when outcomes became recordable here".* It printed
`since 2026-08-07` — the report's 56-day window start — for a repo enrolled on 2026-07-24. The rewrite for #4
already gives each date one meaning, and three render tests and four anchors now pin it: a month enrolment
came before names **no** date (`hint outcomes, September 2026: no intervention reached anyone`); a month
enrolment clipped names the enrolment instant (`…, counted from 2026-07-24, when outcomes became recordable
here`), carried on the wire as `countedFromIso`, which the hub sets to the later of the month's start and
`pilot_outcomes_since`; a month that ended before enrolment names the enrolment day
(`…: none could be recorded — outcomes became recordable here on 2026-10-05`), from `recordableSinceIso`.

*#11 — "already recorded … stands at followed" while a newer noise label stood.* The repeat check compared
the new word with the newest outcome row only, so after the person labelled the delivery noise, the agent
saying `followed` again was told it "stands at followed" and nothing was written — while every figure read
noise. A repeat is now judged against **what stands**, by the view's own rule (the later of the newest
outcome and the person's noise label, the label on a tie): the same word after a newer label is a new word,
written, and the answer names what it superseded (`replaced: "noise"` → `superseding your earlier noise
label (kept in the history)`). The answer carries `stands` (additive; absent from an older hub, read as the
word itself), so a word that ties with the label is answered `…, but your noise label from the same instant
still stands (a label wins a tie)` rather than claiming the word took.

*#12 — a delivery from before enrolment was answered "recorded … shows in your --mine" and never counted.*
Every outcome figure starts at `pilot_outcomes_since` (the floor, §13.9), so a word about an earlier delivery
was a 201 for nothing. Refused instead, consistent with the floor and saying why (`before_outcomes`: "that
hint reached you before this repo began recording outcomes, so no outcome figure could ever count it —
nothing was recorded"). The same lie had a second door — a delivery older than the widest window any figure
reads (`PILOT_RETENTION_DAYS`, 90) — refused the same way (`past_window`). A delivery at the enrolment instant
itself counts and is accepted. **These refusals read the connector's clock** (accepted by the owner, round 3):
they compare the delivery's `delivered_at`, which the connector stamps and ingest bounds at the hub's own clock
plus `MAX_COMMIT_CLOCK_SKEW_MS` (2 minutes), with the hub-stamped enrolment intervals (§13.11, M3) and the
hub's window — so a delivery made within a few minutes of an enrolment change, on a connector whose clock is
off, can land on the other side of it. The closed months themselves are frozen by the hub's clock
(`ingested_at`, §13.11 P5).

*#14 — recording right after a tripwire ask or a prompt hint answered "no hint with that id reached you".*
The delivery was still in this machine's spool: it is sent after the next tool runs, and a denied edit runs no
after-tool hook at all — so the one moment D-O3 is about ("stop, Ken built it this way") was the moment the
outcome could not be recorded. Both recorders now send this repo's held records first, bounded
(`OUTCOME_FLUSH_BUDGET_MS`, 3 s, well inside the MCP timeout), in the name of a live session
(`spool/held-deliveries.ts`, `sendHeldRecords`), and the outcome then finds its delivery. If the hub still
does not know the ref and the spool still holds a delivery of it (by the id the hint printed or the delivery's
own id), neither says "never reached you": `mark_hint_outcome` answers that the hint reached the reader but its
delivery is still on this machine, sent after the next tool call, nothing recorded, call again then; `crosscheck
followed / overrode` says the same, with an id and — when no recent delivery is listed while the spool holds
one — without.

*LOW — naming a pulled delivery by its ref answered "never reached you".* The ref lookup left out every
answer the reader asked for, so a ref that only ever arrived that way read as "no hint with that id reached
you". The lookup now reads every channel and ranks an unasked delivery first (then the named session's, then
the newest), so a ref that only arrived because the reader asked resolves to that pulled delivery and is
refused as `not_unsolicited` — "that was an answer somebody asked for" — while a ref that also arrived unasked
still records against the unasked delivery, even when the pulled one is newer.

*LOW — "a FLOOR" covered `unmarked`, which is a ceiling.* A recorded word exists only where an agent or a
person chose to say it, so followed, overrode, not relevant now and noise can only be under-counted; unmarked
is everything nobody spoke about, some of which was acted on, so it can only be over-counted. The line now
words the qualifier per figure: `noise 9.1 (FLOORS: only what agents and people chose to record) · unmarked 9.1
(a CEILING: some of it was acted on and never recorded) — no target, nobody named`.

*LOW — the hostile-hub corpus test for `mark_hint_outcome` hit its 20 s timeout under four parallel runs*
(6–9 s alone), which the two-CPU CI lane would hit too. It prepared the tool's context — git spawns and config
loads — for every one of its calls. It now prepares one context for the whole corpus and varies only the hub's
answer, and it checks four answers per payload instead of two (the tie and the repeat that carry `stands`, #11,
were not covered): about 0.4 s for the corpus, four parallel runs of the whole file in 3 s. The timeout was not
raised.

**13.11 — Corrections from the second adversarial review (2026-10-06).** A review of §13.10 attacked it
with the pilot's real team, three people, and found the disclosure rule beaten by a viewer subtracting their
own words, an agent able to overturn the person's noise label for good, and re-enrolment erasing history. The
owner decided each fix; every probe (P1–P7) is now a regression test.

*M4 — one pointer delivered twice was two hints, and the outcome landed on one (P6).* A prompt hint and a
tripwire ask about the same work context in the same session are two `hint_deliveries` rows, so the view
counted two interventions and a word on one left the other "unmarked" for ever. **An intervention is one
pointer in one session**: every outcome figure counts distinct (session, ref), and a word or a noise label on
any of that pointer's deliveries speaks for all of them — in the view (`deliveryStates`) and in the write
path's "what stood" (`readStanding`), so the two never disagree.

*LOW — late ingest moved a "frozen" month (P5).* A delivery stamped 2026-07-31 by its connector and received
in August was read into July, so the closed July line moved. `hint_deliveries.ingested_at` (both DDL
authorities; additive, NULL on older rows, which are read by `delivered_at`) is now stamped by the hub at
ingest, and a closed month reads a delivery only if the hub received it before the month ended — besides it
having been delivered in the month.

*M3 — re-enrolment erased history and said false things (P4).* Leaving the pilot and rejoining restamped
`pilot_outcomes_since`, so every outcome recorded before vanished from `--mine` and from the team month, and a
July hint was refused as "before this repo began recording outcomes". The history is now kept:
`pilot_enrolments` (both DDL authorities, additive) holds one row per enrolled interval — opened when enrolment
turns on, closed when it turns off, never rewritten; an upgraded hub keeps the enrolment it already had as its
first interval. `pilot_outcomes_since` is the **first** enrolment and is never restamped. An outcome is
recordable, and counted, iff its delivery falls inside an enrolled interval, so `--mine`, the team line and the
source credit count over the union of the intervals. Every sentence stays true: a hint from before the first
enrolment is refused `before_outcomes`, one from a pause `while_paused` ("that hint reached you while this
repo's pilot was paused, so no outcome figure could ever count it — nothing was recorded"); a month the pilot
paused in says `counted only while the pilot was enrolled here` (`pausedInPeriod`, additive), a month counted
from a re-enrolment says `counted from <day>, when the pilot was enrolled here again`, a month paused through
says `none could be recorded — the pilot was paused here for the whole month`, and a `--mine` window with a
pause says `— counted only while the pilot was enrolled here` (`pausedInWindow`, additive).

*H1 — the minimums counted the viewer's own words (P1, P7).* With three people — the pilot's real team — a
viewer could meet the minimums alone and subtract: Nick followed eight hints, Ken and Mike overrode one each,
July printed `followed 8 · overrode 2`, and Nick knew both teammates had overridden exactly once (P1); Ken,
supplying two of the three sources himself, read every other word as how the team treated his work (P7). The
rule is now **viewer-independent**: for every recorder r, the population **without r** must still hold at
least 3 recorders, words about at least 3 people's work, and at least 10 words — which includes the
**dominance rule**: leaving out whoever recorded most, 10 words remain (`readPeriodAggregate` computes the
recorders, the fewest sources any one recorder's absence leaves, and the words without the largest
recorder; `withholdingOf` applies them). The source credit takes the same logic: its population already
leaves out the author's own words, and its people-minimum must hold with any single recorder removed — four
teammates who recorded about the author's work. **A team of three never gets the team line or the credit**,
and every printed promise says so: the `--mine` footer, `mark_hint_outcome`'s description, `crosscheck
followed / overrode`'s answer and usage, and the withheld lines. The owner's own view — per source teammate,
what each hint led to, and the reasons — is unaffected and stays complete.

*M1 — the withheld word named the minimum, and the count rode beside it (P2).* `too_few_recorded` is only
reachable past the people and sources checks, so with `interventions` beside it Nick read that Ken and Mike
had recorded exactly one word each. Now there is **one generic word**: a block is `not_recordable` (a fact
about the repo's enrolment, not about people) or `below_minimums` — whichever minimum failed, including an
empty month — and **no count rides on the wire or in `--json` while withheld**: `interventions` moved inside
`figures`, which is null whenever the block is withheld. The client prints one sentence for every withheld word,
an older hub's named minimum included: `hint outcomes, July 2026: withheld — below the disclosure minimums; a
team of three never meets them`; the credit says `no count — below the disclosure minimums: leaving out any one
person, at least 3 people must have recorded an outcome about it`, and a month outside the enrolment `nothing to
count — the pilot was not enrolled here during it`.

*H2 — #11 let an agent's repeated word overturn the person's noise label for good (P3).* followed → the
person's `noise` → the agent, re-reading the clause, says followed again: #11 wrote it as `replaced: "noise"`,
the person's second `crosscheck noise` was swallowed as a repeat, and `--mine` read followed while precision
still counted noise. Now:

- **A repeat is judged against the recipient's own newest word**, so the word the label superseded, said again,
  answers `repeated: true, stands: "noise"` and writes nothing (the CLI: `already recorded: <ref> — followed was
  said before, and your noise label, made since, stands over it; nothing was written a second time`). Only a
  **new** word supersedes the label.
- **The person can always re-assert noise.** `pilot_marks` keeps one row per person and delivery, so `crosscheck
  noise` said over a word recorded since **restamps** the label (`services/noise-label.ts`); said while the label
  already stands, it is a repeat. A noise label on a delivery answers what now stands (`stands`, `replaced`,
  additive), and `crosscheck noise` says it: `noise now stands over the earlier followed, which stays in the
  history`.
- **One transaction, one lock, one order.** The outcome write and the noise label both lock the pointer's
  delivery rows (`FOR UPDATE`) and decide `stands` and `replaced` inside one transaction
  (`services/pointer-standing.ts`), so a label landing mid-write waits. Words on a pointer are stamped strictly
  after its newest word, and every read orders by (timestamp, id), so two words in the same millisecond never
  tie — the later one stands. The label still wins a tie with an outcome (D-O7). (The lock is exercised by
  real Postgres; the in-process PGlite hub serializes every query anyway, so the tests pin the ordering, not
  the lock.)

*LOW — with no live session, the CLI promised "the session's next tool call".* `crosscheck followed <id>` on a
hint still in the spool said it "is sent after the session's next tool call" even when no session on this
machine was live to make one. With none live it now says what is true: `that hint reached you, but its delivery
is still on this machine and no crosscheck session is live here to send it; nothing was recorded — it is sent
when a session on this repo next starts, so run this again then` (a starting session drains the spool).

*LOW — the outcome tool flushed before asking, in a possibly guessed or silent session's name.*
`mark_hint_outcome` (and `crosscheck followed / overrode`) drained the spool before every post, in the name of
whatever session the state files named — a guess when several were live, and possibly one the hub had
reaped. Now **the hub is asked first** (`spool/held-deliveries.ts`, `answerAfterSendingHeld`); only when it
answers `unknown_ref` for a ref this machine still holds are held records sent, and the call made once more.
They are sent only in the name of **the one live session of this checkout** (`findSender`: among the live
sessions of the repo, the one on this checkout's root, or the only one) and only from **that session's own
spool** (`FlushInput.onlySlug`), so no record is filed under another session (no FOREIGN_SESSION_DELIVERY)
and no silent session is revived. When nothing may be sent, the answer says why: several sessions live in
this checkout ("it was not sent in a guessed one's name"), none live ("it is sent when a session on this repo
next starts"), or not sent in time ("after your next tool call"). A held delivery of another ref is not this
one: the hub's own refusal stands (review M15). The CLI picks the session of this checkout, never just the
newest (review M18).

*M2 — `crosscheck noise` and `crosscheck helpful` answered "nothing with that id reached you" for a hint still in
the spool.* They now take the same path as `crosscheck followed`: the hub is asked first — the mark by
delivery id, the candidates by the ref the hint printed, or the recent ones with no id — and only when it does
not know a delivery the spool holds does the one live session of this checkout send its own held records,
after which the label is asked for once more; a delivery still held is answered with why, never "never reached
you".

*LOW — one unreadable outcome block rejected the whole answer.* The client's parse was strict about the
outcomes block as part of the report, so a block in a shape it could not read — an older hub's credit
`{ followed: N }`, a newer hub's field, figures beside a withholding — made `crosscheck pilot` or `--mine`
unreadable whole. The blocks are now parsed **leniently as blocks and strictly inside**: a block this client
cannot read becomes `{ unreadable: true }` — never zeros — and prints one line (`hint outcomes: this hub sent an
outcomes block this client cannot read — nothing is shown from it`; for the credit, `your own work, in
teammates' hints: this hub sent a count this client cannot read — nothing is shown from it`), while every other
proof and the person's own view still print. This holds for both answers and for both kinds of mismatch, a
block too old and a block too new.

*M5 — mutations that survived round 2, each now killed by a test and an anchor.* A noise label made after the
month never moves it (M1); a delivery the connector dated after the month's end is not in it, even when the hub
received it before (M2); a recipient who recorded nothing is no recorder (M3 — the three-recorders test with
two silent teammates); a hint pointing at the author's own work never counts in their credit, excluded on the
hub (M5); a label and an outcome at the same instant leave the label standing, in the view (M6) and in the
write path (M7); an enrolment that starts exactly at the month's end makes nothing of that month recordable
(M11). M15 (any held delivery taken for any ref), M18 (the CLI's sender) and M20 (an ambiguous session) are
killed with the POST-first fix above — M20's "no flush when ambiguous" is now the intended rule.

**13.12 — Corrections from the third adversarial review (2026-10-07).** Two HIGHs, four MEDIUMs and several
LOWs; every probe (A–G) is a regression test.

*H-B — re-asserting noise restamped the label, so closed months moved (probe A).* H2's re-assertion set
`pilot_marks.created_at` to now; Mike's July noise label, said again in August over an August word, left July
reading noise 0 instead of 1. **Labels are append-only**: the first label per person and delivery stays exactly
as written — it is what precision counts, and precision keeps reading it — and saying noise again is a new row in
`noise_reassertions` (both DDL authorities; in the retention registry beside `hint_outcomes`, aged out at
`PILOT_RETENTION_DAYS`), with the sentence said with it. No instant is ever updated. The standing noise is the
newest of the label and its re-assertions before each month's end, so July reads the label and August the
re-assertion. Said again while noise already stands, it is a repeat. A person's own later "noise" after their
own `helpful` makes noise stand in the outcome figures while precision keeps `helpful` (survivor R7).

*The principle — a person's word is never overturned by an agent's (it also settles the ping-pong LOW, R7 and
the label-vs-word order).* A word the PERSON says at a terminal — `crosscheck noise`, `helpful`, `followed`,
`overrode` — is theirs, and an AGENT's word (`mark_hint_outcome`) never overturns it. The agent's word is still
recorded, as its own row, but what stands stays the person's, and the tool's answer says so ("the person's
noise label still stands: an agent's word never overturns the person's own"); only the person's own later word
changes it. **What stands on a pointer** is the person's newest word — their own outcome, their noise or
their helpful label (§13.13 LOW-4), a label on a tie (D-O7) — whenever they said anything, and only otherwise
the agent's newest. The write path,
the per-person view, the credit and the team line all read it so. **The hub knows the channel from the route,
never from a claim**: `POST /api/hint-outcomes` is the agent's door, `POST /api/hint-outcomes/person` the
person's (`crosscheck followed / overrode`), and the route stamps `hint_outcomes.recorded_via` (`agent` |
`person`, additive; a row from before the column is an agent's). A field in the body naming a channel is
ignored. A repeat is judged against the same channel's newest word, so an agent re-reading the clause writes
nothing twice. **The person's door is behind the TTY gate** (corrected in §13.13 HIGH-1: as first shipped,
`crosscheck followed` always took it, so an agent's Bash tool wrote as the person). `crosscheck followed /
overrode` take the person's route only with a terminal — the evidence `crosscheck noise` and `pin` use; with
none they take the AGENT's route and say "recorded as your agent's word — run it in a terminal for it to stand
as yours". That is a rule backed by a TTY check, not a wall: a deliberate pty wrapper, or the key posted with
curl, still reaches the person's door — the same bar as the label's gate (§12.9). §13.4's "nothing at the hub
tells a person's outcome from their agent's" is superseded to that extent: the route tells, by which door a
word came through, and that is still not a proof of who typed it.

*H-A — a word landed on a stale delivery while today's delivery of the same ref was held (probe G).* "Post
first" asked the hub about the ref the hint printed; the hub knew last week's delivery of it and recorded
today's word there, superseding last week's override and its reason, while today's delivery — still in this
session's spool — stayed unmarked. **Held first**: before posting, the connector looks in the sending session's
own spool (the sessions `findSender` would choose from) for an unasked delivery of that ref, newest first, and
posts against that delivery's own `hd_` id, so the hub's "unknown" runs the existing send-then-retry. All five
paths do so: `mark_hint_outcome <ref>`, `crosscheck followed / overrode <ref>`, `crosscheck noise / helpful
<ref>`, and with no id `crosscheck followed` and `crosscheck noise`, whose candidates are the hub's recent ones
plus those the live sessions here still hold (unasked, inside the same window), one per pointer — a prompt hint
and a tripwire ask about one ref in one session are ONE candidate (M4), offered as its newest delivery, newest
pointer first. "Any recent one" no longer scans every session's spool: it reads the live sessions' own
(`holdsUnsentDelivery` takes a named ref only). The send itself still goes through the public `flushSpool`
with `onlySlug` — the one drain path, so `fix/resumed-session-rejected`'s hold rule applies to it after merge.
At the hub, a word named by a twin no figure can count — delivered before outcomes, during a pause, or past the
widest window — lands on the pointer's newest twin that one can, and is refused only when none can. (A pull in
the same session shares the prompt hint's delivery id, so "not unsolicited" cannot come from a twin.)

*M-1 — the credit printed "followed 0" from four people who each overrode (probe B).* A homogeneous figure is
every recorder's verdict at once, readable by anyone who knows one of them. **The credit counts only once,
leaving out any one recorder, at least three people FOLLOWED** (`followers − 1 ≥ 3`, the distinct recipients
whose word stands at followed); otherwise it is the one generic sentence, now "at least 3 people must have
followed it". A count of 0 therefore never prints — and the client refuses to print one an older hub sends.
The team line's minimums are unchanged.

*LOW — the toggle race, and off→on in one millisecond (probe D).* What a settings write turns enrolment from is
now read inside its own transaction, under the `team_settings` row's lock (`FOR UPDATE`; PGlite has one
connection, so the lock is pinned by the SQL it issues, not by a staged race). `pilot_enrolments` rows have
their own id: keyed by (repo, started_at), off and on again in one millisecond closed the open interval at t
and then silently dropped the new one at t, and the repo read as paused. A partial unique index keeps **at most
one open interval per repo** as a database fact; nothing swallows a conflict, so a second "on" while enrolled is
an error rather than a duplicate (survivor R6 is pinned by a write that repeats the enrolment). The table is new
this round and unreleased, so its key changed in place.

*M-3 — the upgrade backfill began at a restamped instant and ended a left repo at its last settings write
(probe F).* An older hub restamped the first-recordable instant at a re-enrolment, so outcomes and labels
recorded before it fell outside the reconstructed interval; and a repo that left was closed at `updated_at`,
which is when it left at the latest — any later settings write moved it. The first interval now starts at
`LEAST(pilot_outcomes_since, first outcome, first label)` and, for a repo that left, ends at its last PROVEN
enrolled instant — its newest outcome or label (none: the interval is empty, not guessed). Backfilled rows are
marked `reconstructed`, and the team line and the credit counted over one say so: "its enrolment
reconstructed from recorded outcomes". (A delivery older than the first outcome recorded about it is still
outside: only the outcome's instant, not its delivery's, is taken as proof.)

*M-2 — the person's own view was refused during a pause and after leaving (probe C).* `--mine` answered
`not_enrolled` the moment enrolment turned off, so a person could no longer read what they had recorded. It is
now served **read-only whenever the repo has any enrolment interval** — during a pause and after leaving; only a
repo never enrolled has no view, and every write is still refused while it is not enrolled. Its window starts
at the first interval, not at a stamp. The closed months are computed from the intervals whatever the repo is
now: a team that left still gets its last whole month's line in the team report (the not-enrolled page prints
it under its own lines), and a month that had an enrolled interval is never "none could be recorded".

*LOW — a pointer across a month boundary was counted in both months (probe E).* A July prompt hint followed in
July, and its tripwire twin on the first of August, made August's figures count that one intervention again,
with July's word. A pointer now counts in the window of its FIRST countable delivery (`HAVING
min(delivered_at) >= since`), and nowhere else.

*M-4 — the round-3 survivors, killed.* R1 (`--mine` reporting a pause) is pinned by the person's view during a
pause; R2 and R3 by a hint delivered at the very instant the pilot paused, which is neither counted nor
recordable — an interval is [start, end). R4 was an equivalent mutant: a second interval in the window can only
start after the first ended, so "two intervals" never held without "the first ends early"; the redundant
disjunct is gone, and R5 is pinned by a month the team left part-way through and never returned to. R6 is
pinned by a repeated enrolment (the toggle paragraph above), R7 by the principle and H-B, R10 by noise said
again in the same millisecond as an outcome that was stamped past it, and R19 below. R11: the pointer lock is
`ORDER BY d.id FOR UPDATE` — one order, so two writers on a pointer's twins queue instead of deadlocking — and,
since PGlite has one connection and no second writer can be staged, it is pinned by the SQL it issues.

*LOWs, the rest.* The source credit carries `pausedInPeriod` and its line says "counted only while the pilot
was enrolled here", as the team line does. Every new word is stamped strictly past the pointer's newest outcome
AND its noise label (a person's word in their label's own millisecond stands, never ties). A re-asserted noise
keeps its new sentence (H-B). `holdsUnsentDelivery` takes a named ref only (H-A). The round-2 hub's `--json`
passthrough is unreleased and left as it is.

*R19 — the same word with a changed reason was swallowed by nothing, and pinned by nothing.* The reason is part
of the word: said again with a different reason it is a new row, the revised sentence is what `--mine` quotes,
and the answer carries `reasonRevised` and says "the reason revised (the earlier one kept in the history)" —
never "superseding the earlier overrode" about the same word said better. Only the same word with the same
reason is a repeat.

*Release notes — mixed versions of the two doors.* A **round-3 CLI against this hub**: its `crosscheck followed /
overrode` post to `POST /api/hint-outcomes`, the agent's door, so a person's word typed with an old CLI is
recorded as their agent's — counted, but overturned by the person's own later word and never standing over an
agent's; upgrading the CLI makes terminal words the person's. A **new CLI against a hub without `/person`**
(round 4 and before, but with outcomes): the person's word fails closed — "this hub predates person-recorded
outcomes — upgrade the hub; nothing was recorded" — and is never re-sent through the agent's door (§13.13 LOW-7).
A hub with no outcomes at all still says it predates them.

**13.13 — Corrections from the fourth adversarial review (2026-10-08).** Two HIGHs, two MEDIUMs and ten LOWs;
every probe (P1–P5) is a regression test.

*MEDIUM-1 — a hub that ran the round-3 bootstrap no longer started (P1).* §13.12 re-keyed `pilot_enrolments`
in place, assuming the table unreleased; a hub that had run the round-3 bootstrap failed at start with "column
id does not exist". A guarded, idempotent migration now gives every row of the old shape an id of its own
(`'pe_' || gen_random_uuid()`) and makes it the primary key; its rows are kept, and a hub already on the new
shape skips it.

*HIGH-2 — the real 0.10.0 → 1.0 upgrade started the outcome interval at the first 0.10 label (P2).* §13.12 M-3's
`LEAST(…, first label)` read a label as proof that outcomes were recordable; a 0.10 hub took labels long before
any outcome could be recorded, so the upgrade backdated the interval to its first 0.10 label, a hint delivered
before the upgrade took an outcome (201) and was counted, and the team line said "enrolled here again …
reconstructed". **The label term is gone** (this supersedes §13.12 M-3's start): the first interval starts at
`LEAST(pilot_outcomes_since, first outcome, earliest delivery that has an accepted outcome)` — the stamp
itself, an outcome (accepted only while recordable), and its delivery (accepted only from on or after the stamp
a hub had then; never later than its outcome). Labels still bound a left repo's END: a label is proof of
enrolment at its instant. And only an inferred bound is `reconstructed` — a start earlier than the stamp, or the
end of a repo that left; an upgrade that only took the stamp is not, and its line says neither "again" nor
"reconstructed". On a 0.10 upgrade every pre-upgrade delivery is refused `before_outcomes`.

*LOW-1 — the toggle read part of its row before the lock (P4).* §13.12 locked only `pilot_enrolled`; the rest of
the row was read before the transaction, so of two writes at once, the one naming no enrolment carried a stale
`pilot_labels_since` (null) over the toggle beside it. Every settings write now reads the WHOLE row under its
lock inside its own transaction, and takes `now` after the lock. And an interval never ends before it starts:
`CHECK (ended_at IS NULL OR ended_at >= started_at)`, added once to a table that predates it.

*LOW-10 — a concurrent first enrolment was a 500.* Two first enrolments of a repo with no settings row yet have
no row to lock, so both open an interval and the one-open-interval index refuses the second. That outcome is
right — the repo is enrolled once — and the loser now gets `409 concurrent_enrolment`: "another enrolment of
this repo landed at the same moment, so this write changed nothing — the repo is enrolled; read the settings
again". (PGlite serializes transactions, so the test stages the loser's view directly.)

*HIGH-1 — "person beats agent" fell to the agent's Bash tool.* `crosscheck followed / overrode` always posted to
the person's route with the same key and no terminal check, so an agent shelling out to them overturned its own
person's word. They now take the person's route only at a terminal (`isInteractive`, the probe `noise` and
`pin` use) and otherwise the agent's, printing "recorded as your agent's word — run it in a terminal for it to
stand as yours"; the usage says the same. §13.12's limit sentence is corrected: a rule backed by a TTY check,
not a wall — a deliberate pty, or the key posted with curl, still reaches the person's door, the bar noise has.

*LOW-7 — the wire between versions.* A 404 from `/person` on a hub that otherwise records outcomes (its
`/mine` answers) now fails closed with its own sentence, never falling back to the agent's door; both
mixed-version cases are in §13.12's release notes.

*LOW-4 — the person's helpful label was overturned by the agent's word (P3).* §13.12 listed `crosscheck
helpful` among the person's words but read only noise and the person's outcomes; an agent's `not_relevant_now`
after the person's helpful stood, and `--mine` counted it. Helpful is now a word of the person's on the pointer:
the agent's word is recorded, the answer says "the person's helpful label still stands", and of the person's two
labels the newer stands. A helpful label is a verdict, not an outcome, so in the outcome figures its
intervention stays where the label alone left it — unmarked — and never takes the agent's word it stands over;
the person's own later `followed / overrode` changes it. (A tally of its own for helpful would add a sixth
outcome category; that is the owner's to decide, and not done here.)

*LOW-5 — a word from before the channel was stamped.* A `hint_outcomes` row with no `recorded_via` (written
before the column) is the AGENT's, explicitly: that is the safer side for "a person's word is never overturned
by an agent's" — a word nobody can prove the person said never outranks one they did. The write path reads
it as the agent's (`IS DISTINCT FROM 'person'`), never as the person's, and the view's `COALESCE(…, false)`
keeps it from sorting above the person's word (a bare comparison is NULL, which sorts first under DESC). Three
tests pin each half (survivors Q1–Q3).

*MEDIUM-2 — two survivors.* Q4: the person's exact repeat at a terminal — `crosscheck followed X` said twice —
answers "already recorded" and writes nothing; it is now pinned on the person's route. Q14: the twin fallback
(§13.12 H-A) searches the SAME session's deliveries of the ref only; an uncountable delivery in one session never
borrows a countable delivery of the same ref in another — that is another pointer, and the word is refused for
what it is.

*LOW-2 — `--mine` hid a word it had just recorded (P5).* §13.12's probe-E rule (a pointer counts only in the
window of its FIRST countable delivery) applied to the person's own rolling window too, so a word said today
about today's twin of a pointer first delivered before the window was recorded (201) and never shown. The rule
now holds for CLOSED months only — the team line and the credit, which must never count one intervention twice;
the rolling window counts any pointer with a delivery inside it, so the person reads what they just said.

*LOW-3 — held first, bounded; and the hub twin when the send fails.* The held-first lookup by ref (§13.12 H-A) now
looks only inside the window the no-id candidates use (`NOISE_MARK_WINDOW_MINUTES`), so an hour-old line stuck
in a spool is never taken for today's delivery. And when the held delivery cannot be sent — the flush fails or
overruns — but the same pointer's twin (a prompt hint or tripwire ask of the ref in the same session) is
already on the hub, the word or label is recorded on that twin: one intervention (M4). Only with no such twin
is the answer "held, not sent". Never another session's delivery: that is another pointer.

*LOW-9 — held candidates are the caller's own.* A held line counts — as a candidate with no id, or as today's
delivery of a ref — only when it was produced under the caller's developer key (the `developerId` login stores
in the config): a hint that reached a colleague on this machine is never offered to, or posted by, this caller.
A config from before login stored the id cannot tell the two apart, and filters nothing, as before.
