# 04 — Verdict semantics, fence authority and the human waiver

**Tier 1** (`00-cut-line.md`): *"Verdict semantics"* and *"Fence authority and the
human waiver. Extend the garden fence already in flight; do not restart it."*
**Owns AT-5 and AT-6.** AT-8 is **05's** — this spec discharges the verdict
consequence (VER-7) and does not own the test. **AT-6 is owned with one half
disclosed, not claimed**: the expiry half is discharged as a database
impossibility (§3.6), the human-gate half is a **detection, not a prevention**,
for the reason §8.8 states and §10 D8 puts in front of Nick. Vocabulary is
`00-ground-truth.md` §8. `CoverageRecord` / `isJudgeable` / `CoverageScope` are
**03's**, `CiBehaviorDelta` **05's**, `isOrderable` **01's**,
`explanationTimingFor` and `TIMING_REASONS` **06's**, `EvidenceAxes` **08's** —
consumed, none redefined, and **cited by the names their owners actually
export**. Written against `main@e9aab82` plus **PR #50
@ `bc88b8b`** and **PR #49 @ `2642640`**, both assumed merged (00 §9.4); a line
on a PR branch is cited `crosscheck-pins:<path>`.

## 1. Problem

**The five dimensions do not exist in the code.** Measured on
`crosscheck-pins@bc88b8b`: `grep -rn "ATTRIBUTED\|PROTECTED_CONFLICT\|
INDETERMINATE\|behaviorDelta" packages/` returns **0**; `grep -rn "waiver"
packages/` returns **0**. What ships is `SuspectOutcome` — `ranked |
no_separation | no_touch | withheld`
(`crosscheck-pins:services/suspect.ts:81-87`) — an enum about *one query's rows*,
not a verdict about a behaviour.

**(a) AT-5 is failed today, at one line.** For `no_touch`, `crosscheck suspect`
prints *"no session touched this surface in the last 14 days. Whatever broke it is
not in crosscheck's record."* (`crosscheck-pins:cli/src/cli/suspect-render.ts:191`).
That second sentence is `UNATTRIBUTED` emitted with **no knowledge of whether
anything was being recorded**: `suspect.ts` imports `constants`, `db/schema`,
`readPin`, `team-settings`, `db/client`, `types`
(`crosscheck-pins:services/suspect.ts:38-57`) — no `commit_evidence`, no absence,
no liveness, no coverage. 00 §5.2's gap one surface beyond 03's table; 03 refusal
8 hands it here.

**(b) The fence has no version, so weakening it leaves no fork in the road.**
`applyPinSweep` (`crosscheck-pins:services/pins.ts:526-620`) rewrites
`pin_files.path` **in place** — INSERT-then-DELETE per update, on `deps.db`, **not
inside a transaction** — and bumps `renamed_paths / renamed_at / renamed_by`.
`suspect` prints that a sweep moved the file set (`suspect-render.ts:145-175`),
but nothing can bind to *"the invariant as the human verified it"*.

**(c) There is no human-authority writer an agent cannot reach.**
`record-handlers.ts:501` (`crosscheck-pins:520`) inserts `captureMode:
body.captureMode` — the body's own word. #50 fixed this **for pins only**,
hub-side: the wire carries `presence: "controlling_terminal"` (evidence), the hub
stamps `capture_mode` (`crosscheck-pins:services/pins.ts:112`, `:185-189`;
rationale `crosscheck-pins:routes/pins.ts:14-32`). The waiver copies that. **The
claims path is AT-3's, and AT-3 now has an owner: spec 08.** Three specs had each
handed it to *"the human-authority spec"*, a file that was never commissioned and
does not exist in `docs/1.0/`; 08 §3.2 now owns the write path as well as the WHO
read-model, and this sentence points there rather than at nobody. (#50's `pins` comment at `schema.ts:575-582` still calls `PinSchema`
the gate *"(literal "human")"*, which `schema/src/pin.ts` no longer is — stale on
a branch under repair, flagged so nobody cites it.)

## 2. Principle(s) served

1. **"Only judge when you know you were watching."** `UNATTRIBUTED` only where
   `isJudgeable(coverage)` holds; under a gap, `INDETERMINATE` naming the missing
   source (§3.3, AT-5).
2. **"Attribution is not permission."** Two fields, two functions, two inputs;
   `ATTRIBUTED` + `PROTECTED_CONFLICT` is legal and every renderer must show it.
3. **"A reason written after a change is not evidence the reason existed before
   it."** `explanation_timing` is its own field, computed by 06 over 01's order,
   **never an input** to attribution or protection (§3.2, §9).
4. **"An agent cannot override human-protected behavior by broadening its own
   intent."** `computeProtection`'s input has **no session and no intent in it** —
   reading one is a type error. Only a `fence_waivers` row through the presence
   gate lifts `PROTECTED_CONFLICT` (§3.4, §3.6, AT-6).

## 3. Target model

### 3.1 `services/verdict.ts` — the type

```ts
export const ATTRIBUTIONS = ["ATTRIBUTED", "UNATTRIBUTED", "INDETERMINATE"] as const;
export const PROTECTIONS  = ["unprotected", "protected_ok", "PROTECTED_CONFLICT"] as const;
export const BEHAVIOR_DELTAS = ["confirmed", "unconfirmed", "flaky"] as const;

export interface Verdict {
  readonly repo: string;
  readonly invariant: InvariantRef | null;          // §3.5
  readonly behaviorDelta: BehaviorDelta;
  readonly deltaLane: "ci" | "pin";                 // never merged — 05 §3.1
  readonly deltaReason: DeltaReason;
  readonly coverage: CoverageRecord;                // 03 §3.1 — EXACTLY five rows
  readonly explanationTiming: ExplanationTiming;    // 06 §3.5 — see §3.2
  readonly timingReason: TimingReason;              // 06's TIMING_REASONS — its name, not mine
  readonly attribution: Attribution;
  readonly protection: Protection;
  readonly waiver: WaiverRef | null;                // §3.6
  readonly falsifier: VerdictFalsifier;             // §3.3a — suspect's four, plus one for the ci lane
  readonly evidence: EvidenceAxes;                  // 08 §3.1 — its name, not mine; two axes, no number
  readonly basis: VerdictBasis;                     // enum, never prose — 03 §3.3
  readonly candidates: readonly SuspectCandidate[]; // #50's rows, unchanged
  readonly computedAt: string;
}
```

`VerdictBasis` is an enum for the reason `CoverageReason` is: a verdict line then
carries **no author-written string except the pin surface and the waiver
reason** — the only two untrusted slots §5 must cover. Values: `separated ·
no_separation · no_touch_complete · coverage_gap · pin_paths_missing ·
falsifier_absent · no_check_recipe · attribution_withheld_by_team · delta_flaky ·
delta_unconfirmed · ci_no_surface · reader_named · legality_violation`.
`DeltaReason` on lane `ci` is 05's five values; on `pin` it is one,
`human_recheck_unrepeated` (§8.10). **`computeVerdict` reads no `confidence`**
(08's EV-4 reddens if it does), and `ATTRIBUTED` + `support: unsupported` is a
state the renderer must show.

**Two type names corrected, because the first draft invented both.** The fields
above were declared `IntentTimingReason` and `EvidenceRef` and §9 called the second
*"08's `EvidenceRef` verbatim"* — but **06 exports `TIMING_REASONS` and 08 exports
`EvidenceAxes`**, and `grep -n "EvidenceRef" docs/1.0/*.md` matched this file
alone. An implementer wiring this type had two imports that do not exist and no way
to tell whether a different shape was meant or the same one under another name.
They are the same shape; the owners' names win, as the header says they do.

### 3.3a `VerdictFalsifier` — suspect's four, plus the one the CI lane needs

```ts
export const VERDICT_FALSIFIERS = [
  "recorded_break", "not_recorded_broken", "no_check_recipe",
  "reader_named_files",        // #50's four, mapped 1:1 on the pin lane
  "ci_confirmed_regression",   // the ci lane's own — §3.3, 05 §9.3
] as const;
```

**`SuspectFalsifierKind` is untouched** — §8.6 keeps #50's enum closed ground, and
this is a **verdict-level** type that maps the four in and adds one, rather than
widening theirs. It is the answer to the question 05 §9.3 handed here and §9.6
repeated: *"A confirmed CI delta is a fifth shape … extending that enum is the
verdict spec's call, not mine."* It is this spec's call, and this is the call.

### 3.2 `explanation_timing` — carried, never weighed

`explanationTiming` and `timingReason` are `explanationTimingFor(chain, edit)`'s
return (06 §3.5), verbatim; this spec reads neither `workContextIntents` nor
`intentScope`, which 06's **INT-7** meta-test enforces from its side. **Neither
value is an input to `attribution` or `protection`.**

**Both open questions here are now closed, in both files.** (1) *Does unusable
causal order force `INDETERMINATE`?* **No** — 01 §3.7 yielded; §9 carries the
argument and §10 D7, which existed only to escalate it, is retired. (2) *What does
the timing dimension read under unusable order — 01's "declines to compute" or 06's
`absent` / `not_comparable`?* **06's**, with the rule that makes 01's objection
moot: the value and its reason are **one atomic answer and the value never renders
alone**, exactly as `INDETERMINATE` never renders without its `basis` here. The
first draft of this section said *"the disagreement is theirs"*; a consumer of both
functions does not get to leave a contradiction between them unresolved, so it is
resolved.

*(The meta-test is **INT-7**, "the ledger authorises nothing". This spec cited it
four times as INT-8, which is 06's unrelated back-compat test for an unscoped
intent — every one of those pointers sent a reviewer to a test proving something
else. All four are corrected.)*

### 3.3 Attribution — the mapping, with AT-5 inside it

`computeVerdict(deps, { suspect, coverage, delta, timing, evidence })`. `suspect`
is #50's `SuspectView` **unchanged**: no value added to `SuspectOutcome`, no term
to the lift ranking, no branch in `resolveSuspectScope`.

| input | attribution | basis |
|---|---|---|
| legality check fails (§3.7) | `INDETERMINATE` | `legality_violation` |
| `delta === "flaky"` | `INDETERMINATE` | `delta_flaky` |
| `withheld`, falsifier `not_recorded_broken` | `INDETERMINATE` | `falsifier_absent` |
| `withheld`, falsifier `no_check_recipe` | `INDETERMINATE` | `no_check_recipe` |
| `withheld`, setting `counts_only` | `INDETERMINATE` | `attribution_withheld_by_team` |
| `no_touch` ∧ `missingFiles.length > 0` | `INDETERMINATE` | `pin_paths_missing` |
| `no_touch` ∧ **¬`isJudgeable`** | `INDETERMINATE` | `coverage_gap` |
| `no_touch` ∧ `isJudgeable` | `UNATTRIBUTED` | `no_touch_complete` |
| `ranked` | `ATTRIBUTED` | `separated` |
| `no_separation` | `ATTRIBUTED` | `no_separation` |

**The reader-named scope — a row the first draft had no line for, and the omission
made every day-one answer a legality violation.** #50's fourth falsifier,
`reader_named_files`, is stamped when a caller passes `?path=` with no pin
(`crosscheck-pins:services/suspect.ts:194`) and is **deliberately not gated**: the
withhold gate fires only on `not_recorded_broken` / `no_check_recipe` (`:515-521`),
so a reader-named scope falls straight through to `ranked` / `no_separation` /
`no_touch`. Under the mapping above that answer becomes `ATTRIBUTED`, which trips
§3.7's rule (7) — *`ATTRIBUTED` ∧ falsifier ≠ `recorded_break`* — and fails closed
to `INDETERMINATE` / `legality_violation` **plus a doctor `FAIL`**, on the path
#50's own route header calls *"how this works on day one, before anybody has pinned
anything"* (`crosscheck-pins:routes/suspect.ts:1-15`). The contradiction was
invisible unless you cross-read §3.3 against §3.7.

| input | attribution | basis |
|---|---|---|
| `falsifier = reader_named_files` ∧ `ranked` | `ATTRIBUTED` | `reader_named` |
| `falsifier = reader_named_files` ∧ `no_separation` | `ATTRIBUTED` | `no_separation` |
| `falsifier = reader_named_files` ∧ `no_touch` | the `no_touch` rows above, unchanged | |

**The reader is the falsifier** — that is what the enum value means, in #50's own
comment — so rule (7) does not apply, and §3.7 now says so rather than leaving the
exemption implicit. A reader-named verdict carries `invariant: null`, `protection:
unprotected` and `waiver: null`: there is no pin, so there is nothing protected and
nothing to waive. The rendered basis `reader_named` states the premise out loud,
which is the whole point of #50's falsifier line — *"a ranking whose premise is
unstated is an accusation with the evidence left off"*.

**The `ci` lane — three rows and one refusal, because `deltaLane: "ci"` was a field
with no reachable outcome.** 05 hands this spec a `CiBehaviorDelta` and §9.3/§9.6
hand it the fifth falsifier shape; the first draft refused to extend suspect's enum
(correctly) and then mapped nothing off `delta` except the `flaky` row, so **every
CI-lane verdict could reach only `INDETERMINATE`**, and 05 §9.6's question about an
`unconfirmed` delta had no answer anywhere.

| input on `deltaLane: "ci"` | attribution | basis |
|---|---|---|
| `delta === "flaky"` | `INDETERMINATE` | `delta_flaky` (checked first, as on the pin lane) |
| `delta === "unconfirmed"` | `INDETERMINATE` | `delta_unconfirmed` |
| `delta === "confirmed"` ∧ a scope names the surface (a pin, or the reader's paths) | the pin-lane rows above, falsifier `ci_confirmed_regression` | |
| `delta === "confirmed"` ∧ no scope names a surface | `INDETERMINATE` | `ci_no_surface` |

`unconfirmed` and `INDETERMINATE` are **different dimensions and both are
emitted** — that is 05 §9.6's question, answered: nothing "wins", the delta says
what CI established and the basis says why nobody is named. And the fourth row is
where the honest refusal lives (§8.12): **1.0 has no join from a failing test to a
pinned surface**, so a CI-confirmed regression attributes only where a human or the
reader has already named the code.

Three deliberate decisions. **`flaky` is checked first**: it drops the candidate
list, attributes nothing, renders no row (05 CI-3). **`pin_paths_missing` outranks
`coverage_gap`** — both honest, but the missing-path one has a remedy the renderer
already knows, *re-pin the surface at its new path, not go looking for a session*
(`crosscheck-pins:suspect-render.ts:121-127`); **any** missing path, not all,
since a half-dead file set narrows the intersection without emptying it, *"the
same lie in smaller print"*. **`ATTRIBUTED` is legal under incomplete coverage and
`UNATTRIBUTED` is not**: naming a session that *is* in the record is a true
positive with a short list, while saying *nobody* did it out of a blind spot is
the false accusation principle 1 exists to stop. The coverage clause rides either
way (§5), and `ranked` is **not** demoted under a gap — separation describes the
rows that exist and already prints its arithmetic (`candidateLines`).

### 3.4 Protection — orthogonal, from a type with no intent in it

`computeProtection(input)` returns `unprotected` when `falsifierKind !==
"recorded_break"`, `protected_ok` when `liveWaiver !== null`, else
`PROTECTED_CONFLICT`. Its input is exactly `{ repo, pinId, pinVersion,
falsifierKind, liveWaiver }` — **no session id, no intent** — principle 4 made
mechanical. A session may call `set_intent` as often as it likes (*"Calling
set_intent again supersedes it"*, `mcp/tools/set-intent.ts:244`); it writes
`work_contexts.intent` and touches no pin, no version, no waiver. There is no tool
named `amend_intent`: measured, `grep -rn "amend_intent" packages/` on
`main@e9aab82` returns **0**, and the ten MCP tools are pinned by the `VERIFY:` at
`mcp/tools/index.ts:36`. 00 §8.5 bans a *shape* — a session widening its own scope
and something downstream reading that as permission — and this type is why it has
nowhere to land; 06 §3.6 enforces the same from the ledger side (**INT-7**).
`PROTECTED_CONFLICT` is reachable **only** on `recorded_break`: a pin nobody
falsified protects a behaviour nobody says is broken, which keeps the axis off the
edit path (§6).

### 3.5 The invariant, versioned — one column, no new table

Every field the cut line names exists on #50's tables: the invariant is
`pins.surface` (`crosscheck-pins:schema.ts:586`); the verification recipe
`pins.check_recipe`, NULL only above `MAX_SPEAKING_PIN_FILES = 5`; the code
surface `pin_files.path` + `.status` (`schema.ts:646-662`); ownership
`pins.verified_by` FK→developers with a hub-stamped `capture_mode`; the last
known good commit `pins.verified_at_commit` NOT NULL; affected sessions
`suspect`'s candidates (`work_context_targets ∩ pin_files`); evidence
`pins.broke_at` / `broke_by` plus 05's `ci_runs` and 08's axes. **Only the version
is missing: add `pins.version integer NOT NULL DEFAULT 1`, nothing else.**
`InvariantRef = { pinId, version, surface, checkRecipe, lastKnownGoodCommit,
verifiedBy, files, missingFiles }` assembles from existing rows.

`applyPinSweep` bumps `version` **once per sweep request per pin carrying at least
one accepted rename, before the first path moves** — `stop.ts:9-15`'s lesson,
since the sweep is not transactional and the honest direction is the failure
costing the smaller lie. Bump-first, a crash orphans that pin's waivers and the
verdict falls back to `PROTECTED_CONFLICT`; a human re-grants. Bump-last, a crash
leaves paths moved while old waivers still cover them — a silent widening an agent
could cause on purpose. A rename later rejected inside the loop still costs a
spurious bump and a re-grant: named, not hidden. `createPin` is unchanged.

### 3.6 `fence_waivers` — append-only, reasoned, bounded, expiring

New table after `team_settings` in `packages/server/src/db/schema.ts`. `id` text
PK (`fw_` + `randomUUID`, `crosscheck-pins:cli/src/cli/pin.ts:284`'s pattern) ·
`repo` text NOT NULL (denormalised, `pin_files.repo`'s reason,
`schema.ts:636-645`) · `pin_id` text NOT NULL FK→pins — **per fence, per repo**,
00 §10 Q7 answered · `pin_version` integer NOT NULL (§3.5) · `kind` enum
`WAIVER_KINDS = ["grant","revoke"]` · `granted_by` text NOT NULL FK→developers ·
`capture_mode` enum `CAPTURE_MODES`, **hub-stamped `"human"`, never on the body**
· `reason` text NOT NULL CHECK ≤ `MAX_WAIVER_REASON_CHARS`, required on a revoke
too · `expires_at` timestamptz · `supersedes` text FK→fence_waivers ·
`created_at` timestamptz NOT NULL.

```
CHECK fence_waivers_shape_check:
  (kind = 'grant'  AND expires_at IS NOT NULL AND supersedes IS NULL)
   OR (kind = 'revoke' AND expires_at IS NULL     AND supersedes IS NOT NULL)
INDEX fence_waivers_pin_idx (repo, pin_id, pin_version, created_at DESC)
```

**A waiver without an expiry is a database impossibility** — AT-6's "fails if"
discharged the way `questions_addressee_check` makes "never a broadcast" a
database fact (`schema.ts:489-491`). **Append-only means append-only**: nothing
UPDATEs this table, and withdrawal is a second row (`kind: "revoke"`,
`supersedes` the grant) — the `claims` pattern, *"revision means a NEW claim"*
(`services/hints.ts:68-70`). `readLiveWaiver(deps, repo, pinId, version, now)`
takes the newest row for the triple: a `grant` with `expires_at > now` and no
superseding `revoke` is live, anything else `null`.

**Routes:** `POST /api/fence-waivers`, `POST /api/fence-waivers/:id/revoke`,
`GET /api/fence-waivers?repo=&pin=`, all `developerAuth`; the two writes also
require `presence: PIN_PRESENCE_TERMINAL` and stamp `capture_mode` hub-side —
`crosscheck-pins:routes/pins.ts:14-32`'s gate copied with its stated limit (§8.8).
**Not `/api/records`**: a waiver can be typed by a person with no agent session,
and 00 §10 Q9's rule is general. **Not `requireAdmin`**: that token is the *team's*
decision surface (`crosscheck-pins:routes/team-settings.ts:7-19`), a waiver is one
behaviour in one repo (§10 D1). `app.ts` gains one appended mount. `expires_at` is
sender-supplied, so it is clamped to hub clock + skew and refused above `now +
MAX_WAIVER_DAYS` — `commit-evidence.ts:34-42`'s reason: it would be a ratchet.

**Constants.** `MAX_WAIVER_REASON_CHARS = 200` in `packages/schema/src/waiver.ts`
— the 200 of `MAX_PIN_CHECK_CHARS`, `MAX_REFUSAL_CHARS` (`services/refusal.ts:27`)
and `MAX_HUB_MESSAGE_CHARS`. `MAX_WAIVER_DAYS = 14` in `server/src/constants.ts`
below #50's `SUSPECT_*` block, with a `VERIFY:` pinning it equal to
`SUSPECT_WINDOW_DAYS` so a waiver cannot outlive the attribution window it
silences; it adopts the corpora's floor rule (00 §6.2) in a maximum's direction —
**never raised to make a case pass.**

### 3.7 Legality — what the type forbids

`assertVerdictLegal(v)`, exported, run at the route boundary. Illegal:
(1) `UNATTRIBUTED` ∧ ¬`isJudgeable(coverage)` — **AT-5**; (2) `ATTRIBUTED` ∧ zero
candidates; (3) not-`ATTRIBUTED` ∧ ≥1 candidate; (4) `flaky` ∧ not
`INDETERMINATE` (05 CI-3); (5) `protected_ok` ∧ `waiver === null`;
(6) `PROTECTED_CONFLICT` ∧ falsifier ≠ `recorded_break`; **(7) `ATTRIBUTED` ∧
`invariant !== null` ∧ falsifier ≠ `recorded_break`** — suspect's rule 1
(`crosscheck-pins:services/suspect.ts:15-17`) lifted into the type, **narrowed to
PIN-SCOPED verdicts**; (8) `coverage.sources.length !== 5` (03 §3.1);
**(9) `protection !== "unprotected"` ∧ `invariant === null`** — nothing is
protected where no pin exists.

**Rule (7)'s narrowing is a correction, not a softening.** As first written it read
*"`ATTRIBUTED` ∧ falsifier ≠ `recorded_break`"* with no scope term, which made
every reader-named-paths answer illegal (§3.3) — a `doctor` `FAIL` on #50's
day-one path. The `invariant !== null` term restores the rule's actual subject: a
verdict **about a pinned invariant** may attribute only where somebody recorded
that invariant broken. Where the reader named the files, the reader is the
falsifier and there is no invariant to be wrong about; where the lane is `ci`,
`ci_confirmed_regression` is the recorded break and §3.3's fourth row keeps an
unscoped confirmation from naming anybody. Explicitly **legal, and every
renderer must show it**: `ATTRIBUTED` + `PROTECTED_CONFLICT`; `UNATTRIBUTED` +
`PROTECTED_CONFLICT` (complete coverage, a protected behaviour broken outside
every observed lane); `ATTRIBUTED` + `support: unsupported` (08 §9). A violation
**fails closed to `INDETERMINATE` / `legality_violation` and emits a `doctor`
`FAIL`** — both halves, because non-negotiable #4 is *fail, never silently* and a
silent downgrade would hide the bug that caused it.

## 4. Migration

**`pins.version`** — every existing row becomes version 1 by DEFAULT. Honest
caveat: a pin swept before this lands reads `version = 1` with `renamed_paths > 0`,
so version 1 is *"the invariant as it stands"*, not *"as created"*; nothing is
redefined, because nothing binds to a version yet. **`fence_waivers`** is new, no
backfill possible. **No existing column changes meaning**: `claims.stale_at`
untouched (00 §1.7a, the claim-binding spec's); `SuspectOutcome`,
`SuspectFalsifierKind`, `SuspectView`, `SuspectCandidate` untouched;
`team_settings` untouched **by this spec** and **not** the waiver pattern, being
mutable (00 §10 Q7). *Corrected: the first draft said `team_settings` was untouched
in 1.0 full stop, while 07 §3.6 gates its pilot on a per-repo enrolment flag stored
there — two contradictory accounts of whether #50's two-column table grows. It
grows by one: 07 §4 now creates `pilot_enrolled` explicitly, with its
absent-row default. The waiver argument is unaffected — mutability is why a waiver
is not stored there, and a boolean flag is exactly what a mutable settings table is
for.*
**`bootstrap.sql`** mirrors table, CHECK and index, and `test/ddl-sync.test.ts`
gains a case for `fence_waivers_reason_length_check` matching
`MAX_WAIVER_REASON_CHARS`, following its two body-length cases inside
`describe("bootstrap.sql DDL sync"` — `ddl-sync.test.ts:16` on main,
`crosscheck-pins:22` (00 §9.4a). **No
retention**: the audit trail *is* the product — an expired waiver is what explains
a verdict that did not fire.

## 5. Where it renders / who consumes it

| surface | entry | obligation |
|---|---|---|
| `crosscheck suspect` | **new** `cli-verdict`, `corpus`, `pulled`, `framing: "framed"`, `src/cli/verdict-render.ts` | the verdict block prints above #50's falsifier lines |
| `crosscheck pin list` | existing `cli-pin-list` (`crosscheck-pins:cli/src/render-surfaces.ts:153`), framed | one line per live waiver: granter, expiry, reason |
| `status` / `doctor` | existing `cli-pin-observability` (`:128`), **`framing: "bare"`** | counts and ISO expiries **only — never a waiver reason** |

**The new untrusted slot, named because it is easy to miss.** The waiver `reason`
is prose another developer typed and reaches every reader of `suspect` and `pin
list`, so `cli-verdict` must plant the corpus payload **in the reason slot**, not
only the surface label: reusing #50's `suspectWith(payload)` fixture without a
waiver leaves the new clause unattacked while the registry still counts the
surface — 03's COV-7 failure in another file. `cli-pin-list`'s fixture gains the
same slot. **`cli-pin-observability` stays `bare`**: its registration says `status`
and `doctor` print paths and globs and *never another person's prose*, so
`3 live waivers, next expires 2026-09-28T00:00Z` is the whole line.
`cli-verdict` appends at the **array tail** of `packages/cli/src/render-surfaces.ts`
(3 → 6), **after `cli-status` (`crosscheck-pins:192`)** — 00 §9.1a. *Corrected: the
first draft of this paragraph named two different places in one sentence — "below
#50's +163 block … after `cli-suspect` (`:166`)" and "05 appends `cli-ci-report` to
the same tail" — and they are six lines apart, so this spec's own builder could not
tell which was meant. #50 **prepended** its three surfaces, so `cli-suspect` is at
`:166` and the tail is `cli-status` at `:192`. Four specs add a surface here; all
four now append at the tail, in build order, which makes each a one-line addition
at a different offset instead of a three-way conflict on one line.*

*Corrected again, at build time, by measurement. The tail is no longer
`cli-status`: `cli-claim-revalidate` (02) landed on 2026-09-17, three days after
this paragraph was written, and it took that slot. **And 05 never added
`cli-ci-report` at all** — it rendered its CI block inside `cli/status.ts`, an
already-registered module, and covered it with a probe in
`cli/test/ci-status-render.test.ts`, which is the alternative 05 §5's own
preceding sentence permits. So 05 §5's* "the new `cli-ci-report` entry must be
added … or the meta-test reddens the build" *is **false as measured**: the build
is green with no such entry, because the meta-test walks MODULES and 05 added
none. Two sentences of one paragraph contradict each other, and the build says
which is operative. **Consequence for 00 §9.1a:** the tail chain is
`cli-claim-revalidate` (02) → `cli-verdict` (04) → `cli-pilot` (07); the
`cli-ci-report` link in it names a surface that does not exist, and 07 must not
wait for it. `cli-verdict` is therefore surface **8**, appended after
`cli-claim-revalidate`.*

*And one thing this paragraph assumes that the corpus does not deliver.*
Planting the payload in the reason slot buys the **character** invariants over
that slot — invisible categories, zero-width marks, plane 14, the bounds, the
notice, at most one `« »` pair per line. It does **not** prove the reason is
inside a frame at all: the corpus reads the finished string and cannot know
which span was untrusted. **Measured by doing it** — replacing `quotedBody` with
a bare sanitize in `verdict-render.ts` leaves all **99** registry assertions
green. So `framing: "framed"` is a document-class claim, not a per-span one, and
the frame on the reason is pinned by `cli/test/verdict-render.test.ts` with its
own mutation anchor. A reader who takes the registration as proof that each
untrusted value sits in guillemets is reading more than it says.

**The reason slot had to be built before it could be attacked.** §3.6 defines
`readLiveWaiver` and this spec's `WaiverRef` as `{id, pinVersion, expiresAt}` —
no `reason` and no granter — so the obligation two paragraphs up was
unsatisfiable as written: there was no reason slot on a verdict to plant in.
Both now carry `reason` and `grantedByName`, and `readLiveWaiver` reaches the
name by the same join `listWaivers` already uses — **a LEFT join, not an inner
one**, because that query also reads the `revoke` rows: under an inner join a
revocation whose author is no longer on this hub drops out of the result and the
grant it closed reads as live again, which is a fence somebody shut reopening
itself.

**An absent verdict is the client-side Principle 5 case, and §5 did not name
it.** A 1.0 hub that predates this spec answers `suspect` with a ranking and no
`verdict` key. This tree's convention would read a missing optional block as
"nothing claimed" and print nothing — which leaves the pre-04 answer standing
and reads as a fully qualified one. So `http/verdict.ts` inherits **coverage's
inverted rule** (03 §4) rather than the default: `parseVerdict` returns `null`,
and the renderer is required to say so out loud. It must equally not fabricate
an `INDETERMINATE`: a verdict this client invented is indistinguishable,
downstream, from one the hub computed. The `no_touch` suppression is gated on a
**present** verdict for the same reason — withholding the outcome sentence on
top of a missing verdict would make the surface say less than the hub knows.

**Wire.** `GET /api/suspect` returns `{ ...suspect, coverage, verdict }` — sibling
fields, 03 §3.5's pattern. **03 §3.5 now lists `/api/suspect` among the responses
that gain `coverage`**; its first draft named five and omitted #50's route, while
this section's verdict block, its `coverage_gap` basis and its absent-coverage rule
all assume the field is there — and COV-9's registry walk would have flagged
`suspect-render.ts` as an answer surface with no coverage input. An absent record
becomes `UNKNOWN_COVERAGE` / five `unknown` / `hub_did_not_report` (03 §4), so
`no_touch` falls to `coverage_gap` rather than `UNATTRIBUTED` on an un-upgraded
hub — the correct direction. **This spec passes the pin's `pin_files.path` set as
03's `CoverageScope`** (03 §3.2a), so the gap it reads is a gap about the pinned
surface rather than about every session on the repo — without which `isJudgeable`
is false almost always and `UNATTRIBUTED` is unreachable in the field. **Not the briefing**: `INDETERMINATE` and `PROTECTED_CONFLICT`
lines would compete in one `MAX_BRIEFING_CHARS = 2200` cut, and 00 §10 Q8 makes
that ordering one product decision made once; this spec adds nothing unsolicited
(§8.1). **Not MCP**: measured, no MCP tool reads pins or suspect today.

## 6. Budget

**Hook-path cost: zero milliseconds, on every hook.** `suspect` is *"FULLY
POST-HOC … runs when a person types the command, needs no hook"*
(`crosscheck-pins:services/suspect.ts:5-8`); the waiver routes, `status` and
`doctor` are pulls. The 2 × 400 ms = 800 ms of non-negotiable #5
(`connector-core/src/constants.ts:56-57`, `PRINTS: 800 800`) is untouched,
`spareMs` (`config/hook-budget.ts:48-55`) unspent, `MAX_HINTS_PER_PROMPT = 1`
(`constants.ts:84`) keeps its slot — which matters because #50 already spends part
of Stop's `spareMs` on the git lane. **Hub-job cost** per verdict, bounded, on
existing indexes: one `readLiveWaiver` on `fence_waivers_pin_idx`; #50's suspect
query, capped at `SUSPECT_MAX_CANDIDATES = 50`; 03's `readCoverage`; 06's
`explanationTimingFor`; 05's `CiBehaviorDelta` only on the CI lane. Per waiver
write: one INSERT. **No background pass, no retention job, no new scan.**
**Measurement refusal:** I ran no benchmark, so no millisecond figure appears here;
VER-8 requires one before merge.

*Discharged at build time, and the figure lives in a test rather than in this
paragraph — a number written down once is a number that stops being true.*
`server/test/verdict-latency.test.ts` seeds six sessions against a two-file pin
on embedded PGlite and prints, on the machine that ran it:

```
GET /api/suspect        p50 2.76 ms   p95 3.33 ms
the verdict's own share p50 0.20 ms   p95 0.27 ms   (8.1% of the route's p95)
```

**The allowance is derived, not picked: 10 ms = one indexed lookup.** This spec
adds exactly two things to the route — `readLiveWaiver`, one indexed read on
`(repo, pin_id, pin_version)`, and `computeVerdict`, which is pure and touches no
database. So the ceiling is the cost of one extra round trip with an order of
magnitude of headroom, and a p95 above it does not mean *slow*, it means the added
work stopped being one indexed read. **The ceiling is on the ADDED work, never on
the route's total**, because a regression somewhere else in `suspect` would
otherwise read as a verdict problem and send the next person to the wrong file.

**Baseline in the same process, not against a git checkout.** Timing this branch
against the parent commit would compare two machines' moods as much as two code
paths; the route is timed whole, then the addition alone on the same seeded data,
seconds apart. And the benchmark asserts that it MEASURED something before it
asserts the ceiling: `percentile([])` is 0, 0 is under every ceiling anybody will
ever write, and a loop that never ran would discharge this refusal with a number
nobody measured. That failure has its own anchor.

## 7. Acceptance tests

Each must be able to fail; the mutation named is the one-line edit in
`connector-core/scripts/mutation-check.ts` that must turn the guard **red**
(00 §7.2).

**VER-1 — `UNATTRIBUTED` is unreachable under a gap. (AT-5.)** One reaped session
(`agent_event: incomplete`, `gapSince = 2026-09-05T08:13Z`), a pin recorded
broken, zero touching sessions → `INDETERMINATE` / `coverage_gap`; output must
**not** contain the sentence at `suspect-render.ts:191` and **must** contain
`2026-09-05T08:13Z`. *Mutation:* drop the `isJudgeable` term from `no_touch`.

**VER-2 — the same inputs under complete coverage attribute nothing, in different
words. (AT-5.)** Identical fixture, five sources `complete` → `UNATTRIBUTED` /
`no_touch_complete`. *Fails if* both fixtures render the same text — the pair is
the point. *Mutation:* map `no_touch` to `UNATTRIBUTED` unconditionally.

**VER-3 — a missing pinned path is never a fact about a person. (AT-5.)**
`no_touch`, one of three paths in `missingFiles`, coverage complete →
`INDETERMINATE` / `pin_paths_missing`. *Mutation:* require
`missingFiles.length === scope.files.length`.

**VER-4 — an agent cannot waive by widening its intent. (AT-6.)** **Rewritten,
because as first written it was vacuously green and its mutation could not exist.**
The fixture was a session whose `set_intent` names the pinned path, expecting
`PROTECTED_CONFLICT` — but §3.4 defines `computeProtection`'s input as exactly
`{repo, pinId, pinVersion, falsifierKind, liveWaiver}`, with no session and no
intent in it, so **every conceivable implementation passes, including one that has
never heard of intents**. A test a trivial wrong implementation cannot fail is not
a test. The first draft half-admitted this — *"the mutation is the test: it
compiles only if somebody widened the input type"* — but a `MUTATIONS` entry is
`{label, file, from, to, test, because}` (00 §7.2,
`connector-core/scripts/mutation-check.ts:38-47`): **one textual replacement** that
must turn one guard red. Widening a type, threading a new field through every
caller and adding a branch is not one `from` → `to` edit, so VER-4 shipped with no
working anchor at all — and AT-6's real failure condition (*"any agent-reachable
path mutates a human invariant"*) was left untested.

**The replacement is a meta-test in 06's INT-7 shape, which is the working
pattern.** A test walks every `src` module of every workspace package — the
discovery-from-filesystem shape of
`connector-core/test/render-surface-registry.test.ts:25-28` — and **fails the build
on any verdict or fence module importing `workContextIntents`, `intentScope` or
`workContexts.intent`**. That is a guard a wrong implementation fails, and its
mutation is a single line that really exists:

*Mutation:* add `import { workContextIntents } from "../db/schema.ts";` to
`services/verdict.ts`. VER-4 must go red.

The behavioural fixture stays as the second half — a session whose `set_intent`
names the pinned path, pin recorded broken, no waiver row → `PROTECTED_CONFLICT` —
but it is documentation of intent, and the meta-test is the guard. Paired with 06's
INT-7 from the other side.

*Corrected at build time: **06's INT-7 IS that meta-test, already**, so this spec
writes an anchor and not a second walker.* `server/test/intent-ledger-authority.test.ts`
walks every `src` module of every workspace package and fails on any module
outside its two-entry exempt set that reaches `workContextIntents` or
`workContexts.intent` — a rule strictly wider than "any verdict or fence module",
so 04's ground is inside it. **Measured, not assumed:** this paragraph's own
mutation reddens that file today, and so do the identical edits to
`services/waivers.ts` and `routes/fence-waivers.ts`. Building a second walker here
would be a second copy of a subtle rule, with the weaker copy the one nobody
re-reads — the exact shape INT-7's own header refuses, and the shape 00 §9.6
forbids unless something checks it. VER-4 is therefore satisfied by one
`MUTATIONS` entry naming `intent-ledger-authority.test.ts` as its guard, and the
two specs meet at one mechanism rather than at two that must agree.

**VER-5 — a waiver without an expiry cannot be stored. (AT-6.)** A grant body
with no `expires_at`, and a direct INSERT bypassing zod, are both refused — the
second by `fence_waivers_shape_check`; a `revoke` row makes the grant stop
covering; no UPDATE touches a stored row. *Mutation:* relax the CHECK to
`kind = 'grant'`.

**VER-6 — a sweep orphans the waivers it moved past. (AT-6.)** Grant at version 1,
sweep renames one path, recompute → `PROTECTED_CONFLICT`, grant row still present
and readable. *Mutation:* drop `pin_version` from `readLiveWaiver`.

**VER-7 — a flaky delta attributes nothing, an unfalsified pin names nobody.
(AT-8's verdict consequence; 05 owns AT-8.)** (a) 05's `rerun_green` delta with three ranked candidates
→ `INDETERMINATE` / `delta_flaky`, zero candidates. (b) falsifier
`not_recorded_broken` with candidates present → `INDETERMINATE` /
`falsifier_absent`. *Mutation:* test `flaky` after the outcome switch, not before.

**VER-9 — the `ci` lane reaches a verdict, and a scopeless confirmation names
nobody. (AT-8's verdict consequence; 05 owns AT-8.)** (a) `deltaLane: "ci"`,
`delta: "unconfirmed"` → `INDETERMINATE` / `delta_unconfirmed`, and the delta's own
reason still prints. (b) `delta: "confirmed"` with **no** pin and no reader-named
paths → `INDETERMINATE` / `ci_no_surface`, zero candidates. (c) the same
confirmation **with** a pin naming the surface → the pin-lane mapping, falsifier
`ci_confirmed_regression`, legal under rule (7). *Fails if* (b) names anybody, or
if any `deltaLane: "ci"` input can reach only `INDETERMINATE` — the state the first
draft shipped, where the field existed with no reachable outcome. *Mutation:* map
`ci_confirmed_regression` out of rule (7)'s allowed set.

**VER-10 — a reader-named scope is answerable on day one. (AT-5.)** `?path=`
with no pin, three touching sessions, one separated, coverage complete →
`ATTRIBUTED` / `reader_named`, `invariant: null`, `protection: unprotected`, **no**
`legality_violation` and **no** `doctor` `FAIL`. *Fails if* the answer downgrades —
the defect §3.3 and §3.7 fix, live on #50's documented day-one path. *Mutation:*
drop the `invariant !== null` term from legality rule (7).

**VER-8 — legality is enforced, not documented.** `assertVerdictLegal` over a
table-driven fixture of all **ten** illegal combinations; each downgrades to
`INDETERMINATE` / `legality_violation` **and** produces a `doctor` `FAIL`
(`check(level, name, detail)`, `cli/src/cli/doctor.ts:190` on main /
`crosscheck-pins:204` — the anchor moves under #50's +105, 00 §9.4a). Plus the measured p95 of `GET /api/suspect`
with the verdict attached against the pre-change baseline, with a named
allowance. *Fails if* any combination passes, or no measurement exists.
*Mutation:* make `assertVerdictLegal` return `true` unconditionally.

**`VERIFY:` directives** (00 §7.1): one re-deriving `ATTRIBUTIONS.length ×
PROTECTIONS.length` beside the count of combinations the legality table covers;
one printing `MAX_WAIVER_DAYS` beside `SUSPECT_WINDOW_DAYS`; one printing
`MAX_WAIVER_REASON_CHARS` beside the `bootstrap.sql` CHECK.

## 8. Refusals

1. **No in-session `PROTECTED_CONFLICT` channel in 1.0** — 00 §10 Q6, answered.
   The only unsolicited slots are `UserPromptSubmit` and `PreToolUse`, both 800 ms,
   both capped at `MAX_HINTS_PER_PROMPT = 1`, with the briefing already outranking
   the hint (`connector-claude/src/hooks/user-prompt-submit.ts:207-221`); and
   `PreToolUse`'s `ask` becomes a **one-shot deny** headless
   (`connector-core/src/constants.ts:1270-1297`, measured over 15 variants), which
   is why the pre-edit ask rung is cut. So it renders on `pulled` surfaces only,
   and **never blocks** (non-negotiable #1): no row withheld, no call refused.
2. **The ratchet is not designed here.** *Provisional, Tier 2*: re-verification at
   a new commit, per-version file archives, a path from `unconfirmed` to
   `confirmed`. Named so a reader knows where it would go — an archive table
   beside `pins.version` — **not sketched**.
3. **`explanation_timing` is carried, not defined here** (§3.2); computing it from
   `envelope.ts:33`'s `ts` is AT-4's named failure and is forbidden here too.
4. **No `runtime` rung** — `unavailable` / `out_of_scope_1_0` (03 refusal 3). A
   verdict never invents a source 03's record does not carry.
5. **No per-developer verdict, dashboard or score.** Suspect's rule 3 binds —
   *sessions and intents, never people*
   (`crosscheck-pins:services/suspect.ts:20-25`) — so no developer name joins a
   candidate row. A granter's name appears on a **waiver**, an act a person chose
   to perform, not an inference about them.
6. **`suspect` is not redefined.** Its outcome enum, lift ranking,
   `SUSPECT_SEPARATION_RATIO = 1.5` (a documented deliberate non-tuning), the
   falsifier gate and rule 4 (the reader's own sessions count) are #50's closed
   ground. The verdict wraps; it does not rewrite.
7. **No merge gate.** Cut line decision **B** is Nick's; this spec supplies
   evidence and states what a gate builder must know — a `deltaLane: "pin"`
   verdict carries `human_recheck_unrepeated` (§8.10).
8. **The human gate is worth exactly what #50 says it is worth, and AT-6 is
   therefore HALF-discharged — which the header now says instead of claiming the
   whole.** A bearer key reaching the waiver route can also send `presence`, and it
   sits in plaintext in `~/.crosscheck/config.json`
   (`crosscheck-pins:routes/pins.ts:26-32`, `crosscheck-pins:schema/src/pin.ts:80-88`).
   So an agent holding that key can grant a waiver and lift a `PROTECTED_CONFLICT`
   on a human-declared invariant — **principle 4's exact failure**, and VER-4/5/6
   test none of it. AT-6's "fails if" has two clauses and they land differently:

   | AT-6 clause | status |
   |---|---|
   | *a waiver has no expiry* | **discharged** — `fence_waivers_shape_check` makes it a database impossibility (§3.6), tested by VER-5 |
   | *any agent-reachable path mutates a human invariant* | **NOT prevented.** Detected only. |

   **The compensating control, named as a detection rather than left implicit:**
   every grant and every revoke is append-only, carries `granted_by` and `reason`,
   and **renders on `cli-pin-list` to the pin's own author** (§5), with counts and
   expiries on `status` / `doctor`. A human who pinned a behaviour sees, after the
   fact, that a waiver exists and who granted it. That is worth having and it is
   not the same as prevention; conflating the two would be the fake pass AT-10
   forbids. Making it unforgeable needs a credential an agent on the same machine
   cannot read — an OS keychain item, a hardware token, a second device — which
   this spec does not invent and **§10 D8 puts in front of Nick as an open AT-6
   gap** rather than burying in a refusal list.
9. **No verdict for a pin with no recipe** — `no_check_recipe` →
   `INDETERMINATE`: nothing existed that anybody could have run and watched fail.
10. **AT-8's environment half is not discharged for the pin lane — it is
    disclosed.** A pin discharges the *"always red"* half structurally
    (`verified_at_commit` is NOT NULL, so no pin was red at creation); the
    *"environment reason"* half needs a same-commit re-run, mechanical only in CI.
    05's lane reaches `confirmed` via `rerun_red`, the pin lane cannot, so it
    reports `unconfirmed` / `human_recheck_unrepeated` **while still attributing**
    — what Stage 1 ships, and the cut line says extend, not restart. Rendered as a
    line, not a footnote. §10 D3: where a reviewer may reasonably say no.
11. **Nothing on `conference`, semantic collision detection or elaborate change
    envelopes** — cut (00 §8.6).
12. **No join from a failing test to a pinned surface, and none is invented.**
    `ci_test_results.test_id` is `"<file>::<describe chain>::<name>"` (05 §3.4);
    `pin_files.path` is a repo-relative path. Nothing in the tree maps one to the
    other, and inferring it — "this test probably covers that file" — is semantic
    collision detection, which is **cut** (00 §8.6). 08's `ci_test:<test_id>` ref
    binds a **claim** to a test, not a pin to a test, so it does not close the gap
    either. **Consequence, in doctor rather than as a surprise:** a CI-confirmed
    regression attributes only where a pin already names the surface or the reader
    named the paths; otherwise it is `INDETERMINATE` / `ci_no_surface` (§3.3), a
    real confirmed behaviour change that nobody in the record can be tied to.
    `WARN "ci attribution" — "confirmed regression at <lane>: no pin names this
    surface"`.

## 9. Collisions

**Sequence:** `#50 → #49 → 03 → 01 → 06 → 02 → 08 → 05 → **04** → 07` (00 §9.7).
This spec is second-to-last because it is the only one consuming all of 03, 01, 06,
05 and 08 — the earlier draft's *"#50 → #49 → 03 → 04"* was right about its three
gates and silent about the other four. It still degrades honestly if one slips:
without 06 `explanationTiming` is `absent` / `no_intent`, without 05 the pin lane
stands alone, without 08 `evidence` is `agent_derived` / `unsupported`.

- **PR #50 — all of my ground is theirs.** `schema.ts` (+143: the new column goes
  on their table); `services/pins.ts` (`applyPinSweep` gains the version bump,
  `createPin` unchanged); `services/suspect.ts` and `routes/suspect.ts` (sibling
  field only); `cli/src/render-surfaces.ts` (+163, 3 → 6, append below
  `cli-suspect`); `cli/src/cli/doctor.ts` (+105, already has `checkPins` — my
  `FAIL` joins that ladder and adopts #50's *not measured* = PASS, *could not
  reach* = WARN); `server/src/constants.ts` (`MAX_WAIVER_DAYS` below `SUSPECT_*`,
  never renumbered). **Re-read `crosscheck-pins` before citing a line — it is
  under active repair** (00 §9.4); the stale comment in §1(c) is the evidence.
- **PR #49 — no structural collision**; a granter's name resolves the way
  `pins.verified_by` already does. Both PRs edit `constants.ts`, different regions.
- **`.github/workflows/ci.yml` — binding, 00 §9.2.** This spec adds `MUTATIONS`
  entries, so it bumps the `PRINTS:` count at **`ci.yml:119-120`** — **corrected**
  from `:117-118`, which 05 §9.5 had already measured and which the map now carries
  too — and touches **all three listings, not two**: the count (`:119`), the
  per-file block (`:127`) and the **per-basename block** (`:246` on
  `crosscheck-pins`, `:239` on main), which the first draft did not name. New
  per-file lines for `services/verdict.ts`, `services/fence-waivers.ts` and
  `cli/src/cli/verdict-render.ts`; in the per-basename listing all three are new
  basenames, so all three are added lines rather than bumps — unlike 03's
  `render.ts` and 06's `record-handlers.ts`, which already exist there. **No
  post-merge total is written here**, since I cannot know how many of the eight land
  first. On `mutation-check.ts` this spec is **editor 9** in the build order; all
  eight specs conflict at that array tail.
- **03 — consumed, never recomputed.** Its decision 6 and refusal 7 assign the
  mapping here, and COV-10 leaves *"that the verdict spec's `UNATTRIBUTED` path
  calls this function rather than recomputing it"* to VER-1. My `no_touch` gate is
  **03 §5.1's empty-result rule applied to `suspect-render.ts:191`**, a surface
  03's list does not name and 03 refusal 8 hands here.
- **05 — consumed, never merged.** `deltaLane` exists so a CI delta and a pin delta
  are never compared (05 §3.1 one level up). **AT-8 is 05's**, whole — its "fails
  if" is entirely about always-red tests and environment re-runs, which is CI
  machinery; this spec discharges the **verdict consequence** (VER-7, VER-9) and no
  longer says it owns a half. **Two things 05 handed here are now taken rather than
  left open:** §9.3's *"fifth falsifier shape"* is `VerdictFalsifier`'s
  `ci_confirmed_regression` (§3.3a), minted at the verdict level so
  `SuspectFalsifierKind` stays #50's closed ground; and §9.6's *"whether
  `INDETERMINATE` or `unconfirmed` wins when both apply"* is answered **neither** —
  they are different dimensions, both are emitted, and the basis
  (`delta_unconfirmed`) says why nobody is named (§3.3).
- **06 — agreement, and my one dependency.** 06 §3.6 states an amendment can
  neither clear a `PROTECTED_CONFLICT` nor satisfy a waiver, and **INT-7** — *"the
  ledger authorises nothing"* — reddens the build on any verdict or fence module
  importing `workContextIntents` / `intentScope`. *(This spec cited it as INT-8 in
  four places; INT-8 is 06's back-compat test for an unscoped intent. All four
  corrected, and VER-4's replacement guard is modelled on INT-7, so an implementer
  going to look for it must find the right one.)* I call `explanationTimingFor`,
  read neither table, and take `TimingReason` from 06's `TIMING_REASONS` by its own
  name.
- **08 — consumed, by its own type names.** `evidence` is 08's **`EvidenceAxes`**
  verbatim (`packages/schema/src/evidence-axes.ts`) — the first draft called it
  `EvidenceRef`, a name 08 does not export and `grep` found only here.
  `ATTRIBUTED` + `support: unsupported` is legal (§3.7), and `computeVerdict` reads
  no `confidence`, which 08's EV-4 enforces. **08 also owns AT-3 now**, including
  the claims write path §1(c) points at; it is no longer handed to an uncommissioned
  ninth spec.
- **01 — the one real contradiction in the set, now RESOLVED in both files.**
  01 §3.7 said that where causal order is unusable *"the verdict is `attribution:
  INDETERMINATE` carrying the reason"*. This spec disagreed: attribution is
  computed from a file-touch intersection, a falsifier and a coverage record, and
  none of the three reads `seq`. Letting a broken sequence force `INDETERMINATE`
  makes two of the five dimensions non-orthogonal — 00 §8.1's own framing forbids
  that — and silences attribution for **every pre-`seq` connector**, turning 01's
  own `pre_seq_connector` reason, a fact about instrumentation, into a verdict about
  a person's work. **01 §3.7 has yielded and now states the resolution itself:**
  unusable order affects `explanationTiming` / `timingReason` only, both printed,
  and attribution follows §3.3. **§10 D7 is retired** — it existed only to escalate
  this, and the decision no longer needs Nick. It mattered for the build order:
  04 consumes `isOrderable` and must not recompute it, so 01 lands first, and had
  01 landed as written the loss would have been silent.
- **07 — compatible, and ONE HARD COLLISION the first draft of both specs missed.**
  We **both add a column to #50's `pins` table and both write
  `services/pins.ts`**: this spec adds `pins.version` and the bump inside
  `applyPinSweep` (`crosscheck-pins:services/pins.ts:526`), 07 §3.4 adds
  `pins.repairs_pin_id` and `markPinOk` beside `markPinBroke` (`:225`). Two
  `ALTER TABLE pins` migrations, two `bootstrap.sql` edits and two
  `ddl-sync.test.ts` blocks on one table — and each spec's §9 discussed the other
  about something else entirely (this one about `pilot_attributions`, 07 about the
  outcome enums). **Sequence: 04 first, 07 appends** (00 §9.7 puts 07 last), one
  migration each, 07's stacked on the column this spec adds.

  The write paths interact semantically too, and the ambiguity is now closed in
  07's favour of being explicit: `applyPinSweep` bumps `version` once per sweep
  (§3.5), `markPinOk` records a repair, and nothing said **which version a repair
  is recorded against** — so a repair after a sweep was ambiguous by construction.
  **07 §3.4 now stores `repairs_pin_version` beside `repairs_pin_id`**, read at the
  moment `crosscheck pin add` resolves the broken pin, so a repair names the
  invariant as it stood when it was repaired. Also still true and still worth
  doing: `pilot_attributions` should add `attribution` and `basis`, since proof 3
  is about the verdict, not the outcome.
- **Claim binding (02) — no overlap, and 02 has withdrawn the one obligation it
  assigned here.** `InvariantRef.lastKnownGoodCommit` is `pins.verified_at_commit`,
  a *human's* statement about a surface: not a claim↔code binding, and never to be
  conflated with that spec's `claims.stale_at`. 02 §9 had told this spec that *"a
  fence firing on a claim reads `claimValidity()`"*; **no fence fires on a claim in
  1.0** — §3.4's `computeProtection` takes a `pinId`, a fence is a pin, and
  `Verdict` carries no claim and no validity field by design. 02 §9 now says so and
  the assignment is gone. What survives is true and needs nothing from either side:
  attribution and validity are orthogonal, so on a surface rendering both,
  `ATTRIBUTED` + `stale` is a real state, exactly as `ATTRIBUTED` +
  `PROTECTED_CONFLICT` is.

## 10. Decisions for Nick

**D1 — who may grant a waiver?** *Default: any member — `developerAuth` +
`presence: "controlling_terminal"`, hub-stamped `human`: the pin gate exactly*,
symmetric with the closed decision *anyone may pin*. Cost: the bearer-key limit
§8.8 names. Alternative: `requireAdmin`, making every waiver a hub-operator task.

**D2 — `MAX_WAIVER_DAYS` 14 or 30?** *Default: 14*, pinned equal to
`SUSPECT_WINDOW_DAYS` so a waiver cannot outlive the attribution window it
silences. Cost: a long refactor needs a renewal — one more append-only row.

**D3 — may a pin-lane break attribute without a second recorded run?** *Default:
yes* — it is what Stage 1 ships, and the verdict discloses
`human_recheck_unrepeated`. Saying no means `crosscheck suspect` names nobody
until somebody records a second run: a real reduction in the shipped feature, and
the strict reading of AT-8's environment clause.

**D4 — does a sweep invalidate live waivers?** *Default: yes, via `pin_version`.*
Cost: a repo that renames often re-grants often. Saying no lets an agent-run sweep
move a human's waiver onto behaviour the human never saw.

**D5 — does `PROTECTED_CONFLICT` get an in-session channel in 1.0?** *Default: no*
(§8.1). Cost: a person learns of a conflict on `suspect` or `status`, not
mid-session. Saying yes takes the single hint slot and inherits the headless
one-shot deny.

**D6 — verdict inside `GET /api/suspect` or its own endpoint?** *Default: inside
suspect*, 03 §3.5's pattern. Cost: #50's response gains a sibling field; a
separate endpoint costs a second round trip on a surface already pulling.

**D7 — RETIRED. 01 yielded.** This decision existed only to escalate the one live
contradiction in the set: does unusable causal order force `attribution:
INDETERMINATE`? **No** — 01 §3.7 now states the resolution in its own words, and it
affects `explanationTiming` / `timingReason` and nothing else. Nothing is left for
Nick here. Recorded rather than deleted, because the build order depended on it
(00 §9.7) and a reviewer who read the earlier draft will look for it.

**D8 — NEW, and it replaces D7 as the open item on this spec's ground. How much
does AT-6's human gate have to be worth?** The expiry half is discharged as a
database impossibility. The other half is **not**: the waiver routes take
`developerAuth` plus a body-declared `presence: PIN_PRESENCE_TERMINAL`, and an
agent on the machine can read that bearer key out of `~/.crosscheck/config.json`
and send both — so it can grant a waiver and lift a `PROTECTED_CONFLICT` on a
human-declared invariant, which is principle 4's exact failure. *Default: ship the
gate as a **detection** — explicit, required, refusable, attributable, and rendered
after the fact on `cli-pin-list` to the pin's own author — and say in the header,
in doctor and here that AT-6 is half-discharged.* Cost: a determined agent with the
key can still waive, and the human finds out afterwards rather than being asked
first. *Alternatives, both real and both bigger than this spec:* put the waiver
grant behind a credential an agent cannot read (an OS keychain item or a second
device), which is a new authentication story the hub does not have — it has exactly
two middlewares and no machine identity (00 §3.1); or make a grant require two
developers, which trades forgeability for a process cost on a three-person team.
**This is the decision the first draft buried in refusal 8 while the header claimed
AT-6 outright.**
