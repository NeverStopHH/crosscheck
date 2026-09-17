# 01a — The causal skeleton: retention by root reachability, the attestation record, and declared provider guarantees

**Tier 1, as an amendment to 01** — not a new component. **Owns no acceptance test.** It makes AT-4 *durable*: 01 decides
whether two events may be compared, 06 supplies what is compared, and this spec decides how long that answer survives.
**Supersedes the default of 01 §10 D2**, which Nick changed on 2026-09-15 (§2).

**Written against** `main@390849d` with **#53 (`feat/session-event-order`) assumed merged**. A position on that branch carries
the `event-order:` prefix and one on #52 the `coverage:` prefix, following the convention 00 §9.4a set for #50.
`main@390849d` already contains #50 and #49, so a bare line number here is post-#50 main — not the pre-#50 main the rest of
the set binds to. **Built after 06** (§9): the sweep, the attestation and three tests need 06's ledger. Nothing here is built.

**Revision 3, 2026-09-17.** An adversarial review of revision 2 returned 47 findings: 8 confirmed by an independent refuter,
34 plausible but unrefuted, 5 low. Two of them change the model. A pin retained single **rows** while the other roots retained
**sessions**, and deleting part of a session can turn a `broken` causal order into `usable` (§3.3a). And an unresolvable *pin*
licensed the deletion an unresolvable *row* was protected from (§3.3e). §11 maps every finding to where it is answered.

---

## 1. Problem

### 1.1 Today the hub keeps content forever and forgets causality after thirty days

This is the exact inversion of the rule this spec implements, and it is measured rather than inferred. The hub removes rows in
**five** places and nowhere else (every `.delete(` call site in `packages/server/src`, test files excluded, 2026-09-16; no raw
SQL removal exists):

| call site | table | trigger |
|---|---|---|
| `services/developers.ts` | `developer_emails` | a person removes an address |
| `services/developer-settings.ts` | `developer_mutes` | a person removes a mute |
| `services/pins.ts` | `pin_files` | the pin sweep rewrites a pin's files — insert the new path, then delete the old |
| `services/commit-evidence.ts` | `commit_evidence` | age, `COMMIT_EVIDENCE_RETENTION_DAYS = 30` |
| `event-order:services/session-events.ts` `pruneSessionEvents` | `session_events` | age, `SESSION_EVENT_RETENTION_DAYS = 30` |

Every table that holds author-written content — `claims.body`, `artifacts.content`, `work_contexts.title` / `description` /
`intent` / `normalized_doc`, `work_context_targets.value`, `questions` and `question_answers`, and 06's
`work_context_intents.summary` / `reason` / `wire` and `intent_scope.value` — is **never removed**. The one table whose every
column is an id, an enum, an integer or a hub timestamp is removed at thirty days.

The consequence is concrete. 06 §3.5 step 4 drops a ledger entry whose `seq` is null, and drops everything when
`edit.seq === null`. Once an edit's `session_events` row is gone, `explanationTimingFor` answers `absent` / `not_comparable`
for it — *"we do not know the order"* — for every edit older than a month. That is the population crosscheck is meant to be
most useful on: old diagnoses, recurring failures, fence investigations weeks after the change.

### 1.2 The row being removed already is the skeleton

`event-order:services/session-events.ts` says so above `pruneSessionEvents`: *"the row this DELETE removes IS very nearly the
causal skeleton … retiring content sooner than proven order is a change to the MODEL, a tier that outlives what it orders, and
not a different number in this constant."* The columns bear it out (`event-order:db/bootstrap.sql`, `session_events`): `id`,
`session_id`, `seq_epoch`, `seq_n`, `seq_after`, `kind`, `seq_kind`, `seq_reason`, `ref_kind`, `ref_id`, `observed_at`. No
body, no prose, no path — a target's `ref_id` is `targetDigest`, the SHA-256 hex of `[work_context_id, target kind, value]`
joined with `\n`. So D2 cannot be answered by changing thirty to three hundred. It needs a rule for *which* skeleton stays.

### 1.3 "Forever" is not free, and the number is measured

**MEASURED 2026-09-16** (PGlite 0.3.16, the hub's own database, in memory; 20 000 synthetic rows at real value lengths; the
table and all three #53 indexes; the script is reproduced in this spec's pull request and becomes a `VERIFY:` directive at the
constant when built, §6): **476 bytes per row including indexes** — 93 KiB for a 200-row session, 232 KiB for a 500-row one.
The rows-per-session figure is **not** measured: the pilot hub runs 0.9.0 and has no `session_events`, which is 07's to
measure. As arithmetic only: ten developers at twenty sessions a working day for 250 days is 50 000 sessions a year — **1.2
GB/year at 50 rows a session, 12 GB at 500**. On an embedded single-instance database that is a design input, and it is why
§3.3 keeps skeletons by ROOT REACHABILITY rather than keeping all of them.

### 1.4 What a provider can guarantee is prose

01 §8 declared one rung per connector — `event_seq: full | reduced | off` — with a sentence. Cursor's sentence already states
two structured facts in prose (`event-order:connector-cursor/src/capabilities.ts`): no Stop-time git lane, and no pre-tool
handler, *"so an edit's position is taken only AFTER the tool returned and is an upper bound"*. Nothing downstream can read a
sentence. Coverage Integrity (03) never learns that a Cursor session cannot bracket an edit, and a reader of a coverage line
sees `agent_event: complete` for a session whose edits cannot be ordered against its intent.

### 1.5 The sweep runs on the hook path

`event-order:routes/sessions.ts:75-84` awaits `reapStaleSessions` inside `POST /api/sessions` — the request the SessionStart
hook makes — and `event-order:services/sessions.ts:317` runs `pruneSessionEvents` inside that pass, before its early return and
**not** scoped to the calling developer. Whatever the sweep costs, a developer's session start pays it. The route wraps the
whole pass in one `try/catch`, so a sweep that throws also skips that developer's reap.

---

## 2. Principles served

- **"Forget content before you forget causality."** Nick, 2026-09-15, with its operational form: *"Content may expire.
  Proven causal structure should not expire merely because content retention expired."*
- **"Only judge when you know you were watching."** An attestation is written only under complete observation of the session
  it attests (§3.5 rule 2), because Nick defined the record as *"we could prove this then on complete observation"*.
- **"A reason written after a change is not evidence that the reason existed before the change."** AT-4 must still be
  answerable a year later, without the prompt, the tool output or the agent's text.
- **Provider neutrality, in Nick's formulation:** *"every provider must be able to state which causal guarantees it
  provides."* A new vendor may do less; **it may not look like it does more** — on any surface a user reads (§3.7).
- **"Missing evidence may weaken a conclusion. It must never strengthen one."** Nick, 2026-09-17 — the fifth binding
  principle (README §"The six binding principles"). Operationally: *ambiguous or unmatched closure can only reduce certainty,
  never increase it; no valid match → no closure; multiple indistinguishable matches → only a deterministic conservative
  relation that cannot strengthen the causal claim; if even that is not defensible → withhold the relation.* Where this spec
  chooses between two readings, it takes the one that produces **more refusals** and says so at the choice.
- **"Retention requires positive proof to delete, not positive proof to keep."** Nick, 2026-09-17 — the sixth binding
  principle, and the one this spec is the first to implement: *data is deleted only when crosscheck can prove that nothing
  retaining still references it; not knowing is not a reason to delete.*
- **Data minimisation (non-negotiable #6)** is unchanged: nothing in this spec stores text, a path, or a hash of a person.

---

## 3. Target model

### 3.1 Two tiers, mapped onto the tables that exist

| table | author-written content | removed today | tier | 1.0 rule |
|---|---|---|---|---|
| `session_events` | none | age, 30 d | **skeleton** | kept while its session is reachable from a live root (§3.3) |
| `causal_attestations` (new, §3.5) | none | — | **skeleton** | kept while its session's `agent_sessions` row is |
| `session_causal_guarantees` (new, §3.6) | none | — | **skeleton** | kept while its session's `agent_sessions` row is |
| `pin_file_refs` (new, §3.3d) | none | — | **skeleton** | kept while its pin is |
| `agent_sessions` | `branch` | never | skeleton anchor | never removed; FK target of the skeleton |
| `claims` | `body`, and what is derived from it (`tsv`, `embedding`) | never | content, and the institutional memory | §3.4 |
| `claim_edges` | none that is prose | never | structure | never removed in 1.0 |
| `work_contexts` | `title`, `description`, `intent`, `normalized_doc`, `tsv` | never | content | §3.4 |
| `work_context_targets` | `value` (a path), **inside the primary key** | never | content | §3.4 rule 4: cannot expire in 1.0 |
| `work_context_intents` (06) | `summary`, `reason`, `wire` | never | content, with skeleton columns | §3.4 |
| `intent_scope` (06) | `value` (a path), **inside the primary key** | never | content | §3.4 rule 4: cannot expire in 1.0 |
| `artifacts` | `content` | never | content | §3.4, D-A |
| `questions`, `question_answers` | question and answer text | never | content | §3.4 |
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
| `provider` | **added** | copied from `agent_sessions.agent_kind` — one value per session, so the copy is exact |
| `work_context_id` | **added, per ROW** | the work context of the record this row projects, set by the projection handler. It is **not** derived from the session: `work_contexts.session_id` has no unique constraint (only `work_contexts_session_created_idx`), and `extend_diagnosis` files one session's claim into another session's work context, so "the session's work context" does not exist |
| *(not on his list)* | **added** | `file_ref`, the explicit file identity (§3.3d) — only on `file.modified` rows. `tool.failed` also refs a `target_digest`, but of an error fingerprint, which names no file |
| `commit_ref` | **refused on this row** | §8.5 |
| `parent_event_id` / `causal_parent` | **refused on this row** | §8.6 |

`provider` and `work_context_id` are copied so the skeleton answers *which vendor* and *which context* without reading a
content row. A redacted `work_contexts` row keeps its id (§3.4), but a join through it is still a join through content.

### 3.3 Retention by root reachability

**Nick's rule, 2026-09-17:**

> A skeleton row is retained as long as it is reachable from at least one **independent retention root** through **explicit
> references**.
>
> **A Work Context is not a retention root merely because a session belongs to it. It retains causal data only when it is
> itself independently live under an explicit retention rule or reachable from another retention root.**

Every session has a work context, so "a work context references it" is not a retention policy — it is unbounded storage by
another route. The rule separates two relations a schema cannot tell apart on its own:

| relation | example | retains? |
|---|---|---|
| **ownership / containment** | `work_context contains session` | **no** — belonging says nothing about whether anybody still depends on the session's order |
| **retention reference** | a human's pin reaches a file, and that file reaches a session's touch | **yes** — something durable depends on that causal fact |

#### 3.3a The unit of retention is the SESSION

**Revision 2 kept rows. That was wrong, and the review proved it.** Three of its root clauses matched on `session_id`, and the
pin clause matched on `file_ref`, which only `file.modified` rows carry. So a session retained by a pin kept its edits and lost
its `session.started`, `session.ended`, `claim.created` and `commit.observed` rows.

That is worse than lost detail. `event-order:services/session-order.ts` `causalOrderOf` derives a session's order state from
the **set** of rows present: any row with `seq_reason = epoch_conflict` makes it `broken`, more than one epoch makes it `broken`
/ `epoch_split`, and otherwise it is `usable`. Delete the one row that carried the conflict or the second epoch, and the hub
afterwards answers `usable` for a session whose order was `broken`. **Missing evidence strengthens the conclusion** — principle
5, broken by the predicate that was meant to implement principle 6.

So:

1. **A session's skeleton is kept or removed whole.** The sweep selects **sessions**, and removes every `session_events` row of
   a selected session in one statement.
2. **The age is the session's, not a row's.** A session is old enough when it **ended explicitly** — `ended_at IS NOT NULL AND
   reaped_at IS NULL` — more than `SESSION_EVENT_RETENTION_DAYS` ago. A row's `observed_at` plays no part, so a long session is
   never swept in part.
3. **A reaped session is never swept.** `event-order:services/sessions.ts:340-345` makes a reap *revocable* — *"an end the hub
   INFERRED from silence, which a record from that session can disprove"*. Deleting the skeleton of a session that may still be
   running is deleting on an inference. A reaped session keeps its skeleton until it ends explicitly, or until a later policy
   decides otherwise; `doctor` counts such sessions.

#### 3.3b The declared retention graph — a root counts only while it is itself live

**Nick's second rule, 2026-09-17:** an object is a retention root only when **its own lifecycle is independent of the session**
*and* **it is still live under its own retention policy**:

```
live retention root  →  retaining edge  →  session  →  every skeleton row of that session
```

never `intent amendment → skeleton`. His reason: *if practically every session gets an intent amendment and every amendment is
a root forever, nearly every session is immortal again — the Work Context problem moved one table along.* The same holds for
claims. **Every relation that references a session is declared, with its semantics, its liveness and its build status:**

| relation | `retention_semantics` | lifecycle independent of the session? | liveness — **owned by the spec that owns the root** | status |
|---|---|---|---|---|
| `pins`, via `pin_file_refs.file_ref` → `session_events.file_ref` → session | `root` | yes: a person creates it and a person retires it | **the pins feature.** A broken pin is not a dead pin — `pins.broke_at` marks the violated invariant whose history an investigation needs first | built; §3.3d adds the edge |
| `claims.author_session_id` | `root` | yes: a claim is presented long after its session | **02 / 04.** The tree decides "current" in six places (00 §1.5); the registry must name which one is the retention predicate | built |
| `claim_edges.author_session_id` | `root` | yes: an edge (supersedes, contradicts) outlives its session, and `claim.invalidated` is positioned | **02 / 04**, as for claims | built |
| `work_context_intents.author_session_id` (06) | `root` | **06's to decide**: the ledger is append-only, but whether an amended-away version is live is exactly the open question | **`undefined_pending_spec` (06)** — §3.3c | **not built** |
| 04's attribution record | `root` | 04 declares | 04 declares | **not built** |
| `work_contexts.session_id` | `non_retaining_edge` | — | — | built. **Reason:** ownership, not dependence; every registered session has one (Nick, 2026-09-17) |
| `agent_sessions.developer_id` | `non_retaining_edge` | — | — | built. **Reason:** a person owns the session; causal order is not a property of that person |
| `hint_deliveries.session_id` | `non_retaining_edge` | — | — | built. **Reason:** it records what was shown and reads no position |
| `questions.author_session_id` | `non_retaining_edge` | — | — | built. **Reason:** no skeleton kind projects a question (`SESSION_EVENT_KINDS` has none), so nothing a question depends on is in the skeleton |
| `causal_attestations.session_id` | `non_retaining_edge` | — | — | new. **Reason:** an attestation exists so that the skeleton need not be kept — *"the old session need not be reconstructed"* (Nick, 2026-09-15). Retaining through it would make every attested session permanent |
| `session_causal_guarantees.session_id` | `non_retaining_edge` | — | — | new. **Reason:** a declaration about a session, not a dependence on its order |
| `session_events.session_id` | the skeleton itself | — | — | built |

A diagnosis has no row of its own — it is a claim tree — so it retains through `claims` and `claim_edges`. And the Work Context
escape hatch Nick named — *"unless it is itself independently live under an explicit retention rule"* — **has no rule today**.
No work context is independently live in 1.0, so no work context retains. A later spec that gives work contexts their own
retention rule adds a `root` row here, and the generated predicate (§3.3f) picks it up.

#### 3.3c An undefined liveness is KEEP, counted rather than permanent

1. **A built root whose liveness predicate is undefined retains** — principle 6.
2. **That state is a declared value, not a default.** The registry reads `liveness: undefined_pending_spec` and names the spec
   that owes the definition; `doctor` prints *"retention roots with undefined liveness: … (06)"* with the number of sessions it
   keeps; the build fails for a root with no `liveness` key at all.
3. **A root whose table is not built contributes no clause and keeps nothing** — and that is positive knowledge, not a gap: a
   table that does not exist holds no reference. It is not the same thing as a query that *fails* (§3.3g, CSK-17).

The Work Context edge was *wrong* — ownership never implies dependence — so it left the graph. An intent amendment's liveness
is *unknown*, so it gets the conservative answer with a visible price.

#### 3.3d `file_ref` — an explicit file identity, not a reused digest

A pin names a repo and a path; a skeleton row names a `target_digest`. The existing digest cannot join them — it contains the
work context, so the same file touched in two sessions has two digests — and Nick's objection stands on its own: *coupling
retention to a digest whose semantics belong to something else means whoever changes that digest later silently deletes causal
history.*

**The identity, with its encoding pinned.** Revision 2 wrote `||` and left the field boundary open: repo `github.com/acme/ap`
with path `isrc/x.ts` and repo `github.com/acme/api` with path `src/x.ts` hashed the same bytes.

```ts
// packages/schema/src/file-ref.ts
export const FILE_REF_DOMAIN = "crosscheck:file-ref:v1";
export const fileRef = (repoIdentity: string, canonicalPath: string): string =>
  sha256Hex([FILE_REF_DOMAIN, repoIdentity, canonicalPath].join("\n"));   // targetDigest's encoding
```

- **The separator is safe only because neither field may contain it.** `REPO_RELATIVE_PATH` (`schema/src/pin.ts:116`) rejects
  `..` and NUL but **accepts a newline**; `canonicalRepoPath` below rejects `\n` and `\r`, and `fileRef` refuses a
  `repoIdentity` that contains either. CSK-25 pins the collision pair above as two distinct values.
- **One canonicalisation, in one pure function, applied at every door.** `canonicalRepoPath(path)` in `@crosscheck/schema`:
  POSIX separators; collapse `//` and `.` segments; strip a leading `./` and a trailing `/`; Unicode NFC; reject `..`, NUL,
  `\n`, `\r` and an absolute path. It is synchronous, touches no filesystem, and is imported by **both** connector and hub.
  Revision 2 cited `toRepoRelative`, which is async, connector-only and needs two machine-local absolute paths — the hub cannot
  call it, and the pin door never did: `parsePinArgs` pushes raw argv into `files`, so a pin registered as `./src/x.ts` would
  hash differently from every touch of `src/x.ts`, and the sweep would read that as "no pin references it".
- **Filesystem questions are answered before a path leaves the machine.** Case on a case-insensitive filesystem, symlinks, and
  which worktree a path came from are resolved connector-side by `toRepoRelative`; a tracked file is sent in the spelling
  `git ls-files` reports. `canonicalRepoPath` then makes the string canonical. It cannot guess at a filesystem, and does not.
- **The HUB computes `file_ref`, for both sides**, from values it already holds: `pin_files.repo` + `pin_files.path`, and the
  session's repo + the target's `value` at projection time. One implementation on one machine, so two developers' connectors
  cannot disagree, and no new data reaches the hub.
- **A hash of a path is what `target_digest` already is**, so 01 §3.5's content-freedom argument applies unchanged.

**RENAME SEMANTICS — stated, and built rather than refused.** `sweepPinPaths` follows an unambiguous rename, and the hub then
inserts the new `pin_files` row and deletes the old one (`services/pins.ts`), counted in `pins.renamed_paths`. **A pin therefore
means the logical file.** If `file_ref` were read from `pin_files` alone, a rename would sever the root from every session that
touched the file under its old name — the history of exactly the change that renamed it.

So the pin side of the edge is an **append-only history**, not the current row:

```sql
CREATE TABLE pin_file_refs (
  pin_id     text NOT NULL REFERENCES pins(id),
  file_ref   text,                       -- NULL = this path could not be canonicalised (§3.3e)
  first_seen timestamptz NOT NULL,       -- hub clock; display only
  UNIQUE (pin_id, file_ref)
);
```

Every write to `pin_files` — creation, and the sweep's rename — inserts the `file_ref` it computed, and **nothing removes a
`pin_file_refs` row while its pin exists**. A renamed file stays reachable under every name the pin has watched. That makes the
git-derived alias edge revision 2 refused unnecessary: the pin sweep is already the one place that knows both halves of a
rename.

#### 3.3e Unresolvable is KEEP — on BOTH sides

Nick's D-B4, which revision 2 implemented on one side only:

```
retention_decision = KEEP
reason             = unresolved_file_reference
```

- **Session side.** A `file.modified` row whose `file_ref` is NULL keeps its **whole session**.
- **Pin side** — the half revision 2 missed. A `pin_file_refs` row with a NULL `file_ref` never *matches* anything, so an
  equality join reads it as "no pin references this", and that is a deletion. Instead: **while any pin in a repo has an
  unresolved `file_ref`, no session of that repo carrying a `file.modified` row is swept.**

Both are counted under `unresolved_file_reference` and printed by `doctor`, so *"kept because we could not tell"* is a number a
reader can see, never an invisible default.

#### 3.3f The contract, and a predicate generated from it

Nick's D-B5: every reference relation that can reach a session declares `retention_semantics: root | retaining_edge |
non_retaining_edge`, and `non_retaining_edge` requires a reason. **Revision 2 checked only that a declaration exists — so a
relation could be declared `root` and never appear in the hand-written sweep.** Revision 3 closes both directions:

1. **The registry is data** (`server/src/services/retention-registry.ts`): one entry per row of §3.3b, each carrying its
   semantics, liveness and build status, and — for `root` and `retaining_edge` — the `NOT EXISTS` fragment that expresses it.
2. **The sweep is generated from the registry.** No clause exists outside it, and no built `root` or `retaining_edge` is left
   out of it.
3. **CSK-12** enumerates every `session_id` / `author_session_id` column in `db/bootstrap.sql` and fails for one without a
   registry entry, or for a `non_retaining_edge` without a reason. **CSK-22** is table-driven over the registry: for each built
   `root` it seeds an aged session reachable *only* through that root and asserts that the shipped sweep keeps it — so a
   fragment that is wrong fails, not only one that is missing.

#### 3.3g The sweep

Generated from the registry. Its shape today, with 06 and 04 not built:

```sql
WITH eligible AS (
  SELECT s.id FROM agent_sessions s
   WHERE s.ended_at IS NOT NULL AND s.reaped_at IS NULL                               -- §3.3a: ended explicitly, never inferred
     AND s.ended_at < $cutoff                                                         -- SESSION_EVENT_RETENTION_DAYS
     AND NOT EXISTS (SELECT 1 FROM claims c       WHERE c.author_session_id = s.id)   -- root: claims (+ liveness, 02/04)
     AND NOT EXISTS (SELECT 1 FROM claim_edges ce WHERE ce.author_session_id = s.id)  -- root: claim_edges
     AND NOT EXISTS (                                                                 -- root: pins, via their history (§3.3d)
       SELECT 1 FROM session_events pe
         JOIN pin_file_refs pr ON pr.file_ref = pe.file_ref
        WHERE pe.session_id = s.id)
     AND NOT EXISTS (                                                                 -- §3.3e: unresolved, on EITHER side
       SELECT 1 FROM session_events pe
        WHERE pe.session_id = s.id AND pe.kind = 'file.modified'
          AND (pe.file_ref IS NULL
               OR EXISTS (SELECT 1 FROM pin_file_refs pr JOIN pins p ON p.id = pr.pin_id
                           WHERE pr.file_ref IS NULL AND p.repo = s.repo)))
   ORDER BY s.ended_at
   LIMIT $maxSessions                                                                 -- bounded per pass (§6)
)
DELETE FROM session_events WHERE session_id IN (SELECT id FROM eligible);
```

`work_contexts` appears nowhere in it, which is the point. Neither do `causal_attestations` and `questions`: both are declared
non-retaining (§3.3b).

**THE CHECK AND THE DELETE SEE ONE SNAPSHOT** — Nick's D-B7. A root written after the predicate ran and before the rows went
would turn positive deletion evidence into evidence about a state that no longer exists. The predicate is a CTE of the `DELETE`
itself, and the statement runs inside `db.transaction` (already used at five call sites in `services/`), so a later
multi-statement form cannot silently lose the property. The hub's single PGlite instance is **not** the guarantee: requests
interleave between `await`s, so a check-then-delete written as two awaited statements would be exposed even there. CSK-18.

**A FAILED CHECK DELETES NOTHING, AND DOES NOT TAKE THE REAP WITH IT.** The statement is one unit: if a fragment errors, the
transaction rolls back and nothing is removed (CSK-17). The sweep gets its own `try/catch` inside `reapStaleSessions`, counts the
failure and returns. Today one `catch` in the route covers both, so a failing sweep would also skip the caller's reap.

**LIVENESS TERMS** join a root's fragment — `AND <root is live>` — when its owning spec declares them, and never before. A wrong
liveness predicate deletes causal history while looking like a tightening, so this spec invents none (§8.3).

**THE INTERIM RULE, until the file identity is proven** (Nick): no session that carries a `file.modified` row is swept at all
until CSK-15 and CSK-20 pass against real pins and real touches, and `doctor` prints which mode is live. Revision 2 exempted the
*rows*, which under row-grain deletion still removed every other row of every aged session; at session grain, the exemption
means what it says.

**What is lost, named.** An explicitly ended session, more than thirty days old, that no live root reaches — no claim, no claim
edge, no pinned file under any name the pin has had — loses its skeleton, whole. Nothing in 1.0 compares against it: without an
intent, `explanationTimingFor` returns `absent` / `no_intent` at step 1 before reading a position, and 01 §3.7 (1) made
attribution independent of `seq`. Its targets stay, because they are content and `work_context_targets` is never removed.
**Until 06 is built there are no intent roots, and that is why this spec is built after 06** (§9). Swept earlier, a session
whose intent 06 would have recorded is unreachable by construction.

### 3.4 The content rule — redaction in place, never removal, for anything the skeleton references

This spec adds **no content expiry by default** (D-A). It adds the rule that makes a later content policy safe:

1. **Content expires by redaction in place, never by row removal**, for any row a skeleton row or an attestation references:
   `claims`, `claim_edges`, `work_context_intents`, `work_contexts`, `artifacts`, `questions`, `question_answers`,
   `agent_sessions`. Each gets `content_expired_at timestamptz NULL`. Redaction sets it, replaces each content column with the
   fixed marker `[expired]` — which every `NOT NULL` and length `CHECK` on those columns accepts — and **nulls what was derived
   from the content** (`claims.tsv`, `claims.embedding`, `work_contexts.normalized_doc`, `work_contexts.tsv`), because a vector
   or a tsvector reconstructs what the marker hid. Ids and foreign keys survive, so `ref_id` always resolves.
2. **No skeleton reader inner-joins a content column.** The order half of `explanationTimingFor`, `isOrderable`, the
   attestation reader and the §5 doctor lines read ids, enums and positions only. A redacted referent renders as the
   renderer-owned literal `content expired`, and is still orderable.
3. **06 step 5 is the one place where order needs content**: `intent_scope` holds the path each intent names. The attestation
   (§3.5) is what answers once the scope can no longer be read.
4. **Two content columns cannot expire in 1.0 — a refusal, not an oversight.** `work_context_targets.value` and
   `intent_scope.value` are inside their tables' primary keys. Redacting them in place would change row identity and collide
   rows, and removing them would break rule 1. Their content stays until a later spec gives them a content-free identity.

`content_expired` is a render state in 03's sense (enum, never prose), and adds one case to the render-surface registry (00 §6)
per surface in §5 — **no untrusted slot**, since the literal is renderer-owned.

### 3.5 The Causal Attestation Record

When order has already produced a load-bearing statement, the statement is kept as its own row, so the old session never has to
be reconstructed.

```sql
CREATE TABLE causal_attestations (
  id                     text PRIMARY KEY,   -- ca_ + 32 hex of sha256([session_id, seq_epoch, subject_ref, object_ref, ladder_version].join("\n"))
  session_id             text NOT NULL REFERENCES agent_sessions(id),
  seq_epoch              text NOT NULL,
  statement              text NOT NULL,      -- enum: predeclared_explanation | post_hoc_explanation | declared_non_goal_edited
  relation               text NOT NULL,      -- enum: happens_before | happens_after
  subject_ref            text NOT NULL,      -- work_context_intents.id (iv_…)
  object_ref             text NOT NULL,      -- session_events.id (se_…) of the edit
  subject_seq            integer NOT NULL,
  object_seq             integer NOT NULL,
  object_seq_after       integer NOT NULL,   -- the bracket the comparison relied on (rule 3)
  timing_reason          text NOT NULL,      -- 06 TIMING_REASONS, the three order-derived values only
  observation            jsonb NOT NULL,     -- viewer-INDEPENDENT coverage only (rule 5)
  guarantees_at_judgment jsonb NOT NULL,     -- the session's §3.6 declarations: enums only
  ladder_version         integer NOT NULL,   -- EXPLANATION_LADDER_VERSION at write time
  attested_at            timestamptz NOT NULL -- hub clock; display only, orders nothing
);
CREATE INDEX causal_attestations_session_idx ON causal_attestations (session_id);
CREATE INDEX causal_attestations_object_idx  ON causal_attestations (object_ref);
```

**Rules.**

1. **Written once, when the session ends EXPLICITLY** — on `session.ended` ingest, where `reaped_at` stays null. **Never on a
   reap:** a reap is revocable (§3.3a), so an attestation frozen then could describe a session that later continued and went
   `broken`, and would still be read as settled.
2. **Written only under complete observation.** Nick defined the record as *"we could prove this then on complete
   observation"*. A statement is attested only when the session's `agent_event` rung (03) is `complete` at that moment;
   otherwise nothing is attested, and the live skeleton — kept by its roots — stays the only answer. Revision 2 attested under
   any coverage and glossed the record as *"on this much observation"*: a weaker claim, made silently.
3. **Only statements order produced.** A row is written when `explanationTimingFor` answers `declared_before`,
   `declared_after` or `declared_non_goal_edited`, and `isOrderable` held. No other reason depends on the skeleton. An
   `observed` edit, or one without a bracket, is `not_comparable` under 01 and #53, so `object_seq_after` can be `NOT NULL`.
4. **Bounded on the hub.** One row per `(session, epoch, edited target)`, capped at `ATTESTATIONS_MAX_PER_SESSION`; the rest are
   counted, not written. `MAX_SEEN_TARGETS` is a connector-side cap the hub does not enforce, so it cannot be the bound.
5. **The coverage it stores is viewer-independent.** On #52, `readCoverage` takes a `viewerDeveloperId`
   (`coverage:server/src/services/coverage.ts:466`) because the git rung's census is scoped to what that viewer may be told. An
   attestation is written on an ingest path that has no viewer, and read by everyone. So it stores only the rungs that do not
   depend on the viewer — this session's `agent_event` record and the three refused rungs — and the `git` rung is recomputed
   for the asking viewer at read time. CSK-24.
6. **`ladder_version` makes a wrong attestation findable, and a superseded one is not used.** 06 §3.5 records that its first
   draft of step 6 answered a violated non-goal `predeclared`. A row older than the current `EXPLANATION_LADDER_VERSION` is
   `attestation_superseded`: **its statement is withheld** — the consumer gets `not_comparable` with that reason — and the old
   statement is shown only as history. Principle 5: a statement from a ladder since found wrong may weaken an answer, never
   supply one.
7. **Readers: live first, attestation second, disagreement counted.** A consumer asks the live ladder; only when the skeleton or
   the scope content is gone does it read a current-version attestation, and the render says *attested at … under complete
   observation*. When both answer with the same version and disagree, the live answer is used and `attestation_disagreements`
   is counted — both read the same positions, so a disagreement is a defect signal.
8. **No text.** Every column is an id, an enum, an integer, a timestamp, or JSON whose leaves are enums and ISO timestamps,
   validated on write with the zod schemas 03 and §3.6 export.

**What an attestation is not.** Not a verdict, not a permission, not a cache of 04 — and **not a retention root** (§3.3b): it
exists so that the skeleton it summarises may go. 04 still computes attribution fresh; principle 2 is untouched.

### 3.6 Declared causal guarantees

```ts
// packages/schema/src/causal-guarantees.ts
export const CAUSAL_GUARANTEES = ["undeclared", "unavailable", "partial", "guaranteed"] as const;   // weakest first
export const CAUSAL_GUARANTEE_REASONS = [
  "bracketed_by_pre_tool",      // guaranteed: every producing lane opens the position before the tool runs
  "lifecycle",                  // guaranteed: n = 0 or the terminal position, with no tool to race
  "unbracketed_lane",           // partial: some producing lane positions only after the fact
  "observed_lane_only",         // partial: the kind is produced only by an observing lane (git diff)
  "derived_after_the_fact",     // partial: a derived record is positioned when written down, after the turn it describes
  "ambiguous_session_possible", // partial: the MCP picker's ambiguity (01 D1) can withhold the position
  "no_emitter",                 // unavailable: this connector never produces the kind
  "not_built",                  // unavailable: the kind's producer does not exist yet
  "provider_undeclared",        // undeclared: the session sent no declaration
] as const;
```

**The weakest-lane rule.** A connector declares, per kind, the guarantee of the **weakest lane that can produce it**. Claude Code
produces `file.modified` from bracketed Edit-family tools, from Bash — which is in `POST_TOOL_USE_MATCHER =
"Edit|Write|MultiEdit|NotebookEdit|Bash"` and not in `PRE_TOOL_USE_MATCHER = "Edit|Write|MultiEdit|NotebookEdit"`
(`event-order:connector-core/src/constants.ts`) — and from the Stop git lane. So its `file.modified` is `partial` /
`unbracketed_lane`, however good its Edit path is.

**Where it lives, and what the build can actually check.** Revision 2 promised that the existing meta-test would learn which kind
each call site produces. It cannot: connectors emit `target` / `claim` / `session` records, and the projection to the seven dotted
names happens on the hub. So the map is declared where the kinds are — a table in `connector-core`, `(connector, kind) → { lane,
producingModules }` — and the build checks what an import graph can prove, in both directions:

- every module that calls `allocateSeq`, `allocateToolSeq` (connector-core's — not the MCP helper of the same name in
  `mcp/tools/shared.ts`) or `openToolWindow` appears in the map, and every module in the map calls one of them;
- a kind declared `guaranteed` / `bracketed_by_pre_tool` has **no** producing module outside a pre-tool-bracketed lane;
- the map's kinds agree with the hub's projection (`TARGET_EVENT_KINDS`, `seqKindFor`), so the two cannot drift.

This is a **new mechanism** this spec asks for, not a check the existing registry test "gains".

**Initial declarations**, read from `event-order:` at `91d79dc` — to be **re-derived by the builder, not copied**:

| kind | `claude-code` | `cursor-ide` | `acp:*` |
|---|---|---|---|
| `session.started` | guaranteed / `lifecycle` | guaranteed / `lifecycle` | guaranteed / `lifecycle` |
| `file.modified` | partial / `unbracketed_lane` | partial / `unbracketed_lane` | partial / `unbracketed_lane` |
| `tool.failed` | partial / `unbracketed_lane` | partial / `unbracketed_lane` | builder derives |
| `claim.created` | partial / `derived_after_the_fact` — the summarizer's claims are a weaker lane than MCP ambiguity | builder derives the weakest lane | builder derives |
| `claim.invalidated` | builder derives | builder derives | builder derives |
| `commit.observed` | guaranteed / `lifecycle` | unavailable / `no_emitter`¹ | unavailable / `no_emitter`¹ |
| `session.ended` | guaranteed / `lifecycle` | guaranteed / `lifecycle` | builder derives |
| `intent.declared`, `intent.amended` | unavailable / `not_built` | unavailable / `not_built` | unavailable / `not_built` |

¹ `collectCommitEvidence` has exactly one caller, `connector-claude/src/hooks/session-start.ts`. `connector-core` re-exports it
from `index.ts` and `kit.ts`, so a fourth connector built on the kit can start calling it — and its declaration must then change
with it, which the map check enforces.

**Transport.** The declaration travels in the `session.started` record body — at most nine enum triples — into
`session_causal_guarantees (session_id, kind, guarantee, reason, PRIMARY KEY (session_id, kind))`. A session that sends none is
stored as nothing, and read as `undeclared` / `provider_undeclared`, never as `guaranteed`.

**Rows outrank declarations — on every surface, not only in doctor.** Comparability is decided per row by `seq_kind` and
`seq_after`. A row that contradicts its session's declaration — an `observed` or unbracketed `file.modified` from a session
that declared `guaranteed` — is counted as `declaration_contradicted` **and** caps that session's effective guarantee for the
kind at `partial`, with that reason (§3.7). Revision 2 counted it in doctor only, while the coverage line, the briefing and the
referee page kept showing `guaranteed`: the surface a user reads went on looking more capable than the rows.

### 3.7 Where it enters Coverage Integrity — beside the source lines, not as one

Nick's direction is that missing capability *"becomes part of Coverage Integrity"*. 01 §3.7 (1), resolved against 04, is that
**unusable order must not force attribution to `INDETERMINATE`** — attribution never reads `seq`. Both hold if the guarantees
are part of the coverage **record** but not one of its **sources**:

```ts
interface CoverageRecord {
  // …03's fields, unchanged; COVERAGE_SOURCES keeps its five values and its order (00 §8.2)
  readonly order: {
    readonly state: CausalGuarantee;          // "undeclared" | "unavailable" | "partial" | "guaranteed"
    readonly reason: CausalGuaranteeReason | "declaration_contradicted" | "no_session_in_scope";
    readonly sessions: number;                // sessions in scope the state was computed over
  };
}
```

**The fold, defined.** `CAUSAL_GUARANTEES` is ordered weakest first. `order.state` is the **minimum**, over the sessions in scope
and the kinds the question needs, of each session's *effective* guarantee — its declaration, capped by its own rows (§3.6).
**An empty scope is `undeclared` / `no_session_in_scope`.** Revision 2 left the empty case open, and a plain minimum over nothing
returns the strongest value — less observation producing a stronger statement. A session that declared nothing contributes
`undeclared`, and therefore wins the fold.

`isJudgeable` (03) does not read `order`. `isOrderable`'s callers do, and a timing answer computed under `order.state !==
"guaranteed"` renders that state beside it. **The coverage line stays one record, and the two gates stay orthogonal.** D-C
records the alternative.

The two copies of the coverage vocabulary (`coverage:server/src/services/coverage.ts` and
`coverage:connector-core/src/http/coverage.ts`) gain the same `order` type, and 03's parity test covers it. `COVERAGE_REASONS`
is not extended.

---

## 4. Migration

1. **`session_events`**: `ADD COLUMN IF NOT EXISTS` `provider text`, `work_context_id text`, `file_ref text`, plus
   `session_events_file_ref_idx`. New rows are written complete by the projection handler. **The backfill, and what it cannot
   reach:**
   - `provider` — from `agent_sessions.agent_kind`; exact, since there is one value per session.
   - `work_context_id` — for `claim.created` rows from `claims.work_context_id` through `ref_id`; for `claim.invalidated` rows
     through `claim_edges`; for `file.modified` and `tool.failed` rows by recomputing `targetDigest` over
     `work_context_targets` **in SQL** — `encode(sha256(convert_to(work_context_id || E'\n' || kind || E'\n' || value,
     'UTF8')), 'hex')`, matched on `ref_id`. For the session-level kinds it stays NULL: they belong to no single work context.
   - `file_ref` — the same `work_context_targets` join yields the target's `value`; the hub applies `canonicalRepoPath` and
     `fileRef` in application code. **A row the join does not match, or whose path does not canonicalise, stays NULL** and
     keeps its session (§3.3e). The number of unresolved rows is printed, and a backfill that reports zero is investigated
     rather than trusted.
   None of this is the wall-clock backfill 01 §8 refuses: it copies identity, not order, and touches no position.
2. **Indexes** for §3.3g: `claims (author_session_id)`, `claim_edges (author_session_id)`, and `agent_sessions (ended_at)
   WHERE reaped_at IS NULL`.
3. **`pin_file_refs`** (§3.3d): created, and seeded from every existing `pin_files` row through `canonicalRepoPath` and
   `fileRef`. **Before seeding, the pin door canonicalises** — `parsePinArgs` in the CLI and the hub's pin route — so no new pin
   is stored in a spelling the seed would disagree with.
4. **`causal_attestations`** and **`session_causal_guarantees`**: new tables, mirrored in `db/bootstrap.sql` and pinned by
   `test/ddl-sync.test.ts`. Sessions that ended before deploy get **no attestation**: attesting after the fact would write under
   an observation nobody recorded at the time.
5. **`content_expired_at timestamptz NULL`** on the eight tables of §3.4 rule 1. Nothing sets it in 1.0 unless D-A says so.
6. **The retention registry** (§3.3f) and the generated sweep, which replaces `pruneSessionEvents`' body.
   `SESSION_EVENT_RETENTION_DAYS` keeps its value, and its comment names its new meaning.

**The sweep stays off until this spec lands.** Nick's D-D decision of 2026-09-17: #53 withdraws the call to
`pruneSessionEvents` with a documented refusal before it merges (in progress on that branch as this is written). The first
deploy that deletes a skeleton row is therefore the one that deletes it by §3.3g. The price is a table that grows without bound
between the two merges, which `doctor` prints and §1.3 sizes at 476 bytes a row.

---

## 5. Where it renders, and who consumes it

| surface | adds | untrusted slots |
|---|---|---|
| `crosscheck doctor` | sweep mode (off / interim / full); sessions kept, by the root that keeps them; sessions kept for `unresolved_file_reference`; roots with `undefined_pending_spec` and what they keep; reaped sessions awaiting an explicit end; sweep failures; attestations written, capped, superseded and disagreeing; `declaration_contradicted`; this connector's declaration table | none — counts, enums, ISO timestamps |
| coverage line (03) | `order: <state> (<reason>) over <n> sessions` | none |
| `get_diagnosis`, referee page, briefing | a timing answer read from an attestation renders *attested at <ISO> under complete observation*; a superseded one renders as withheld; a redacted referent renders `content expired` | none |

**Consumers.** 06's `explanationTimingFor` (the attestation fallback), 04 through 06, and 07's pilot counters — sessions kept
against sessions swept, and by which root, are pilot measurements. The render-surface registry (00 §6) gains the literals;
`INJECTION_CORPUS` gains no case, because no new slot carries author text.

---

## 6. Budget

**Revision 2 said "hook path: 0 ms added". That was wrong** for the part that dominates: the sweep runs inside
`POST /api/sessions` (§1.5), so a SessionStart pays for it. What each part costs, and where:

- **Sweep — on the SessionStart request.** Bounded to `SESSION_EVENT_SWEEP_MAX_SESSIONS` per pass, ordered by `ended_at`, in its
  own transaction and its own `try/catch`. **MEASURE before merge** on PGlite, at 100 000 `session_events` rows with half of
  their sessions retained, with the generated clauses: milliseconds per pass at the cap, written as a `VERIFY:` directive at the
  constant. If a pass does not fit comfortably inside the SessionStart request's own timeout, the sweep moves off the request
  path — the builder decides that on the number.
- **Declaration — on the SessionStart request.** One constant array in a body already sent, and one `INSERT` into
  `session_causal_guarantees` in the existing transaction. MEASURE the body-size delta.
- **`file_ref` — at ingest, on the hub.** One `canonicalRepoPath` and one SHA-256 per `file.modified` target, beside the
  `targetDigest` already computed there. No connector cost.
- **Attestation — on the SessionEnd request.** One ladder pass over the session's edited targets and intent chain, and at most
  `ATTESTATIONS_MAX_PER_SESSION` inserts. MEASURE at 50 and 500 edited targets.
- **Storage.** 476 B per skeleton row today (§1.3). Re-measure with the three new columns, and report the attestation and
  `pin_file_refs` row sizes.

The predicate has four `NOT EXISTS` probes today, and gains one per root as 06 and 04 land — the count is the registry's, not a
number in this section.

---

## 7. Acceptance tests

Every test names its mutation anchor. Every anchor joins `mutation-check.ts`, and **all three** listings in
`.github/workflows/ci.yml`, plus the per-test listing in `mutation-check.ts`, are regenerated by running their commands. No
count is written here.

**CSK-1 — a claim keeps its whole session.** An explicitly ended session, 31 days old, with one `claim.created`, one
`file.modified` and its lifecycle rows: after the sweep, every row remains. *Fails if* any row of that session is removed.
*Mutation:* drop the `claims` fragment from the registry.

**CSK-2 — an intent version keeps its session, and the timing survives.** With 06 built: as CSK-1, with a ledger row that
predates a bracketed edit and no claim; the rows remain **and** `explanationTimingFor` still answers `declared_before`.
*Mutation:* drop the `work_context_intents` fragment.

**CSK-3 — a session nothing reaches is swept, whole.** An explicitly ended session with events only, 31 days old, loses every
row; one 29 days old keeps every row. *Fails if* the sweep became "never", or removed part of a session. *Mutation:* remove the
age term.

**CSK-4 — an attestation answers after the skeleton is gone.** End a session explicitly, under complete observation, with an
intent that predates a bracketed edit; remove its skeleton as a later policy would; the timing answer is still `predeclared` /
`declared_before`, rendered as attested. *Fails if* it becomes `absent`. *Mutation:* skip the attestation read.

**CSK-5 — attested only when order produced it and observation was complete.** A session answering `no_intent`, one answering
`not_comparable`, and one with `agent_event: incomplete` each write zero attestations. *Mutation:* drop the observation gate.

**CSK-6 — a superseded ladder's statement is withheld.** An attestation one version behind yields `not_comparable` /
`attestation_superseded`, is counted, and its old statement appears only as history. *Fails if* a superseded `predeclared` is
returned as the answer. *Mutation:* fall through to the superseded statement.

**CSK-7 — no connector declares more than its weakest lane, and the map matches the code.** A declaration of `file.modified:
guaranteed` while a Bash-reachable module allocates for it fails the build; so does an allocating module missing from the map,
and a map kind the hub's projection does not produce. *Mutation:* fold the lanes with `max`.

**CSK-8 — an empty or undeclared scope is never read as guaranteed.** A scope with no sessions yields `undeclared` /
`no_session_in_scope`; a session without a declaration yields `undeclared` / `provider_undeclared`. *Mutation:* seed the fold
with `guaranteed`.

**CSK-9 — a contradicting row lowers what the user sees.** A session declaring `guaranteed` that sends an `observed`
`file.modified` increments `declaration_contradicted` **and** renders `order: partial (declaration_contradicted)` on the
coverage line. *Mutation:* count without capping.

**CSK-10 — no text reaches the skeleton.** Plant marked text in a claim body, an intent summary, a target path, an artifact and
a question; end the session; search `session_events`, `causal_attestations`, `session_causal_guarantees` and `pin_file_refs`
byte for byte. *Fails if* one marker is found. This extends 01's content-free test rather than adding a parallel one.

**CSK-11 — a pin keeps the WHOLE session, including the evidence of a broken order.** An aged session whose only root is a
pinned file it touched, and which carries an `epoch_conflict` row on a `claim.created`: after the sweep every row remains, and
the session's order still reads `broken`. *Fails if* any row goes, or the order reads `usable`. *Mutation:* match the pin
fragment on `file_ref` alone instead of on the session.

**CSK-12 — no session-bearing relation may be silent about retention.** A `session_id` or `author_session_id` column in
`bootstrap.sql` without a registry entry, or a `non_retaining_edge` without a reason, fails the build. *Mutation:* make the
undeclared case a warning.

**CSK-13 — ambiguity never strengthens a relation.** A table of pairs, each input with and without its ambiguity — a superseded
attestation, an undeclared session, an empty scope, a redacted referent, an unresolved `file_ref` on either side, a reaped
session, a `broken` order: every ambiguous answer equals the unambiguous one or is weaker, and no retention decision under
ambiguity is `DELETE`. *Mutation:* make the superseded branch fall through to the live answer.

**CSK-14 — the sweep is off until this spec turns it on, and says so.** Lands in **#53** (D-D): with the age sweep withdrawn, an
aged unreferenced session keeps every row, and `doctor` prints the refusal. *Mutation:* restore the `pruneSessionEvents` call.

**CSK-15 — the file identity links, and an unresolved one keeps, on both sides.** (a) A pin created through the CLI as
`./src/x.ts` and a session that edited `src/x.ts` produce the same `file_ref`; two worktrees of one repo agree; two repos with
the same path do not. (b) A `file.modified` row with a NULL `file_ref` keeps its session. (c) A pin in the repo with a NULL
`file_ref` keeps every file-bearing session of that repo. *Fails if* any of the three deletes. *Mutation:* compare
`pr.file_ref = pe.file_ref` without the unresolved clause.

**CSK-16 — a work context alone does not retain.** An explicitly ended aged session with a work context and nothing else is
swept. *Fails if* it survives. *Mutation:* add a `work_contexts.session_id` fragment.

**CSK-17 — a failed root check deletes nothing, and the reap still runs.** Make one fragment's query error: no row is removed,
the failure is counted, and the calling developer's stale sessions are still reaped. *Fails if* the error is read as "no
reference", or takes the reap down. *Mutation:* catch the fragment's error in the statement builder and drop the fragment.

**CSK-18 — a root that appears during the sweep still protects.** Between the predicate's evaluation and the delete, commit a
pin — or a claim — for an eligible session through the hub's own paths: its rows survive. *Mutation:* split the CTE and the
`DELETE` into two awaited statements.

**CSK-19 — a dead root stops retaining; an undefined liveness keeps, and is counted.** (a) For a root whose owning spec has
declared liveness, an object that fails it does not by itself keep an aged session. (b) For `undefined_pending_spec`, the
session is kept, and `doctor` names the owing spec and the count. *Mutation for (b):* keep without counting.

**CSK-20 — a rename never shortens retention, and canonicalisation agrees everywhere.** (a) Pin a file, touch it in session A,
rename it through `sweepPinPaths`, touch it in session B: both sessions are kept, because `pin_file_refs` holds both names. (b)
The matrix — `./`, `//`, a trailing `/`, `.` segments, NFC against NFD, and a path reached through two worktrees — yields one
`file_ref` wherever the rule claims equality, and a rejection for `..`, NUL, `\n` and an absolute path. *Fails if* a rename
lets session A go. *Mutation:* remove the old `pin_file_refs` row on rename.

**CSK-21 — partial deletion is impossible.** For every eligible session, either all of its rows are removed or none. A session
whose rows straddle the cutoff by `observed_at` is decided by its `ended_at` alone. *Mutation:* reintroduce a row-age term.

**CSK-22 — every declared root is in the predicate, and does what it says.** Table-driven over the registry: for each built
`root`, seed an aged session reachable only through it, and assert that it survives; for each fragment, assert that a registry
entry owns it. *Mutation:* remove one fragment while keeping its registry row.

**CSK-23 — a reaped session is neither swept nor attested.** An aged session closed by the reaper keeps every row and has no
attestation; after a revival and an explicit end, both become possible. *Mutation:* drop `reaped_at IS NULL`.

**CSK-24 — an attestation carries no viewer-scoped coverage.** An attestation written for developer A renders to developer B no
`git` rung state that B's own `readCoverage` would not produce. *Mutation:* store the full `CoverageRecord`.

**CSK-25 — the file identity's encoding is unambiguous.** Repo `github.com/acme/ap` with path `isrc/x.ts`, and repo
`github.com/acme/api` with path `src/x.ts`, yield two values; a path containing `\n` is rejected before hashing. *Mutation:*
join with the empty string.

---

## 8. Refusals

1. **No content expiry is switched on by this spec.** The mechanism (§3.4) ships; the policy is D-A.
2. **No skeleton is removed while a live root reaches its session**, and no setting overrides that in 1.0. A stricter compliance
   policy that also removes metadata is possible later as a deliberately chosen policy — Nick's words — and would be its own
   spec, stating what AT-4 can then no longer answer.
3. **No liveness predicate is invented here.** Each root's liveness is declared by the spec that owns it (§3.3b). Where it is
   missing, the state is `undefined_pending_spec`, and everything it reaches is kept, counted and printed.
4. **No content expiry for `work_context_targets.value` or `intent_scope.value` in 1.0** (§3.4 rule 4): both are inside a
   primary key.
5. **No `commit_ref` on the skeleton row.** `commit.observed` refs the session (01 §3.5), and a claim's commit is 02's binding on
   `claims`, which is never removed. Copying it here would duplicate 02's authority. The tension 02 records — it refused a
   per-commit table while Nick's direction note asks for commit-level identity — is untouched here and remains Nick's.
6. **No `causal_parent` in 1.0.** No emitter knows a parent event; the only parent-like fact is the tool window, already stored
   as `seq_after`. Subagent parentage is 00 §10 Q2's open half, and it is not guessed.
7. **No attestation for sessions that ended before deploy, for reaped sessions, or under incomplete observation**, and none is
   written on read.
8. **No retention through an attestation** (§3.3b): it exists so that the skeleton may go.
9. **No sixth coverage source** (§3.7, D-C).
10. **No cross-session attestation.** 01 §8.1 holds: order exists inside one `(session, epoch)`.

---

## 9. Collisions and build order

**Build order: after 06.** The sweep's intent root, the attestation's `subject_ref`, `timing_reason`,
`EXPLANATION_LADDER_VERSION`, and CSK-2 and CSK-4 all need 06's ledger and ladder. Swept earlier, sessions whose intents 06
would have recorded are unreachable by construction. README's build order places 01a between 06 and 02. Nothing is lost by
waiting, because the sweep is off (D-D).

- **#53 (`feat/session-event-order`)** — carries D-D's change: the call to `pruneSessionEvents` is withdrawn with a documented
  refusal before that PR merges, and CSK-14 lands there. This spec replaces that function's body
  (`services/session-events.ts`), moves the sweep into its own `try/catch` inside `reapStaleSessions`
  (`services/sessions.ts`), rewrites the comment on `SESSION_EVENT_RETENTION_DAYS`, and adds three columns to `session_events`
  in `db/bootstrap.sql`.
- **#52 / 03** — `CoverageRecord` gains `order` in **both** copies; 03's parity test and COV-5 shape are edited;
  `COVERAGE_REASONS` is not. §3.5 rule 5 depends on `readCoverage`'s `viewerDeveloperId` staying the viewer boundary.
- **06** — `work_context_intents` is a root whose liveness 06 owes; `explanationTimingFor` gains the attestation fallback and
  `EXPLANATION_LADDER_VERSION`; `intent_scope.value` is refused content expiry.
- **02 / 08** — `claims` gains `content_expired_at` in the migration family 02 and 08 already share, which makes this spec its
  third editor; 02 owes the claims liveness predicate the registry names.
- **04** — consumes timing through 06 only; owes its attribution record's registry entry when it lands.
- **07** — `PILOT_RETENTION_DAYS = 90` is unrelated; 07 gains the kept / swept / by-root counters.
- **Pins (#50's feature)** — `pin_file_refs`; the pin write path and the sweep's rename (`services/pins.ts`) insert into it;
  `parsePinArgs` (CLI) and the pin route canonicalise at the door.
- **Schema** — `file-ref.ts` (`fileRef`, `canonicalRepoPath`) and `causal-guarantees.ts`. `pin.ts`'s `REPO_RELATIVE_PATH` stays
  a validator; canonicalisation happens before it.
- **Routes** — `routes/sessions.ts:75-84` keeps calling the reaper; the sweep's cost on that request is §6's measurement.
- **Connectors** — each `capabilities.ts` gains a declaration; `connector-core` gains the `(connector, kind)` map and its build
  check (§3.6).
- **`mutation-check.ts` and `.github/workflows/ci.yml`** — one anchor per CSK that names one; every derived listing is
  regenerated by running its `VERIFY:` command.

---

## 10. Decisions for Nick

**D-A — Does any content expire in 1.0?** *Default (recommended): no.* The mechanism ships (§3.4); nothing sets
`content_expired_at`. Your note names *"strukturierte Begründung, Oberflächendetails, Werkzeug-Metadaten, Zusatzinformationen"*
as the thirty-day tier. The complete inventory against the hub: prompts, tool output and agent prose are not stored at all
(non-negotiable #6); the outbox carries ids only; what remains is claims (with their derived search vector and embedding), claim
edges, work contexts (title, description, intent, normalised document), targets, intents and their scope, artifacts, and
questions with their answers — the institutional memory your same note wants kept. The one table that matches
*"Zusatzinformationen"* cleanly is `artifacts.content`. *Alternative:* redact `artifacts.content` at thirty days and keep the
row. Cost: an approved artifact attached to a live claim disappears from that claim a month later.

**D-B — CLOSED 2026-09-17 by Nick.** He refused the either/or revision 1 offered (*"a digest on `pin_files`, or keep
everything"*): the pin question exposed a missing retention semantics, not a missing column.

- **D-B1** Retention is reachability from explicit roots (§3.3).
- **D-B2** Intrinsic ownership — `Work Context → its own session` — is not a root (§3.3b).
- **D-B3** Pins are roots and connect through an explicit `file_ref`, never a reused generic digest (§3.3d).
- **D-B4** An unresolvable reference is `KEEP` / `unresolved_file_reference` (§3.3e) — on both sides, since revision 3.
- **D-B5** Every session-bearing relation declares its retention semantics, or the build fails (§3.3f).
- **D-B6** A root counts only while it is itself live, and only if its lifecycle is independent of the session (§3.3b, §3.3c).
- **D-B7** The check and the delete see one snapshot (§3.3g).
- **D-B8** `file_ref` has stated rename semantics (§3.3d) — built through `pin_file_refs` since revision 3, not refused.

The sixth binding principle follows from them: *"Retention requires positive proof to delete, not positive proof to keep."*

**Two choices revision 3 makes on your words — overrule them if they misread you:**

- **The attestation is not a retention root** (§3.3b), although your first object list named Causal Attestation. The reading:
  you defined the record so that *"the old session need not be reconstructed"*, and your later rule makes a root retain only
  *"as far as its policy says it must preserve the underlying causality"*. An attestation's purpose is to replace that
  causality, so retaining through it would make every attested session permanent.
- **The attestation is written only under complete observation** (§3.5 rule 2), reading *"we could prove this then on complete
  observation"* as a condition rather than a description. Cost: a session with incomplete `agent_event` coverage gets no
  attestation, keeps its skeleton only through live roots, and loses its timing once the skeleton goes.

**D-C — Guarantees beside the coverage sources, or as a sixth source?** *Default (recommended): beside* (§3.7), which keeps 01
§3.7 (1): unusable order never makes attribution `INDETERMINATE`. *Alternative:* a sixth `COVERAGE_SOURCES` value
`causal_order`. Cost: 00 §8.2's source list is a contract all eight specs bind to, and `isJudgeable` would start gating
attribution on order — the coupling 04 refused.

**D-D — DECIDED 2026-09-17 by Nick: the sweep is switched off on #53 before it merges.** His reason: *deploying a retention
mechanism you already know deletes exactly the data later causal statements need is unnecessary risk.* The earlier thirty-day
argument made data survival depend on a delivery date. On #53 this is a documented refusal that `doctor` prints, not a
commented-out line. This spec turns the sweep back on with §3.3g, and CSK-14 is the test.

---

## 11. What the review of revision 2 changed

47 findings (2026-09-17): 8 survived an independent refuter, 34 got none (30 beyond the review's refuter cap, and 4 whose
refuter died on a session limit), and 5 were low. Every one is answered below. "Unrefuted" means plausible and checked by the
author against the code — not independently verified.

| finding | status | answered in |
|---|---|---|
| A pin keeps one row of the session it protects, not the session | confirmed, CRITICAL | §3.3a, §3.3g, CSK-11, CSK-21 |
| An unresolvable or renamed pin licenses deletion | confirmed, HIGH | §3.3d `pin_file_refs`, §3.3e, CSK-15 (c), CSK-20 |
| An unresolvable PIN licenses the deletion the spec forbids | confirmed, MEDIUM | §3.3e, CSK-15 (c) |
| `coverage_at_judgment` replays one viewer's coverage to every reader | confirmed, CRITICAL | §3.5 rule 5, CSK-24 |
| `file_ref` concatenates without a delimiter | confirmed, MEDIUM | §3.3d encoding, CSK-25 |
| The normalisation is connector-side, and the pin door skips it | confirmed, HIGH | §3.3d `canonicalRepoPath`, §4.3, CSK-15 (a) |
| The build check cannot derive kinds from connector source | confirmed, HIGH | §3.6 map, CSK-7 |
| Nothing forces a declared root into the sweep predicate | confirmed, HIGH | §3.3f generated predicate, CSK-22 |
| `claim_edges` and `questions` are undeclared session-bearing relations | unrefuted; checked against `bootstrap.sql` | §3.3b |
| A pin with a NULL `file_ref` protects nothing | unrefuted | §3.3e |
| `work_context_id` is not a function of a session | unrefuted; checked (no unique constraint) | §3.2, §4.1 |
| "Complete observation" is silently weakened and never gated | unrefuted | §3.5 rule 2, §10 |
| An over-declaring vendor still looks more capable on the surface | unrefuted | §3.6, §3.7, CSK-9 |
| D-B2's escape hatch is quoted but never defined | unrefuted | §3.3b ("no rule today") |
| The attestation is written at a revocable end | unrefuted; checked (`reaped_at`) | §3.3a, §3.5 rule 1, CSK-23 |
| Redaction cannot reach `intent_scope` | unrefuted | §3.4 rules 3–4 |
| CSK-1 asserts a timing reason without an intent row | unrefuted | CSK-1, CSK-2 |
| "Hook path: 0 ms" — the sweep runs inside SessionStart | unrefuted; checked | §1.5, §6 |
| 01a needs 06, and no build order placed it | unrefuted | header, §9, README |
| The weakest-declaration fold has no empty case | unrefuted | §3.7, CSK-8 |
| What happens to a superseded attestation's statement is unspecified | unrefuted | §3.5 rule 6, CSK-6 |
| The NULL guard exempts every `tool.failed` row | unrefuted; checked (`tool.failed` refs an error fingerprint) | §3.2, §3.3g (`kind = 'file.modified'`) |
| An attestation is a root for its own session — a cycle | unrefuted | §3.3b, §8.8 |
| Redaction is not expressible, and one table cannot be redacted | unrefuted | §3.4 rules 1 and 4 |
| The sweep names an unbuilt table and can take the reaper down | unrefuted | §3.3c rule 3, §3.3g, CSK-17 |
| The spec states in the present tense a #53 change not yet made | unrefuted | §4 ("in progress") |
| D-A rests on an incomplete inventory | unrefuted | §3.1, §3.4, D-A |
| The registry is incomplete against its own enumeration | unrefuted | §3.3b (all session-bearing columns) |
| CSK-17's mutation cannot apply to a single statement | unrefuted | CSK-17 |
| The budget's counts are wrong or rest on an unenforced cap | unrefuted | §3.5 rule 4, §6 |
| Neither backfill has an implementable mechanism | unrefuted | §4.1 |
| CSK-7 needs per-kind, per-lane evidence | unrefuted | §3.6, CSK-7 |
| the remaining unrefuted MEDIUM findings — second-lens duplicates of the rows above | unrefuted | as above |
| LOW: `claim.created` names the wrong weakest lane | low | §3.6 table |
| LOW: three `NOT EXISTS` probes in the budget, four in the SQL | low | §6 (the count is the registry's) |
| LOW: "ten mutation anchors", seventeen defined | low | §9 (one anchor per CSK) |
| LOW: post-#50 main against the set's pre-#50 binding | low | header |
| LOW: both pointers still say "retention by relevance" | low | README table, 01 §10 |
