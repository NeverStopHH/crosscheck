# 06 — Structured intent and the append-only intent ledger

**Tier 2 — provisional v1** (`00-cut-line.md`: *"Structured intent: desired delta, expected surface,
non-goals, plus amendments"*). The pilot decides the final shape; §8 says what is deliberately left
open. **Supports AT-4 without owning it** — 01 owns it, because AT-4's "fails if" line is *"the answer depends
on wall-clock timestamps from two processes rather than a monotonic per-session sequence"*, and that is
01's mechanism. This spec supplies **what is compared** (the declared scope and the chain), 01 supplies
**whether two things may be compared at all**. *An earlier header here claimed "the intent half", while 01
claimed AT-4 outright and its §9 named this spec only as owning "its record's content" — so a reviewer
checking AT-4 had two specs and no stated division. One AT, one owner;* `docs/1.0/README.md` *is the
table.* It likewise **supports** AT-3 and AT-6 without owning either: §8.1 refuses a human intent rung,
§3.6 forbids an amendment from ever acting as a waiver. **AT-3's owner is 08** (its §3.2 now carries the
write path), not "the human-authority spec", which was never commissioned.

**Baseline.** `main@e9aab82` at `/Users/nicknouschirvan/worktrees/crosscheck-main`, written against
**main + #50 + #49 merged** (00 §9.4); a PR-only line is cited `crosscheck-pins:<path>`, paths are
repo-relative under `packages/`, and 00 §8's vocabulary plus 03's and 05's names win over mine.
**Measurement refusal:** I ran the greps and the one `bun -e` quoted below and nothing else, so no
latency figure appears here (§6).

---

## 1. Problem

**An intent is 200 characters of prose in one mutable cell, and the previous sentence is destroyed by
the next one.**

The object is `{ summary, provenance, confidence, capturedAt }`, `MAX_INTENT_SUMMARY_CHARS = 200`
(`schema/src/session.ts:31-53`), in one jsonb column, `work_contexts.intent`
(`server/src/db/schema.ts:168`). **Measured:** `grep -n "intent" packages/server/src/db/schema.ts` on
main returns that column and a comment at `:190` and nothing else — no history table, no version column,
no prior value. `mergeIntent` (`services/record-handlers.ts:120-135`) **replaces**: an absent field
keeps the stored intent, a derived record never overwrites a declared one, declared over declared is
*"the re-declare supersede"* (`:116-117`), and the superseded sentence is written nowhere. The only
surviving trace is an outbox row whose `changed` array contains the string `"intent"` — ids and field
names, never text, deliberately (`:186-194`): enough to know *that* an intent moved, nothing about what
it was or where in the session.

1. **`crosscheck suspect` prints the head as "what they said they were doing."** Its rule 3 is
   *"sessions and intents, never people"* (`crosscheck-pins:services/suspect.ts:21-25`), selected at
   `:297`. A session that widened its intent *after* the break reads exactly like one that declared the
   wider scope up front — principle 3 failing inside the surface #50 built for attribution.
2. **The trust label is body-carried and the hub cannot check it.** `mergeIntent` reads
   `next.provenance` off the body; `ingestWorkContext` stamps nothing (`:198-244`). #50 fixed this shape
   for pins — the hub stamps `capture_mode`, the body may never carry it
   (`crosscheck-pins:services/pins.ts:185-189`) — because `captureMode: "human"` was *"a sentence a
   model could write"* (`crosscheck-pins:schema/src/pin.ts:25-28`).
3. **Nothing in an intent is checkable**, and **there is no sequence**: the only time an intent carries
   is `capturedAt`, a wall clock the connector writes (`set-intent.ts:182`,
   `derive/intent/worker.ts:188-195`).

## 2. Principles served

> **3. "A reason written after a change is not evidence the reason existed before it."**
> `explanation_timing` needs CAUSAL order — happens-before over a monotonic per-session sequence, never
> wall-clock comparison across machines, subagents, offline connectors or batch sync.

That is the whole spec: §3.5 is the sentence as a total function, INT-2 the mutation proving it reads no
clock. Principle 4 — *"an agent cannot override human-protected behavior by broadening its own intent"*
— is served by refusal rather than machinery (§3.6; 00 §8.5 already bans `amend_intent`). **Not served
here:** principle 1 is 03's, and an unanswerable timing is *not* a coverage gap (§9); principle 2 is the
verdict spec's.

## 3. Target model

### 3.1 The wire — `IntentSchema` grows, it is not replaced

`schema/src/session.ts`. The four existing fields keep their meaning and their derived-confidence check
(`:40-52`); everything added is optional, so older connectors and older spool lines still parse — the
forward-compat contract `envelope.ts:26-28` states one level up:

```ts
INTENT_SCOPE_KINDS = ["file"]  ·  INTENT_SCOPE_ROLES = ["expected", "non_goal"]   // §8.2
MAX_INTENT_SCOPE_ENTRIES = 30 (per role) · MAX_INTENT_AMEND_REASON_CHARS = 200
MAX_INTENT_CHAIN_VERSIONS = 20
IntentScopeEntrySchema = { kind: enum(INTENT_SCOPE_KINDS), value: string(1..MAX_PIN_PATH_CHARS) }

IntentSchema += {
  expectedSurface?, nonGoals?: IntentScopeEntry[]  // each <= MAX_INTENT_SCOPE_ENTRIES
  seq?:           SeqStamp | null  // 01 §3.1's { epoch, n } PAIR; null = not comparable
  amendsVersion?: number | null    // null on the first intent
  reason?:        string | null    // <= MAX_INTENT_AMEND_REASON_CHARS
}
```

**`seq` is a PAIR, not an integer — corrected, because a bare integer answers confidently where 01
requires a refusal.** 01 §3.1 defines `SeqStampSchema = { epoch: uuid, n: int }` and §3.4 defines
happens-before as *"A and B share a `session_id`, share a **non-null** `seq_epoch`, and `A.seq_n <
B.seq_n`"*; 01 SEQ-5 requires a cross-epoch pair to come back `state = broken`, `reason = epoch_split`,
timing **not computed**. This spec had `seq?: number | null` and compared two bare integers — so every
mechanism 01 lists as restarting the counter (a SessionStart re-fire inside a live session, the uncarried
fallback when a lock is busy, two homes on one `hostSessionKey`) would have produced a confident
`predeclared` or `post_hoc` from two positions in different epochs. 07 §3.6 carried the same scalar shape
and is corrected too. The epoch is **opaque and never rendered** (01 §3.1), so it adds no untrusted slot.

**`summary` IS the desired delta** — not renamed, and no second prose field minted: four readers depend
on that sentence (`briefing/intent.ts:47`, and **measured** `grep -rn -e "->> 'summary'"
packages/server/src` → 3 hits across `services/ghost-overlap.ts` and `services/solved-matches.ts`), and
a second sentence nobody can reconcile with the first is a defect, not a field. What changes is what
`set_intent` *asks for* — the delta, not the steps. **`reason` is REQUIRED when `amendsVersion !==
null`**, a schema `.check` refused at the connector before the hub sees it as `checkIntent` already
refuses (`set-intent.ts:186-189`): an amendment with no reason is the field this spec exists to capture,
left blank. `MAX_PIN_PATH_CHARS = 300` is **reused**, not re-minted, and `MAX_INTENT_SCOPE_ENTRIES = 30`
is `MAX_PIN_FILES` (**measured**, `crosscheck-pins:schema/src/pin.ts:50`): a second number would be a
second argument.

### 3.2 `work_context_intents` — the ledger, append-only

Appended after #50's `team_settings` in `server/src/db/schema.ts`; both indexes mirrored into
`db/bootstrap.sql`, which `test/ddl-sync.test.ts` enforces.

| column | type | note |
|---|---|---|
| `id` | text PK | `iv_` + first 32 hex of `sha256(workContextId \n authorSessionId \n seq \n summary)` — the `hint_deliveries` pattern (`capture/records.ts:66-82`), so a spool replay is a `duplicate`, never a second version |
| `work_context_id` | text NOT NULL FK→`work_contexts` | |
| `amends_version` | int NULL | null on the first intent |
| `author_session_id` | text **NULL** FK→`agent_sessions` | NULL only on backfill (§4) — the `work_context_targets.created_at` precedent: a pre-column row reads null and the surface says *unknown* rather than fabricating one (`schema.ts:218-225`) |
| `version` | int NOT NULL | **hub-assigned** `max(version)+1`; unique `(work_context_id, version)` |
| `seq_epoch` | text **NULL** | 01's epoch; NULL = not causally comparable. **Two positions are comparable only inside one epoch** (01 §3.4) |
| `seq` | int **NULL** | 01's `n` within that epoch; NULL = not causally comparable; CHECK `>= 0`. CHECK: `seq` and `seq_epoch` are both NULL or both NOT NULL |
| `provenance` | enum `PROVENANCES` NOT NULL | what the body claimed — unverifiable (§1.2, §8.1) |
| `summary` | text NOT NULL | CHECK ≤ `MAX_INTENT_SUMMARY_CHARS` |
| `reason` | text NULL | CHECK ≤ `MAX_INTENT_AMEND_REASON_CHARS`; table CHECK makes it NOT NULL whenever `amends_version` is |
| `captured_at` | timestamptz NOT NULL | sender-controlled, so **clamped to hub clock + skew on write** (`commit-evidence.ts:34-42`); display and retention only, it orders nothing |
| `received_at` | timestamptz NULL | hub clock; NULL on backfill |
| `wire` | jsonb NOT NULL | the intent object as received |

Indexes: `work_context_intents_context_version_idx (work_context_id, version DESC)` for the chain read
and the `max(version)` probe; `work_context_intents_session_idx (author_session_id, seq)` for §3.5.
**Append-only; revision means a new row** — the posture `claims` already takes
(`services/hints.ts:68-70`); `services/intent-ledger.ts` exposes no UPDATE and no DELETE path.

### 3.3 `intent_scope` — the checkable half

PK `(intent_id, role, kind, value)`, FK `intent_id`, plus **denormalised `work_context_id`** (the
`pin_files.repo` precedent, #50). Index `intent_scope_kind_value_idx (kind, value)` is deliberately the
shape of `work_context_targets_kind_value_idx` (`schema.ts:233`), the index #50's suspect intersection
already rides, so *"did any intent name this path"* is one index lookup, not a text predicate.

**This is not the dead predicate.** The closed decision killed *"intent covers pin"* — 200 characters of
prose against a name plus paths, where word overlap failed both directions on our own examples. This is
a declared `(kind, value)` set in the vocabulary the capture lane already writes, compared by equality,
and never a gate (§3.6).

### 3.4 Who assigns what

The **connector** assigns `summary`, scope, `reason`, `amendsVersion` — it is the declaration — and
`provenance`, which **the hub cannot verify** (§8.1: stated, not hidden). The **hub** assigns `version`,
`received_at` and the `captured_at` clamp, because two writers exist per work context (`set_intent` and
the derived worker) and a connector-assigned version would let both claim v2. **`seq` comes from 01's
reservation**, under `updateSessionState`'s lock (`state/session-state.ts:460-475`) — the only monotonic
per-session mechanism in the tree (00 §10 Q2).

**`seq` is monotonic, not gapless.** `updateSessionState` returns `false` and writes nothing when the
lock stays busy (`session-state.ts:452-455`), so a reservation can fail and one can be spent on a record
later refused. A gap is not an error, and a failed reservation yields `seq: null`, which §3.5 can only
read as *not comparable* — the fail-closed direction.

### 3.5 `explanationTimingFor` — the one consumer of causal order

`packages/server/src/services/intent-ledger.ts`:

```ts
export const EXPLANATION_TIMINGS = ["predeclared", "post_hoc", "absent"] as const;
export const TIMING_REASONS = [
  "declared_before", "declared_after", "declared_non_goal_edited",
  "no_intent", "derived_excluded", "different_session", "not_comparable",
  "scope_not_named",
] as const;

explanationTimingFor(chain, edit) => { timing, reason, version: number | null }
```

A ladder of early returns; the order is the contract.

1. chain empty → `absent` / `no_intent`
2. drop `provenance !== "declared"`; nothing left → `absent` / `derived_excluded`
3. drop `author_session_id !== edit.sessionId`; nothing left → `absent` / `different_session`
4. drop `seq === null` **or `seq_epoch !== edit.seqEpoch`**, and drop all if `edit.seq === null`;
   nothing left → `absent` / `not_comparable`
5. drop entries whose `intent_scope` lacks `(edit.kind, edit.value)` in **either** role; nothing left →
   `absent` / `scope_not_named`
6. **answer by ROLE, non-goal first** (below), over the **earliest** survivor in each role

**Step 4's epoch term is new** and it is what makes 01 SEQ-5 true from this side: two positions in
different epochs are `not_comparable`, never an answer. Without it a counter restart — a SessionStart
re-fire, a busy-lock fallback, two homes on one key — silently produced a confident timing.

**Step 6 — the roles answer differently, and the first draft answered a violated non-goal
`predeclared`.** Step 5 keeps an entry whose scope names the edited path *"in either role"*, and step 6
then answered `predeclared` / `declared_before` whenever that entry's `seq` preceded the edit. So a
session that declared `non_goal: packages/b.ts` at seq 5 and edited `b.ts` at seq 7 was reported as having
**declared the reason before the change — for a sentence that said the opposite**. That is principle 3
answered backwards on the one input this ledger exists to capture. The corollary was worse: `role` was
written and never read — §3.6 makes `explanationTimingFor` the only consumer of the two tables and INT-7
reddens the build on a second one, so `expected` versus `non_goal` was stored, decided nothing, and had no
test (INT-1's fixture says only *"amendment_v2 naming b.ts"*, with no role). An unread column is the
silent absence AT-10 forbids.

```
E_non_goal = earliest survivor whose scope names the path as non_goal
E_expected = earliest survivor whose scope names it as expected

if E_non_goal and E_non_goal.seq < edit.seq
      -> post_hoc / declared_non_goal_edited   (version = E_non_goal.version)
else if E_expected and E_expected.seq < edit.seq
      -> predeclared / declared_before          (version = E_expected.version)
else  -> post_hoc / declared_after              (earliest survivor's version)
```

**Non-goal wins where both name the path**, because it is the stronger signal: *"a declared non-goal that
was then edited"* is the most post-hoc thing a session can do, and a later `expected` entry naming the
same path is the amendment that widened past it — which is exactly the event AT-4 asks about.
`declared_non_goal_edited` is a new `TIMING_REASONS` member, not a fourth `EXPLANATION_TIMINGS` value: the
dimension keeps its three values (00 §8.1, 01 §8 refusal 4).

**`absent` never renders alone — 01 §3.7's objection, answered without a fourth value.** 01 argued that
falling back to `absent` under unusable order *"asserts no explanation exists, a different and falsifiable
claim"*, and proposed declining to compute the dimension instead. **Resolved in this spec's favour, with
the rule that makes it honest:** the timing and its reason are **one atomic answer, and no surface prints
the value without the reason** — exactly as `attribution: INDETERMINATE` never prints without its `basis`
(04 §3.1) and a `CoverageState` never prints without its `CoverageReason` (03 §3.3). `TIMING_REASONS`
already separates `no_intent` (genuinely absent) from `not_comparable` (cannot be ordered) and
`different_session`, so nothing is lost; what was missing was the rule forbidding the bare word. It is
binding on every renderer of this value, and INT-3 tests it. 01 §3.7 now states the same thing.

`captured_at`, `received_at` and the envelope `ts` appear nowhere in this function, and `TIMING_REASONS`
is an enum, never prose (03 §3.3), so a timing line adds **no untrusted slot** to any surface it lands
on. **Step 3 is Q2's subagent risk made mechanical**: a subagent that sometimes inherits the parent's
`hostSessionKey` and sometimes mints its own makes `seq` comparison *silently* wrong (00 §10 Q2);
refusing cross-session comparison makes that an `absent` / `different_session` a reader can see.

### 3.6 The two corrections, as invariants

**The ledger RECORDS intent evolution, it does not AUTHORISE it.** An agent widening its own intent
authorises itself, so the value of this table is the clock, not the row. No predicate anywhere reads
*"the current intent covers X, therefore X is fine"*: `explanationTimingFor` is the **only** consumer of
the two tables, an amendment can neither clear a `PROTECTED_CONFLICT` nor satisfy a human waiver (AT-6)
nor change an emitted verdict, and INT-7 fails the build on a second consumer. **A DERIVED non-goal is a
suggestion to a human, never evidence against the same agent** — step 2 drops derived entries first, so
such an entry may be *rendered* as a suggestion but may never enter a timing answer about the session
that produced it. In 1.0 the derived worker emits no scope entries (§8.4), so this rule is in place
before its first writer exists, and INT-6 fails on a fixture today.

## 4. Migration

**Two tables, two indexes, no existing column redefined.** `work_contexts.intent` keeps its meaning and
its top-level `summary` key — four readers depend on that shape (§3.1) and changing it would silently
empty `solved-matches` and `ghost-overlap` — and becomes a **denormalised copy of the newest ledger
row's `wire`**: the ledger is authoritative, and INT-4 pins that the two cannot disagree.

**Backfill, one row per non-null `work_contexts.intent`:** `version = 1`,
`summary`/`provenance`/`captured_at` from the jsonb, `wire` = the jsonb, `author_session_id = NULL`,
`seq = NULL`, `received_at = NULL`, no `intent_scope` rows. `author_session_id` is null rather than
`work_contexts.session_id` because the declaring session was never stored — updates never re-home a
context (`record-handlers.ts:180`) — and guessing puts a name on a row nobody recorded; such rows are
`seq: null` for ever and answer `absent` / `not_comparable`, which is correct. `ingestWorkContext` grows
one branch inside its **existing** transaction (`record-handlers.ts:207-243`): when `workContextChanges`
reports an intent change, append the ledger row and its scope rows before the head update; when
`mergeIntent` keeps the stored intent, **nothing is appended** (§8.4).

## 5. Where it renders, and who consumes it

**The head renders exactly as today:** `briefing/intent.ts` stays the one spelling of an intent on every
surface (`:1-21`), unchanged, still the sanitizer `mutation-check.ts` re-breaks.

Three surfaces gain something. `mcp/render.ts`'s diagnosis (`pulled`) gains the chain — `intent_v1 …
amendment_v3`, each with its reason, newest-first, at most `INTENT_CHAIN_MAX_SHOWN`. `crosscheck
suspect` (#50, `pulled`) gains one timing clause on its existing intent line (§10.2). `cli/doctor.ts`
gains the `seq: null` ratio with its denominator. Every `unsolicited` surface — briefing, hints,
tripwire, statusline — gains **nothing** (§8.6).

**Registry and corpus obligations.** The chain adds two untrusted slots — the amendment `reason` and an
`intent_scope` `value`, both agent-written — in a `pulled` MCP answer, so both are corpus obligations,
not notes. `MCP_DIAGNOSIS_SLOTS` (`test/fixtures/injection-corpus.ts:582-601`) gains `intentAmendReason`
and `intentScopeValue`. **Measured today: 18 slots.** The implementation plants the `VERIFY:` directive at
the list **and writes no literal post-change total** — *corrected: the first draft pinned `PRINTS: 20`
while 08 §5, appending `verificationRef` to the same array, pinned `PRINTS: 19`. Whichever landed second
would have reddened the other, and if both land the answer is 21, a number neither spec contained.* That
is exactly the trap 00 §9.2 makes binding for `ci.yml` — *"must not write a literal post-merge total …
because it cannot know how many other specs land first"* — on a second shared directive the map had not
named. It now names it, generalised: **no spec writes a literal total into any `PRINTS:` whose command
counts a list more than one spec appends to.** Write the directive, name the fixture file and the other
appender under *Collisions* (§9), and let CI print the number.
The renderer is a new module `connector-core/src/mcp/render-intent-chain.ts`, registered in
`connector-core/src/render-surfaces.ts` as `kind: "corpus"`, `name: "mcp-intent-chain"`, `delivery:
"pulled"`, `framing: "framed"`, planting the payload in the `reason` slot. `RENDER_LAYER_MODULES` /
`RENDER_BARREL_MODULES` (`render-surfaces.ts:138-154`) are unchanged — a surface, not a primitive — and
there is no new CLI surface: the suspect clause renders inside #50's existing `cli-suspect` entry.

**Doctor, with a ran-denominator.** `checkIntentLedger` prints `<null-seq rows> of <rows> intent
versions carry no sequence` — **both halves, always**, because `state/git-lane-cost.ts:12-21` is the
lesson written out: *"a lane that never runs looks exactly like a quiet one."* A hub whose `seq` is null
on every row cannot answer AT-4 at all, and without the denominator that reads as a quiet hub. Ladder:
*not measured* PASS, high ratio WARN (§10.5), never FAIL.

## 6. Budget

**Nothing is added to any hook, so no hub round trip is added to one and the 800 ms pair is untouched**
— `connector-core/src/constants.ts:56-57`, `PRINTS: 800 800`. That matters because #50 already spent
part of Stop's `spareMs` on the git lane (00 §9.1), and `spareMs` is the sole accessor
(`config/hook-budget.ts:31-33`). Hub cost per intent change is one `max(version)` probe on the context
index, one insert and at most `2 × MAX_INTENT_SCOPE_ENTRIES` scope inserts, all inside the transaction
`ingestWorkContext` already opens; **hub job cost is none** — no background pass, no retention job
(§10.1 bounds the chain instead).

- **`set_intent` is not on a hook path** — an MCP tool, `delivery: "pulled"`, `MCP_TIMEOUT_MS = 10_000`.
  It gains one `updateSessionState` round for 01's `seq` reservation and no new HTTP call: the intent
  still travels on the existing `work_context` UPDATE record (`set-intent.ts:12-13`). **Measured by
  INT-11, not asserted here**: the reservation's uncontended p95 is **0.5 ms** and the tool's own p95
  **44 ms** against a 2 000 ms bound, and the round-trip count is **2** — the record POST and the ghost
  GET, the same two as before. *Corrected: this line read "worst case ~100 ms of lock retries,
  `session-state.ts:454-456`". That number was true when the state lock retried 5 times; #53 raised
  `SESSION_STATE_LOCK_RETRIES` to 20 to stop losing positions under contention, moving the contended
  worst case to **400 ms** without moving this sentence — a quantifier rotting against a constant, the
  exact class `verify-claims.ts` exists to kill. INT-11 derives the ceiling from the two constants, so
  the next change to either is carried by arithmetic rather than by memory.*
- **The derived-intent worker is detached** and already takes the state lock
  (`derive/intent/worker.ts:47`, `:95`, `:138`); its reservation moves **before** the spool append
  (`:222-228`), keeping the Stop-hook ordering contract (`hooks/stop.ts:9-15`) — book first, lose a slot
  on a crash, never double-spend.

**No millisecond figure appears above** because I benchmarked nothing; **INT-11** requires one before
merge, on `connector-claude/test/capture-latency.test.ts` and the MCP harness pattern of
`connector-core/test/latency.test.ts`. *Corrected: this line pointed at **INT-5**, which is the
derived-intent test — "a derived intent still never overwrites a declared one, and appends nothing" — and
measures nothing at all. No test in the INT-1…INT-9 list did, so this spec's zero-cost claim and its
`set_intent` lock acquisition had **no gate**, while the six sibling specs each discharge the same
obligation with a numbered test (CCB-8, COV-8, VER-8, PIL-9, EV-8). INT-11 is that test. 01 §7 had the
same hole and now has SEQ-9.*

## 7. Acceptance tests

Each can fail; each names the one-line edit that must turn its guard red in
`connector-core/scripts/mutation-check.ts` (00 §7.2). **Where the numbers live:** `verify-claims.ts`
walks `ROOTS = ["packages", ".github"]` (`:109`) — **`docs/` is not scanned** — so every `VERIFY:` asked
for here is a directive the implementation plants in `packages/`.

**INT-1 — declared-before is distinguishable from declared-after (AT-4).** One session, an edit to
`packages/b.ts` at `seq 7`, and `amendment_v2` naming `b.ts` at `seq 5` in one fixture and `seq 9` in
the other: first answers `predeclared`, second `post_hoc`. *Fails if* both agree.

**INT-2 — the answer never comes from a clock (AT-4's "fails if").** A fixture where `captured_at` and
`seq` **disagree**: the amendment's wall clock earlier than the edit's, its `seq` later (a spool flushed
by a successor session, `records.ts:67-69`). The answer must be `post_hoc`. *Mutation:* swap step 6's
`seq` comparison for `captured_at`.

**INT-3 — an unorderable pair is never `predeclared`, and `absent` never renders alone.** Three cases:
(a) `seq: null` against any edit answers `absent` / `not_comparable`; (b) an entry from session A against
an edit in session B answers `absent` / `different_session`, whatever the numbers; (c) **two positions in
different `seq_epoch`s answer `absent` / `not_comparable`, never a comparison** — 01 SEQ-5's epoch-split
refusal from this side, which a bare-integer `seq` could not express. Plus the rendering rule §3.5 makes
binding: every surface printing an `EXPLANATION_TIMINGS` value prints its `TIMING_REASONS` value in the
same clause. *Fails if* (c) answers, or if any surface can print the bare word `absent`. *Three
mutations:* null `seq` → `0`; delete step 3; drop the `seq_epoch !== edit.seqEpoch` term from step 4.

**INT-4 — the head cannot disagree with the ledger.** After N amendments `work_contexts.intent` equals
version N's `wire` and `max(version) = N`; a replayed spool line returns `duplicate` and no new version.
*Mutation:* write the head without the row.

**INT-5 — a derived intent still never overwrites a declared one, and appends nothing.** The existing
rule (`record-handlers.ts:127-133`) plus the new one: no ledger row for the refused record. *Mutation:*
drop the `provenance` term from `mergeIntent`.

**INT-6 — a derived non-goal is never evidence against its own session.** A chain whose only entry
naming the edited path is `provenance: "derived"` answers `absent` / `derived_excluded`, and that row
still renders as a suggestion. *Mutation:* delete step 2.

**INT-7 — the ledger authorises nothing.** A meta-test walks every `src` module of every workspace
package — the discovery-from-filesystem shape of `test/render-surface-registry.test.ts:25-28` — and
fails on any module outside `services/intent-ledger.ts` importing `workContextIntents` or `intentScope`.
*Fails if* a verdict, fence or hint path reads the chain.

**INT-8 — an unscoped intent still lands (back-compat).** A v0 `set_intent` call carrying only `summary`
is accepted, renders `intent: «…»` exactly as today, and creates version 1 with both scope lists empty.
*Fails if* any new field is required on the wire.

**INT-9 — an uncheckable scope entry is refused at the wire.** `kind: "symbol"` fails
`IntentScopeEntrySchema`. *Mutation:* widen `INTENT_SCOPE_KINDS` to `TARGET_KINDS`.

**INT-10 — a declared non-goal that was then edited is `post_hoc`, and `role` is read. (AT-4.)** One
session declares `non_goal: packages/b.ts` at seq 5 and edits `b.ts` at seq 7 → `post_hoc` /
`declared_non_goal_edited`, **not** `predeclared`. A second fixture declares the same path as `expected`
at seq 5 → `predeclared` / `declared_before`. A third names it in both roles → the non-goal answer wins.
*Fails if* the two roles produce the same answer — which is what the first draft's step 6 did, reporting a
violated non-goal as a reason declared before the change, and leaving `INTENT_SCOPE_ROLES` with no reader
in the whole of 1.0. *Mutation:* collapse step 6's two branches into the `expected` one.

**INT-11 — the budget is measured, not asserted.** `set_intent` wall clock with the `seq` reservation on,
against the pre-change baseline with a named allowance, on `connector-core/test/latency.test.ts`'s
harness, plus SessionStart / PostToolUse p95 on `connector-claude/test/capture-latency.test.ts` (nothing
here is on a hook path, so the second half proves the claim rather than measuring a change). *Fails if* no
measurement exists. **§6 points here**, not at INT-5, which measures nothing.

**Nine entries reach `MUTATIONS`** — INT-2, INT-3 ×3, INT-4, INT-5, INT-6, INT-9, INT-10 — so this spec
bumps `.github/workflows/ci.yml` and adds its own lines in all three listings (§9). *Corrected: this
sentence read "Six entries … (INT-2, INT-3 ×2, INT-4, INT-5, INT-6, INT-9)", which is **seven** items
counted as six — the exact defect class `verify-claims.ts` exists to kill (*"what rotted were quantifiers
and pointers: 'exactly one', 'the ONLY', '2 of 8'"*, 00 §7.1), in a spec that cites that discipline, on a
number that feeds the `ci.yml` bump. The count is now derived from the list and the list is the
authority.*

## 8. Refusals

1. **No human intent writer in 1.0, and therefore no human intent.** On the two evidence axes (00 §8.3)
   **every 1.0 intent is `agent_derived` on the WHO axis**, including the one the schema calls
   `provenance: "declared"` at confidence 1: the tool sets that confidence itself
   (`set-intent.ts:53-55`) and the bearer key reaching the route sits in plaintext
   (`crosscheck-pins:routes/pins.ts:27-33`). A human rung is buildable — #50's `presence:
   "controlling_terminal"` gate (`crosscheck-pins:schema/src/pin.ts:75-89`) — and 1.0 does not build it,
   so `CAPTURE_MODES.human` is not a value any intent may carry, doctor says so rather than leaving a
   silent absence (AT-10), and an intent can never be a waiver (AT-6).
2. **No `symbol`, `component` or `error_fingerprint` scope entries.** **Measured:** connectors emit
   exactly two target kinds, `"file"` (`flows/capture-targets.ts:102`) and `"error_fingerprint"`
   (`:143`); nothing writes `symbol` or `component`, so a declared surface nothing can ever match would
   be a silent absence. `error_fingerprint` is excluded separately: an intent naming a failure it
   expects is a different feature.
3. **No prose non-goals.** *"Do not change the public API"* is not checkable, and inferring structure
   from it is heavy intent inference from agent prose — cut, Tier 3.
4. **The derived worker emits no scope entries** — it produces one sentence
   (`derive/intent/worker.ts:136-157`) and 1.0 does not teach it paths — and **a refused merge appends
   nothing**: a derived intent arriving behind a declared one is not intent evolution, and recording it
   would put a model sentence nobody accepted within reach of every renderer, against non-negotiable #6.
5. **No new outbox kind** (00 §8.4b: a 1.0 event kind is not automatically an SSE kind, and
   `work_context_updated` already names `"intent"` in `changed` with no text crossing,
   `record-handlers.ts:186-194`). `intent.declared` and `intent.amended` (00 §8.4) are **durably this
   table** — 01 needs no second store. **01 §3.2 and §3.5 now agree**, and the agreement fixed a real
   defect on its side: its first draft projected *both* kinds from a `work_context` record into
   `session_events`, whose id hashed `(session_id, ref_kind, ref_id)` — so the declaration and every
   amendment in one session shared a referent, and every amendment after the first was answered
   `duplicate` and received no position at all. The amendment is precisely the event AT-4 asks about.
   **This table is the event**: one row per version, with `version`, `seq` and `seq_epoch` on the row, and
   an id (`iv_ + sha256(workContextId \n authorSessionId \n seq \n summary)`) that is unique per version
   by construction. 01 lands before this spec (00 §9.7), so until this table exists the two kinds are **not
   projected at all** rather than projected wrongly, and doctor says so.
6. **The chain never reaches an unsolicited surface**, and **superseded intents never enter search.**
   Briefing, hints, tripwire and statusline show the head only (`MAX_BRIEFING_CHARS = 2200` is already
   contested, 00 §10 Q8), and `normalized_doc` keeps indexing the head alone
   (`services/normalized-doc.ts:109-113`): a plan the session abandoned must not surface as related
   work.
7. **No confidence arithmetic across a chain** (versions do not average, accumulate or promote — the two
   axes are not a ladder, 00 §8.3) and **no per-developer intent surface**: sessions and intents, never
   people (`crosscheck-pins:services/suspect.ts:21-25`).
8. **Not refused, but not mine:** `explanation_timing` reaching a verdict, the `PROTECTED_CONFLICT`
   channel (00 §10 Q6), the fence waiver's table (00 §10 Q7) — I supply the function, the verdict and
   fence specs call it.

## 9. Collisions and sequencing

**Write after #50 and #49 both merge** (00 §9.4).

**One contradiction with the shared map, declared rather than quiet.** 00 §8.3 maps `claims.provenance`
(`declared | derived`) onto the WHO axis. **For intents that mapping is wrong**: `provenance:
"declared"` means *an agent called an MCP tool*, not that a human declared anything (§8.1). Claims are
untouched; the correction is scoped to intents, and it is why §8.1 exists.

**PR #50.** `schema/src/session.ts` (+14/−1, `TargetSchema.source`) — same file, different region;
append below, never renumber. `server/src/db/schema.ts` (+143/−1) — append both tables after
`team_settings`, mirror both indexes into `db/bootstrap.sql` (+92), which `test/ddl-sync.test.ts` (+27)
enforces. `services/record-handlers.ts` (+19) — #50 upgrades the target `source` label on a PK
collision, I add a branch to `ingestWorkContext`: different functions, one file.
`crosscheck-pins:services/suspect.ts` — I add a clause to the rendered intent line and touch **neither**
the outcome enum (`ranked | no_separation | no_touch | withheld`) **nor** the falsifier enum; closed
ground stays closed. `connector-core/src/constants.ts` (+62) — `INTENT_CHAIN_MAX_SHOWN` appends below
#50's `PIN_SWEEP_*` block; `cli/src/render-surfaces.ts` (+163, 3 → 6) gains no new surface; and on
`scripts/mutation-check.ts` (+151 on #50, +101 on #49) I am **editor 5** in the build order (00 §9.7),
conflicting at the array tail. *Corrected from "the third editor" — 03 §9 and 05 §9.6 had each claimed
that same seat, which was the evidence that none of the three had sequenced against the others on this
file. **All eight specs** append to that tail.*

**`.github/workflows/ci.yml`** (00 §9.2) — both PRs already rewrite the same `PRINTS:` line at
`ci.yml:119-120`, and they collide there **with each other** before any spec starts (00 §9.2 carries the
instruction). I add **nine** `MUTATIONS` entries on top (§7), so this spec bumps that count and touches
**all three listings, not two**: the count (`:119`), the per-file block (`:127`) and the **per-basename**
block (`:246` on `crosscheck-pins`, `:239` on main), which the first draft did not name. New per-file
lines for `services/intent-ledger.ts` and `mcp/render-intent-chain.ts` plus a bump to the existing
`services/record-handlers.ts` line. **In the per-basename listing two of my three are BUMPS, not
additions** — that block keys on the basename, and `record-handlers.ts` already stands at 1
(`crosscheck-pins:.github/workflows/ci.yml:307`) while `render.ts` already stands at 26 (`:312`), which is
the line `mcp/render-intent-chain.ts`… does *not* touch, since its basename is `render-intent-chain.ts`
and that one is new. An earlier draft of this line listed `record-handlers.ts` as an **added** line; it is
a bump. **No post-merge total is written here** — I cannot know how many specs land first, so write the
directive and let CI print the number.

**Spec 08 — one shared fixture, and we were about to redden each other.** We both append to
`MCP_DIAGNOSIS_SLOTS` in `connector-core/test/fixtures/injection-corpus.ts` (measured today: 18 entries):
I add `intentAmendReason` and `intentScopeValue`, 08 adds `verificationRef`. Each of us had written its own
absolute post-change total into that list's `VERIFY:` / `PRINTS:` directive — `20` here, `19` there — so
whichever landed second would have turned the other's directive red, and the correct number if both land
is 21, which neither spec contained. Neither §9 mentioned the other on this file. **Both now write the
directive and no total** (§5 here, 08 §5 there), and 00 §9.2 generalises the rule beyond `ci.yml`.
**Sequence: either order**, which is the point of not writing a total.

**PR #49** has no structural collision: every new bound lives in `packages/schema/src`, not
`server/src/constants.ts`.

**Other 1.0 specs.** **01 (`seq`) is a hard dependency I do not define, and it lands first** (00 §9.7):
reservable from an MCP tool *and* a detached worker (`derive/intent/worker.ts` already takes the lock),
`null` when the lock fails, `null` propagating to the row — §3.5 handles that. **Two shapes had to be made
to match and both edits are mine:** `seq` is 01's `{ epoch, n }` **pair**, so this ledger carries
`seq_epoch` beside `seq` and step 4 refuses a cross-epoch comparison (§3.1, §3.2, §3.5); and
`intent.declared` / `intent.amended` are **rows in this table, not in `session_events`** — 01 §3.2 and
§3.5 now say so, which also fixes the id collision that would have discarded every amendment after the
first. **04 consumes `explanationTimingFor` and cites INT-7** — *"the ledger authorises nothing"* — as the
ledger-side half of principle 4; it had cited INT-8 (the back-compat test) in four places and is
corrected, and its VER-4 is now a meta-test in INT-7's shape, because its own version was vacuously
green. **03 (coverage)** has no dependency either way and one thing to keep apart: an `absent` /
`not_comparable` timing is **not** a coverage gap and must never be folded into `agent_event` — coverage
asks whether we were watching, timing asks whether two observed events can be ordered, and folding them
is the `coverage = 87%` lie in a third shape. **05 (CI)** does not overlap: CI has no producer session
(05 §3.7, 00 §8.4a), so a CI reporter can never author an intent. **Claim binding (Q11)** shares the
append-only posture — its supersession shape must not become a second `version`. **Verdict / fence**
consume `explanationTimingFor` and gate on 03's `isJudgeable`, which I never call.

## 10. Decisions for Nick

1. **What happens at the 20th amendment?** *Default: the hub accepts the record, appends nothing, leaves
   the head where it is and returns `ignored`* — already a first-class outcome (`record-handlers.ts:37`)
   — *and `set_intent` prints the cap.* It must not be `rejected`: a rejected record is a destroyed one,
   since the spool advances its cursor on any 2xx (`records.ts:71-79`). Cost: a session amending 21
   times loses the 21st sentence, loudly.
2. **Does `crosscheck suspect` carry the timing clause?** *Default: yes, one clause on the existing
   intent line* — the surface where the missing distinction hurts most (§1.1). Cost: it edits #50's file
   after #50 merges.
3. **Backfill existing intents as version 1, or leave them outside the ledger?** *Default: backfill,
   `author_session_id` and `seq` NULL*, keeping one code path and the head/ledger invariant. Cost: every
   pre-1.0 intent is permanently `not_comparable` — which is the truth.
4. **Are non-goals paths-only?** *Default: yes.* Cost: *"do not change the public API"* cannot be
   declared in 1.0 at all; the checkable field stays checkable, or becomes a second prose sentence
   nobody can verify.

4a. **Does a violated non-goal get its own timing answer, or does `non_goal` leave 1.0?** *Default: its
   own answer* — `post_hoc` / `declared_non_goal_edited`, with the non-goal winning where both roles name
   the path (§3.5 step 6). Before this, step 5 kept non-goal entries and step 6 reported them
   `predeclared`, so a session that declared *"do not touch `b.ts`"* and then touched it was recorded as
   having declared its reason **before** the change — principle 3 answered backwards — and `role` was a
   column nothing read. The alternative is honest too and cheaper: **drop `non_goal` from
   `INTENT_SCOPE_ROLES` in 1.0** and say so, since an unread column is the silent absence AT-10 forbids.
   Cost of the default: one more `TIMING_REASONS` value and one more branch. Cost of the alternative: a
   session cannot declare what it is deliberately not doing, which is half of what structured intent was
   for.
5. **Does doctor WARN on a high null-`seq` ratio, or only report it?** *Default: WARN above half,
   denominator printed either way.* Cost: a WARN on every install until 01 lands; the alternative is a
   hub that cannot answer AT-4 and says nothing.
