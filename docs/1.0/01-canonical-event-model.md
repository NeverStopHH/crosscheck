# 01 — Canonical event model and per-session causal order

**Tier 1** (`00-cut-line.md`: *"A per-session monotonic event sequence. Happens-before, never wall clock."*). **Owns AT-4**
— whose "fails if" line is about wall clock versus a monotonic sequence, which is this spec's mechanism and nobody else's.
**06 supports AT-4 without owning it** (it supplies what is compared; this spec supplies whether two things may be compared
at all), the way 06 supports AT-3 and AT-6. 06's header said *"owns the intent half of AT-4"*; one AT has one owner, and
`docs/1.0/README.md` is the table both defer to.
Answers **00 §10 Q2**, both open halves, and corrects one measured claim in 00 §4.4a. Against `main@e9aab82`, **assuming #50 and
#49 both merged** (00 §9.4); `crosscheck-pins` cited by symbol, not by line.

---

## 1. Problem

Intent exists. Causal order does not. `work_contexts.intent` has a wire shape already (`schema/src/session.ts`, `IntentSchema`),
and `set_intent` posts a `work_context` UPDATE that **replaces** it (`connector-core/src/mcp/tools/set-intent.ts:12-13`), so the
hub can answer *"what does this session say it is doing"* and cannot answer *"was that sentence written before or after the edit
that exceeded the previous one"* — the amendment overwrites its predecessor and leaves no ordered trace. Nothing on main carries
a per-session sequence, and the four candidates are each disqualified:

| candidate | why it is not a session sequence | file:line |
|---|---|---|
| envelope `ts` | wall clock, sender-controlled; AT-4's "fails if" names it. The tree already treats a sender-controlled timestamp as a ratchet and clamps it (`services/commit-evidence.ts:34-42`) | `schema/src/envelope.ts:33` |
| spool line offset | **a session's spool file has more than one writer** — recovery appends to files it does not own, `rescueTail` puts rescued bytes on another session's path, `appendThroughHandle` recreates a file reap unlinked | `connector-core/src/spool/append.ts:7-13` |
| `events.id` bigserial | hub **arrival** order and the SSE replay cursor; a spool flushed after an offline day arrives after events that happened later | `server/src/db/schema.ts:335-340` |
| `work_context_targets.created_at` | nullable, and deliberately never bumped on a duplicate touch | `server/src/db/schema.ts:218-225` |

**One measured correction to 00 §4.4a.** The map says the detached summarizer worker "does not update session state", citing
`worker.ts`'s imports. True of `connector-claude/src/summarizer/worker.ts`; false of the path it calls. `worker.ts:24` imports
`deriveFromSlice`, and `connector-core/src/derive/summarizer/derive.ts` imports `updateSessionState` (`:41`) and calls it at
`:92`, `:154`, `:160`, `:168`, `:202`. **The worker holds the state lock already** — so Q2's first open half has a real answer
(§3.6), not a `seq: null` fallback.

---

## 2. Principles served

- **Principle 3 — "A reason written after a change is not evidence the reason existed before it."** This spec is that
  principle's mechanism and nothing else: `explanation_timing` (00 §8.1) is computed over `seq`, **never** over a clock.
- **Principle 1 — "Only judge when you know you were watching,"** applied to order: an unusable sequence yields *not
  comparable*, never a guess. **It propagates to `explanation_timing` and stops there** — not to `attribution`, which reads no
  `seq` at all (§3.7, resolving 04 §9's objection in 04's favour): a blind spot in *instrumentation* must not become a verdict
  about a person's work, which is what silencing attribution for every pre-`seq` connector would have been.
- **Non-negotiable #4.** Every failure mode is a counted number with a `doctor` line: unallocated seq, broken epoch, pre-seq
  connector, platform rung. **Non-negotiable #6.** An event row carries refs and enums only — no prompt, no body, no path text
  that is not already a row.

---

## 3. Target model

### 3.1 One new wire field, not nine new wire kinds

00 §8.4 proposes nine dotted kinds "that travel the existing envelope and spool" — **seven of which this table carries; the two
intent kinds are 06's ledger rows (§3.5)**. The refinement is the whole design: **the nine
dotted names are the canonical vocabulary and they are a PROJECTION of records that already travel — not nine additional
envelope kinds**, because nine parallel kinds would double every record on the wire and build the second pipeline 00 §4 warns
against (divergence declared in §9). The wire gains exactly one optional field:

```ts
// packages/schema/src/envelope.ts — appended to EnvelopeSchema
seq: SeqStampSchema.optional()
export const SEQ_EPOCH_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SeqStampSchema = z.object({
  epoch: z.string().regex(SEQ_EPOCH_PATTERN),   // opaque, never rendered
  n: z.number().int().min(0),
});
```

`epoch` is regex-pinned to a UUID **because a connector is untrusted**: an opaque id cannot carry prose into a surface, so this
field adds no untrusted slot anywhere (§5). An envelope with no `seq` stays legal forever — the forward-compatibility contract
at `envelope.ts:26-28`, and how a pre-`seq` connector keeps working.

### 3.2 The projection — nine names, all from records that exist; seven of them rows here

| canonical name | projected from | seq source |
|---|---|---|
| `session.started` | `session` register via `POST /api/sessions` | `n = 0`, minted at state-file create |
| `intent.declared` | **06's `work_context_intents` row, version 1** — not a `session_events` row (§3.5) | the emitting call |
| `intent.amended` | **06's `work_context_intents` row, version > 1** — not a `session_events` row (§3.5) | the emitting call |
| `tool.failed` | `target`, `kind = error_fingerprint` | the emitting hook |
| `file.modified` | `target`, `kind = file`, `source` from #50 | the emitting hook (see `seq_kind`) |
| `claim.created` | `claim` | hook, MCP tool or worker |
| `claim.invalidated` | `claim_edge` of the invalidating kind (`schema/src/enums.ts:20`) | the emitting call |
| `commit.observed` | `commit_evidence` | SessionStart's collection |
| `session.ended` | `session` end; `reason: reported \| reaped` (`agent_sessions.reaped_at`) | last allocated `n`; **none on a reap** |

**A reap has no `seq`**, where 00 §8.4 wrote "seq = last": a reap is the hub's inference from silence — revocable
(`schema.ts:138-145`, `records.ts:71-79`), over-firing on read-and-plan sessions (`records.ts:72-74`) — and the hub cannot
invent a position in a sequence it did not emit.

**`seq_kind`, derived on the hub, never sent.** `file.modified` from the tool lane is *emitted* at the edit; from #50's git lane
it is *observed* at Stop, mtime-filtered (`crosscheck-pins:connector-core/src/flows/capture-git-touches.ts`, header "WHY MTIME
AND NOT THE RAW DIFF"). Mapped from `work_context_targets.source` (#50, `enums.ts` `TARGET_SOURCES`):
`tool_edit → emitted · git_diff → observed · both → emitted`. An `observed` event is an **upper bound only**: it proves the edit happened no later than
that Stop, never that it happened after the previous event, so asking "did the amendment precede a `git_diff`-only edit" is
refused (§8).

### 3.3 The counter — `SessionState`, the only mechanism that works

00 §10 Q2 narrowed this to one candidate and the narrowing holds. `updateSessionState`
(`connector-core/src/state/session-state.ts:460`) is a lock-protected read-modify-write keyed by `hostSessionKey`, fail-open on
a missing, unparseable or busy-locked file, worst case ~100 ms of retries (header, `:452-458`). Two new fields shaped exactly
like #50's three — `.default()` keeps every older state file parsing, #50's own forward-compat contract — plus one allocator,
since `updateSessionState` returns `boolean` and an allocator must hand the number back:

```ts
// state/session-state.ts, appended to SessionStateObjectSchema
seqEpoch: z.string().min(1).nullable().default(null),
eventSeq: z.number().int().min(0).default(0),   // highest n ALLOCATED
export interface SeqRange { readonly epoch: string; readonly from: number; readonly count: number }
export const allocateSeq = (home, hostSessionKey, count): Promise<SeqRange | null>
```

`withLock(sessionStateLockPath(...))` → read → `eventSeq += count` → write → return the range. **Monotonicity is a property of
the lock, not of the caller.** Worst case is the spool lock's own: `SPOOL_LOCK_RETRIES = 5` × `SPOOL_LOCK_RETRY_DELAY_MS = 20` =
100 ms (`constants.ts:383-384`). A `null` becomes `seq: null` on the envelope — **not comparable**, first-class, counted.

### 3.4 The epoch — why a pair, and what it buys

`seqEpoch` is minted by `crypto.randomUUID()` **at every state-file CREATE** and carried unchanged across every re-fire. Three
measured mechanisms would otherwise restart the counter: SessionStart re-fires inside a live session, where compact, resume and
clear re-create the state file under the same `hostSessionKey` (`session-state.ts:478-482`); the uncarried fallback, where a
busy lock makes `publishSessionState` write plain state with no carry at all (`:542-544`, *"the counters lose rather than the
file"*); and two homes on one key, where a cloud or background agent sharing a host session id across machines cannot share a
`~/.crosscheck` lock. **So `eventSeq` and `seqEpoch` both join `withCarriedCapture`'s carried list** (`:494`), beside
`editToolFires` and `targetsCapturedCount`. Factual note: #50 added three counters (`gitTouchCount`, `gitLaneSkipped`,
`gitLaneRan`) and did **not** add them to that list (`crosscheck-pins:state/session-state.ts`, `withCarriedCapture` body) — an
easy omission, which is why §7 anchors a mutation on it.

**Happens-before, complete:** `A → B` iff A and B share a `session_id`, share a **non-null** `seq_epoch`,
and `A.seq_n < B.seq_n`. Anything else is **not comparable**. Gaps in `n` are legal and never evidence of loss — an allocation whose emitter
then crashed leaves a hole by design; loss is visible in the spool `.drops` ledger (`spool/append.ts:23-26`), not here.

### 3.5 The hub — one append-only, content-free table

`work_contexts.intent` is overwritten in place, so an amendment has no row to carry a `seq`. That is what makes a table
necessary rather than three new columns.

```sql
CREATE TABLE session_events (
  id          text PRIMARY KEY,       -- se_ + 32 hex, deterministic
  session_id  text NOT NULL REFERENCES agent_sessions(id),
  seq_epoch   text,                   -- NULL = not comparable
  seq_n       integer,                -- NULL = not comparable
  kind        text NOT NULL,          -- SEVEN dotted names (the two intent kinds are 06's)
  seq_kind    text NOT NULL,          -- emitted | observed
  ref_kind    text NOT NULL,          -- claim | claim_edge | session | target_digest
  ref_id      text NOT NULL,
  observed_at timestamptz NOT NULL    -- hub clock; retention and display ONLY
);
CREATE UNIQUE INDEX session_events_position_idx ON session_events (session_id, seq_epoch, seq_n)
  WHERE seq_epoch IS NOT NULL;
CREATE INDEX session_events_session_kind_idx ON session_events (session_id, kind);
```

Mirrored in `server/src/db/bootstrap.sql`, enforced by `server/test/ddl-sync.test.ts`. **No body, no prose, no path**: `ref_id`
points at the row that already holds the content, exactly as `hint_deliveries` carries refs and never rendered text
(`connector-core/src/capture/records.ts:85`). Written by the existing handlers in `services/record-handlers.ts`, **in the
same transaction as the row it projects** — one pipeline, not two.

**`ref_kind` is four values, not six, and the two that were dropped were undeliverable.** A `ref_id` is `text NOT NULL`, so it
can only name a row with a **single-column identity**. Two of the six kinds the first draft listed do not have one, and pursuing
them would have broken §5's own claim that no author-written string exists in an event row:

- **`target` — REPLACED by `target_digest`.** `work_context_targets` has PK `(work_context_id, kind, value)` and no id column
  (00 §1.6), and its only identity *contains the file path*, which is author-written. So the referent is
  `ref_id = sha256(work_context_id \n kind \n value)` — content-free by construction, joinable by recomputing the same hash,
  and carrying nothing a renderer could print. `file.modified` and `tool.failed` both use it.
- **`commit_evidence` — REMOVED.** Its PK is `(repo, author_email)` and *"`author_email` never leaves the hub"* (00 §1.9). A
  hash of it would be a content-derived pseudonymous identifier of a person, which non-negotiable #6 forbids. `commit.observed`
  therefore refs the **session whose SessionStart ran the collection** (`ref_kind = "session"`); the aggregate itself stays in
  `commit_evidence` keyed by repo, which a consumer joins by repo. The event records *that a collection happened, here in the
  order* — which is all a position can honestly assert about an aggregate.
- **`work_context` — REMOVED with the two intent kinds** (below).

**The deterministic id — corrected, because the first shape collapsed distinct events into one row.**

```
id = "se_" + sha256(session_id \n kind \n seq_epoch \n seq_n \n ref_kind \n ref_id).slice(0,32)
```

The first draft hashed `(session_id, ref_kind, ref_id)` only — the `hintDeliveryId` pattern (`capture/records.ts:69-82`) for its
stated reason, that a spool replay re-sends the same primary key and the hub answers `duplicate` instead of a second row. **On
this table that pattern silently deletes events**, because three kinds share one referent: `session.started`, `commit.observed`
and `session.ended` all ref the session, so the second and third would have been answered `duplicate` and received no position
at all. `kind` and the allocated position are therefore both inside the hash. A replay is still a `duplicate`, because the
connector stamps `seq` on the envelope once and re-sends the same value.

**What that costs when there is no position, named rather than hidden.** With `seq_n` null the hash carries the literal
`"null"`, so two genuinely distinct unsequenced events of the same kind on the same referent collapse to one row and the second
is answered `duplicate`. It is counted under `allocation_failed` and printed. The cost is bounded and it is the right one:
without a position, AT-4 could not have used the distinction anyway.

**The two intent kinds are not in this table at all.** `intent.declared` and `intent.amended` project into 06's
`work_context_intents`, whose row id is `iv_ + sha256(workContextId \n authorSessionId \n seq \n summary)` — one row per
version, with `version`, `seq` and `seq_epoch` on the row itself. 06 §8.5 says the same thing from its side (*"durably this
table — 01 needs no second store"*), and the first draft of this spec contradicted it by projecting both kinds from a
`work_context` record: since **both** kinds project from the same mutable row, the declaration and every amendment in a session
shared one referent, and under any id scheme keyed on that referent the amendments would have been discarded — which is exactly
the event AT-4 asks about. The ledger row is the event. **Sequence: 06 before the projection handler** (00 §9.7); until 06
lands, the two kinds are **not projected at all** rather than projected wrongly, and doctor says so.

The unique index gives the third outcome. A write whose `(session_id, seq_epoch, seq_n)` is taken by a **different** `id` is a
**conflict** — a restarted counter, a second home, or a broken connector. It is neither `duplicate` nor `rejected`: rejecting
would destroy the record, because the connector's flush advances its cursor on any 2xx (`services/records.ts:71-79`, binding on
every 1.0 ingest path). The row is stored with a null position, the conflict is counted, and that epoch is marked broken for the
session (§3.7). The record survives; only its position is lost.

**Growth, named rather than assumed.** One row per canonical event; targets are already deduplicated per session by
`MAX_SEEN_TARGETS = 500` (`constants.ts:236`) and claims by the summarizer caps, so a session is bounded at roughly five hundred
content-free rows. `SESSION_EVENT_RETENTION_DAYS = 30` matches `COMMIT_EVIDENCE_RETENTION_DAYS` (`server/src/constants.ts:98`)
and 05's `CI_RETENTION_DAYS`; the corpora floor rule (00 §6.2) applies.

### 3.6 Where each emitter allocates — Q2's first open half, ANSWERED

| emitter | allocation | new lock acquisition? |
|---|---|---|
| SessionStart register (`flows/register-session.ts:223`) | `n = 0` inside `publishSessionState`'s own lock | **no** |
| PostToolUse targets and PostToolUseFailure (`flows/capture-targets.ts:97`, `:136`) | folded into the bookkeeping transform already there (`state/capture-bookkeeping.ts`) | **no** |
| Stop git lane (#50, `connector-claude/src/hooks/stop.ts`) | folded into `withGitTouches` | **no** |
| Summarizer, ghost and intent workers (`derive/summarizer/derive.ts:182`, `derive/ghost/worker.ts:358`, `derive/intent/worker.ts:222`) | one `allocateSeq` immediately before `appendRecords`; **`seq_kind = observed`** (below) | yes — **off the hook path** |
| `set_intent` (`mcp/tools/set-intent.ts`) | folded into the `updateSessionState` it already calls | **no** |
| `publish_claim` | one `allocateSeq` | yes — MCP path, `MCP_TIMEOUT_MS = 10_000` |
| SessionEnd (`flows/end-session.ts`) | last `n`, read in the acquisition that reads state before deletion | **no** |

The detached workers are therefore **inside** the lock discipline, not outside it (§1): a worker's draft gets a real `seq`
before its `appendRecords`, and `seq: null` is reserved for genuine failure.

**But a worker's position is `observed`, not `emitted`, and the first draft did not say so.** A worker summarises a slice from
*earlier* in the session, so the position it allocates records when the row was **written**, not when the fact it describes was
seen. Under §3.4's definition (`A.seq_n < B.seq_n` **is** happens-before) every worker-authored `claim.created` would otherwise
sort after edits it actually predates — a confident wrong answer, which is the one outcome this spec exists to prevent. 02 §6
makes precisely this argument about the same three workers for a different field: *"the slice they summarise is from earlier in
the session, so the worker's HEAD is not the HEAD the observation was made at"*, and chooses the conservative answer. **This
spec adopts it.** `seq_kind` therefore has two producers, not one: the `git_diff` target lane (§3.2) and every detached worker.
An `observed` position is an **upper bound only** — it proves the fact was recorded no later than that point, never that it
happened after the previous event — so "did the amendment precede this claim" against a worker-authored record **refuses**
(SEQ-7). The alternative considered and rejected: allocate the worker's range at spawn time inside the Stop hook's lock, which
is more faithful but puts a bookkeeping write on Stop's already-partly-spent `spareMs` (00 §9.1) for a question no 1.0 surface
asks.

**Q2's second open half — subagents — dissolves rather than needing a measurement.** `constants.ts:1274-1296` records, measured,
that there is no trustworthy per-hook headless signal and that orchestration subagents are spawned from a parent whose env leaks
into the child. The map feared that a subagent which *sometimes* inherits `hostSessionKey` and *sometimes* mints its own makes
`seq` silently wrong. It does not, for the reason in §3.3: monotonicity is a property of the **lock**, not of who holds it. A
subagent sharing the key shares the file and the lock, so its allocations interleave in real acquisition order and the sequence
stays true; one minting its own key is a separate session with its own sequence, also true. A shared key costs **attribution
granularity** — `producer.agentKind`'s problem, not the order's. The one genuinely broken case is two *homes* on one key, which
§3.4's epoch already refuses.

### 3.7 Ordering health — what a consumer must ask before comparing

`packages/server/src/services/session-order.ts` (new; this spec's ground):

```ts
export const CAUSAL_ORDER_STATES = ["usable", "broken", "unsequenced"] as const;
export const CAUSAL_ORDER_REASONS = ["sequenced", "epoch_conflict", "epoch_split",
  "pre_seq_connector", "allocation_failed", "reaped_end"] as const;  // ENUM, never prose — 03 §3.3
interface SessionCausalOrder { sessionId; state; reason; epochs /* count */ }
export const isOrderable = (order: SessionCausalOrder, a: Event, b: Event): boolean
```

**`explanation_timing` may only be computed when `isOrderable` returns true.** It keeps its three values (00 §8.1) — I add none.

**Two things the first draft of this section got wrong, both resolved against it, both changed in the other spec too.**

**(1) Unusable order does NOT force `attribution: INDETERMINATE`.** The first draft said the verdict falls to `INDETERMINATE`
carrying the reason. 04 §9 refused, and **04 is right**: attribution is computed from a file-touch intersection, a falsifier and
a coverage record, and none of the three reads `seq`. Coupling them makes two of the five dimensions non-orthogonal, which 00
§8.1's own framing forbids, and it silences attribution for **every pre-`seq` connector** — turning this spec's own
`pre_seq_connector` reason, a statement about instrumentation, into a verdict about a person's work. **Unusable order affects
`explanationTiming` and `timingReason` and nothing else.** Both are printed. 04 §10 D7 existed only to escalate this
disagreement and is retired.

**(2) The unusable-order value is `absent` paired with its reason, not a declined computation.** The first draft refused to fall
back to `absent`, on the ground that `absent` asserts *no explanation exists* — a different and falsifiable claim. The objection
is real and the remedy was wrong: 06 §3.5 step 4 returns `absent` / `not_comparable`, 04 consumes 06's function, and a
"declined" fourth outcome is the fourth value §8 refusal 4 bans. **Resolved in 06's favour, with the binding rule that makes it
honest:** the value and its reason are **one atomic answer and the value never renders alone** — exactly as `attribution:
INDETERMINATE` never renders without its `basis` (04 §3.1) and a `CoverageState` never renders without its `CoverageReason`
(03 §3.3). `TIMING_REASONS` already separates `no_intent` (genuinely absent) from `not_comparable` (cannot be ordered) and
`different_session`, so nothing is lost; what was missing was the rule forbidding the bare word. 06 §3.5 now carries it and
INT-3 tests it.

`isOrderable` remains what a consumer must ask before comparing two positions, and it mirrors 03's `isJudgeable`
deliberately — but like `isJudgeable` it gates **one dimension**, not the verdict.

---

## 4. Migration

**Nothing existing is redefined.** No column changes to `claims`, `work_contexts`, `work_context_targets` or `agent_sessions`;
`stale_at` is untouched (00 §1.7a — the claim-binding spec's ground). One new table, one envelope field, two state fields, one
capability name. **Rows that exist today** get no `session_events` row — backfilling from `created_at` would be the wall-clock
lie this spec refuses; they are `unsequenced / pre_seq_connector` forever, and say so. **Spools written before this lands**
flush envelopes with no `seq`: accepted, projected, stored with a null position, same reason. **State files written before this
lands** parse unchanged via `.default(null)` / `.default(0)` and mint an epoch on their next create. **A newer connector against
an older hub** sends `seq`; the hub ignores the unknown field (`EnvelopeSchema` is a `z.looseObject`, `envelope.ts:30`). No
version gate, no outage.

---

## 5. Where it renders, and who consumes it

**No new render surface, and that is checkable rather than asserted.** Everything this spec shows a human is an integer, a UUID,
or a value from `CAUSAL_ORDER_STATES` / `CAUSAL_ORDER_REASONS`. No author-written string exists in an event row (§3.5), so it
adds no untrusted slot to any surface and no case to `INJECTION_CORPUS`. The only prose is the capability `sentence` in §8 — a
constant in our own source, already rendering through the registered `cli-doctor` surface.

**The verdict / fence spec** takes `isOrderable` and `explanation_timing` and must not recompute either, exactly as it must not
recompute 03's `isJudgeable`. **03 (coverage)** takes nothing and gives nothing — 03 §9 says *"no dependency either way"*. **05
(CI)** likewise: 05 §3.7 refused the envelope for CI because `ProducerSchema` requires a session (`envelope.ts:19-23`) and CI
has none, so a CI run has **no `seq` and no `session_events` row**, a refusal adopted unchanged. **The SSE outbox is refused** —
a 1.0 event kind is not automatically an outbox kind (00 §8.4b), and per-event fan-out would drown the signals SSE consumers
care about, the reason targets and commit evidence already emit nothing (`services/commit-evidence.ts:47-49`). `EVENT_KINDS` is
unchanged.

---

## 6. Budget

**The two hooks the 800 ms rule governs allocate nothing.** `UserPromptSubmit` emits only `hint_delivery`, which is not one of
the nine canonical kinds; `PreToolUse` emits no record at all (00 §4.3). Marginal cost on both: **0 ms**. The pair pinned at
`connector-core/src/constants.ts:56-57` —

```
VERIFY: bun -e 'const c=await import("./packages/connector-core/src/constants.ts");console.log(c.USER_PROMPT_SUBMIT_BUDGET_RATIO*c.HTTP_TIMEOUT_MS, c.PRE_TOOL_USE_BUDGET_RATIO*c.HTTP_TIMEOUT_MS)'
PRINTS: 800 800
```

— is untouched, and `test/hint-budget.test.ts` / `test/hint-hook-latency.test.ts` need no new case. On hooks that do emit,
allocation is **folded into an `updateSessionState` that already runs** (§3.6), so the marginal cost is the arithmetic, not a
second lock: `POST_TOOL_USE_BUDGET_RATIO = 4` (1600 ms) and `STOP_BUDGET_RATIO = 2` (`constants.ts:1031`, 800 ms) are unchanged.
Stop's `spareMs` is already partly spent by #50's git lane (00 §9.1); folding into `withGitTouches` spends none of what is left
and preserves Stop's record-before-spawn order (`stop.ts:9-15`). Everything paying a **new** 100 ms worst-case acquisition is
off the hook path: three detached workers and two MCP tools under `MCP_TIMEOUT_MS = 10_000` (`constants.ts:1381`). **Hub cost:**
one extra INSERT per record inside the record's own transaction, and one retention sweep beside the existing ones. No new job,
no new poll.

---

## 7. Acceptance tests

**AT-4 — "Declared-before is distinguishable from declared-after."** *Fails if the answer depends on wall-clock timestamps from
two processes rather than a monotonic per-session sequence.*

- **SEQ-1 (positive).** `set_intent` (A) → edit to `src/x.ts` outside A's scope → `set_intent` (B): the hub answers `post_hoc`
  for B against that edit and `predeclared` for A against a later edit.
- **SEQ-2 (the "fails if", executable).** Same fixture, every envelope `ts` **inverted** — the amendment stamped an hour before
  the edit — seqs left correct. The answer must be unchanged. This is the test that proves no code path reads the clock.
- **SEQ-3 (monotonicity under interleaving).** Two concurrent emitters on one `hostSessionKey` (the shape of
  `test/state-race.test.ts`) allocate 200 seqs: strictly increasing, no repeat.
- **SEQ-4 (re-fire carry).** Emit, re-fire SessionStart on the same repo and hub, emit again: the second `n` exceeds the first
  and `seqEpoch` is unchanged.
- **SEQ-5 (epoch split refuses, never lies).** Two epochs in one session: a cross-epoch pair is not
  comparable, `state = broken`, `reason = epoch_split`, `explanation_timing` not computed. Fails if any comparison returns an answer.
- **SEQ-6 (conflict keeps the record).** Replay a taken `(session, epoch, n)` with a different `ref_id`: neither `duplicate` nor
  `rejected`, the row exists with a null position, conflict counter moved.
- **SEQ-7 (observed is an upper bound, both producers).** (a) A `git_diff`-only `file.modified` carries `seq_kind = observed`,
  and a "did the amendment precede this edit" query refuses. (b) **A worker-authored `claim.created` carries `seq_kind =
  observed` too** (§3.6) and the same query refuses against it. Fails if either answers, or if (b) is stamped `emitted`.
- **SEQ-8 (pre-seq connector).** An envelope with no `seq` is accepted, projected, reported `unsequenced / pre_seq_connector`.
  Fails on a rejection **or** a silent null with no reason.
- **SEQ-9 (the budget is measured, not asserted).** §6 asserts *"marginal cost on both: 0 ms"* on the two 800 ms hooks and
  concedes a **new ~100 ms worst-case lock acquisition** on `set_intent`, `publish_claim` and three workers — on arithmetic
  alone, because I benchmarked nothing. Six other specs discharge this obligation with a numbered test (CCB-8, COV-8, VER-8,
  PIL-9, EV-8, INT-11); the first draft of this spec had **none**, which left its zero-cost claim with no gate at all. SEQ-9 is
  that gate: SessionStart, PostToolUse and Stop p95 on `connector-claude/test/capture-latency.test.ts` against the pre-change
  baseline with a named allowance, plus the measured wall clock of `set_intent` and `publish_claim` with allocation on, on the
  harness pattern of `connector-core/test/latency.test.ts`. *Fails if* no measurement exists. **I state no millisecond figure
  here** — the 100 ms is `updateSessionState`'s own documented worst case (header, `state/session-state.ts:452-458`;
  `SPOOL_LOCK_RETRIES = 5` × `SPOOL_LOCK_RETRY_DELAY_MS = 20`, `constants.ts:383-384`), which is arithmetic, not a measurement
  of this change.

**Mutation anchors** (`connector-core/scripts/mutation-check.ts`, the `{ label, file, from, to, test, because }` shape at
`:38-47`). Every number this spec quotes lives as a `VERIFY:` / `PRINTS:` directive at its constant, never as a sentence (00
§7.1).

| edit | guard that must go red |
|---|---|
| drop `eventSeq` from `withCarriedCapture`'s carried list | SEQ-4 |
| drop `seqEpoch` from the same list | SEQ-5 |
| `A.seq_n < B.seq_n` → `Date.parse(A.ts) < Date.parse(B.ts)` | SEQ-2 |
| unique index → plain index on `session_events` | SEQ-6 |
| `seq_kind` for `git_diff` → `emitted` | SEQ-7 |
| `allocateSeq` returns `from` without writing back | SEQ-3 |
| `seq_kind` for a worker-authored record → `emitted` | SEQ-7(b) |
| drop `kind` from the `session_events` id hash | SEQ-10 |

- **SEQ-10 (distinct kinds on one referent are distinct rows).** One session emits `session.started`, `commit.observed` and
  `session.ended`, all with `ref_kind = "session"` and the same `ref_id`: **three rows with three positions**. *Fails if* any is
  answered `duplicate` — the defect the first draft's id formula shipped (§3.5).

---

## 8. Refusals

1. **No global or cross-session order.** Order exists inside one `(session, epoch)` and nowhere else. Two sessions, two
   machines, a session and a CI run: not comparable by construction, no "best effort".
2. **No wall clock for order, anywhere** — `ts` and `observed_at` are retention and display only. **No inference of `seq` from
   arrival**: not from `events.id`, not from spool position, not from batch order. **No backfill** of pre-1.0 rows from
   `created_at` (§4).
3. **No `seq` on CI** (05 §3.7, adopted). **No `runtime` events** — runtime invariant mining is Tier 3, and that coverage source
   stays `unavailable / out_of_scope_1_0` (00 §8.2).
4. **No fourth value on `explanation_timing`.** Unusable order gates the computation; it does not add a label (§3.7).
5. **No structured intent here** — desired delta, expected surface and non-goals are Tier 2 and another spec's; this one
   sequences whatever `IntentSchema` carries. **No elaborate change envelopes and no heavy intent inference from agent prose** —
   both Tier 3, named because a reader arriving from AT-4 would expect them.

**Platform rungs — declared as data, printed by `doctor`, never a silent absence.** The mechanism exists:
`DeriveCapabilityManifest` (`connector-core/src/derive/capabilities.ts:68`), whose rungs mean exactly `full | reduced | off`
(`:22-28`) and whose meta-test `test/derive-capability-registry.test.ts` fails the build in **both** directions — a connector
shipping a capability without declaring it, and one declaring a capability it does not ship (`:12-20`). This spec adds
`"event_seq"` to `DERIVE_CAPABILITIES` (`:40`), adds `allocateSeq` to that test's `TRIGGER_IDENTIFIERS` (`:45-57`), and corrects
the array's one-line comment, which today reads *"The four things a connector can be asked to make a model do"* — a sequence is
not a model inference.

| connector | rung | sentence (the platform fact, not a roadmap) |
|---|---|---|
| `claude-code` | `full` | every emitting hook already holds the session state lock, so each canonical event is stamped in the transform that records it |
| `cursor-ide` | `full` | the handlers write session state through the same core transforms, so the sequence is minted the same way; a **cloud** agent with only a user-level install runs no hooks at all and so emits no events to sequence — the existing "cloud and background agents" refusal in that manifest is the reason |
| `acp:*` | `reduced` | the proxy sequences everything it can see off the parse copy, but **no ACP host runs #50's Stop git lane** (`captureGitTouches` is imported only by `connector-claude/src/hooks/stop.ts`), so a file changed by `sed -i`, a codemod or a generator produces no `file.modified` to order at all |

The refusal belonging to all three, phrased once: `git_diff`-sourced `file.modified` is `observed`, not `emitted`, and **changes
committed during the session and untracked new files are invisible to that lane entirely** — the sentence `doctor` already
prints for the lane (`crosscheck-pins:flows/capture-git-touches.ts`, "WHAT IT CANNOT SEE").

---

## 9. Collisions

**PR #50** (assume merged). `state/session-state.ts` — two appended fields plus `withCarriedCapture`'s carried list, copying
#50's `.default()` + transform shape; textual conflict at the schema tail likely, semantic conflict none. `schema/src/enums.ts`
— I **reuse** `TARGET_SOURCES` and mint no second lane label. `connector-claude/src/hooks/stop.ts` — folded into
`withGitTouches`, not a new step. `connector-core/src/constants.ts` — one constant appended below #50's block, never renumbered.
`server/src/db/bootstrap.sql` + `ddl-sync.test.ts` — one table, both mirrors. **PR #49** — none; it touches developer listing
and identity, and nothing here reads a developer.

**`.github/workflows/ci.yml`** — this spec adds `MUTATIONS` entries (§7), so per 00 §9.2 it bumps the count at `ci.yml:119-120`
and touches **all three listings, not two**: the count (`:119`), the per-file block (`:127`) and the **per-basename block**
(`:246` on `crosscheck-pins`, `:239` on main), which the first draft of this spec did not name. New per-file lines for
`services/session-order.ts` and `state/session-state.ts`; in the per-basename listing `session-state.ts` is a **bump of an
existing line**, not a new one, because that block keys on the basename. **No post-merge total is written**; the `VERIFY:`
directive prints the number. On `mutation-check.ts` this spec is **editor 5** — #50, #49, 03 and 06 precede it in the build
order (00 §9.7); all eight specs append to the same array tail, so "third editor" is a seat three specs had each claimed.

**The other specs.** *03 (coverage):* agreed both ways — 03 §9 *"no dependency either way"*; I reuse its reason-enum discipline
(03 §3.3) for `CAUSAL_ORDER_REASONS` deliberately. *05 (CI):* agreed — 05 §9.6 reads *"**01** owns `seq` (Q2); I consume nothing
from it"*, and I adopt its §3.7 envelope refusal. **An earlier draft of this section quoted that sentence as saying "02" and
asked whoever sequences the set to fix a spec-number collision: the quote was wrong and the collision does not exist.** Verified:
`grep -n "02 (" docs/1.0/05-ci-ingestion.md` returns nothing. The ask is withdrawn so nobody edits a correct file.

*Divergence from 00 §8.4, declared rather than quiet* (00 §11.2's rule): the nine dotted names stay verbatim as vocabulary but
are a **projection**, not nine new envelope kinds (§3.1); `session.ended(reaped)` carries no `seq` where §8.4 wrote "seq = last";
and **two of the nine project into 06's ledger rather than this table** (§3.5) — §8.4's three non-negotiable properties survive
unchanged in all three cases.

*Intent ledger (06) — a real dependency in both directions, and the order is settled.* 06 consumes `seq` and stores it on
`work_context_intents`; **this spec's `intent.declared` / `intent.amended` projection is that row**, so the projection handler
is written once 06 has landed (00 §9.7 puts 06 immediately after this spec). Two shapes must match and both are 06's edits:
`seq` on the ledger is the **`(epoch, n)` pair** of §3.1, not a bare integer — a bare integer compares two positions across
epochs and answers confidently where SEQ-5 requires a refusal — and 06 §3.2 gains `seq_epoch` beside `seq`. *Claim binding (02):*
each owns its record's **content**, this spec owns its **position**; 02 §3.4 refuses a `commits` table, so `commit.observed`
stays the aggregate — **either order**.

*Verdict / fence (04): the only hard dependency in the set; it consumes `isOrderable` and must not recompute it — **this spec
first**. The one live contradiction between us is resolved in 04's favour (§3.7): unusable order affects `explanationTiming`
only and never forces `attribution: INDETERMINATE`.*

---

## 10. Decisions for Nick

**D1 — Does an MCP-emitted event inherit the session picker's guess, or refuse?** An MCP server is never told which session is
calling it, so `connector-core/src/mcp/session.ts:96` picks: same hub, same repo, prefer the same worktree root, then newest
`startedAt`. Its own header states the limit (`:20-24`): *"Two agent sessions in the SAME worktree against the same hub are
indistinguishable from in here, and the newest one is chosen."* `set_intent` is exactly the call AT-4 hangs on, so a wrong guess
files an amendment into another session's causal order. *Default (recommended): count the ambiguity and refuse the seq, not the
record* — one bounded boolean on `OwnWorkContext` (more than one eligible state file matched the same worktree root), and under
it the record is emitted normally with `seq: null`, reason `allocation_failed`. The claim or intent still lands; only its
position is withheld. Stamping the guess would let AT-4 answer confidently from a coin flip. Cost: in a two-agent worktree
`explanation_timing` is unavailable until Claude Code passes a session id to MCP servers.

> **Decided otherwise on 2026-09-15.** Nick kept D1 and changed D2: *"Forget content before you forget causality."* The flat
> thirty days below is withdrawn as the model; [01a](01a-causal-skeleton.md) replaces it with retention by root reachability, a causal
> attestation record and declared provider guarantees. The text below is kept as the record of what was proposed.

**D2 — Retention: 30 days, or the life of the claim it orders?** *Default (recommended): 30 days*, matching
`COMMIT_EVIDENCE_RETENTION_DAYS` and 05's `CI_RETENTION_DAYS`. The consequence should be chosen rather than discovered: a claim
older than thirty days keeps its body and loses its position, so a fence verdict on old work can still say *what* was claimed
and no longer *whether the reason predated the change*. The alternative — keep an event as long as the row it references lives —
is unbounded in exactly the way `commit_evidence` was designed to avoid (`schema.ts:370-373`).
