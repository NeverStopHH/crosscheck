# 01a — The causal skeleton: retention by relevance, the attestation record, and declared provider guarantees

**Tier 1, as an amendment to 01** — not a new component. **Owns no acceptance test.** It makes AT-4 *durable*: 01 decides
whether two events may be compared, 06 supplies what is compared, and this spec decides how long that answer survives.
**Supersedes the default of 01 §10 D2**, which Nick changed on 2026-09-15 (§2). Written against `main@390849d` with **#53
(`feat/session-event-order`) assumed merged**; a position on that branch carries the `event-order:` prefix, the convention
00 §9.4a set for #50. Nothing here is built.

---

## 1. Problem

### 1.1 Today the hub keeps content forever and forgets causality after thirty days

This is the exact inversion of the rule this spec implements, and it is measured rather than inferred. The hub removes rows
in **five** places and nowhere else (every `.delete(` call site in `packages/server/src`, test files excluded, 2026-09-16;
no raw SQL removal exists):

| call site | table | trigger |
|---|---|---|
| `services/developers.ts` | `developer_emails` | a person removes an address |
| `services/developer-settings.ts` | `developer_mutes` | a person removes a mute |
| `services/pins.ts` | `pin_files` | the pin sweep rewrites a pin's files |
| `services/commit-evidence.ts` | `commit_evidence` | age, `COMMIT_EVIDENCE_RETENTION_DAYS = 30` |
| `event-order:services/session-events.ts` `pruneSessionEvents` | `session_events` | age, `SESSION_EVENT_RETENTION_DAYS = 30` |

Every table that holds author-written content — `claims.body`, `artifacts.content`, `work_contexts.title` / `description` /
`intent`, `work_context_targets.value`, the question tables, and 06's `work_context_intents.summary` / `reason` / `wire` — is
**never removed**. The one table whose every column is an id, an enum, an integer or a hub timestamp is removed at thirty days.

The consequence is concrete. 06 §3.5 step 4 drops a ledger entry whose `seq` is null and drops everything when
`edit.seq === null`. Once an edit's `session_events` row is gone, `explanationTimingFor` answers `absent` /
`not_comparable` for it — *"we do not know the order"* — for every edit older than a month. That is precisely the population
crosscheck is meant to be most useful on: old diagnoses, recurring failures, fence investigations weeks after the change.

### 1.2 The row being removed already is the skeleton

`event-order:services/session-events.ts` says so in the comment above `pruneSessionEvents`: *"the row this DELETE removes IS
very nearly the causal skeleton … retiring content sooner than proven order is a change to the MODEL, a tier that outlives
what it orders, and not a different number in this constant."* The columns bear it out (`event-order:db/bootstrap.sql`,
`session_events`): `id`, `session_id`, `seq_epoch`, `seq_n`, `seq_after`, `kind`, `seq_kind`, `seq_reason`, `ref_kind`,
`ref_id`, `observed_at`. No body, no prose, no path — `ref_id` for a file is `sha256(work_context_id \n kind \n value)` (01
§3.5). So D2 cannot be answered by changing thirty to three hundred. It needs a rule for *which* skeleton rows stay.

### 1.3 "Forever" is not free, and the number is measured

**MEASURED 2026-09-16** (PGlite 0.3.16, the hub's own database, in memory; 20 000 synthetic rows at real value lengths, the
table and all three #53 indexes; the script is reproduced in this spec's pull request, and the build turns it into a
`VERIFY:` directive at the constant, §6): **476 bytes per row including indexes** — 93 KiB for a 200-row
session, 232 KiB for a 500-row one. The rows-per-session figure is **not** measured: the pilot hub runs 0.9.0 and has no
`session_events`, which is 07's to measure. As arithmetic only: ten developers at twenty sessions a working day for 250
days is 50 000 sessions a year — **1.2 GB/year at 50 rows a session, 12 GB at 500**. On an embedded single-connection
database that is a design input, and it is why §3.3 keeps rows by relevance rather than keeping all of them.

### 1.4 What a provider can guarantee is prose

01 §8 declared one rung per connector — `event_seq: full | reduced | off` — with a sentence. Cursor's sentence already
states two structured facts in prose (`event-order:connector-cursor/src/capabilities.ts`): no Stop-time git lane, and no
pre-tool handler, *"so an edit's position is taken only AFTER the tool returned and is an upper bound"*. Nothing downstream
can read a sentence. Coverage Integrity (03) never learns that a Cursor session cannot bracket an edit; a reader of a
coverage line sees `agent_event: complete` for a session whose edits cannot be ordered against its intent.

---

## 2. Principles served

- **"Forget content before you forget causality."** Nick, 2026-09-15, with its operational form: *"Content may expire.
  Proven causal structure should not expire merely because content retention expired."*
- **"Only judge when you know you were watching."** The attestation record carries what was watched when it was judged.
- **"A reason written after a change is not evidence that the reason existed before the change."** AT-4 must still be
  answerable a year later, without the prompt, the tool output or the agent's text.
- **Provider neutrality, in Nick's formulation:** *"every provider must be able to state which causal guarantees it
  provides."* A new vendor may do less; **it may not look like it does more.**
- **Data minimisation (non-negotiable #6)** is unchanged: nothing in this spec stores text, a path, or a hash of a person.

---

## 3. Target model

### 3.1 Two tiers, mapped onto the tables that exist

| table | author-written content | removed today | tier | 1.0 rule |
|---|---|---|---|---|
| `session_events` | none | age, 30 d | **skeleton** | kept by relevance (§3.3) |
| `causal_attestations` (new, §3.5) | none | — | **skeleton** | kept while its session is |
| `session_causal_guarantees` (new, §3.6) | none | — | **skeleton** | kept while its session is |
| `agent_sessions` | `branch` | never | skeleton anchor | never removed; FK target of the skeleton |
| `work_context_intents` (06) | `summary`, `reason`, `wire` | never | content, with skeleton columns (`id`, `seq_epoch`, `seq`, `version`, `author_session_id`) | §3.4 |
| `claims` | `body` | never | content, and the institutional memory itself | §3.4 |
| `artifacts` | `content` | never | content | §3.4, D-A |
| `work_context_targets` | `value` (a path) | never | content | §3.4 |
| `commit_evidence` | none that leaves the hub | age, 30 d | unchanged | 01 §3.5 |
| `events` | none — the outbox carries ids and metadata only (`services/events.ts:30`) | never | unchanged | — |

**The tiers are a rule about dependence, not a new store.** The skeleton is the set of rows that never need a content row to
answer *which session, which epoch, which position, before or after*. Content may go; the skeleton must still answer.

### 3.2 The skeleton row — Nick's field list against the row #53 built

| Nick's field (2026-09-15) | on the row | how |
|---|---|---|
| `event_id` | yes | `id` (`se_` + 32 hex, deterministic) |
| `session_id` | yes | `session_id` |
| `event_type` | yes | `kind` (seven dotted names, `event-order:schema/src/session-event.ts`) |
| `seq` | yes | `seq_epoch` + `seq_n`, and the bracket `seq_after` |
| `provenance` | yes | `seq_kind` (`emitted` / `observed`) + `seq_reason` (seven values) |
| `subject_ref` | yes | `ref_kind` + `ref_id` — an id or a digest, never text |
| `work_context_id` | **added** | new nullable column, §4 |
| `provider` | **added** | new nullable column, §4 |
| `commit_ref` | **refused on this row** | §8.3 |
| `parent_event_id` / `causal_parent` | **refused on this row** | §8.4 |

**Why two columns are denormalised rather than joined.** Both are derivable today — `work_contexts.session_id` and
`agent_sessions.agent_kind` — but the first join passes through a row holding `title`, `description` and `intent`, which is
content. A skeleton that needs a content row to say which work context it belongs to has not outlived its content; it has
only outlived it *so far*. `provider` is copied for the symmetric reason: the guarantee a row was produced under (§3.6) must
be readable from the skeleton alone. The cost is re-measured with both columns at build (§6).

### 3.3 Retention by relevance

**A skeleton row lives as long as something that can ask about its order lives.**

A session is **retained** when any of these reference it:

| dependent | column | why it can ask about order |
|---|---|---|
| `claims` | `author_session_id` | a claim's position is what makes a reason post-hoc (principle 3) |
| `work_context_intents` (06) | `author_session_id` | `explanationTimingFor` compares exactly these positions |
| `causal_attestations` | `session_id` | an attestation cites the positions it was derived from (§3.5) |

The sweep replaces `pruneSessionEvents`' predicate — age alone — with age **and** no dependent:

```sql
DELETE FROM session_events se
 WHERE se.observed_at < $cutoff               -- SESSION_EVENT_RETENTION_DAYS, unchanged at 30
   AND NOT EXISTS (SELECT 1 FROM claims c               WHERE c.author_session_id = se.session_id)
   AND NOT EXISTS (SELECT 1 FROM work_context_intents i WHERE i.author_session_id = se.session_id)
   AND NOT EXISTS (SELECT 1 FROM causal_attestations a  WHERE a.session_id        = se.session_id);
```

`claims_author_session_idx` does not exist today and is added (§4); 06 already specifies
`work_context_intents_session_idx (author_session_id, seq)`; §3.5 specifies the attestation index. The statement stays one
pass on `reapStaleSessions`' existing schedule (`event-order:services/sessions.ts`), before its early return, as #53 placed
it. **The thirty-day constant keeps its value and changes its meaning**: it is now the grace period for sessions nothing can
ever ask about, and its comment says so.

**What is lost, named.** A session with no claim and no intent version loses its order after thirty days. Nothing in 1.0 can
compare against it: `explanationTimingFor` step 1 returns `absent` / `no_intent` for it before step 4 ever reads a position,
and 01 §3.7 (1) already made attribution independent of `seq`. That session's *targets* stay, because they are content and
`work_context_targets` is never removed.

**The literal reading was considered and is D-B.** Nick's sentence names *"Claims, Work Contexts oder Invarianten"*.
`registerSessionFlow` spools a work-context record for every session it claims (`connector-core/src/flows/register-session.ts`),
so "as long as its work context exists" is "forever" in this schema, at the §1.3 cost.

### 3.4 The content rule — redaction in place, never removal, for anything the skeleton references

This spec adds **no content expiry by default** (D-A). It adds the rule that makes any future content expiry safe, so that a
retention policy chosen later cannot silently take causality with it:

1. **Content expires by redaction in place, never by row removal**, for any row a skeleton row or an attestation
   references: `claims`, `work_context_intents`, `work_contexts`, `artifacts`, `agent_sessions`. The content columns are
   nulled or replaced with a fixed marker, a `content_expired_at timestamptz` column is set, and the row, its id and its
   foreign keys survive. `ref_id` therefore always resolves to a row.
2. **No skeleton reader inner-joins a content column.** `explanationTimingFor`'s order half, `isOrderable`, the attestation
   reader and the §5 doctor lines read ids, enums and positions only. A referent whose content has expired renders as the
   renderer-owned literal `content expired` — an enum-backed state, never prose — and is still orderable.
3. **06 step 5 is the one place order needs content** (`intent_scope` holds paths). After redaction the live ladder cannot
   run step 5 for that version. The **attestation** (§3.5) is what still answers, because it was written while step 5 could
   run.

`content_expired` is a render state in 03's sense (enum, never prose), and adds one case to the render-surface registry
(00 §6) for each surface in §5 — **no untrusted slot**, since the literal is renderer-owned.

### 3.5 The Causal Attestation Record

When order has already produced a load-bearing statement, the statement is kept as its own row, so the old session never has
to be reconstructed.

```sql
CREATE TABLE causal_attestations (
  id                     text PRIMARY KEY,   -- ca_ + 32 hex of sha256(session_id \n seq_epoch \n subject_ref \n object_ref \n ladder_version)
  session_id             text NOT NULL REFERENCES agent_sessions(id),
  seq_epoch              text NOT NULL,
  statement              text NOT NULL,      -- enum ATTESTED_STATEMENTS: predeclared_explanation | post_hoc_explanation | declared_non_goal_edited
  relation               text NOT NULL,      -- enum: happens_before | happens_after
  subject_ref            text NOT NULL,      -- work_context_intents.id (iv_…)
  object_ref             text NOT NULL,      -- session_events.id (se_…) of the edit
  subject_seq            integer NOT NULL,
  object_seq             integer NOT NULL,
  object_seq_after       integer NOT NULL,   -- the bracket the comparison relied on (rule 2)
  timing_reason          text NOT NULL,      -- 06 TIMING_REASONS, the three order-derived values only
  coverage_at_judgment   jsonb NOT NULL,     -- 03 CoverageSourceRecord[] for the session's scope: enums and ISO timestamps only
  guarantees_at_judgment jsonb NOT NULL,     -- the session's §3.6 declarations: enums only
  ladder_version         integer NOT NULL,   -- EXPLANATION_LADDER_VERSION at write time
  attested_at            timestamptz NOT NULL -- hub clock; display only, orders nothing
);
CREATE INDEX causal_attestations_session_idx ON causal_attestations (session_id);
CREATE INDEX causal_attestations_object_idx  ON causal_attestations (object_ref);
```

**Rules.**

1. **Written once per session, when the session ends** — `session.ended` ingest and `reapStaleSessions`' close, the two
   paths that already make a session terminal. At that point the session's `agent_event` coverage is final, which is what
   `coverage_at_judgment` is for: *"this statement was provable then, on this much observation."* Writing on ingest of each
   edit would attest under coverage that is still moving; writing on read would make a read path write.
2. **Only statements order produced.** A row is written when `explanationTimingFor` answers with one of the three
   order-derived reasons — `declared_before`, `declared_after`, `declared_non_goal_edited` — and `isOrderable` held. Every
   other answer (`no_intent`, `derived_excluded`, `different_session`, `not_comparable`, `scope_not_named`) does not depend on
   the skeleton and is not attested. An `observed` edit, or one without a bracket, is `not_comparable` under 01 and #53, so it
   never reaches this table — which is why `object_seq_after` can be `NOT NULL`.
3. **Bounded:** at most one row per `(session, epoch, edited target)` — the ladder already answers over the **earliest**
   survivor per role (06 §3.5 step 6), so each edited target yields one statement. That is ≤ `MAX_SEEN_TARGETS` per epoch,
   and in practice the number of distinct files a session changed under a declared intent.
4. **`ladder_version` makes a wrong attestation findable.** 06 §3.5 records that its first draft of step 6 answered a violated
   non-goal `predeclared`. An attestation frozen by a ladder with that defect would be wrong forever and indistinguishable
   from a right one. `EXPLANATION_LADDER_VERSION` is a constant beside `explanationTimingFor`, bumped by any change to its
   early returns, and a reader treats a row whose version is older than the current one as `attestation_superseded` —
   printed, never silently trusted, never silently dropped.
5. **Readers: live first, attestation second, disagreement counted.** A consumer asks the live ladder. Only when the live
   ladder cannot answer because the skeleton row or the scope content is gone does it read the attestation, and the render
   says *attested at* with the coverage it carries. When both answer, with the same `ladder_version`, and disagree, the live
   answer is used and `attestation_disagreements` is counted and printed by doctor — a real defect signal, since both read the
   same positions.
6. **No text.** Every column is an id, an enum, an integer, a timestamp, or JSON whose leaves are enums and ISO timestamps.
   The JSON is validated on write with the zod schemas 03 and §3.6 export, so a free-text field cannot enter through it.

**What an attestation is not.** It is not a verdict, not a permission and not a cache of 04. It records one happens-before
fact and the observation it rested on. 04 still computes attribution fresh; principle 2 is untouched.

### 3.6 Declared causal guarantees

```ts
// packages/schema/src/causal-guarantees.ts
export const CAUSAL_GUARANTEES = ["guaranteed", "partial", "unavailable"] as const;
export const CAUSAL_GUARANTEE_REASONS = [
  "bracketed_by_pre_tool",      // guaranteed: every producing lane opens the position before the tool runs
  "lifecycle",                  // guaranteed: n = 0 or the terminal position, with no tool to race
  "unbracketed_lane",           // partial: some producing lane positions only after the fact
  "observed_lane_only",         // partial: the kind is produced only by an observing lane (git diff)
  "ambiguous_session_possible", // partial: the MCP picker's ambiguity (01 D1) can withhold the position
  "no_emitter",                 // unavailable: this connector never produces the kind
  "not_built",                  // unavailable: the kind's producer does not exist yet (06's two intent kinds today)
] as const;
export type CausalGuaranteeKind = SessionEventKind | "intent.declared" | "intent.amended";
export interface CausalGuaranteeDeclaration {
  readonly kind: CausalGuaranteeKind;
  readonly guarantee: (typeof CAUSAL_GUARANTEES)[number];
  readonly reason: (typeof CAUSAL_GUARANTEE_REASONS)[number];
}
```

**The weakest-lane rule.** A connector declares, per kind, the guarantee of the **weakest lane that can produce that kind**.
Claude Code produces `file.modified` from bracketed Edit-family tools, from Bash, and from the Stop git lane — Bash is in
`POST_TOOL_USE_MATCHER = "Edit|Write|MultiEdit|NotebookEdit|Bash"` and not in `PRE_TOOL_USE_MATCHER =
"Edit|Write|MultiEdit|NotebookEdit"` (`event-order:connector-core/src/constants.ts`) — so its `file.modified` is `partial` / `unbracketed_lane` — not
`guaranteed`, however good its Edit path is. A declaration describing only the best lane is the "looks like it does more"
this spec exists to forbid.

**Where it lives.** Beside `DeriveCapabilityManifest` in each connector's `capabilities.ts`, as data. The existing meta-test
`test/derive-capability-registry.test.ts` gains the two-directional check it already enforces for rungs: a connector whose
source emits a kind it has not declared fails the build, and so does one declaring `guaranteed` for a kind with a producing
call site outside a pre-tool bracket. The trigger identifiers are 01's (`allocateSeq`, `allocateToolSeq`, `openToolWindow`);
the lane of each call site is read from the file it sits in.

**Initial declarations** — read from the code on `event-order:` at `91d79dc`, to be **re-derived by the builder, not copied**:

| kind | `claude-code` | `cursor-ide` | `acp:*` |
|---|---|---|---|
| `session.started` | guaranteed / `lifecycle` | guaranteed / `lifecycle` | guaranteed / `lifecycle` |
| `file.modified` | partial / `unbracketed_lane` | partial / `unbracketed_lane` | partial / `unbracketed_lane` |
| `tool.failed` | partial / `unbracketed_lane` | partial / `unbracketed_lane` | builder derives |
| `claim.created` | partial / `ambiguous_session_possible` | partial / `ambiguous_session_possible` | builder derives |
| `claim.invalidated` | builder derives | builder derives | builder derives |
| `commit.observed` | guaranteed / `lifecycle` | unavailable / `no_emitter`¹ | unavailable / `no_emitter`¹ |
| `session.ended` | guaranteed / `lifecycle` | guaranteed / `lifecycle` | builder derives |
| `intent.declared`, `intent.amended` | unavailable / `not_built` | unavailable / `not_built` | unavailable / `not_built` |

¹ `collectCommitEvidence` has exactly one caller, `connector-claude/src/hooks/session-start.ts`. `connector-core` re-exports
it from `index.ts` and `kit.ts`, so a fourth connector built on the kit can start calling it — and its declaration must then
change with it, which is what the CSK-7 meta-test enforces. The builder re-verifies both halves.

**Transport.** The declaration travels in the `session.started` record body — at most nine enum triples — and lands in
`session_causal_guarantees (session_id, kind, guarantee, reason, PRIMARY KEY (session_id, kind))`. A connector that sends none
is stored as nothing, and every reader treats the absence as `undeclared`, never as `guaranteed`.

**Rows outrank declarations.** A declaration never upgrades a row: comparability is still decided per row by `seq_kind` and
`seq_after` (01, #53). The declaration is what coverage and disclosure read. A row that contradicts its session's declaration
— an `observed` or unbracketed `file.modified` from a session that declared `guaranteed` — is counted as
`declaration_contradicted` and printed by doctor. That is the runtime enforcement of *"may not look like it does more"*; the
meta-test is the build-time one.

### 3.7 Where it enters Coverage Integrity — beside the source lines, not as one

Nick's direction is that missing capability *"becomes part of Coverage Integrity"*. 01 §3.7 (1), resolved against 04, is that
**unusable order must not force attribution to `INDETERMINATE`** — attribution never reads `seq`. Both hold if the guarantees
are part of the coverage **record** but not one of its **sources**:

```ts
interface CoverageRecord {
  // …03's fields, unchanged; COVERAGE_SOURCES keeps its five values and its order (00 §8.2)
  readonly order: {
    readonly state: "guaranteed" | "partial" | "unavailable" | "undeclared";
    readonly reason: CausalGuaranteeReason | "provider_undeclared";
    readonly sessions: number; // sessions in scope the state was computed over
  };
}
```

`order.state` is the weakest declaration across the sessions in scope, for the kinds the question needs. `isJudgeable` (03)
does not read it. `isOrderable`'s callers do, and a timing answer computed under `order.state !== "guaranteed"` renders that
state beside it — exactly as `attribution: INDETERMINATE` never renders without its basis. **The coverage line stays one
record and the two gates stay orthogonal.** D-C puts the alternative — a sixth coverage source — in front of Nick with its
cost.

`COVERAGE_REASONS` is not extended; `order` carries its own enum. The two copies of the coverage vocabulary
(`server/src/services/coverage.ts` and `connector-core/src/http/coverage.ts`, both on #52) gain the same `order` type, and
03's parity test covers it.

---

## 4. Migration

1. **`session_events`**: `ADD COLUMN IF NOT EXISTS work_context_id text`, `ADD COLUMN IF NOT EXISTS provider text`. Existing
   rows are backfilled by join (`work_contexts.session_id`, `agent_sessions.agent_kind`). **This is not the wall-clock backfill
   01 §8 refuses** — it copies identity, not order, and touches no position.
2. **`claims_author_session_idx`** on `claims (author_session_id)`, for §3.3's sweep.
3. **`causal_attestations`** and **`session_causal_guarantees`**: new tables, mirrored in `db/bootstrap.sql` and pinned by
   `test/ddl-sync.test.ts`. Sessions that ended before deploy get **no attestation** — attesting them after the fact would
   write under coverage nobody recorded at the time. They keep their live skeleton under §3.3.
4. **`content_expired_at timestamptz NULL`** on the five tables in §3.4 rule 1. Nothing sets it in 1.0 unless D-A says so.
5. **The prune's predicate** changes in place (§3.3); `SESSION_EVENT_RETENTION_DAYS` keeps its value and gets a new comment.

**The window that makes the order of merges matter.** #53's prune removes only rows older than thirty days, and a hub starts
writing `session_events` only once #53 is deployed. **If this spec ships within thirty days of #53's first deploy, no row is
ever lost.** If it ships later, rows older than thirty days are gone, including those of sessions that have claims. D-D.

---

## 5. Where it renders, and who consumes it

| surface | adds | untrusted slots |
|---|---|---|
| `crosscheck doctor` | skeleton rows kept / rows in the grace period / oldest kept position; attestations written, superseded, disagreeing; `declaration_contradicted`; this connector's declaration table | none — counts, enums, ISO timestamps |
| coverage line (03) | `order: <state> (<reason>) over <n> sessions` | none |
| `get_diagnosis`, referee page, briefing | a timing answer read from an attestation renders *attested at <ISO> under coverage <enums>*; a redacted referent renders `content expired` | none |

**Consumers.** 06's `explanationTimingFor` (attestation fallback, §3.5 rule 5), 04 through 06, and 07's pilot counters (rows
kept against rows in the grace period is a pilot measurement). The render-surface registry (00 §6) gains the three literals;
`INJECTION_CORPUS` gains no case, because no new slot carries author text.

---

## 6. Budget

- **Hook path: 0 ms added.** The declaration is a constant riding a `session.started` body that is already sent. MEASURE the
  body-size delta at build (nine enum triples) and report it beside 01's.
- **Hub ingest:** one INSERT into `session_causal_guarantees` per session start, inside the existing transaction.
- **Session end:** one ladder pass over the session's edited targets and its intent chain, both of which 06 already reads; at
  most `MAX_SEEN_TARGETS` INSERTs. **MEASURE** at 50 and 500 edited targets on PGlite and write the numbers as `VERIFY:`
  directives at the constant.
- **Sweep:** three `NOT EXISTS` probes per candidate row on indexed columns. **MEASURE** at 100 000 rows, half of them
  retained, before merge.
- **Storage:** 476 B per skeleton row today (§1.3); re-measure with the two new columns and report the attestation row size.

---

## 7. Acceptance tests

Each names its mutation anchor. All anchors join `mutation-check.ts`, and **all three** listings in
`.github/workflows/ci.yml` plus the per-test listing in `mutation-check.ts` are regenerated by running their commands.

**CSK-1 — a session with a claim keeps its order past thirty days.** Seed a session with one `claim.created` and one
`file.modified`, advance the clock 31 days, run the reaper pass. Both rows remain and `explanationTimingFor` still returns an
order-derived reason. *Fails if* any positioned row of that session is removed. *Mutation:* drop the `claims` `NOT EXISTS`.

**CSK-2 — a session with an intent version keeps its order.** As CSK-1 with a 06 ledger row and no claim. *Mutation:* drop
the `work_context_intents` `NOT EXISTS`.

**CSK-3 — a session nothing can ask about is still pruned.** A session with events only, 31 days old, loses its rows; one 29
days old keeps them. *Fails if* the sweep became "never" — the §1.3 cost chosen by accident. *Mutation:* remove the age term.

**CSK-4 — an attestation answers after its content is gone.** End a session whose intent predates a bracketed edit; redact the
intent (`content_expired_at` set, `wire` and `summary` replaced); the timing answer is still `predeclared` /
`declared_before`, rendered as attested, with the coverage it was written under. *Fails if* the answer becomes `absent`.
*Mutation:* skip the attestation read.

**CSK-5 — only order-derived statements are attested.** A session whose ladder answers `no_intent`, and one answering
`not_comparable` because its edit is unbracketed, write zero attestation rows. *Mutation:* widen the reason filter to all
eight reasons.

**CSK-6 — a superseded ladder is never trusted silently.** An attestation with `ladder_version` one below the constant renders
`attestation_superseded` and is counted. *Mutation:* compare with `<=`.

**CSK-7 — no connector declares more than its weakest lane.** The registry test fails for a manifest declaring
`file.modified: guaranteed` while a Bash-reachable PostToolUse call site allocates for it. *Fails if* Claude Code's current
code could declare `guaranteed`. *Mutation:* fold the lanes with `max` instead of `min`.

**CSK-8 — an undeclared session is never read as guaranteed.** A `session.started` with no declaration yields
`order.state: undeclared` in the coverage record. *Mutation:* default the missing declaration to `guaranteed`.

**CSK-9 — a contradicting row is counted.** A session declaring `guaranteed` that sends an `observed` `file.modified`
increments `declaration_contradicted`. *Mutation:* skip the counter.

**CSK-10 — no text reaches the skeleton.** Plant marked text in a claim body, an intent summary, a target path and an
artifact; end the session; search `session_events`, `causal_attestations` and `session_causal_guarantees` byte for byte.
*Fails if* one marker is found. This extends 01's existing content-free test rather than adding a parallel one.

---

## 8. Refusals

1. **No content expiry is switched on by this spec.** The mechanism (§3.4) ships; the policy is D-A.
2. **No skeleton row is removed while a dependent exists**, and no setting overrides that in 1.0. A stricter compliance policy
   that removes metadata as well is possible later as a deliberately chosen retention policy — Nick's words — and would be its
   own spec, stating what AT-4 can then no longer answer.
3. **No `commit_ref` on the skeleton row.** `commit.observed` refs the session (01 §3.5); a claim's commit is 02's binding on
   `claims`, which is never removed. Copying it here would duplicate 02's authority, which 02 exists to make single. The
   tension 02 records — it refused a per-commit table while Nick's direction note asks for commit-level identity — is untouched
   by this spec and remains Nick's.
4. **No `causal_parent` in 1.0.** No emitter knows a parent event. The only parent-like fact the connectors have is the tool
   window, and it is already stored as `seq_after`. Subagent parentage is 00 §10 Q2's open half and is not guessed here.
5. **No attestation for sessions that ended before deploy**, and none written on read.
6. **No sixth coverage source** by default (§3.7, D-C).
7. **No cross-session attestation.** 01 §8.1 holds: order exists inside one `(session, epoch)`.

---

## 9. Collisions

- **#53 (`feat/session-event-order`)** — `services/session-events.ts` `pruneSessionEvents` (predicate replaced);
  `constants.ts` `SESSION_EVENT_RETENTION_DAYS` (comment rewritten, value kept); `db/bootstrap.sql` `session_events` (two
  columns) and `session_events_observed_at_idx` (kept: the sweep still ranges by age first). Build **after** #53 merges.
- **#52 / 03** — `CoverageRecord` gains `order` in **both** copies; 03's parity test and COV-5 shape are edited. 03's
  `COVERAGE_REASONS` is not.
- **06** — `work_context_intents` is a retaining dependent; `explanationTimingFor` gains the attestation fallback and
  `EXPLANATION_LADDER_VERSION`; 06 step 5 is the one order computation that needs content (§3.4 rule 3).
- **02** — `claims` gains `content_expired_at` in the migration family 02 and 08 already share, which makes this spec the third
  editor of it.
- **04** — consumes timing through 06 only; no change to its gates.
- **07** — `PILOT_RETENTION_DAYS = 90` is unrelated (pilot tables); 07 gains two counters (rows kept, rows in grace).
- **Connectors** — each `capabilities.ts` gains a declaration; `test/derive-capability-registry.test.ts` gains the
  two-directional check.
- **`mutation-check.ts` and `.github/workflows/ci.yml`** — ten anchors; every derived listing is regenerated by running its
  `VERIFY:` command, never transcribed.

---

## 10. Decisions for Nick

**D-A — Does any content expire in 1.0?** *Default (recommended): no.* The mechanism ships (§3.4); nothing sets
`content_expired_at`. Your note names *"strukturierte Begründung, Oberflächendetails, Werkzeug-Metadaten,
Zusatzinformationen"* as the thirty-day tier. Measured against the hub: prompts, tool output and agent prose are not stored at
all (non-negotiable #6), the outbox carries ids only, and what remains is claims, intents, targets and artifacts — the
institutional memory your same note wants kept *"solange die zugehörigen Claims … existieren"*. The one table that matches
"Zusatzinformationen" cleanly is `artifacts.content`. *Alternative:* redact `artifacts.content` at thirty days and keep the
row. Cost: an approved artifact attached to a live claim disappears from that claim a month later.

**D-B — Relevance, or literal "forever"?** *Default (recommended): relevance* (§3.3) — a session's order is kept while a claim,
an intent version or an attestation references it. *Alternative:* keep every skeleton row, since every session has a work
context. Cost: §1.3 — 1.2 to 12 GB a year for a ten-person team, on an embedded database.

**D-C — Guarantees beside the coverage sources, or as a sixth source?** *Default (recommended): beside* (§3.7), which keeps
01 §3.7 (1): unusable order never makes attribution `INDETERMINATE`. *Alternative:* a sixth `COVERAGE_SOURCES` value
`causal_order`. Cost: 00 §8.2's source list is a contract all eight specs bind to, and `isJudgeable` would start gating
attribution on order — the coupling 04 refused.

**D-D — Ship order against #53.** *Default (recommended): build this within thirty days of #53's first deploy* (§4), so no
row is ever lost. *Alternative:* a one-line change on #53 now that keeps the prune from running until this lands. Cost: a
second edit to a PR that is under adversarial review while this is written.
