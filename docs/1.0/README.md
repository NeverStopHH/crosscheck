# Crosscheck 1.0 — the spec set

This directory is the design record for Crosscheck 1.0: what gets built, in what
order, and which acceptance test each piece has to survive. `00-cut-line.md` is
the scope decision — three tiers, ten acceptance tests each with the line that
makes it fail, five proofs, and two decisions reserved for Nick.
`00-ground-truth.md` is the shared map of what the code *is* today, so that eight
specs build on one event model, one set of table shapes and one vocabulary; it
designs nothing, and every claim in it carries a `file:line` that was read.
`01`–`08` are the specs themselves, each owning one component, each stating its
migration, its render surfaces, its hook budget, its acceptance tests, its
refusals and its collisions. The set is written against `origin/main` at `e9aab82`
with **PR #50 and PR #49 assumed merged**; a bare line number is main's, and a
post-#50 position always carries the `crosscheck-pins:` prefix (00 §9.4a). Where a
rung cannot exist on a platform, or the honest answer is "not in 1.0", the spec
writes the refusal — a spec that pretends is worse than no spec.

## The six binding principles

1. **"Only judge when you know you were watching."** `UNATTRIBUTED` is emitted
   only under complete coverage; under a known gap the verdict is
   `INDETERMINATE`, never "unexplained, low confidence".
2. **"Attribution is not permission."** The verdict is `ATTRIBUTED`, never
   `EXPLAINED` or `ALLOWED`. Attribution and protection are orthogonal axes, and
   `ATTRIBUTED` + `PROTECTED_CONFLICT` is a real state every renderer must show.
3. **"A reason written after a change is not evidence the reason existed before
   it."** `explanation_timing` is its own dimension — `predeclared` / `post_hoc` /
   `absent` — and it needs **causal** order: happens-before over a monotonic
   per-session sequence, never a wall-clock comparison across machines, subagents,
   offline connectors or batch sync.
4. **"An agent cannot override human-protected behavior by broadening its own
   intent."** A fence invariant outranks any session widening. Changing one needs
   a human waiver — bounded, reasoned, append-only, expiring. Never
   `amend_intent`.
5. **"Missing evidence may weaken a conclusion. It must never strengthen one."**
   Added 2026-09-17, and it is the most general of the six: it binds coverage,
   provider gaps, claim evidence, CI, the garden fence and attribution alike, not
   just the ordering path that produced it. Its operational form, for any matching
   or closure a connector or the hub performs:

   > **Ambiguous or unmatched closure can only reduce certainty. It can never
   > increase it.**
   >
   > No valid match → no closure. Multiple indistinguishable matches → choose only
   > a deterministic conservative relation that cannot strengthen the causal claim.
   > If even that is not defensible → withhold the relation.

   The principle exists because PR #53 broke it in the most dangerous direction a
   system like this can break: an *unmatchable* tool window was closed by a
   foreign hook, and an unprovable state became `predeclared` — the value that
   exonerates. A gap that produces an accusation is a bug; a gap that produces an
   exoneration is a bug that nobody reports. Every guard written against this
   principle therefore has to show which way its failure falls.
6. **"Retention requires positive proof to delete, not positive proof to keep."**
   Added 2026-09-17, and it is the fifth principle applied to time: *data is
   deleted only when crosscheck can prove that nothing retaining still references
   it. Not knowing is not a reason to delete.* An unresolvable reference, a
   relation nobody declared, a table added without retention semantics — each of
   those is a **KEEP** with a counted reason, never a silent removal. 01a §3.3
   builds the retention graph this principle requires: explicit roots, explicit
   edges, and a declared contract that fails the build when a new session-bearing
   relation says nothing about whether it keeps causal history alive.

## Build order

```
#50 → #49 → 03 → 01 → 06 → 01a → 02 → 08 → 05 → 04 → 07
```

**Step 0 is the two PRs against each other.** #50 and #49 both rewrite
`.github/workflows/ci.yml:120` and both append to the `mutation-check.ts` array
tail, so they conflict before any spec starts. Whoever merges the second one takes
**neither side**: re-run the `VERIFY:` command on the merged tree and write what it
prints (the arithmetic 298 + 10 + 6 = 314 is the expectation, not the source).

**Six of the eight specs are hard-gated on #50** — they consume code or tables that
exist only on that branch, not merely text. Only 05 and 08 are gated textually.
The order inside the eight is fixed by what each consumes: **03** first because it
owns `CoverageReason`, the COV-5 shape 05 must edit, and the `isJudgeable`
predicate 04 and 07 both call; **01** next because 04 consumes `isOrderable` and 06
consumes `seq`; **06** next because 04 consumes `explanationTimingFor` and 01's two
intent event kinds project into 06's ledger; **02 before 08** because they share one
`claims` migration; **05** late because it is the only spec editing `ci.yml` for
content as well as counts; **04** second-to-last because it consumes all of 03, 01,
06, 05 and 08; **07** last because its `pins` columns stack on 04's. **01a** sits between 06 and 02: its
retention sweep needs 06's ledger as a root, and its `claims` column joins the migration family 02 and 08 share. Nothing
is lost waiting for it, because #53 ships with the sweep switched off (01a §10 D-D). The full
argument, with the measured #50-only dependencies, is 00 §9.7.

## The eight specs

Status is **spec** (written, not built), **in progress**, or **shipped**.

| # | spec | owns | status |
|---|---|---|---|
| 01 | [Canonical event model and per-session causal order](01-canonical-event-model.md) | **AT-4** | spec |
| 01a | [The causal skeleton: retention by root reachability, attestation, declared provider guarantees](01a-causal-skeleton.md) | — (makes AT-4 durable; amends 01 §10 D2) | spec (revision 3) |
| 02 | [Claim-to-code binding and individual commit identity](02-claim-code-binding.md) | **AT-2** | spec |
| 03 | [Coverage integrity at the answer layer](03-coverage-integrity.md) | **AT-1, AT-9, AT-10** | spec |
| 04 | [Verdict semantics, fence authority and the human waiver](04-verdict-semantics-and-fence-authority.md) | **AT-5, AT-6** | spec |
| 05 | [CI ingestion keyed to a commit, with same-commit re-run](05-ci-ingestion.md) | **AT-8** | spec |
| 06 | [Structured intent and the append-only intent ledger](06-intent-ledger.md) | — (supports AT-4, AT-3, AT-6) | spec |
| 07 | [Pilot instrumentation for the five proofs](07-pilot-instrumentation.md) | — (measures AT-1, AT-5, AT-9) | spec |
| 08 | [Two evidence axes and calibration measurement](08-evidence-axes-and-calibration.md) | **AT-3** | spec |

**One AT has one owner.** This table is the authority; a spec header that disagrees
with it is the spec that is wrong. Contributors are named but do not own: 06
supplies what AT-4 compares while 01 supplies whether two things may be compared at
all; 03 supplies the predicate AT-5 is decided by while 04 owns the verdict; 04
discharges AT-8's verdict consequence while 05 owns the test; 05, 07 and 08 each
discharge an *instance* of AT-10's refusal rule for their own rungs.

**AT-6 ships half-discharged, and 04 says so in its own header.** A waiver without
an expiry is a database impossibility, which is one clause of its "fails if"; the
other — *any agent-reachable path mutates a human invariant* — is a **detection,
not a prevention**, because the bearer key that reaches the waiver route sits in
plaintext on the same machine as the agent. 04 §10 D8 puts that residue in front of
Nick rather than leaving it in a refusal list.

**AT-7 is owned by nobody, and that is stated rather than left blank.** The
counterfactual injection benchmark asks for a net-new harness that runs a task
twice per provider and diffs tool calls, files read and written, shell commands,
plan changes and final result. `INJECTION_CORPUS` is prior art for the payloads and
proves *framing* — and AT-7's own "fails if" line says framing is not behaviour, so
the corpus cannot be stretched into the measurement. **The eight specs discharge
nine of ten acceptance tests.** Shipping 1.0 against ten means commissioning a
ninth spec; shipping against nine is a scope decision, not an omission a writer can
close (00 §10 Q12).

## Reading order

Read `00-cut-line.md` first and find your component's tier. Read `00-ground-truth.md`
§8 for the shared vocabulary — it is binding, and 03's and 05's names win over
yours. Read 03 and 05 before writing anything that touches coverage or CI. Cite
`file:line` for every claim about current code, write numbers as `VERIFY:`
directives rather than sentences, and name `.github/workflows/ci.yml` in your
collision section if you add a `MUTATIONS` entry — including **all three** of its
listings, which is the mistake five specs made and one caught.
