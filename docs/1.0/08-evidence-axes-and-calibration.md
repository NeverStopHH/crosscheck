# 08 — Two evidence axes and calibration measurement

**Tier 2** (`00-cut-line.md`): *"The two evidence axes plus the calibration measurement over time."* The calibration **scoring
surface is Tier 3 — cut**: *"Collect the data, build the UI once it says something."* This spec collects; it builds no UI.
**Owns AT-3 — both halves, as of this revision.** The first draft said *"I own none outright"* and handed AT-3's write path to
*"the human-authority spec"*; 04 §1(c), 06 §8.1 and 07 §9 handed it there too. **No such spec exists.** `docs/1.0/` contains
`00-cut-line`, `00-ground-truth` and `01`…`08`, and `grep -n "AT-3" docs/1.0/*.md` finds only disclaimers and inheritances — so
Tier 1's *"a production writer for human authority. An agent may not certify its own work"* and one of ten acceptance tests were
owned by nobody, while the live defect stayed open on main. This spec already owns the WHO axis and the `HumanAuthorityProbe`
seam, so it takes the write path too (§3.2a). It further **discharges instances of two rules it does not own**: **AT-8** is 05's
(`repository_verified` consumes its red/green machinery and adds a commit-order rule), **AT-10** is 03's (a rung that cannot
exist is a doctor refusal, never a silent absence). Mine are `EV-1…EV-9`, after 03's `COV-*` and 05's `CI-*`. Baseline `origin/main` @ `e9aab82` (read at
`/Users/nicknouschirvan/worktrees/crosscheck-main`), PR #50 @ `bc88b8b` and PR #49 @ `2642640` assumed merged (00 §9.4).

---

## 1. Problem

**1.1 The WHAT axis does not exist as data** — no column, no field, no wire shape. A claim carries two trust labels and no
third: `claims.provenance` (`schema.ts:252`) and `claims.confidence` (`schema.ts:250`). A reader gets `provenance declared ·
confidence 0.80`, and nothing says whether anything was ever *run*. `evidence_refs` is not that thing: `jsonb readonly string[]`
(`schema.ts:258-261`) holding **claim ids** — *"Ids of claims that support this one"* (`publish-claim.ts:62-68`) — persisted
**unresolved**, because *"referenced claims may arrive later in the same flush"* (`record-handlers.ts:489-490`). "What supports
this" means "which other sentences the model listed": a model citing three of its own hypotheses satisfies the one hard gate
there is (`claim.ts:45-55`).

**1.2 Confidence is a free number that gates nothing.** `publish_claim` takes it from the model (`publish-claim.ts:56-61`),
`DEFAULT_CONFIDENCE = 0.6` (`:39`). **Measured:** in all of `packages/*/src` the token `confidence` appears in exactly **two**
comparisons — `schema/src/claim.ts:36` and `schema/src/session.ts:44`, both the `DERIVED_CONFIDENCE_CAP` wire check; there is no
third (`VERIFY: grep -rEn 'confidence\s*(>|<|>=|<=)' packages/*/src | wc -l | tr -d ' '` · `PRINTS: 2`). It is a floor on
nothing and a sort key for nothing. It is *printed* on six surfaces — `mcp/render.ts:315`, `hints/render.ts:186`,
`hints/render.ts:299`, `briefing/render.ts:629`, `server/src/ui/pages/work-context.tsx:44`, `server/src/ui/pages/referee.tsx:50`
— plus the author echo (`publish-claim.ts:241`). The tree already wrote the consequence down at `briefing/render.ts:575-591`:
*"`publish_claim` takes the number from the model — so 'It is probably X, but I never confirmed it' at 0.05 is a legal, honest
`likely_root_cause` and makes its tree SOLVED on every surface."*

**1.3 The WHO axis is readable but wrong if read naively.** `publish_claim` writes `captureMode: "agent"`
(`publish-claim.ts:183`) with `provenance: "declared"` (`:187`), deliberately (`:184-187`: *"An agent calling this tool is
DECLARING, not deriving"*), so a renderer reading `declared` as "a human vouched" is wrong on every agent claim in the tree.
**Measured:** seven claim writers stamp a capture mode — four `"agent"` (`publish-claim.ts:183`, `extend-diagnosis.ts:262`,
`review-draft.ts:239`, `answer-question.ts:139`), three `"auto"` (`model/gates.ts:221`, `derive/ghost/worker.ts:347`,
`cli/conference.ts:507`); **zero write `"human"`**. Nor does the hub stamp it: `record-handlers.ts:501` on main
(`crosscheck-pins:520` — #50's +19 moves it, 00 §9.4a) inserts `captureMode: body.captureMode` straight off the wire — the opposite of #50's pins, where the hub stamps and the body may never carry it
(`crosscheck-pins:server/src/services/pins.ts`, `HUMAN_CAPTURE_MODE` at `:112`, stamped at `:189`).

**1.4 There is no calibration dataset and nothing could produce one.** Nothing ever records whether a root cause turned out to
be right: `services/solved.ts:1-31` derives SOLVED from status, supersedes, evidence refs, provenance and deadlock, never from
an outcome. A confidence that can never be scored cannot be wrong.

---

## 2. Principles served

**1 — "Only judge when you know you were watching."** Support **fails closed**: an unresolvable reference is `unsupported`,
never `tool_observed`, mirroring non-negotiable #3's *"unknown provenance fails CLOSED to derived"*.

**3 — "A reason written after a change is not evidence the reason existed before it."** `repository_verified` means red
**before**, green **after**, and before/after is **commit order, never clock order**: two runs report `started_at` from two
runners, and a sender-controlled clamped timestamp is a ratchet, not an ordering (`commit-evidence.ts:34-42`).

**2 — "Attribution is not permission."** Same orthogonality: `ATTRIBUTED` + `unsupported` is real and reachable, as is
`human_declared` + `unsupported`; neither axis licenses the other. **Non-negotiable #6:** no tool output, stdout, stack trace,
failure message or prompt is stored — the only new bytes are one bounded pointer per claim.

---

## 3. Target model

### 3.1 Two axes as a derived read-model, not two new columns

```ts
// packages/schema/src/evidence-axes.ts   (NEW)
export const EVIDENCE_WHO = ["human_declared", "agent_derived"] as const;
export const EVIDENCE_SUPPORT = ["unsupported", "tool_observed", "repository_verified"] as const;
export interface EvidenceAxes {
  readonly who: EvidenceWho;
  readonly support: EvidenceSupport;
  readonly supportReason: EvidenceSupportReason;  // enum, never prose
  readonly observedAt: string | null;             // when the tool ran
  readonly verifiedAtCommit: string | null;
}
```

`EvidenceSupportReason` is an enum for 03 §3.3's reason — prose here would add an untrusted slot to every surface the label
lands on. Values: `no_verification_ref` · `ref_malformed` · `ref_unresolved` · `observed_failure` · `ci_observed` ·
`red_then_green` · `no_binding` · `no_ci_coverage` · `pruned_by_retention` · `no_platform_rung`. Axes are **derived fresh per
read**, like `CoverageRecord` (03 §3.2) and SOLVED (`solved.ts:1-3`: *"derived fresh per read — no LLM, no stored flag, nothing
to go stale"*): the claim does not change, the world around its check does.

### 3.2 WHO — and why every claim that exists is `agent_derived`

`evidenceWho(claim, probe: HumanAuthorityProbe)` returns `human_declared` only when **all** of `capture_mode === "human"`,
`provenance === "declared"` and `probe.wasStampedByHumanRoute(claim)` hold; everything else is `agent_derived`. The probe never
reads the wire field, because `record-handlers.ts:501` (`crosscheck-pins:520`) takes it from the body and a sender's assertion is
what AT-3 exists to refuse. **In 1.0 every claim is `agent_derived`** — not a placeholder but the measured truth (§1.3).

**A read-model failing closed does not discharge AT-3, and §3.2a is why this spec no longer stops here.** AT-3's "fails if" has
two halves — *"`publish_claim` or any agent surface can produce human capture mode, **or** the attempt is silently downgraded
instead of refused"* — and the first half is a **write-path** defect, live on main, that no read-model closes.

### 3.2a AT-3's write path — the hub stamps `capture_mode`, and the wire stops carrying it

**The defect, measured.** `ClaimSchema` (`packages/schema/src/claim.ts:18-31`) carries
`captureMode: CaptureModeSchema` **on the wire**, and `record-handlers.ts:501` (`crosscheck-pins:520`)
inserts it verbatim. `grep -rn 'captureMode: "human"' packages/*/src` returns **zero** writers, so nothing
in the product does this today — but nothing stops a hand-rolled POST under a developer bearer key from
doing it, and the key sits in plaintext in `~/.crosscheck/config.json`. A claim stored
`capture_mode: "human"` renders to every teammate as a human's word.

**The fix is #50's, copied rather than invented.** #50 solved exactly this for pins by **removing the field
from the wire**: `PinSchema` no longer carries `captureMode` at all, it carries `presence` — *"what the
client OBSERVED"* — and the hub stamps the stored mode from it (`crosscheck-pins:schema/src/pin.ts:24-33`,
`:70-89`; `services/pins.ts:112`, `:189`). Its own comment names the reason: `captureMode: "human"` was
*"the caller's own conclusion ABOUT ITSELF, which the hub then printed as 'verified by Nick (a human, at a
terminal)' … a sentence a model could write about Nick"*. Applied to claims:

1. **`ClaimSchema` drops `captureMode`.** The agent tools already hard-code it (`publish-claim.ts:183` and
   three siblings), so no tool call changes; what disappears is the *ability* to send it.
2. **The hub stamps it from the route and the producer.** `/api/records` is an agent path: a `claim` record
   is stamped `agent` where the producer is an MCP tool or hook and `auto` where it is a derived worker —
   the same seven writers, the same seven values, now decided hub-side where a caller cannot reach them.
3. **A body carrying `captureMode` is a REFUSAL, not a downgrade.** It fails `ClaimSchema` at the schema
   boundary and returns a validation error naming the field. This is the half AT-3's second clause is about,
   and the distinction matters against 00 §4.5's rule that *"a 1.0 route that rejects a well-formed record
   for a policy reason destroys it"*: **a record carrying a field the schema does not define is not
   well-formed**, so it never reaches the ingest path, the spool never advances its cursor on a 2xx, and
   nothing is destroyed. A *policy* rejection of a valid record would be the trap; a *schema* refusal is the
   boundary the tree already refuses at, and #50 chose it deliberately — *"the literal makes the gate fail
   CLOSED — an absent or unknown value is a parse failure, never a default"*.
4. **`CAPTURE_MODES.human` becomes unreachable on claims in 1.0, and doctor says so** rather than leaving a
   silent absence (AT-10, 03's rule): `PASS "human authority" — "no human claim route in 1.0: every claim is
   agent_derived; capture_mode is hub-stamped and the wire cannot carry it"`. **This is the honest scope
   line.** #50's `presence: PIN_PRESENCE_TERMINAL` gate is buildable for claims and 1.0 does not build one:
   a human typing a claim at a terminal is a product surface nobody has asked for, and inventing it to fill
   a table would be the fake design this set forbids. What 1.0 owes AT-3 is that **no agent surface can
   produce human capture mode**, and that is what §3.2a delivers.

**`HumanAuthorityProbe` stays as the seam**, now with a named future occupant rather than an uncommissioned
spec: when a human claim route lands, `wasStampedByHumanRoute` asks the hub which route stamped the row.
Until then it returns `false` unconditionally, and §3.2's read-model is the second lock on the same door.

### 3.3 WHAT — `tool_observed`, and the re-check the hub cannot do

`tool_observed` = **a machine produced an observation of a named check, the hub holds it structurally, and a reader with the
repository can re-run it.** **The hub re-checks nothing** — the brief's phrase is narrowed here rather than designed around: the
hub holds no repository (05 §3.5 states it for refs), runs no commands, and has no outbound-call story (05 §8.4); it holds the
pointer and resolves it against rows it already has. **Exactly two producers of a machine observation exist:** an
`error_fingerprint` target — a connector-observed tool *failure*, hashed (`flows/capture-targets.ts:126-149` via `fingerprint()`
at `capture/fingerprint.ts:53-60`, value `sha256:<hex>`, stored `schema.ts:210-234`) — and a `ci_test_results` row (05 §3.3), a
CI-observed non-green test or its *absence* in a `completed` run. Nothing else in the tree produces a result a machine saw: a
profiler trace, a flame graph and a benchmark have **no rung in 1.0** (§8.5).

### 3.4 The one thing stored: `claims.verification_ref`

`text NULL`, `"<kind>:<value>"`, `VERIFICATION_REF_KINDS = ["error_fingerprint","ci_test"]`, CHECK `char_length ≤
MAX_VERIFICATION_REF_CHARS`.
- `error_fingerprint:sha256:<hex>` resolves against `work_context_targets (work_context_id, 'error_fingerprint', value)` — the
  PK (`schema.ts:229`) and the `(kind, value)` index (`schema.ts:233`) both serve it, and the alphabet is `sha256:` plus hex, so
  it carries **no untrusted text**. `work_context_targets.created_at` is `observedAt`, nullable by design (`schema.ts:217-226`):
  null means *age unknown*, not *unobserved*.
- `ci_test:<test_id>` resolves against `ci_test_results.test_id` (05 §3.4) scoped by `repo` via `ci_test_results_repo_test_idx`.
  A `test_id` is `"<file>::<describe chain>::<name>"` — **author-written text**, ≤ `MAX_CI_TEST_ID_CHARS = 300`, and the reason
  for §5's pulled-only rule.

Wire: `ClaimSchema` gains `verificationRef: z.string().max(MAX_VERIFICATION_REF_CHARS).optional()`. Absent means `unsupported` /
`no_verification_ref`, **never** "unknown, assume good". The hub stores it **without resolving** it, for the reason
`evidence_refs` are persisted as-is: the target row may arrive later in the same flush. **One ref per claim** — a second
verification is a second claim, since claims are append-only and *"revision means a NEW claim"* (`services/hints.ts:68-70`).
**Refused: widening `evidence_refs` instead** — a tagged union inside a live `jsonb` array gives one column two meanings.

### 3.5 `repository_verified` — four legs; unreachable until 02 and 05 land

All four, or the weaker rung with the reason naming the missing leg:
1. the claim is **bound to a commit** (spec 02; 00 §10 Q4, Q11). Missing → `tool_observed` / `no_binding`.
2. ref kind is `ci_test`. An `error_fingerprint` can show a failure was observed, never that a fix landed — it stops at
   `tool_observed` / `observed_failure`.
3. a `ci_runs` row in **one lane** (05 §3.1 — nothing is compared across lanes) where the test is **non-green at the bound
   commit** or an ancestor inside that lane's base window.
4. a later `outcome = "completed"` run **in the same lane** where the test is **absent from the non-green list**, at the commit
   where the affected surface landed. Only a `completed` run establishes a green.

Ordering across 3 and 4 is **by commit, never by `started_at`** (§2). A red run pruned past `CI_RETENTION_DAYS = 30` →
`pruned_by_retention` (§10 D1); `readCiCoverage` `unavailable`/`unknown` → `no_ci_coverage`. **`repository_verified` is
unreachable without 02 and 05, and that is a doctor line, not a silent absence** (AT-10): `WARN "evidence axes" —
"repository_verified unreachable: no ci coverage"` / `"… no claim commit binding"`, via `check()` at
`cli/src/cli/doctor.ts:190` on main / `crosscheck-pins:204` (00 §9.4a).

### 3.6 What `confidence` becomes: capped, informational, never load-bearing

1. **It keeps its wire field, column and six render sites** — removing it breaks six renderers and a shipped wire contract to
   fix a labelling problem.
2. **It may appear in no predicate** — not a filter, sort key, floor, gate, selector or threshold. Today that is true by
   accident (§1.2); `EV-4` makes it true on purpose and makes the moment somebody changes it a red build. **EV-4 needs two
   directives to cover that sentence, not one** — the comparison grep cannot see a sort comparator, a cap or a truthiness
   filter, and the tree already contains one of those (§7).
3. **It renders only beside both axis labels** (§5). `confidence 0.80` alone is the failure mode; `agent_derived · unsupported ·
   confidence 0.80` is a hedge a reader can discount.

**Why 0.80 that is right 55 % of the time is worse than no number.** A reader discounts prose correctly — "I think it is the
cache" is heard as a guess — but two decimals read as a *measurement*, and the reader cannot know that nothing measured it
(§1.4). The number transfers the model's uncertainty in a form that suppresses the reader's own discounting; no number leaves
that discounting intact. It becomes worth printing once calibration says what it means, which is why it is kept. **Refused:
extending `DERIVED_CONFIDENCE_CAP` to agent-declared claims** — `publish-claim.ts:184-187` says the cap does not apply to a
declaring agent *"and must not be quietly borrowed to escape it either"*, and extending it would break `review_draft` confirm
above 0.5 (`review-draft.ts:139`).

### 3.7 The calibration measurement

`packages/server/src/services/calibration.ts` — **derived on read. No table, no job, no cron, no retention.**

```ts
export interface CalibrationCell {
  readonly agentKind: string;              // agent_sessions.agent_kind — the provider
  readonly rootCausesObserved: number;     // agent_derived root causes in window
  readonly withVerificationRef: number;    // could ever be verified
  readonly withoutVerificationRef: number; // could NEVER be — printed always
  readonly nowToolObserved: number; readonly nowRepositoryVerified: number;
  readonly stillUnsupported: number; readonly unresolvableByRetention: number;
  readonly windowDays: number; readonly computedAt: string;
}
// CalibrationReport { repo; cells ≤ CALIBRATION_MAX_CELLS; claimsRead; claimsTotal }
```

It answers the brief's question: over months, how often did an `agent_derived` / `unsupported` root cause later become
`repository_verified`, **per provider** — `agentKind`, which already exists (`schema.ts:130`,
`connector-core/src/constants.ts:3`). Four rules, each refusing a familiar mistake:
1. **Counts only. No rate, percentage, score or badge.** The scalar ban (00 §8.1, §8.5) applies for the reason it applies to
   coverage: a ratio over twelve observations is the 0.80-at-55 % problem wearing a denominator. Whether a rate is ever printed
   is decided after the data exists (§10 D2).
2. **`withoutVerificationRef` is always printed beside the rest** — the ran-denominator lesson in #50's own words
   (`crosscheck-pins:connector-core/src/state/git-lane-cost.ts:12-21`: *"A LANE THAT NEVER RUNS LOOKS EXACTLY LIKE A QUIET
   ONE"*). A claim that never named a check can never be verified; hiding it turns the verified count into a flattering hit
   rate.
3. **Per `agent_kind`, per repo. Never per developer.** No developer id, name or email, and no session author, reaches a cell —
   #50's suspect rules draw this line one notch looser (*sessions and intents, never people*,
   `crosscheck-pins:services/suspect.ts:21-25`); here not even sessions.
4. **The bound is not spent at random** — newest-first before the cap, with `claimsRead` / `claimsTotal` so a surface can say
   the cut happened (`state/capture-health.ts:13-31`).

**No `CALIBRATION_MIN_OBSERVATIONS` floor is minted**, because no rate is printed and nothing needs one; minting it would be a
threshold with no data behind it, which the corpora's floor rule (`precision-corpus.test.ts:9-16`) exists to prevent.

### 3.8 Constants

`packages/schema/src/evidence-axes.ts`: `MAX_VERIFICATION_REF_KIND_CHARS = 20` and `MAX_VERIFICATION_REF_CHARS =
MAX_CI_TEST_ID_CHARS + MAX_VERIFICATION_REF_KIND_CHARS + 1` — **derived from 05's constant, not a second literal**, with a
`VERIFY:` that re-derives it (00 §7.2). `packages/server/src/constants.ts`, appended below 05's `CI_*` block (itself below #50's
`SUSPECT_*`), never renumbered: `CALIBRATION_WINDOW_DAYS = 90` · `CALIBRATION_MAX_CELLS = 8` · `CALIBRATION_MAX_CLAIMS = 500`.
Inherited **by name** so nothing is inherited silently (00 §10 Q10): `DERIVED_CONFIDENCE_CAP = 0.5` (`claim.ts:14`), not widened
(§3.6); `DIAGNOSIS_MAX_CLAIMS = 500` (`diagnosis.ts:17-27`), what `CALIBRATION_MAX_CLAIMS` matches; `CI_RETENTION_DAYS = 30` (05
§3.8), the ceiling on how far back a red/green pair is re-derivable and the reason `unresolvableByRetention` exists.
`CALIBRATION_WINDOW_DAYS = 90` is a **deliberate non-tuning** in `SUSPECT_SEPARATION_RATIO`'s sense: "months" is the brief, and
no dataset here justifies a second number.

---

## 4. Migration

**Nothing existing is redefined.** One nullable column, one optional wire field, one hub service, one render module.
- **Every existing claim becomes `agent_derived` / `unsupported`, reason `no_verification_ref` — the truth, not a default**, on
  §1.1 and §1.3's measurements.
- `verification_ref` is **written once at ingest, never updated**, so append-only (`hints.ts:68-70`) is preserved; what changes
  over months is the derivation. `evidence_refs` keeps its meaning (claim ids). `stale_at` is **untouched** — no writer, not on
  the wire, permanently null (00 §1.7a); it is the claim-binding spec's (00 Q11).
- `bootstrap.sql` gains the column and its CHECK, mirroring `schema.ts`; `server/test/ddl-sync.test.ts` gains a case asserting
  the CHECK matches `MAX_VERIFICATION_REF_CHARS`, following its two body-length cases (`:17-42`).
- **No backfill, and none is possible.** No historical claim named a check, and inferring one from a body is heavy intent
  inference from agent prose — cut (00 §8.6).

---

## 5. Where it renders, who consumes it

Both labels render **everywhere a confidence renders** — the six sites and the author echo enumerated in §1.2. **The ref text
renders only on `pulled` surfaces — `get_diagnosis` (`mcp/render.ts:315-319`) and nowhere else.** A `ci_test` id is author text
up to 300 chars, and the anchoring asymmetry is data, not habit (`render-surfaces.ts:71-95`): substance belongs where the reader
asked, and spending an unsolicited hint's characters on somebody's test name anchors a session on a file path.

**Registry obligation (non-negotiable #2).** One new module `packages/connector-core/src/evidence/render.ts` exporting
`axesClause(axes): string`, registered in `connector-core/src/render-surfaces.ts` as `{ kind: "composite", name:
"evidence-axes-clause", delivery: "unsolicited", module: "src/evidence/render.ts", note: <enum values, a commit sha and ISO
timestamps only — no author-written string reaches it>, corpusCoveredBy: ["test/evidence-axes-render.test.ts"] }`. `delivery:
"unsolicited"` although the clause also lands on a `pulled` surface: one module carries one classification,
`test/anchoring-separation.test.ts` walks the field, and the **tighter** is the safe direction (03 §5.2). The `note` may not say
`"corpus-covered"` (`:119`). No change to `RENDER_LAYER_MODULES` / `RENDER_BARREL_MODULES` (`:138-154`); **no new CLI surface**,
and the calibration line lands in the existing `cli-doctor` closure.

**Corpus obligation.** The ref is a new untrusted slot on one surface: `MCP_DIAGNOSIS_SLOTS`
(`connector-core/test/fixtures/injection-corpus.ts:582`) gains `verificationRef`. **Measured today: 18 slots.** The
implementation plants the directive and **writes no literal post-change total**:

```
VERIFY: bun -e 'const c=await import("./packages/connector-core/test/fixtures/injection-corpus.ts");console.log(c.MCP_DIAGNOSIS_SLOTS.length)'
PRINTS: <re-derived by CI — this spec is not the only appender>
```

*Corrected: this block pinned `PRINTS: 19` while **06 §5**, adding `intentAmendReason` and `intentScopeValue` to the same array,
pinned `PRINTS: 20`. Whichever landed second would have reddened the other, and if both land the answer is 21 — a number neither
spec contained. Neither §9 named the other on this file. That is the trap 00 §9.2 makes binding for `ci.yml` — "must not write a
literal post-merge total … because it cannot know how many other specs land first" — on a second shared directive the map had not
named; it now names it and generalises the rule to any `PRINTS:` counting a list more than one spec appends to. §9 below names 06
and the fixture.*

**Measured, and named rather than fixed:** `packages/server` has **no** `src/render-surfaces.ts` (five exist: `cli`,
`connector-acp`, `connector-claude`, `connector-core`, `connector-cursor`), so the two hub pages sit outside the registry walk
today; enum labels add no untrusted slot there, which is why **the ref text does not go on those pages**. Registering that
package is out of scope, named so it is not read as an oversight. **Consumers:** the verdict spec (read the axes, never the
number), 03 (§9), 05 (`ci_test_results`, `readCiCoverage`), 02 (the commit binding).

---

## 6. Budget

**Zero new hook-path work, zero new hub round trips.** The 800 ms rule (`connector-core/src/constants.ts:56-57`, `PRINTS: 800
800`) is untouched: no hook computes an axis, resolves a ref or reads a CI row.
- **The ref is set on an MCP tool call the agent already makes** — `publish_claim` and `extend_diagnosis` gain one optional
  argument (§10 D3). MCP is not a hook path.
- **`get_diagnosis` (hub, bounded)** — `DIAGNOSIS_MAX_CLAIMS = 500` (`diagnosis.ts:17-27`). Resolving 500 refs singly is an N+1,
  so **two batched queries per diagnosis**: one `IN` over `work_context_targets (kind, value)` (index `schema.ts:233`) and one
  over `ci_test_results (repo, test_id)`. Two, not five hundred.
- **Unsolicited surfaces** — two enum values ride the existing hint and briefing payloads: bytes, not a round trip.
  `MAX_HINTS_PER_PROMPT = 1` (`constants.ts:84`) is untouched, because the clause is part of a claim's fact list and not a
  second hint — which matters because `PROTECTED_CONFLICT` already competes for that slot (00 Q6).
- **Calibration is a pull only, and in 1.0 it is ONE DOCTOR LINE — there is no `crosscheck calibration`
  command.** *Corrected: §5 states "no new CLI surface, and the calibration line lands in the existing `cli-doctor` closure",
  §9 repeats it, and this section previously described a `crosscheck calibration` command while EV-7 asserted properties of "the
  report" — cells, counts, `withoutVerificationRef` — which only a printed report has. A module that renders a report is a module
  that renders, and non-negotiable #2's meta-test fails the build on any `src` module reaching the render layer that is not
  registered (`connector-core/src/render-surfaces.ts:1-19`, `test/render-surface-registry.test.ts:25-28`), so as written this spec
  either shipped an unregistered surface — a red build — or shipped no way to read the data it collects.* **Decided the second
  way, because the cut line decides it:** Tier 3 cuts *"calibration scoring surfaces — collect the data, build the UI once it says
  something"*, and a per-provider CLI report is that surface in a smaller costume. So 1.0 prints **one `cli-doctor` line** —
  `cells, claimsRead/claimsTotal, and withoutVerificationRef` — `calibrationReport()` returns the full `CalibrationReport` to
  whoever builds the UI later, and **EV-7 tests the returned value plus that doctor line**, not a command. No background pass, no
  retention, never on a hook path. **Hub job cost: none**, since nothing is stored.

**Measurement refusal.** I ran no benchmark, so this spec states **no** millisecond figure for the two batched queries. `EV-8`
requires one before merge, on `connector-claude/test/capture-latency.test.ts`.

---

## 7. Acceptance tests

Each `EV-n` can fail, and names the mutation that must turn its guard red in `connector-core/scripts/mutation-check.ts`
(`{label, file, from, to, test, because}` at `:38-47`). Counts are `VERIFY:` directives, never sentences (00 §7.1).

**EV-1 — an agent cannot read as human. (AT-3, WHO half.)** A `claim` record posted to `/api/records` with `captureMode:
"human"` is stored as sent and still yields `who: "agent_derived"` on every surface. *Fails if* any wire-supplied capture mode
produces `human_declared` under the default probe.

**EV-2 — support fails closed.** A ref that is malformed, carries an unknown kind, or names a row that does not exist yields
`unsupported` / `ref_malformed` or `ref_unresolved`. *Fails if* an unresolvable ref counts as support.

**EV-3 — `repository_verified` needs four legs and commit order.** (a) a `ci_test` ref with red at commit A and green at commit
B but **no commit binding** → `tool_observed` / `no_binding`; (b) green-then-red → never verified; (c) a pair whose `started_at`
order contradicts its commit order verifies **by commit**. *Fails if* clock order decides, or a missing binding still verifies.

**EV-4 — confidence gates nothing, on purpose. TWO directives, because one could not see what §3.6 rule 2 forbids.** The
rule is broad — confidence *"may appear in no predicate — not a filter, sort key, floor, gate, selector or threshold"* — and the
first draft's whole check was the comparison grep. **A sort comparator (`b.confidence - a.confidence`), a `Math.max`/`Math.min`
cap, a `filter(c => c.confidence)` and a ternary all pass it untouched**, and the tree already contains a non-comparison
operation on confidence the grep misses: `confidence: Math.min(draft.confidence, DERIVED_CONFIDENCE_CAP)`
(`connector-core/src/mcp/tools/review-draft.ts:132`, verified). So the mutation most likely to happen in practice — ranking hints
by confidence — was the one the guard could not catch, while the spec claimed a third comparison was *"the moment the invented
number becomes load-bearing"*.

*(a) The comparison directive, unchanged and still true.* **Measured: 2** — `schema/src/claim.ts:36` and
`schema/src/session.ts:44`, both the `DERIVED_CONFIDENCE_CAP` wire check.

```
VERIFY: grep -rEn 'confidence\s*(>|<|>=|<=)' packages/*/src | wc -l | tr -d ' '
PRINTS: 2
```

*(b) The occurrence directive, new.* Every `confidence` token in `packages/*/src` outside a **named allowlist**, counted by a
`VERIFY:` the implementation plants beside the allowlist. The allowlist is three entries and each says why: the two schema
files (the wire cap), and `mcp/tools/review-draft.ts` (the same cap applied on the way in). The six render sites of §1.2 plus
the author echo are *printing* sites and are listed separately, so a seventh printer is also visible. **Any other occurrence
fails the build** — that is where a sort key, a selector or a floor would first appear.

*Fails if* either count moves without the allowlist moving with it, in a reviewed edit. *Mutations:* add a 0.5 `confidence`
floor to the hint selector (catches (a)); **sort `candidates` by `b.confidence - a.confidence` in `hints/select.ts`** (catches
(b) and nothing else — which is the point).

**EV-5 — the labels travel with the number.** Every surface printing a confidence prints both labels in the same fact list — six
sites plus the author echo (§1.2). *Fails if* any surface prints a bare confidence.

**EV-6 — the ref is pulled-only.** `verificationRef` text appears on `get_diagnosis` and on no unsolicited surface, and the
diagnosis slot is in the corpus. *Fails if* a hint, briefing or statusline contains ref text, or the slot is missing.

**EV-7 — calibration prints counts, never a rate, never a person, and it prints through DOCTOR.** Two halves, because §5 and
§6 now agree that 1.0 ships no `crosscheck calibration` command: (a) a unit test over `calibrationReport()`'s **returned value**
— no ratio field, no `%`, no developer id, name or email, and every cell carrying `withoutVerificationRef` and
`unresolvableByRetention`; (b) the **`cli-doctor` line** renders cells, `claimsRead`/`claimsTotal` and `withoutVerificationRef`,
and nothing else. *Fails if* a rate field exists, a developer identifier reaches a cell, the never-verifiable count is omitted,
or **a `src` module renders a calibration report outside the registered `cli-doctor` closure** — which the registry meta-test
(`test/render-surface-registry.test.ts:25-28`) turns into a red build, and which is what an unregistered
`crosscheck calibration` would have been.

**EV-9 — an agent surface cannot produce human capture mode, and the attempt is REFUSED, not downgraded. (AT-3, write half.)**
Three cases, and all three are the halves of AT-3's "fails if": (a) a `claim` record whose body carries `captureMode` at all
**fails `ClaimSchema` at the boundary** with an error naming the field — not accepted-and-coerced, which is the silent downgrade
the second clause forbids, and not a policy rejection of a well-formed record, which 00 §4.5 forbids; (b) every claim stored
through `/api/records` carries a **hub-stamped** `capture_mode` derived from the route and the producer, matching what the seven
existing writers stamp today (`agent` ×4, `auto` ×3, **`human` ×0**, §1.3); (c) **no path in the tree stores
`capture_mode: "human"` on a claim** — a repo-wide assertion, the shape of EV-4's directive. *Fails if* any wire-supplied value
reaches the column, or if an attempt is coerced instead of refused. *Mutations:* restore `captureMode` to `ClaimSchema`; stamp
`body.captureMode` in the claim insert. **This is the test that was missing while three specs deferred AT-3 to a spec that was
never commissioned.**

**EV-8 — an unreachable rung is a doctor line, and the query is measured.** (03's AT-10 rule, applied here.) On a hub with no CI reporter, doctor
prints a named refusal for `repository_verified`, and §6's two batched queries are measured on `capture-latency.test.ts` before
merge. *Fails if* the rung's absence is invisible, or the spec ships with no measured number.

**Mutation anchors required**, plus a second `VERIFY:` re-deriving `MAX_VERIFICATION_REF_CHARS` from `MAX_CI_TEST_ID_CHARS`:
`evidenceWho` reads `claim.captureMode` instead of the probe (EV-1) · an unresolved ref returns `tool_observed` (EV-2) · order
the red/green pair by `ci_runs.started_at` (EV-3) · drop the `no_binding` leg from the predicate (EV-3) · add a 0.5 `confidence`
floor to the hint selector (EV-4) · drop the axes clause from `renderClaimHint`'s fact list (EV-5) · add the ref to
`renderClaimHint` (EV-6) · drop `withoutVerificationRef` from `CalibrationCell` (EV-7) · doctor returns `PASS` when
`readCiCoverage` is `unavailable` (EV-8).

---

## 8. Refusals

Each is a doctor line where a reader could mistake it for a gap — `check(level, name, detail)` at `cli/src/cli/doctor.ts:190`
on main / `crosscheck-pins:204` (00 §9.4a).
1. **No ladder, ever.** No `L1`–`L4`, rank, tier or "promoted to", and no combined score. `repository_verified` is not "higher
   than" `human_declared`; they answer different questions. The advisor's ladder was rejected and the rejection accepted (00
   §8.3).
2. **The hub re-checks nothing** (§3.3) — "re-checkable" means re-runnable by a reader who has the repo, recorded structurally
   by the hub.
3. **No calibration UI, scoring surface or dashboard** (Tier 3, cut), and **no rate, percentage or calibrated confidence in
   1.0** (§3.7 rule 1).
4. **`DERIVED_CONFIDENCE_CAP` is not extended to agent-declared claims** (§3.6).
5. **No new tool-capture lane** — no profiler hook, no benchmark harness, no `bun test` capture from a hook. A profiler trace,
   flame graph and benchmark have **no rung in 1.0**: `WARN "evidence axes" — "runtime tool evidence: no_platform_rung"`,
   matching 03's `runtime` = `unavailable` / `out_of_scope_1_0`. A local `bun test` is never evidence about a commit (05 §8.2).
6. **No stored tool output** — no stdout, stack trace, failure message, prompt or hostname (#6; 05 §8.5's precedent). The two
   stored shapes are a hash and a test name.
7. **No `human_edit` rung** (03 settled it; 00 §8.2), and **no inference of a verification from a claim body** (00 §8.6): if the
   model names no check the claim is `unsupported` and lands in `withoutVerificationRef`.
8. **Multiple refs per claim: refused** (§3.4). **`stale_at` is not mine** (00 §1.7a, Q11). *The AT-3 write path **is** mine
   now — §3.2a — and this clause used to disclaim it. Three specs disclaimed it; nobody owned it.*
8a. **AT-7 is not discharged by this spec or by any of the eight, and that is stated rather than left blank.** `grep -n "AT-7"
   docs/1.0/*.md` matches `00-cut-line.md` and `00-ground-truth.md` only — **zero across 01…08**. It asks for a net-new
   control-vs-treatment harness that runs a task twice per provider and diffs tool calls, files read and written, shell
   commands, plan changes and final result; `INJECTION_CORPUS` (61 cases) is prior art for the **payloads** and proves framing,
   and AT-7's own "fails if" line says framing is not behaviour, so the corpus cannot be stretched into the measurement. It is
   named here because a reader arriving at *"what supports this claim"* is one question away from *"and did the hostile claim
   change behaviour"*, and because a silently dropped acceptance test is what 00 §11.6 forbids. **The set discharges nine of
   ten**; 00 §10 Q12 carries the scope decision.
9. **Semantic collision detection, runtime invariant mining, auto-generated behavioural probes and conference are cut** (00
   §8.6), named because a reader arriving at "what supports this claim" expects one. A renamed test reads as a new test with no
   history — `ref_unresolved`, which is honest.

---

## 9. Collisions and sequencing

**PR #50 @ `bc88b8b`** (assume merged): `server/src/db/schema.ts` (+143/−1) — #50 appends tables after `question_answers`, my
column lands **inside** the existing `claims` block, which is `:237-291` **on main** and
`crosscheck-pins:257-311` after #50's +143. `services/record-handlers.ts` (+19) — #50's delta is the target handler's `"both"`
upgrade, mine is one field in the claim insert, `:491-509` on main and `crosscheck-pins:510-528`; the `.insert(claims)` call
moves `:492 → :511` and `captureMode: body.captureMode` moves `:501 → :520`. *All three were written as bare numbers under a
heading that says "PR #50 @ `bc88b8b` (assume merged)", so a builder taking them literally after #50 lands reads the wrong code.
00 §9.4a now states the one convention for the set and carries the measured pairs.* `server/src/constants.ts` (+38) — append
below, never renumber; **#49 also edits this file** near the head. `cli/src/cli/doctor.ts` (+105, `checkPins`) — one check
appended after it, and `check(level, name, detail)` is `:190` on main / `crosscheck-pins:204`. `cli/src/render-surfaces.ts`
3 → 6 — **no new CLI surface** (§5: the calibration line lands in the existing `cli-doctor` closure, and §6 no longer describes a
`crosscheck calibration` command). `git-lane-cost.ts` is untouched, but §3.7 rule 2 copies its pattern.

**`.github/workflows/ci.yml` and `mutation-check.ts`** (+151 on #50, +101 on #49). I add eleven `MUTATIONS` entries (EV-1…EV-9),
so per 00 §9.2 I name `ci.yml` here and touch **all three listings, not two**: the count at `:119-120`, the per-file block at
`:127`, and the **per-basename block** at `:246` on `crosscheck-pins` (`:239` on main) — *the third was not named in the first
draft, and a spec that updates two of three leaves a machine-checked guard stale and CI red.* New per-file lines for
`schema/src/evidence-axes.ts`, `services/calibration.ts` and `connector-core/src/evidence/render.ts`; in the per-basename
listing the first two are new basenames but **`render.ts` is a BUMP** of an existing line standing at 26
(`crosscheck-pins:.github/workflows/ci.yml:312`), not an addition. I **write no post-merge total** — I cannot know how many
specs land first. The directive prints it. On `mutation-check.ts` I am **editor 7** in the build order (00 §9.7); all eight specs
conflict at that array tail.

**Spec 03.** Build order puts 03 first and this spec seventh, so `isJudgeable`'s widened form (03 §3.1) is already in place when
the axes render beside a verdict.

**Spec 03.** No contradiction, one explicit warning: **coverage and support are different axes.** `coverage.ci = complete` says
CI reported at this commit; `support = repository_verified` says this claim's named check went red then green. A renderer
reading either as the other is wrong, and both land in the same fact lists.

**Spec 05 — the one disagreement between us, now settled in both files.** I add **no** CI table and no second reader of
`ci_runs`, but I read 05's rows in the opposite direction: 05 computes green → red (a regression), I need red → green (a fix).
This spec asked 05 to export `wasNonGreenAt(lane, commitSha, testId)` from `services/ci-delta.ts`, so the lane join lives in one
file; 05 §9.6 stated the opposite as settled — that 08 *"writes its own lane join rather than a second CI table — the right
call"*. As written, either the helper was never built and legs 3 and 4 of §3.5 had no implementation seam, or 05 gained an export
it said it did not owe. **05 has yielded**, because the argument is its own: §3.1's *"nothing is ever compared across lanes"* is
05's invariant, and an invariant enforced in two files is one that will disagree with itself.
**`services/ci-delta.ts` exports `wasNonGreenAt(lane, commitSha, testId): boolean`**, honouring the base window and the
`outcome = "completed"` rule that decides what a green means there; I call it and add no lane join of my own.

**Spec 02 (claim ↔ code binding).** Hard dependency and a shared migration: **we both add a column to `claims` and a field to
`ClaimSchema`.** Sequencing: **02 first, 08 appends** — one migration, one `bootstrap.sql` edit, one `ddl-sync.test.ts` block.
`repository_verified` is unreachable until 02 lands, and says so in doctor (§3.5).

**Spec 01 (event model): no collision — this spec adds no event kind and no record kind.** The ref rides the existing `claim`
record body; 00 §8.4's nine kinds are untouched, and putting it on `claim.created` is that spec's call.

**Spec 06 (intent ledger) — one shared fixture, and we were about to redden each other.** We both append to
`MCP_DIAGNOSIS_SLOTS` in `connector-core/test/fixtures/injection-corpus.ts` (measured today: 18 entries): I add
`verificationRef`, 06 adds `intentAmendReason` and `intentScopeValue`. Each of us had written its own absolute post-change total
into that list's `VERIFY:` / `PRINTS:` directive — `19` here, `20` there — so whichever landed second would have turned the
other's directive red, and the correct number if both land is 21, which neither spec contained. Neither §9 mentioned the other
on this file; this one said of the event model *"no collision"* and never named 06 at all. **Both now write the directive and no
total** (§5 here, 06 §5 there), and 00 §9.2 generalises 00's `ci.yml` rule to any `PRINTS:` counting a list more than one spec
appends to. **Sequence: either order**, which is the point of not writing a total.

**AT-3 is this spec's** (§3.2a) — the wire drops `captureMode`, the hub stamps it, a body carrying it is refused at the schema
boundary, and `CAPTURE_MODES.human` is unreachable on claims in 1.0 with a doctor line saying so. `HumanAuthorityProbe` stays as
the seam for a human claim route that 1.0 does not build. **04 §1(c), 06 §8.1 and 07 §9 now point here** instead of at a
*"human-authority spec"* that was never commissioned.

**The verdict spec (04):** `ATTRIBUTED` + `unsupported` and `human_declared` + `unsupported` are reachable states its renderers
must show, and attribution must not read `confidence` — `EV-4` turns red if it does. It consumes this spec's type by its real
name, **`EvidenceAxes`**; its first draft imported a non-existent `EvidenceRef` and is corrected.

---

## 10. Decisions for Nick

**D1 — the calibration horizon collides with CI retention.** The brief asks "over months"; `CI_RETENTION_DAYS = 30` (05 §3.8)
prunes the red run that proves a red → green pair, so a claim from 60 days ago whose fix landed 45 days ago is **unresolvable**,
not unverified. *Default: accept it and print `unresolvableByRetention` on every cell, so the loss is visible rather than
silent.* The alternative — a durable per-`(lane, test, commit)` marker surviving pruning — changes 05's build and reintroduces
the unbounded growth `commit_evidence` was designed to avoid (`schema.ts:370-373`).

**D2 — counts only, or a rate once some N is reached?** *Default: counts only in 1.0.* A rate is the first inch of a score and
the scoring UI is cut; reversing it means minting a floor with no data behind it, which the corpora's floor rule
(`precision-corpus.test.ts:9-16`) prevents.

**D3 — does `publish_claim` ask the model for a verification ref?** The one decision that changes what the trial can prove.
*Default: yes — one optional argument on `publish_claim` and `extend_diagnosis`, described as "the test that would go green, or
the error fingerprint that would stop, if you are right".* Cost: one tool-schema field and one sentence of description. The
alternative is that the axis exists as data, **nothing ever leaves `unsupported`**, the calibration dataset is empty for the
whole trial, and proof 5 has nothing in it.

**D4 — keep the confidence number, or retire it?** *Default: keep it — capped, informational, never load-bearing, always beside
both labels (§3.6).* Retiring it is defensible (§1.2, §1.4) but costs six renderers and a shipped wire field to fix a labelling
problem that a label fixes. If Nick prefers retirement, §3.6 becomes its rationale.
