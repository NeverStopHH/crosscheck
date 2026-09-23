# 02 — Claim-to-code binding and individual commit identity

**Tier 1** (`00-cut-line.md`: "Claim ↔ code binding", "Individual commit
identity"). **Owns AT-2**; answers 00 §10 **Q4** and **Q11**. Baseline
`main@e9aab82` + PR #50 + PR #49 (00 §9.4). Paths repo-relative under
`packages/`; a `crosscheck-pins:` prefix marks a line that exists only on #50,
where I cite symbols rather than line numbers.

The cut line asks to *"resolve the collision with the existing clock-based
`stale_at`."* **There is no collision.** Re-measured: `grep -rn
'staleAt|stale_at' packages` returns **5** lines on `main@e9aab82` and the same 5
on `crosscheck-pins@bc88b8b`. One column, zero definitions, no writer. §4 says
what becomes of it; §10 D1 flags the premise correction.

---

## 1. Problem

**A claim is bound to a person, a session and a clock. It is bound to no code.**

1. **No commit on a claim.** `claims` (`server/src/db/schema.ts:237-291`) has
   `author_session_id`, `created_at`, `last_seen_at`, `dedup_count` and no commit
   column. The nearest commit is `agent_sessions.base_commit` (`schema.ts:130`),
   HEAD at **SessionStart** — a session that commits twice and then records a
   root cause leaves a claim two commits behind the code it is about.
2. **`stale_at` is dead.** The 5 hits: declaration `schema.ts:255`, mirror
   `db/bootstrap.sql:92`, frozen fixture
   `server/test/fixtures/pre-search-block-bootstrap.sql:69`, pass-throughs
   `services/diagnosis.ts:128` and `:211`. Not on the wire — `ClaimSchema`
   (`schema/src/claim.ts:18-31`) has no such field — so no connector can send
   one. Every claim reads `NULL`, which `get_diagnosis` ships as `null`.
3. **The one staleness check is clock-based, tree-wide, solved-only.**
   `checkSolvedFileDrift` (`connector-core/src/git/solved-staleness.ts:44-84`)
   asks `rev-list --count --since=<iso> <ref> -- <paths>`: a **wall clock**, the
   **work context's** targets rather than a claim's, called only from the solved
   branch (`mcp/tools/get-diagnosis.ts:135-140`). `mcp/render.ts:868-878` states
   the gap itself — *"marking actual drift would mean running
   checkSolvedFileDrift for open trees too."*
4. **The injection gate never asks about code.** `isInjectable`
   (`hints/select.ts:125-130`) decides whether a **teammate's** claim enters your
   prompt as substance; it reads provenance, body, evidence and
   `status !== "superseded"`. A root cause recorded in April against a file
   rewritten in June is injected in July, unqualified.
5. **`commit_evidence` has no hashes.** PK `(repo, author_email)`, columns
   `latest_commit_at` / `commit_count` / `window_days` (`schema.ts:368-399`).
   AT-2 requires the downgrade to *name the commits*; there is nothing to name.

## 2. Principles served

> **1. "Only judge when you know you were watching."**

A claim whose observation point is unknown may not be presented as current. The
binding fails **closed**: no commit ⇒ `commit_binding = "none"` ⇒ never
substance. Non-negotiable #3's "unknown fails closed", on the code axis.

> **3. "A reason written after a change is not evidence the reason existed
> before it"** — causal order, never wall clock.

`stale_at` is that mistake one axis over: *a claim is old* is not evidence *the
code moved*. Validity here is ordered by git ancestry — `X..<ref>`,
happens-before over commits inside one repository — never by two machines'
clocks. Also served: **#4 fail-never-silently** (a repo that cannot answer yields
`unknown` and a doctor line, never a quiet `current`) and **#1 never block** (a
non-current claim stays readable on every pulled surface; only the unsolicited
substance lane narrows). Not mine: `seq` (01), coverage (03).

## 3. Target model

### 3.1 Two insert-only columns on `claims`

```
observed_at_commit  text NULL                     -- author's HEAD at claim time
commit_binding      text NOT NULL default 'none'  -- CLAIM_COMMIT_BINDINGS
```

`CLAIM_COMMIT_BINDINGS = ["reported","session_base","none"]`
(`schema/src/enums.ts`). CHECK `claims_commit_binding_check`:
`observed_at_commit IS NULL` **iff** `commit_binding = 'none'` — a database fact,
the shape `questions_addressee_check` uses (`schema.ts:468-471`). Written **once
at INSERT, never updated**, so `claims` stays insert-only apart from the two
telemetry columns ingest already bumps (`record-handlers.ts:455-461`).

- **`reported`** — the emitter sent it, at **zero marginal cost**: `prepareMcp`
  resolves `RepoIdentity` per call (`mcp/context.ts:35-45`) and `prepareHook` per
  hook (`connector-claude/src/hooks/runner.ts:120`), and `identity.baseCommit` is
  `git rev-parse HEAD` (`git/repo-identity.ts:276`).
- **`session_base`** — no commit on the wire, so ingest reads
  `agent_sessions.base_commit` for `author_session_id` (a row `checkOwnedSession`
  already loads). A **lower bound**: the revalidation window is wider than the
  truth and the claim goes stale earlier — the safe direction for AT-2.
- **`none`** — the session's base commit is the `NO_COMMIT_SHA` placeholder
  `"0000000"` (`git/repo-identity.ts:228`). Real, rare, never silent (§8.5).

### 3.2 `claim_surfaces` — the declared half of the affected surface

```
claim_surfaces: claim_id FK→claims · repo text NOT NULL · path text NOT NULL
                PK (claim_id, path) · index claim_surfaces_repo_path_idx (repo, path)
```

`repo` is denormalised for `pin_files`' reason
(`crosscheck-pins:server/src/db/schema.ts`, its header): the hot question is
"which rows in this repo watch this path", asked with a path and no claim id.
Capped at `MAX_CLAIM_SURFACE_PATHS = 30` — #50's `MAX_PIN_FILES = 30`, inherited
by name, not silently (00 §10 Q10). Rows exist **only where the author declared
paths**: `publish_claim`, `extend_diagnosis` and `review_draft` gain one optional
`affectedPaths: string[]` through the denylist and secret scan every target path
already passes. **Nothing is inferred from agent prose** — the cut line's Tier 3
rule.

**The fallback is not new.** With no declared rows a claim's surface is the work
context's `file` targets — the set `get_diagnosis` already hands
`checkSolvedFileDrift` (`mcp/tools/get-diagnosis.ts:129-132`). The two are told
apart by `basis` (§3.3) because a context-derived surface **over-fires**: any file
in the context changing marks every claim on it.

### 3.3 `claim_revalidations` — one UPSERT-only row per revalidated claim

```
claim_id text PK FK→claims · result text ("changed"|"unchanged"|"unknown")
basis text (CLAIM_REVALIDATION_BASES) · ref_commit text
touching_commits jsonb default '[]'   -- readonly string[]
revalidated_at timestamptz (HUB clock) · reported_by text FK→developers
```

`result` reuses `SolvedFileDrift` (`git/solved-staleness.ts:12`) **verbatim** —
three states, `unknown` first-class. No fourth spelling, and specifically **not**
#50's `PinPathStatus` (`present|missing|unknown`), a different question about a
different object. `CLAIM_REVALIDATION_BASES = ["declared","context_targets"]`.

UPSERT-only, bounded by how many claims anyone revalidates — the `commit_evidence`
argument (`schema.ts:370-373`). `revalidated_at` is stamped by the hub, never
taken from the body, because a sender-controlled timestamp on a last-writer-wins
row is a ratchet (`services/commit-evidence.ts:34-42`).
`CLAIM_REVALIDATION_RETENTION_DAYS = 30`, pruned at ingest, matching
`COMMIT_EVIDENCE_RETENTION_DAYS = 30` (`server/src/constants.ts:98`). **A pruned
row reads `unknown` again — fails closed.**

**The UPSERT is DOWNGRADE-ONLY, and this is the one rule without which AT-2's
teeth are an agent's to pull out.** §5 makes `validity.state ∉ {stale,
invalidated, superseded}` the gate on the unsolicited substance lane. That state
comes from this row, whose only producer is a connector-computed report POSTed
under `developerAuth` — the developer bearer key that **sits in plaintext in
`~/.crosscheck/config.json`** and that any agent on the machine can read
(`crosscheck-pins:schema/src/pin.ts:80-88`, in #50's own words; 04 §8.8 says the
same). §3.6 already states that *"the hub never computes staleness"*, and §10 D5's
default trigger is the MCP `get_diagnosis` pull — i.e. the agent. So without this
rule, **the agent that wrote a claim can assert `result: "unchanged"` about its
own claim**, overwrite a `changed` reading, restore `current`, and keep a stale
root cause injected as substance into teammates' prompts. That is AT-3's shape —
*an agent cannot certify its own work* — landing on AT-2's gate, and the first
draft of this spec did not name it. §3.7's mitigation does not hold either: *"the
next honest report repairs it"* presumes a second reporter, and nothing in 1.0
makes one exist for another person's tree.

> **A revalidation may move a claim's validity only toward less-current.** An
> incoming `result: "unchanged"` **never overwrites a stored `"changed"`**; it is
> recorded as a no-op and counted. `unknown → current`, `unknown → changed` and
> `unchanged → changed` are all legal; `changed → unchanged` is not.

Enforced in SQL, not in a service, the way `questions_addressee_check` makes a
rule a database fact: the UPSERT carries
`WHERE claim_revalidations.result <> 'changed' OR excluded.result = 'changed'`.
Returning a `stale` claim to the substance lane then needs what the tree already
requires for every other revision — **a new claim** (*"revision means a NEW
claim"*, `services/hints.ts:68-70`) — which is authored, attributable and
append-only. **Named cost:** a genuine revert, where a file really did move back,
leaves the claim `stale` until somebody re-publishes it. That is the safe
direction for AT-2 and it is cheap; the alternative leaves the product's only
substance gate forgeable from inside the machine it protects.

### 3.4 `touching_commits` — individual commit identity, and its cost (Q4)

AT-2 requires the downgrade to *name the commits*; Q4 asks what table that costs.
**None.** Hashes ride this bounded per-claim row, newest-first, capped at
`MAX_CLAIM_TOUCHING_COMMITS = 5`, each matched against `COMMIT_SHA_PATTERN` on
the wire. **Stored: abbreviated hashes and nothing else** — no author name,
email, message, parents, timestamps or paths. The trust argument is
`landed_evidence`'s verbatim: a commit hash is already-shared git history every
clone can re-derive (`schema/src/landed-evidence.ts`, header), and
`commit_evidence`'s narrowing rule — *"`author_email` … never leaves the hub"*
(`schema.ts:381-382`, `services/absences.ts:34`) — is not weakened, because **no
identity is attached to a hash here at all**.

**Refused: a `commits` table.** Unbounded by construction — the property
`commit_evidence` was designed against — colliding with retention and
non-negotiable #6. Q4 says *"name the cost; do not assume the table."* The cost
of the bounded form: a downgrade names at most 5 commits, then "and N more".

`COMMIT_SHA_PATTERN` has **two copies today** — `git/commit-drift.ts:17`
(exported, its comment saying two copies would be two things to widen) and a
private one in `schema/src/landed-evidence.ts`. Rather than become a third, this
spec hoists it to `packages/schema/src/commit-sha.ts`, which
`landed-evidence.ts` then imports.

### 3.5 `validity_state` is DERIVED, not stored

New hub service `packages/server/src/services/claim-validity.ts`:

```ts
export const CLAIM_VALIDITY_STATES = [
  "current", "superseded", "invalidated", "stale", "unknown",
] as const;

export interface ClaimValidity {
  readonly state: ClaimValidityState;
  readonly observedAtCommit: string | null;
  readonly commitBinding: ClaimCommitBinding;
  readonly basis: ClaimRevalidationBasis | null;
  readonly touchingCommits: readonly string[];   // ≤ MAX_CLAIM_TOUCHING_COMMITS
  readonly lastRevalidatedAt: string | null;
  readonly supersededByClaimId: string | null;
}
export const claimValidity = (row, revalidation, supersededBy): ClaimValidity;
export const isCurrent = (v: ClaimValidity): boolean;
```

Resolution order, first match wins. **This is the whole definition:**

| state | condition |
|---|---|
| `superseded` | a `supersedes` edge points **at** this claim |
| `invalidated` | `claims.status === "rejected"` |
| `stale` | revalidation `result === "changed"` |
| `current` | revalidation `result === "unchanged"` |
| `unknown` | no revalidation row, `result === "unknown"`, or `commit_binding === "none"` |

Derived on read for 03's reason: a stored verdict outlives its evidence
(03 §3.2). **Two of the five already exist and are reused, not re-minted** —
`supersededBy` is `findSupersededBy` (`server/src/services/referee.ts:320-336`),
one lookup on `claim_edges_to_kind_idx` (`schema.ts:318`), batched as one
`IN (…)` per tree; `invalidated` is the author-declared `rejected` status
(`schema/src/enums.ts:12-18`).

**One authority, stated because there were nearly two.** `claims.status` may also
read `"superseded"`, and `hints/select.ts:129` gates on it today. After this spec
**the edge is authoritative**, `isInjectable` reads `claimValidity()`, and the
status value stays the author's word without being a second definition.
`last_revalidated_at` is a *freshness-of-answer* fact, the kind
`commit_evidence.collected_at` and `AbsenceFinding.evidenceCollectedAt`
(`absences.ts:39`) already are — never arithmetic for a staleness verdict.

### 3.6 Computed connector-side, always

**The hub has no checkout** —
`crosscheck-pins:connector-core/src/git/pin-sweep.ts` says so in its header,
which is why the pin sweep runs on the developer's machine and reports. Same
shape here: **the connector computes, the hub records.** New module
`packages/connector-core/src/git/claim-drift.ts`:
`checkClaimDrift(root, defaultRef, observedAtCommit, paths) →
{ result: SolvedFileDrift; touchingCommits: readonly string[] }`, per distinct
`observed_at_commit`, using `runGitOutcome`
(`crosscheck-pins:connector-core/src/git/git.ts`) — the primitive separating "no
commits" from "git did not answer", the null-on-empty trap
`checkSolvedFileDrift` spends a second call to dodge (`solved-staleness.ts:26-32`):

1. `rev-list --max-count=<cap+1> <X>..<ref> -- <paths>` → hashes; non-empty ⇒
   `changed`, newest-first.
2. Empty ⇒ `ls-tree --name-only <ref> -- <paths>`; empty ⇒ `unknown` (the
   cross-repo case `get_diagnosis` serves, `solved-staleness.ts:33-41`), else
   `unchanged`.
3. `X` unknown locally — a teammate's unpushed commit — exits non-zero, which is
   `unknown`, never an error (`git/commit-drift.ts:21-24`).

Bounds: `CLAIM_REVALIDATION_MAX_COMMITS = 8` distinct commits per pull,
**newest-commit-first before the cap**, the cut reported as `revalidated / total`
— `state/capture-health.ts:13-31`'s rule that a bound must not be spent at random
and must not claim more than it measured. `CLAIM_REVALIDATION_MAX_GIT_CALLS = 24`
caps process count the way `PIN_SWEEP_MAX_GIT_CALLS` does. The timeout **reuses**
`STALENESS_GIT_TIMEOUT_MS = 250` (`connector-core/src/constants.ts:639`); no
third 250 is minted.

### 3.7 Wire and route

`ClaimSchema` gains
`observedAtCommit: z.string().regex(COMMIT_SHA_PATTERN).optional()` and
`affectedPaths: z.array(…).max(MAX_CLAIM_SURFACE_PATHS).default([])`.
`.optional()` is the forward-compat seam (`envelope.ts:26-28`): an old connector
sends nothing and ingest stamps `session_base`. Because claims are append-only
and INSERTed once, **absent means null forever on that row** — it does *not* mean
"keep what you have", which is `IntentSchema`'s rule
(`schema/src/session.ts:62-66`) for a mutable object. The answer path inherits
both fields free: `QuestionAnswerSchema` embeds the canonical `ClaimSchema`
(`schema/src/question.ts:115-124`).

**The revalidation report is not an envelope.** New
`packages/schema/src/claim-revalidation.ts`; new route
`POST /api/claim-revalidations`, mounted in `server/src/app.ts` after #50's three
mounts. 00 §8.4a's rule: a record that can originate outside an agent session
gets its own route — and this one can, because `crosscheck revalidate` runs from
a terminal with no session and minting one is the phantom teammate of Q9. It uses
the existing **`developerAuth`** (`middleware/auth.ts:38+`); it does **not** need
05's `requireCiToken`. Trust model is `landed_evidence`'s
(`services/landed.ts:20-27`): any member may report, because the check is
reproducible from any clone. A forged report changes one claim's presentation
label — never a body, an edge or any ranking — and the next honest report repairs
it, the row being an UPSERT of a current reading rather than an accumulation.

> **D6 — this paragraph and the downgrade-only rule are incompatible, and the
> choice is Nick's.** The trust argument above permits any member to report
> *because* a forged report is repairable. CCB-3's downgrade-only UPSERT removed
> that: a stored `changed` is only ever replaced by another `changed`, so no
> honest `unchanged` can undo a forged one. An independent refuter measured the
> consequence — a member whose only sessions are in another repo names this one
> in the request body, demotes its claims, and the owner's correction comes back
> `refusedDowngrades: 1`. The caller cannot be scoped without refusing
> `crosscheck revalidate`, which §3.7 itself says runs with no session. Three
> ways out, none of them free:
>
> 1. **Keep permanence, add disclosure.** `reported_by` is stored and refused
>    walk-backs are counted; render WHO demoted a claim, and whether they have
>    ever worked in this repo. Blocks nothing, and a reader can judge.
> 2. **Keep repairability, bound the upgrade.** Allow `changed -> unchanged`
>    only from the claim's own author, or only with a newer `ref_commit`. The
>    forged downgrade becomes temporary; a forged UPGRADE becomes possible again
>    for exactly one party.
> 3. **Scope the caller and give `revalidate` a session.** Closes it properly
>    and costs the phantom-teammate refusal Q9 makes.
>
> Nothing is implemented beyond the disclosure half of (1) — `reported_by` and
> `self_reported` are stored, and doctor prints the refusal counts. The
> paragraph above is left standing rather than quietly edited, because the
> contradiction is the finding.
`Diagnosis.claims[]`, the hint candidate rows and the referee position each gain
one `validity: ClaimValidity` sibling.

## 4. Migration

| today | after |
|---|---|
| every `claims` row, no commit | `observed_at_commit` backfilled from `agent_sessions.base_commit` via `author_session_id`; `commit_binding = 'session_base'` |
| a session whose `base_commit` is `"0000000"` | `commit_binding = 'none'`, `observed_at_commit` NULL |
| `claims.stale_at`, NULL on every row | **DROPPED** |
| `ClaimView.staleAt` (`diagnosis.ts:128`, `:211`) | removed |
| `work_context_targets` | **untouched** — no new column, no re-labelled `source` |
| `claim_edges` kind `supersedes` | **untouched**, now authoritative for `superseded` |

**`stale_at` is retired, not redefined — that is the one-authority answer.**
Redefining it would put a timestamp beside a state and invite the next reader to
compute `now() − stale_at`, re-inventing the clock definition principle 3
forbids. Nothing breaks: **none of the 5 hits is outside `packages/server`**, so
no connector module references it. `bootstrap.sql` gains `ALTER TABLE claims DROP
COLUMN IF EXISTS stale_at;`; the frozen `pre-search-block-bootstrap.sql` fixture
**keeps** it, being a snapshot of an older database that editing would turn into
a different fixture. `server/test/ddl-sync.test.ts` proves the two stay in step.
`status = "superseded"` keeps its meaning as the author's word and stops being a
gate.

## 5. Where it renders, who consumes it

**The clause.** One renderer-owned sentence of enum values, small integers and
hex: *"Recorded at `abc1234`; 3 commits have touched these files since —
`def5678`, `9a1b2c3`, `4d5e6f7`."* Bounded by
`MAX_CLAIM_VALIDITY_LINE_CHARS = 160`, matching 03's `MAX_COVERAGE_LINE_CHARS`.
**It never renders a path**: paths are author-written and already reach surfaces
through the existing target-rendering path, so the clause names counts and shas
only and opens **no new untrusted slot**. Hashes are `COMMIT_SHA_PATTERN`-shaped
on the wire and re-checked on read — landed-evidence's rule that nothing flag- or
prose-shaped reaches git or SQL.

| surface | entry | change |
|---|---|---|
| MCP diagnosis | `diagnosis` (`render-surfaces.ts:764`) | per-claim clause; the solved block keeps `FILE_DRIFT_SENTENCES` (`mcp/render.ts:748-755`), now derived from the same record |
| claim hint | `claim-hint` (`:692`) | **state word only** (≤ 32 chars), never the commit list — §5a |
| briefing solved | `briefing-solved` (`:528`) | clause on the root-cause line |
| referee brief | `referee-brief` (`:862`) | already ships `supersededByClaimId`; now the full record |
| search results | `search-results` (`:772`) | clause on claim-matched rows |
| **new CLI** | `cli-claim-revalidate` | `crosscheck revalidate`, appended at the **array tail** of `cli/src/render-surfaces.ts`, after `cli-status` (`crosscheck-pins:192`) — 00 §9.1a |
| doctor | `cli/src/cli/doctor.ts` | the refusals of §8.5 and §8.9 |

**§5a — the claim hint carries two qualifiers, and the first draft budgeted only
one, against the wrong constant.** Two specs land a ≤160-char qualifier on the same
`claim-hint` response: 03's coverage note (`MAX_COVERAGE_LINE_CHARS = 160`) and
this spec's validity clause. 02 §9 ordered them (*"coverage first, validity
second"*) without reconciling 320 characters of qualifier against one hint, and
bounded its own clause with **`MAX_HUB_MESSAGE_CHARS = 200`** — which is the wrong
constant: its own comment scopes it to *"a string THE HUB chose, as a tool prints
it back"* (`connector-core/src/constants.ts:1540-1555`), and 00 §3.1 documents it
as the bound on a hub-chosen **refusal** string, not on a claim-hint body. Both
corrected:

> On `claim-hint`, the coverage note renders first at up to
> `MAX_COVERAGE_LINE_CHARS = 160`, and the validity clause renders as **its state
> word alone** — `stale` · `superseded` · `invalidated` · `unknown` — bounded by
> `MAX_CLAIM_VALIDITY_WORD_CHARS = 32`. The full clause of §5 (*"Recorded at
> `abc1234`; 3 commits have touched these files since — …"*) is bounded by
> `MAX_CLAIM_VALIDITY_LINE_CHARS = 160` and renders **only on `pulled`
> surfaces** — diagnosis, briefing-solved, referee brief, search results.

The reasoning is the anchoring asymmetry the registry already encodes
(`render-surfaces.ts:71-95`): a hint is unsolicited and spending its characters on
three commit hashes anchors a session on a file history nobody asked about, while
a reader who pulled a diagnosis asked. Nothing is hidden — the state word is the
part that changes what a reader should do with the sentence, and the hashes are
one `get_diagnosis` away.

**The substance gate — AT-2's teeth.** `isInjectable`
(`hints/select.ts:125-130`) gains
`validity.commitBinding !== "none" && validity.state ∉ {stale, invalidated,
superseded}`, the last term replacing `status !== "superseded"`. A claim failing
them is **not silenced**: it keeps the pointer lane and stays readable on every
`pulled` surface — the precision corpus's own SUBSTANCE / POINTER / SILENCE
ladder (00 §6.2), one rung down, not out.

**Registry obligations.** `claim-drift.ts` is git, not render, and registers
nothing. The clause is built inside `mcp/render.ts`, `hints/render.ts` and
`briefing/render.ts`, all already on `RENDER_LAYER_MODULES`
(`render-surfaces.ts:138-147`) — **no change to that list or to
`RENDER_BARREL_MODULES`**. The new CLI surface registers `kind: "corpus"`,
`delivery: "pulled"`. `cli/src/render-surfaces.ts` is **not** free ground: #50
takes it 3 → 6 (00 §9.1).

## 6. Budget

**Zero added cost on every hook path. The 800 ms rule
(`connector-core/src/constants.ts:56-57`, `PRINTS: 800 800`) is untouched,
because no hook gains a git call or a hub call.**

- **`observed_at_commit` is free.** Both claim-writing paths already hold it:
  `prepareMcp` (`mcp/context.ts:35-45`), `prepareHook`
  (`connector-claude/src/hooks/runner.ts:120`), and `resolveRepoIdentity` runs
  `rev-parse HEAD` inside them (`git/repo-identity.ts:276`). A field on a body
  already being built — bytes, not a round trip.
- **SessionStart (1000 ms), UserPromptSubmit / PreToolUse (800 ms), PostToolUse
  and Stop: unchanged.** #50 already spent part of Stop's `spareMs` on the git
  lane; this spec does not compete for it.
- **The detached summarizer and ghost workers write claims with no identity
  resolved** (`derive/summarizer/derive.ts:187-198`,
  `derive/ghost/worker.ts:363-374`). They do **not** pay `resolveRepoIdentity`,
  for correctness rather than budget: the slice they summarise is from earlier in
  the session, so the worker's HEAD is not the HEAD the observation was made at.
  They send no commit, ingest stamps `session_base`, and that is the honest lower
  bound.
- **Revalidation runs where the reader is waiting** — inside `get_diagnosis`,
  under `MCP_TIMEOUT_MS = 10_000` (`constants.ts:1381`), which
  `mcp/tools/get-diagnosis.ts:115-121` already names as *"inside the MCP budget
  (not a hook path)"*. That path spends at most three bounded git calls today;
  this adds at most `CLAIM_REVALIDATION_MAX_GIT_CALLS` more at
  `STALENESS_GIT_TIMEOUT_MS = 250` each, over at most
  `CLAIM_REVALIDATION_MAX_COMMITS = 8` distinct commits.
- **Hub job cost: none.** No background pass, no reaper change; retention prunes
  at revalidation ingest, the shape `ingestCommitEvidence` already uses.

**Measurement refusal.** I ran no benchmark, so this spec states **no millisecond
figure** for the revalidation leg. CCB-8 requires one before merge.

## 7. Acceptance tests — AT-2, restated so each can fail

Each names the mutation that must turn its guard red in
`connector-core/scripts/mutation-check.ts` (00 §7.2).

**CCB-1 — a claim with no commit binding is never substance.** A claim whose
author session has `base_commit = "0000000"` ⇒ `commit_binding = 'none'`; it
appears in `get_diagnosis` and as a pointer, and **never** in a `claim-hint`
body. *Fails if* it is injected as substance. *Mutation:* drop the
`commitBinding !== "none"` term from `isInjectable`. — **AT-2's first "fails if"
clause.**

**CCB-2 — exactly one staleness definition exists.** `grep -rn 'staleAt|stale_at'
packages` returns only the frozen fixture, and `claimValidity()` is the sole
producer of a `ClaimValidityState`. *Fails if* a second producer appears or the
column survives. Pinned by a `VERIFY:` / `PRINTS:` pair re-deriving both counts
from the tree, never by this sentence (00 §7.1). — **AT-2's second "fails if"
clause.**

**CCB-3 — the downgrade names the commits.** A claim at `X`, two commits touching
its surface between `X` and the default ref: `result = "changed"`,
`touchingCommits` holds both newest-first, and the clause contains both short
shas. *Fails if* it says "changed" naming nothing. *Mutation:* return `[]` from
`checkClaimDrift`'s hash leg.

**CCB-4 — code, not clock.** Two claims of identical age, one whose surface moved
and one whose did not: old-and-untouched stays `current`, young-and-touched is
`stale`. *Fails if* either verdict tracks `created_at`. *Mutation:* order
`claimValidity`'s resolution by age.

**CCB-5 — an unanswerable repo is `unknown`, never `current`.** An
`observed_at_commit` unknown to the local clone, git absent, or the call budget
exhausted ⇒ `unknown`, and the surface says so. *Fails if* any failure path
yields `current` or silence. *Mutation:* map `runGitOutcome`'s `ok: false` to
`"unchanged"`.

**CCB-6 — a pruned revalidation fails closed.** A row past
`CLAIM_REVALIDATION_RETENTION_DAYS` is deleted and the claim reads `unknown`, not
its last verdict. *Fails if* a verdict outlives its evidence. *Mutation:* skip
the prune.

**CCB-7 — the edge outranks the status.** `status = "proposed"` with an incoming
`supersedes` edge is `superseded`; `status = "superseded"` with no edge is not.
*Fails if* `isInjectable` still reads `status`. *Mutation:* restore
`claim.status !== "superseded"` in `hints/select.ts`.

**CCB-10 — a revalidation cannot walk a claim back into the substance lane.** A
claim with a stored `result = "changed"` receives a report of
`result: "unchanged"` under a valid `developerAuth` bearer key: the stored row is
**unchanged**, `claimValidity()` still reads `stale`, `isInjectable` still refuses
the substance lane, and the no-op is counted and printed by doctor. A second case
asserts the legal directions still work — `unknown → changed` and
`unchanged → changed` both land. *Fails if* any single report restores `current`
from `stale`. *Mutation:* drop the
`WHERE claim_revalidations.result <> 'changed' OR excluded.result = 'changed'`
clause from the UPSERT. — **§3.3's rule, and the reason AT-2's gate is not an
agent's to open.**

**CCB-8 — the budget is measured, not asserted.** `get_diagnosis` wall clock with
revalidation on, against the pre-change baseline, with a named allowance, on the
harness pattern of `connector-core/test/latency.test.ts` and
`connector-claude/test/capture-latency.test.ts`. *Fails if* no measurement
exists.

**CCB-9 — the cut is reported.** A tree with more than
`CLAIM_REVALIDATION_MAX_COMMITS` distinct observed commits revalidates the newest
8 and the response carries `revalidated / total`, which the surface prints.
*Fails if* the bound is spent at random or the cut is silent
(`state/capture-health.ts:13-31`).

**Corpus floors.** The substance gate moves fixtures in
`connector-core/test/fixtures/precision-corpus/`, so
`VERIFY … PRINTS: 11 33 11 4 18` (`precision-corpus.test.ts:19-20`) will change.
**Fixtures are relabelled with a written rationale and the floors re-derived; no
floor is tuned down to make a test pass** (00 §6.2). I state no post-change
numbers, because I have not run it.

## 8. Refusals

1. **No symbol granularity.** Measured: `targetRecord(` is called exactly twice
   in `packages/*/src` — `"file"` (`flows/capture-targets.ts:102`) and
   `"error_fingerprint"` (`:143`). `symbol` and `component` are `TARGET_KINDS`
   values (`schema/src/enums.ts:41-46`) with **no producer anywhere in the
   tree**. AT-2's *"affected symbol"* is served at **file** granularity in 1.0,
   and every renderer says "files", never "symbol".
2. **No "80 % of the affected symbol rewritten" figure — not on a hook budget,
   not as a hub job, not anywhere.** There are no symbol boundaries to measure
   against (1); the number needs `--numstat` or blame over a range, which the hub
   cannot run (no checkout) and no hook can afford; and a single percentage
   standing in for an evidence question is the shape 00 §8.5 bans — `78 %
   rewritten` is `coverage = 87 %` in another costume. The answer is three
   states, reusing `SolvedFileDrift`.
3. **No `commits` table** (§3.4); hashes ride the bounded per-claim row.
4. **No identity attached to a hash** — no author, email, message, parents,
   paths.
5. **`commit_binding = 'none'` can never be revalidated.** No "from" commit, so
   the rung cannot exist — a **doctor refusal** naming the count and the reason,
   never a silent absence (AT-10's rule).
6. **The hub never computes staleness.** No checkout; it records what a clone
   reported and derives a state from it. **Consequence, stated rather than
   assumed:** the report is not attested, so the row is downgrade-only (§3.3) and
   a forged `unchanged` cannot restore a `stale` claim to the substance lane. The
   residue the design keeps: an agent holding the developer key can still *first*
   mark its own never-revalidated claim `current` — `unknown → current` is a legal
   direction — but `unknown` is **already** injectable under §5's gate, so that
   move changes nothing a reader sees. Closing it entirely needs the hub-stamped
   human-authority writer 08 owns (AT-3), and it is that spec's, not this one's.
7. **Nothing blocks, nothing is hidden.** A `stale` claim is readable on every
   pulled surface with its clause; only the unsolicited substance lane narrows.
8. **No revalidation on any hook path**, and none in the detached workers.
9. **No CI- or runtime-driven invalidation.** 05 owns `ci`; `runtime` is Tier 3
   and stays `unavailable` (03 §3.2). A future CI invalidation is additive and
   must call `claimValidity()` rather than recompute it.
10. **No elaborate change envelope** (cut list): a revalidation records a
    *result*, never a description of the change.
11. **No per-developer anything.** `reported_by` is provenance, never rendered as
    a score or ranking (`suspect.ts:21-25`).
12. **Conference is cut** and gets no validity wiring.

## 9. Collisions and sequencing

**Write after #50 and #49 both merge** (00 §9.4).

**PR #50 — three dependencies and the near-miss the brief asks me to name.**
`git/git.ts` (+45) brings `runGitOutcome`, which `claim-drift.ts` **requires**;
without it the empty-versus-failed ambiguity returns. `server/src/db/schema.ts`
(+143): my two tables append after `team_settings`, and my columns and the
`stale_at` drop sit inside the `claims` block #50 does not touch;
`bootstrap.sql` (+92) mirrors both indexes and the drop, and
`server/test/ddl-sync.test.ts` (+27) enforces it. `cli/src/render-surfaces.ts`
goes 3 → **6** (00 §9.1), so `cli-claim-revalidate` appends at the **array tail**,
after `cli-status`. **Corrected:** an earlier draft of this line said *"after
`cli-suspect`"*, which is a different place — #50 **prepended** its three surfaces,
so `cli-suspect` sits at `:166` and the tail is `cli-status` at `:192`, six lines
below. Three specs had named that insertion point and one named two contradictory
anchors in a single sentence; 00 §9.1a now states the one convention (append at the
tail, in build order), and 04, 05 and 07 are corrected to match. 05 §9.4 had
already corrected its own free-ground claim; 03 §9 registers no CLI surface at
all.
`cli/src/cli/doctor.ts` (+105) and `server/src/constants.ts` (+38 `SUSPECT_*`):
append below, never renumber.

**The near-miss — four facts, four spellings.** #50's git-touch lane gives
`work_context_targets` a **`source`** column (`tool_edit | git_diff | both`,
`schema/src/enums.ts`), a **lane** label saying which observer saw a file.
`claims.commit_binding` is **not** a lane: it says how precisely we know *when*
an assertion was made. `claim_surfaces` has **no** `source` column.
`pins.verified_at_commit` is a *human's* statement about a surface — which 04 §9
also flags — and is not a claim↔code binding. Folding any two of the four into
one enum is the defect. The lane does improve my fallback for free: after #50 a
context's `file` targets include `sed -i` and codemod edits the tool lane never
saw, so the `context_targets` basis sees more of the truth without this spec
asking for anything.

**PR #49** — no structural collision; `server/src/constants.ts` is shared (#49
near the head, #50 at the tail) and my `CLAIM_*` block goes below both.

**`.github/workflows/ci.yml`** — I add `MUTATIONS` entries (CCB-1, CCB-3…CCB-7,
CCB-10), so per 00 §9.2 I name this file. **Three listings, not two**: the count at
`:119-120`, the per-file block at `:127`, and the **per-basename block** at `:246`
on `crosscheck-pins` (`:239` on main), which an earlier draft did not name. New
per-file lines for `git/claim-drift.ts` and `services/claim-validity.ts` plus a
bump to the existing `hints/select.ts` line; in the per-basename listing
`select.ts` is a **bump**, `claim-drift.ts` and `claim-validity.ts` are new.
**No post-merge total is written here** — I cannot know how many other specs land
first. On `mutation-check.ts` I am **editor 6** in the build order (00 §9.7); all
eight specs conflict at the same array tail.

**Spec 08 (evidence axes) — a shared migration, the tightest coupling in the
set.** 08 §9 states it: *"we both add a column to `claims` and a field to
`ClaimSchema` … Sequencing: **02 first, 08 appends** — one migration, one
`bootstrap.sql` edit, one `ddl-sync.test.ts` block."* Adopted verbatim. Names do
not clash (`observed_at_commit` / `commit_binding` vs `verification_ref`), and
08 §3.5 leg 1 consumes my binding: missing ⇒ `tool_observed` / `no_binding`. Its
leg 4 reads §3.2's surface, so **`repository_verified` is unreachable until this
spec lands**, which 08 already says in doctor.

**Spec 03 (coverage) — and the range AT-1 asks for, which this spec cannot
supply.** 03 §3.4 shipped `commitRange` as a field that is null *"until that table
lands"*, sequencing AT-1's full example sentence — *"coverage incomplete for
commits A..F"* — behind this spec. §3.4 above **refuses a `commits` table**, and
what it ships instead is ≤ `MAX_CLAIM_TOUCHING_COMMITS = 5` hashes on a
**per-claim** row scoped to **that claim's own surface**. That cannot answer a
repo-wide question about which commits a coverage hole spans: different subject,
different scope, different bound. **So AT-1's example sentence is unreachable for
the whole of 1.0, and neither spec said so.** Both now do — 03 §3.4 drops the
field rather than shipping one that is null on every row for every release, which
is the silent absence AT-10 forbids, and prints the refusal in doctor instead.
`CommitRange` as a type is defined nowhere in the set and is not minted here.

**Spec 03 (coverage) — one adjacency, one deliberate divergence.** Both clauses
can land on `search-results` and `diagnosis`: **coverage first, validity second**
— coverage is about the archive, validity about the row — and a search whose only
matches are non-current claims is **not** empty, so 03 §5.1's empty-result rule
does not fire. *Divergence, stated rather than quiet* (00 §11.2): 03 §5.1
annotates only on `incomplete`, never on `unknown`, because a caveat on every
answer teaches people to ignore caveats. **My clause renders on `unknown` too.**
03's `unknown` is a property of the repo's observation; mine is a property of the
sentence being asserted, and an unqualified assertion is the defect itself. I
consume neither `CoverageRecord` nor `isJudgeable`, and redefine neither.

**Spec 01 (canonical event model)** — no shared table or column. A revalidation
is **not** an envelope and carries **no `seq`**; in 01's vocabulary it is
`unsequenced`. 01 §4 already promises `stale_at` is untouched and §9 assigns me
`claims` and commit identity; §3.4 here answers its note that *"when its commit
table lands, `commit.observed` can project per-commit rows"* — **there is no
commit table, so `commit.observed` stays the aggregate it is.**
`observed_at_commit` on `claim.created` is additive and welcome;
`claim.invalidated` firing on a revalidation must read `claimValidity()` rather
than recompute it. **Sequence: either order.**

**Specs 04 / 05 / 06 / 07.** 04 — **an earlier draft of this line assigned 04 an
obligation that does not exist, and 04 was right to record "no overlap".** It said
*"a fence firing on a claim reads `claimValidity()`"*. **No fence fires on a claim
in 1.0.** 04 §3.4's `computeProtection` takes exactly
`{repo, pinId, pinVersion, falsifierKind, liveWaiver}`; a fence is a **pin**, its
surface is `pin_files.path`, and 04's `Verdict` carries no claim and no validity
field by design. The sentence is withdrawn. What survives of it is true and
smaller: attribution and validity are **orthogonal**, so where a surface renders
both — `search-results`, `diagnosis` — `ATTRIBUTED` + `stale` is a real renderable
state, the shape `ATTRIBUTED` + `PROTECTED_CONFLICT` already is. Nothing is
required of 04.

Should a *claim* fence ever exist it would be additive and would call
`claimValidity()` rather than recompute it — the same rule as refusal 9. It is not
in 1.0, and this spec does not sketch it. 05: no shared table, route or
middleware — mine uses `developerAuth` and `requireCiToken` stays 05's. 06: no
collision; it is append-only on `work_context_intents` while I touch `claims`,
and we independently reuse the same precedent (`services/hints.ts:68-70`). 07:
`validity` is a field on rows it already counts; nothing is required of either
side.

**One correction to 00, for spec 01's owner.** 00 §4.4a says *"the detached
summarizer worker does not update session state"*, measured from
`connector-claude/src/summarizer/worker.ts` — which does import only
`readSessionState` (`:25`). But the shared derive it calls **does**:
`derive/summarizer/derive.ts:202` and `derive/ghost/worker.ts:378` both end in
`updateSessionState(…)`. The worker is inside the lock discipline after all,
which changes Q2's option (1). Flagged, not resolved — `seq` is not mine.

## 10. Decisions for Nick

**D1 — the cut line's premise is wrong and this spec corrects it.** There is no
clock-based `stale_at` to reconcile: 5 lines, no writer, not on the wire.
*Default: retire the column; `validity_state` is the first and only authority.*
Cost: a reviewer reading the cut line alone will look for a reconciliation
section that should not exist.

**D2 — backfill existing claims from `agent_sessions.base_commit`
(`commit_binding = 'session_base'`), or leave them unbound?** *Default:
backfill.* Cost: the binding is a lower bound, so a claim can be marked `stale`
by commits made before it was written — it errs toward "not current", the safe
direction. The alternative: every pre-1.0 claim is `none` and permanently
pointer-only.

**D3 — does a `stale` claim keep the unsolicited substance lane with its clause,
or drop to a pointer?** *Default: drop to a pointer.* AT-2 says "no longer
presented as a current cause". Cost: a correct-but-old root cause stops being
injected until someone revalidates that tree.

**D4 — ship the optional `affectedPaths` argument on the claim tools, or run on
context targets alone?** *Default: ship it.* Cost: one tool argument and one
bounded table agents may never use, in which case the `context_targets` fallback
carries everything and over-fires by design.

**D5 — revalidation triggers: MCP pull only, or also a manual
`crosscheck revalidate`?** *Default: both, the CLI manual.* Cost without the CLI:
a repo nobody pulls a diagnosis from is never revalidated and reads `unknown`
forever — which doctor must then say out loud, every time.

**D6 — `MAX_CLAIM_TOUCHING_COMMITS = 5`.** *Default: 5.* Cost: a busy file's
downgrade says "and 12 more". Raising it grows a jsonb column on a table bounded
by claims.
