# 05 — CI ingestion keyed to a commit, with same-commit re-run

**Baseline.** `origin/main` at `e9aab82`, read at `~/worktrees/crosscheck-main`;
written against **main + #50 + #49 merged** (`00-ground-truth.md` §9.3). Facts
living only on a PR branch are cited `crosscheck-pins:<path>`. **Measurements I
ran this pass are marked `measured`; nothing else is a number.**

**Scope — answered.** `00-cut-line.md:41-42` puts this in **Tier 2**: *"CI
ingestion keyed to a commit, including a re-run of the same commit to separate
flake from regression."* Tier 2 = built as a v1 *because waiting produces data
that cannot answer the question* (`:36`). It is the cheapest half of the thesis —
*a test that was green and is now red, in an area no active intent covers, is an
unexplained change* — CI + git + intents, no new evidence machinery. **This spec
owns AT-8**, whole — its "fails if" is entirely about always-red tests and
environment re-runs, which is this spec's machinery; 04 discharges the **verdict
consequence** (VER-7, VER-9) and no longer claims a half. **AT-10 is 03's**, one AT
with one owner; this spec discharges an *instance* of its rule for its own provider
refusals (§8.1, §8.3, CI-8) and says so rather than claiming a share. Four specs had
each claimed a piece of AT-10 and none owned it, so no single test could fail for
it. See `docs/1.0/README.md` for the whole table.

**Revision note (2026-09-14).** The first draft opened §7 refusing to name any AT
because `00-cut-line.md` was lost; it is recovered, so **that refusal is
deleted** and CI-1…CI-8 map onto AT-8 and AT-10. I re-ran every measurement
rather than inherit it and corrected six citations (§9.4). **Section numbers are
frozen**: 03, 07 and 08 cite `05 §3.1`, `§3.3`, `§3.4`, `§3.5`, `§3.6`, `§3.8`,
`§4` and `§8.2/8.4/8.5`, so new material is appended (refusal 9, CI-7, CI-8),
never inserted. The §3 model is unchanged — ground truth §8.2b and §8.4a adopt it
verbatim.

---

## 1. Problem

**There is no `ci` coverage source and nothing in the tree emits one.** Ground
truth §8.2 lists `ci` as one of five sources and marks its signal *nothing
exists*. Re-checked: `RECORD_BODY_SCHEMAS` (`packages/schema/src/envelope.ts:42-54`)
has eleven kinds, none a CI result; `app.ts:26-50` mounts seventeen routes
(**measured**), none CI; and the five services that answer questions —
`search.ts`, `hints.ts`, `diagnosis.ts`, `solved-matches.ts`, `conference.ts` —
import no CI anything (§5.2).

**This repo's own CI cannot support the test either.** `.github/workflows/ci.yml`
is 411 lines, seven jobs — `test` `:9`, `concurrency` `:33`, `budgets` `:57`,
`mutation` `:105`, `cpu-starved` `:342`, `claims` `:377`, `secrets` `:400`
(**measured**). Three defects, all read:

1. **No result leaves the runner.** The `test` job is `- run: bun test`
   (`ci.yml:23`). Nothing writes, uploads or posts a machine-readable report; a
   red suite exists only as an exit code and a log.
2. **No re-run mechanism is wired.** `grep -rn "rerun\|re-run\|retry\|attempt"
   .github/workflows/` returns exactly two hits, both prose in comments
   (`ci.yml:63`, `hook-contract-watch.yml:12`) — **measured**. No
   `workflow_dispatch`, no step reads `github.run_attempt`. GitHub's native
   *Re-run failed jobs* does re-run at the same commit and does increment the
   attempt, but nothing records which attempt produced which result, so the two
   are indistinguishable. The one same-commit repetition that exists,
   `concurrency` (`ci.yml:46-55`), is a hard-coded loop over three files that
   reports nothing.
3. **`github.sha` on `pull_request` is the merge commit, not the branch head.**
   `ci.yml:4` triggers on `pull_request`. A row keyed on the merge sha can never
   join a session's `base_commit` (`schema.ts:133`) or a `landed_evidence` sha
   (`packages/schema/src/landed-evidence.ts:19`) — no developer's history
   contains it — so getting this wrong makes the feature silently join zero rows.

---

## 2. Principles served

**Principle 1 — "Only judge when you know you were watching."** The base window
can be absent (new lane), short (< `CI_FLAKE_BASE_RUNS`) or unreliable
(truncated); each yields `behavior_delta: unconfirmed` with a named reason and
pushes `coverage.ci` off `complete`, so the verdict layer must reach
`INDETERMINATE`, not `UNATTRIBUTED` — **AT-5**, whose predicate 03 owns and this
must not undercut. There is no path here from "CI said nothing" to a judgement.

**That sentence was not true when it was written, and 03 has been changed so that
it is.** `isJudgeable` read `agent_event` and `git` only (03 §3.1, first shape), and
04 §3.3 gates `no_touch` on that predicate and on no other coverage term — so a
repo with complete agent and git coverage and a `ci` source at `incomplete` still
reached `UNATTRIBUTED`, and a pin-lane verdict never consulted `ci` at all. The
requirement stated here was being silently undercut by the two specs it names.
**03 §3.1 now fails `isJudgeable` on any source that is `incomplete`** — not on
`unavailable` or `unknown`, so a rung that cannot exist and a rung nobody reports
still leave a verdict reachable — and **COV-10 enumerates all five sources**. The
states §3.6 defines below are the ones that now bite.

**Principle 3 — "A reason written after a change is not evidence the reason
existed before it."** CI timestamps are wall-clock on somebody else's machine,
and this spec **never** compares them to a session's clock. `started_at` /
`collected_at` are clamped to hub clock plus skew on ingest, as
`services/commit-evidence.ts:57-64` clamps its sender-controlled timestamp, and
serve only retention, ordering *within one lane*, and display.
`explanation_timing` is decided over the per-session `seq` (§8.4, Q2) and takes
nothing from here.

**Non-negotiable #4 — "fail, never silently."** Every way this can fail to know
something is readable: run `outcome` (`completed | truncated | crashed`), the
`awaiting_rerun` reason, `unavailable` for a provider with no reporter, and a
doctor line for each (§8).

---

## 3. Target model

*(Binding on the other seven specs as ground truth §8.2b — do not rename.)*

### 3.1 The lane — the only unit that may be compared

```
lane = (repo, provider, workflow, job, leg, ref)
```

`repo` is `normalizeRemoteUrl()`'s output (`connector-core/src/git/repo-identity.ts:26`),
so a CI row joins the key a session already carries. **Measured** by importing
it: all four spellings of this repo's remote (`https://…/crosscheck.git`,
`git@github.com:…`, no `.git`, `ssh://git@…`) normalise to
`github.com/neverstophh/crosscheck`. `leg` is the matrix leg, `""` when a job has
none; `ref` is the branch, because a base window interleaving a PR branch with
`main` means nothing. **Nothing is ever compared across lanes** — a
`macos-latest` red and an `ubuntu-latest` green are two facts, never one
contradiction, and `ci.yml:10-12` records that the team keeps both legs
*precisely because they disagree* (an inode-reuse bug, 20/20 Linux, 0/20 macOS).

### 3.2 `ci_runs` — one row per lane per attempt

| column | type | note |
|---|---|---|
| `id` | text PK | `cir_` + first 32 hex of `sha256(provider\nrepo\ncommit_sha\nworkflow\njob\nleg\nref\nrun_attempt\nrerun_kind)`. Deterministic, mirroring `hintDeliveryId`'s `hd_` shape (`connector-core/src/capture/records.ts:67,74-82`), so a retried POST is a `duplicate`, never a second row. |
| `repo` | text NOT NULL | |
| `commit_sha` | text NOT NULL | `COMMIT_SHA_PATTERN` (`git/commit-drift.ts:17`), reused not re-minted. **Head sha, never a PR merge sha** (§1.3). |
| `provider` | text NOT NULL | `CI_PROVIDERS = ["github_actions"]` |
| `workflow` / `job` / `leg` / `ref` | text NOT NULL | each ≤ `MAX_CI_LANE_FIELD_CHARS` |
| `run_attempt` | int NOT NULL | ≥ 1; `GITHUB_RUN_ATTEMPT` |
| `external_run_id` | text NOT NULL | `GITHUB_RUN_ID` — opaque, so a human can open the log |
| `rerun_kind` | text NOT NULL | `CI_RERUN_KINDS = ["none","same_job","new_attempt"]` |
| `rerun_of` | text NULL FK→`ci_runs.id` | hub rejects one whose target differs in repo+commit_sha+workflow+job+leg+ref |
| `outcome` | text NOT NULL | `CI_RUN_OUTCOMES = ["completed","truncated","crashed"]` |
| `tests` / `failures` / `skipped` | int NOT NULL | totals as the runner counted them |
| `duration_ms` | int NOT NULL | |
| `started_at` / `collected_at` | timestamptz NOT NULL | both clamped on write |
| `created_at` | timestamptz NOT NULL | |

Indexes (mirrored into `bootstrap.sql`, §4): `ci_runs_repo_commit_idx (repo,
commit_sha)`, `ci_runs_lane_started_idx (repo, provider, workflow, job, leg, ref,
started_at DESC)`, `ci_runs_rerun_of_idx (rerun_of)`. **No `reported_by`** —
`commit_evidence.reported_by` is a developer FK (`schema.ts:394-396`), a CI run
has no author, and inventing one is the phantom-teammate trap of Q9. Ownership
lives in the token (§3.7).

### 3.3 `ci_test_results` — non-green rows only

| column | type | note |
|---|---|---|
| `ci_run_id` | text FK→`ci_runs.id` | |
| `test_id` | text NOT NULL | ≤ `MAX_CI_TEST_ID_CHARS`, §3.4 |
| `repo` | text NOT NULL | **denormalised**, as #50 denormalises `repo` into `pin_files` for its `(repo, path)` index |
| `status` | text NOT NULL | `CI_TEST_STATUSES = ["failed","errored","skipped"]` |
| `duration_ms` | int NOT NULL | |

PK `(ci_run_id, test_id)`; index `ci_test_results_repo_test_idx (repo, test_id)`.

**Only non-green rows are stored, and that is a contract, not an optimisation.**
**Measured**: 275 test files, 651 `describe(`, 2555 line-start `test(`/`it(`
declarations. Two legs × ~2.5k rows per attempt against `MAX_INGEST_BATCH = 100`
(`server/src/constants.ts:88`) is ~50 round trips to say "everything passed". So
a run row asserts *these are all the non-green tests I ran*, and **that assertion
is usable only when `outcome = "completed"`**: a `truncated` run — one whose list
hit `CI_MAX_TEST_ROWS` — can never establish that any test was green. That is
`crosscheck-pins:connector-core/src/flows/capture-git-touches.ts:27-33`'s rule
("nothing" and "no answer" are different facts) applied to a suite. `skipped` is
stored rather than dropped, because a test that stops running looks green to any
rule built on absence; **measured**, this repo has 0 static `test.skip` /
`.todo` / `describe.skip` and 2 `skipIf`, so the cost is 2 rows per run.

### 3.4 `test_id` — derived from the runner's own report

**Measured this pass**, `bun 1.3.13`, `bun test --reporter=junit
--reporter-outfile=out.xml` over a purpose-built probe file (isolated in a
scratchpad; the repo suite was **not** run):

- console output is **preserved** alongside the XML — the CI log does not worsen;
- `<testcase>` carries `name`, `classname`, `file`, `line`, `time`, `assertions`;
- **`classname` is the describe chain innermost-first AND double-escaped** —
  nested `outer`/`inner` emits `classname="inner &amp;gt; outer"`, decoding to the
  literal `inner &gt; outer` — while **a top-level test emits `classname=""`**;
- **the chain is also present structurally**, as nested `<testsuite name="outer">`
  → `<testsuite name="inner">`, singly-escaped and already outermost-first;
- `line` is the test's own line, so it moves on any edit above it;
- two same-named tests in one file emit **identical `name` and `classname`**,
  differing only in `line` and `time`;
- `<testsuite>` carries `hostname="MacBook-Pro-von-Nick.local"` on every element;
- `<failure>` came back self-closing with only `type` — no message, no stack.

```
test_id = "<file>::<describe chain, OUTERMOST first, joined by ' > '>::<name>"
```

**The reporter derives the chain from the `<testsuite>` ancestry, not from
`classname`**: the ancestry is already outermost-first and singly-escaped, while
`classname` needs a reversal and a second un-escape — and a reversal silently
corrupts any describe name that legitimately contains `>`. A top-level test has
an **empty middle segment**, so both colons are always present. `line` is never
in the id; `hostname` is dropped and never sent (#6); `<failure>` is read for
**presence only**, never message or stack even where bun emits none, because a
failure message quotes source text and content-derived text on the hub is what #6
forbids.

**A duplicated `(file, chain, name)` triple is dropped and counted**, never given
a positional ordinal — an ordinal is stable only until somebody reorders the
file, and a test that cannot be identified cannot carry a verdict. The run then
carries `ambiguous_dropped > 0`, which doctor prints. **Measured**: a static scan
of all 275 files finds 3 repeated literal test names across 2 files
(`connector-core/test/session-state-transforms.test.ts`,
`cli/test/connector-capture-health.test.ts`), all three disambiguated by their
enclosing `describe` — so today's true ambiguity count is 0. I did not run the
repo suite to confirm it; the drop rule exists **because** I did not.

### 3.5 The flake filter — `services/ci-delta.ts`

For each non-green `test_id` in the primary run (`rerun_kind = "none"`) of lane L
at `commit_sha` C:

1. **Base window** = the most recent `CI_FLAKE_BASE_RUNS` runs of L with
   `rerun_kind = "none"`, `outcome = "completed"`, distinct `commit_sha`,
   excluding C, within `CI_BASE_WINDOW_DAYS`. With fewer on L's own `ref`, the
   window falls back to the same `(repo, provider, workflow, job, leg)` on the
   default ref, stamped `base_window_source: "default_ref_fallback"`. **The hub
   holds no repository and cannot check that the branch descends from that ref**
   — the fallback is an assumption, so it is labelled and rendered, never hidden.
2. `base.length < CI_FLAKE_BASE_RUNS` → `unconfirmed` / `insufficient_base`. **Stop.**
3. Non-green in any base run → `unconfirmed` / `not_stably_green`. **Stop.**
4. No run with `rerun_of` = this run's id → `unconfirmed` / `awaiting_rerun`. **Stop.**
5. Re-run green → **`behavior_delta: flaky`** / `rerun_green`. **No attribution is
   computed, requested or rendered for a flaky delta.**
6. Re-run non-green → `behavior_delta: confirmed` / `rerun_red`.

A run with `outcome = "crashed"` produces **no delta at all** and never enters a
base window: an infrastructure failure is not a fact about a commit.

```ts
export interface CiBehaviorDelta {
  readonly testId: string;              // sanitized at render, not here
  readonly lane: CiLane;
  readonly delta: "confirmed" | "unconfirmed" | "flaky";
  readonly reason: "insufficient_base" | "not_stably_green"
                 | "awaiting_rerun" | "rerun_green" | "rerun_red";
  readonly baseRuns: number;
  readonly baseWindowSource: "same_ref" | "default_ref_fallback";
  readonly rerunKind: "none" | "same_job" | "new_attempt";
}
```

`same_job` (a second `bun test` over the failed files, same runner) and
`new_attempt` (GitHub's re-run button, fresh runner) are **both** same-commit
re-runs and both reach `confirmed`; which one is recorded, because a `same_job`
re-run cannot rule out host state (§10 D2).

### 3.6 The `ci` coverage source — what 03 consumes

```ts
export interface CiCoverage {
  readonly state: "complete" | "incomplete" | "unknown" | "unavailable";
  readonly lanesExpected: number;
  readonly lanesReported: number;
  readonly truncatedLanes: number;
  readonly awaitingRerun: number;
  readonly collectedAt: string | null;
}
```

`readCiCoverage(deps, repo, commitSha)`. **No percentage, no scalar, no badge**
(§8.1). **`unavailable`** — never reported, or the provider has no reporter; the
default for every repo, and it stays the default. **`unknown`** — the repo
reports, but nothing has arrived for this commit yet. **`incomplete`** — some
expected lanes reported and some did not, or any lane is `truncated`/`crashed`,
or `awaitingRerun > 0`. **`complete`** — every expected lane reported `completed`
at this commit.

`lanesExpected` is **derived, not declared**: the lanes that reported in **all**
of the last `CI_LANE_QUORUM_COMMITS` distinct commits on this ref. A job added
yesterday is not yet expected; a job deleted yesterday stops being expected once
the quorum rolls past it. **03 owns `CoverageReason` and its twelve-value enum
has no CI members** (03 §3.3); `readCiCoverage` returns a state, not a reason, so
the mapping needs four additions **03 must make** — §9.1. This spec does not mint
them.

### 3.7 Wire and route

**`POST /api/ci-runs`, its own route — not an envelope.** `EnvelopeSchema`
requires `producer: {developerId, agentKind, sessionId}`
(`envelope.ts:19-23,30-37`) and CI has none of the three; minting a synthetic
session is the phantom teammate of Q9. So the reporter is not a producer, does
not spool, and does not go through `/api/records`. Ground truth §8.4a **adopted
this refusal** and generalised it: a 1.0 record that can originate outside an
agent session gets its own route.

Body (`packages/schema/src/ci-run.ts`, `CiRunReportSchema`): §3.2's columns minus
`id`/`created_at`, plus `results: CiTestResult[]` (≤ `CI_MAX_TEST_ROWS`) and
`ambiguousDropped: int`. Bounds mirror #50's, whose constants live in
`crosscheck-pins:packages/schema/src/pin.ts`: `MAX_CI_TEST_ID_CHARS = 300`
(`MAX_PIN_PATH_CHARS`, `:92`), `MAX_CI_LANE_FIELD_CHARS = 120`
(`MAX_PIN_SURFACE_CHARS`, `:34`), `CI_MAX_TEST_ROWS = 200`
(`MAX_PIN_SWEEP_UPDATES`, `:105`). Clock skew reuses the exported
`MAX_COMMIT_CLOCK_SKEW_MS = 120_000` (`packages/schema/src/commit-evidence.ts:31`)
rather than minting a second number.

**Auth: a hub-level `CROSSCHECK_CI_TOKEN`**, compared with `isTokenEqual`
(`middleware/auth.ts:4`), middleware `requireCiToken` beside `requireAdmin`
(`auth.ts:19-36`); read (`GET /api/ci-runs?repo=&commit=`) is `developerAuth`
(`auth.ts:38-`). Write-privileged / read-open is exactly #50's team-settings
asymmetry, stated in its own header — *"READ IS OPEN, WRITE IS ADMIN, and the
asymmetry is the point"*
(`crosscheck-pins:server/src/routes/team-settings.ts:8-14`). Not the admin token:
it also flips `pin_policy` and `suspect_attribution`, and a GitHub Actions secret
widens its blast radius to every fork-adjacent workflow mistake (§10 D1).
`app.ts` gains one mount, appended after the existing seventeen, not reordered.

### 3.8 Constants

Appended below #50's `SUSPECT_*` block in `packages/server/src/constants.ts`,
never renumbered: `CI_FLAKE_BASE_RUNS = 5`, `CI_BASE_WINDOW_DAYS = 14`,
`CI_LANE_QUORUM_COMMITS = 3`, `CI_RETENTION_DAYS = 30`. Inherited by name per
Q10: `COMMIT_EVIDENCE_RETENTION_DAYS = 30` (`constants.ts:98`) is what
`CI_RETENTION_DAYS` matches and why; `SUSPECT_WINDOW_DAYS = 14`
(`crosscheck-pins:server/src/constants.ts:542`) is what `CI_BASE_WINDOW_DAYS`
matches, so the attribution window and the base window cannot drift apart;
`MAX_INGEST_BATCH = 100` is *not* reused — this route posts one run and its cap
is `CI_MAX_TEST_ROWS`. The three wire bounds minted in §3.7 —
`MAX_CI_TEST_ID_CHARS = 300`, `MAX_CI_LANE_FIELD_CHARS = 120`,
`CI_MAX_TEST_ROWS = 200` — are named here too, so a sibling spec looking for
"05's constants" finds all seven in one place; a constant another spec cannot
find is one it will re-mint. `CI_FLAKE_BASE_RUNS = 5` is a **deliberate
non-tuning** in the sense `SUSPECT_SEPARATION_RATIO`'s comment uses, and adopts
the corpora floor
rule — *"THE FLOORS ENCODE TODAY'S INTENT, NOT MEASURED TRUTH … any metric below
its floor is a REGRESSION against declared intent"*
(`connector-core/test/precision-corpus.test.ts:8-15`) — so it is never lowered to
make a case pass.

---

## 4. Migration

**Nothing existing is redefined.** Two new tables, one route, four hub constants,
one schema module; no column changes anywhere.

- Existing rows untouched. No backfill is possible or attempted — CI history
  before the reporter lands exists in no form the hub can read.
- `coverage.ci` moves from *no signal exists* (§8.2) to **`unavailable` for every
  repo**, and stays there until that repo's workflow runs the reporter.
  `unavailable` is a real answer, not a placeholder. **03's COV-5 must change
  shape when this lands** — §9.1.
- `bootstrap.sql` gains both `CREATE TABLE IF NOT EXISTS` blocks and all four
  indexes, mirroring `schema.ts`. `packages/server/test/ddl-sync.test.ts`
  enforces it and gains a case for `MAX_CI_TEST_ID_CHARS` matching the
  `ci_test_results.test_id` CHECK, following its two existing body-length cases
  (`ddl-sync.test.ts:17-42`).
- Retention: ingest prunes `ci_runs` (cascading `ci_test_results`) past
  `CI_RETENTION_DAYS` and clamps future-dated rows on write, as `commit_evidence`
  does (`services/commit-evidence.ts:57-64`) — otherwise a forged `started_at`
  outruns retention forever.

---

## 5. Where it renders, who consumes it

| consumer | surface | obligation |
|---|---|---|
| **spec 03 (coverage)** | none of its own | `readCiCoverage()` is the whole contract |
| **spec 07 (pilot instrumentation)** | its own | calls `readCiCoverage(repo, commitSha)` *"at report time"*; reads, never writes |
| **spec 08 (evidence axes)** | its own | reads `ci_runs` / `ci_test_results` as `tool_observed` support, resolving `ci_test:<test_id>` against `ci_test_results_repo_test_idx`; its own lane join, never a second CI table |
| **the verdict layer** | its own | `CiBehaviorDelta[]`; a `flaky` delta is never handed an attribution question |
| **`crosscheck status`** | existing `cli-status` (`crosscheck-pins:cli/src/render-surfaces.ts:192`), `delivery: "pulled"` | one line per non-green lane at the session's `base_commit` |
| **`crosscheck doctor`** | existing `cli-doctor` (`crosscheck-pins:178`), `delivery: "pulled"` | §8's refusals, as `check(level, name, detail)` rows (`cli/src/cli/doctor.ts:190` on main / `crosscheck-pins:204`) |
| **the reporter** | new `cli-ci-report`, `kind: "composite"`, `delivery: "pulled"`, appended at the **array tail** after `cli-status` (00 §9.1a) | prints **counts and its own outcome only, never a test name** — it renders no untrusted text at all, and that is the note it registers with |

*The two existing entries were cited at their `origin/main` positions — `:27-33`
and `:13-19` — inside a spec written against #50-merged, whose own §9.4 records
that #50 **prepended** three surfaces and moved both. Corrected to the measured
post-#50 positions, which are the ones 03 §5.2 and 04 §5 use. 00 §9.4a now states
the one citation convention for the whole set: a bare line number is main's, a
post-#50 number carries the `crosscheck-pins:` prefix.*

**Corpus obligation — non-negotiable #2, and it is real here.** A `test_id` is
author-controlled text from a repository and a fork PR can name a test anything,
so every surface printing one takes the full `INJECTION_CORPUS` through
`sanitizeUntrusted` under the `framed`/`sanitized` invariants of
`connector-core/src/render-surfaces.ts:61-69`. **Measured** by importing the
fixture: `INJECTION_CORPUS.length === 61`. `cli-status` and `cli-doctor` are
already registered `composite` surfaces whose `corpusCoveredBy` files the
registry test checks exist and really run the corpus (`:122-129`), so adding a CI
line to either means adding a probe to the named file, not editing the note. The
new `cli-ci-report` entry must be added to `packages/cli/src/render-surfaces.ts`
or the meta-test reddens the build (`:1-19`) — **and that file is not free
ground, §9.4.**

**Explicitly not rendered in 1.0:** the briefing. `briefing/render.ts` orders
contradictions → solved → drafts → absences and cuts at `MAX_BRIEFING_CHARS`;
Q8 makes that ordering one product decision, made once, not per spec. This spec
adds nothing unsolicited.

---

## 6. Budget

**Hook-path cost: zero milliseconds, on every hook.** Nothing here runs in a
hook — the reporter runs on a CI runner, the flake filter is a hub read behind a
CLI pull. The 800 ms of non-negotiable #5 — `USER_PROMPT_SUBMIT_BUDGET_RATIO`
(`connector-core/src/constants.ts:64`) and `PRE_TOOL_USE_BUDGET_RATIO` (`:66`),
both 2 × `HTTP_TIMEOUT_MS = 400` (`:6`), machine-checked by the `VERIFY:` at
`:56` — is untouched and `spareMs` unspent. That matters because #50 already
spends part of Stop's `spareMs` on the git-touch lane; CI adds nothing on top.

**Hub-job cost.** Per ingest: one clamp+insert of one `ci_runs` row, one bulk
insert of ≤ 200 `ci_test_results` rows, one bounded retention delete. Per
`readCiCoverage`: two indexed reads. Per `CiBehaviorDelta`: one lane read bounded
by `CI_FLAKE_BASE_RUNS = 5`, plus one `(repo, test_id)` read per non-green test,
bounded by `CI_MAX_TEST_ROWS = 200`. **CI-runner cost**, the one real cost: one
extra `bun test` pass over the failed files when the suite is red; on a green
suite, one HTTP POST.

---

## 7. Acceptance tests

**This spec owns AT-8** (`00-cut-line.md:130-137`) — not a half. 04 discharges the
**verdict consequence** (its VER-7 and VER-9); the test itself is here:

> *"A fence fires only when the invariant's own verification ran and failed,
> **and** the same verification was green at a named commit. Re-run the same
> commit to separate flake from regression."*
> **Fails if** *a test that was always red, or one failing for an environment
> reason, can produce an attribution.*

| AT-8 clause / failure mode | discharged by |
|---|---|
| green at a **named** commit — the commit must be joinable | CI-1 |
| the **same** verification — one lane, not a merge of lanes | CI-5, CI-6 |
| the verification **ran** — a partial run proves nothing | CI-2 |
| re-run the same commit to separate flake from regression | CI-3, CI-4 |
| fails-if: *a test that was always red* | CI-2 (step 3, `not_stably_green`) |
| fails-if: *one failing for an environment reason* | CI-7, and CI-5's leg separation |

**AT-10 is 03's, and this spec discharges an INSTANCE of its rule** — not a share
of it. AT-10 (`00-cut-line.md:147-153`: *"a rung a platform genuinely cannot serve
appears as a documented refusal in doctor … fails if there is any silent absence"*)
had four partial owners across the set and therefore no single failing test; it now
has one owner, 03, whose COV-5 and COV-9 are its mechanism. Here, §8.1 and §8.3 are
doctor lines with an assertion behind them — CI-8 — which is what that rule asks of
this spec's providers.

**CI-1 — the reporter sends the head sha, not the merge sha. REWRITTEN, because
the first version's only assertion could not fail.** It read: *"assert
`readCiCoverage(repo, headSha)` is `complete` and the merge-sha row joins no
session."* Both halves are properties of the **fixture**, not of any implementation
choice — the hub holds no repository (§3.5) and cannot tell a merge sha from a head
sha, so no wrong implementation makes that assertion fail. CI-1 was also the only
one of CI-1…CI-8 missing from the mutation-anchor table below, so by 00 §7.2
nothing proved its guard could go red. Both are fixed by moving the test to where
the decision actually is — **the reporter's arguments**:

> A reporter-level test asserts that the `--sha` argument the step passes resolves
> to `github.event.pull_request.head.sha` on a `pull_request` event and to
> `github.sha` otherwise, and that the value posted is the one it resolved. The
> guard is a string assertion over the workflow YAML and the reporter's argument
> parsing, and it is stated as such rather than dressed as a hub property.

*Fails if* the reporter can send `github.sha` on a `pull_request` event.
*Mutation (now in the table):* `--sha ${{ github.event.pull_request.head.sha ||
github.sha }}` → `--sha ${{ github.sha }}` in the `test` job's reporter step
(§10 D4). **The fixture note survives as a note:** two rows for one PR, one keyed
on the merge sha and one on the head sha, demonstrate that the merge-sha row joins
no session's `base_commit` (`schema.ts:133`) and no `landed_evidence` sha — which
is §1.3's defect, and is why the argument matters. It documents; it does not
guard.

**CI-2 — a truncated run cannot make a test green.** *Fails if* a base run with
`outcome = "truncated"` counts toward `CI_FLAKE_BASE_RUNS` or toward "the test
was green here". Five base runs, one truncated → `unconfirmed` /
`insufficient_base`.

**CI-3 — flaky never attributes.** *Fails if* a green re-run yields anything but
`flaky`, or any attribution field is populated on a flaky delta. Stable-green
base, red primary, green re-run → `flaky` / `rerun_green`, and the verdict caller
receives no candidate list.

**CI-4 — an unrun re-run is not a confirmation.** *Fails if* a red primary with a
stable-green base returns `confirmed` before a re-run row exists. No `rerun_of`
row → `unconfirmed` / `awaiting_rerun`, and `readCiCoverage` reports `incomplete`
with `awaitingRerun = 1`.

**CI-5 — lanes are never merged.** *Fails if* an `ubuntu-latest` green counts as
a base green for a `macos-latest` red, or `lanesExpected` collapses the legs. Two
legs, one red; `lanesExpected = 2`, one delta, and the red leg's base window
holds no rows from the green leg.

**CI-6 — an ambiguous test id is dropped and said.** *Fails if* two identical
`(file, chain, name)` triples produce a stored row, or `ambiguousDropped` stays 0
when they do. The junit fixture measured in §3.4 (two `dup name` testcases,
identical `name` and `classname`) → zero rows, `ambiguousDropped = 1`, a doctor
`WARN` naming the count. A second case asserts the chain came from the
`<testsuite>` ancestry: a describe named `a > b` round-trips as **one** segment.

**CI-7 — an infrastructure failure never attributes.** *Fails if* a run with
`outcome = "crashed"` produces any `CiBehaviorDelta`, enters any base window, or
leaves `coverage.ci` at `complete`. AT-8's *"environment reason"* made executable.

**CI-8 — a provider with no reporter refuses out loud.** *Fails if* a repo whose
provider has no reporter yields `coverage.ci` anything but `unavailable`, or if
`crosscheck doctor` prints no line for it. AT-10's *silent absence*.

**Mutation anchors required** (`connector-core/scripts/mutation-check.ts`,
`{label, file, from, to, test, because}` at `:38-47`; 4794 lines — **measured** —
and both open PRs already extend it, §9.5):

| edit | guard that must go red |
|---|---|
| `outcome === "completed"` → `outcome !== "crashed"` in the base filter | CI-2 |
| `"flaky"` → `"confirmed"` on the `rerun_green` branch | CI-3 |
| drop the `rerun_of` existence check (treat missing as red) | CI-4 |
| remove `leg` from the lane tuple | CI-5 |
| keep the first of a duplicate triple instead of dropping both | CI-6 |
| admit `crashed` runs to the delta computation | CI-7 |
| `CI_FLAKE_BASE_RUNS` `5` → `1` | CI-2 |
| map an unreported provider to `unknown` instead of `unavailable` | CI-8 |
| `--sha ${{ github.event.pull_request.head.sha \|\| github.sha }}` → `--sha ${{ github.sha }}` in the reporter step | **CI-1** |

*CI-1's anchor is new: the first draft had no entry for it, which left the one
guard on §1.3's silent-zero-join defect unproven.*

Plus two `VERIFY:` directives per §7.2 (the number is a named constant; the prose
re-derives it from the data): one printing `CI_PROVIDERS.length` beside the count
of reporters that exist, one printing `CI_MAX_TEST_ROWS` beside the
`ci_test_results` CHECK in `bootstrap.sql`.

---

## 8. Refusals

Each is a **doctor line**, never a silent absence — `check(level, name, detail)`
at `cli/src/cli/doctor.ts:190` on main / `crosscheck-pins:204` (00 §9.4a).
AT-10's *"fails if there is any silent absence"*
makes that mandatory rather than tidy.

1. **GitLab CI is `unavailable`, and I am not designing it now.** The shape
   accepts `provider`, but `CI_PROVIDERS` ships one member. I have no GitLab
   instance to measure against, and the rung that decides the design — whether a
   retried job carries a verifiable attempt number on the same commit — is
   exactly what I cannot confirm without one. Designing `rerun_kind` against an
   unverified platform fact is the pretending this spec set forbids. Doctor:
   `FAIL "ci provider" — "gitlab_ci has no reporter; ci coverage is unavailable"`.
2. **A local `bun test` is never CI.** A laptop run happens at an unknown sha in
   a dirty worktree; recording it as evidence about a commit is the false
   accusation `crosscheck-pins:…/capture-git-touches.ts:13-20` refuses for
   `git diff` dirt. No local-runner rung, and none in 1.0.
3. **Fork pull requests report nothing.** A fork `pull_request` gets no
   repository secrets, so the reporter has no hub token. It prints one line and
   **exits 0** — inform, never block (#1) — and the hub sees `coverage.ci:
   unknown` at that commit. Doctor names it rather than letting the gap read as a
   green suite.
4. **The hub never triggers a re-run.** That needs a GitHub token held by the
   hub, an API client and an outbound-call story. Out of scope; the re-run comes
   from the workflow (`same_job`) or a human clicking *Re-run failed jobs*
   (`new_attempt`).
5. **No failure messages, no stack traces, no `hostname`.** All three are in the
   junit file — `hostname` **measured** on every `<testsuite>` element (§3.4) —
   and none is sent. #6 forbids content-derived artifacts; a failure message is
   source text.
6. **No per-commit `commit_evidence`.** Q4 asks whether `commit.observed` needs
   per-commit rows; this spec does **not**. `ci_runs.commit_sha` is a sha CI
   already had, joined to a session's `base_commit`, and adds no new commit
   surface to the hub.
7. **Out of scope, named because a reader would expect them here:** runtime
   invariant mining, auto-generated behavioural probes and semantic collision
   detection are **Tier 3, cut** (`00-cut-line.md:50-53`). A test's *identity* is
   its name; this spec does not infer that two renamed tests are the same test. A
   rename reads as one test disappearing and another arriving with no base —
   `unconfirmed` / `insufficient_base`, which is honest.
8. **`coverage.runtime` stays `unavailable`.** This spec creates the `ci` source
   and only that one. Q5 asked about both; half is now answered.
9. **This spec does not decide the merge gate.** `00-cut-line.md:188-194`
   reserves it for Nick, and its recommendation — gate only on human-declared
   invariants whose own verification ran and failed, never on anything derived —
   constrains the *verdict* spec, not ingestion. This supplies evidence; it
   blocks nothing.

---

## 9. Collisions and sequencing

**9.1 With spec 03 — two edits 03 must make when this lands.** *COV-5 changes
shape:* 03 §7 asserts *"`ci`, `runtime`, `human_edit` are `unavailable`"* and
anchors it with the mutation *"map `ci` to `unknown`"*. Once this lands, `ci` is
`unavailable` **only for a repo with no reporter**, so COV-5 must split —
`runtime` and `human_edit` stay unconditional, `ci` becomes CI-8's conditional
form. **Sequence 03 first**; the edit is 03's, not mine. *The flip condition is
already correct* — 03 was revised in parallel on 2026-09-14 and its refusal 2 now
reads *"only when `readCiCoverage` (00 §8.2b) is callable"*, retiring the
`ci.result` wording §8.4a killed. Nothing further is owed there.
*`CoverageReason` needs four CI members,* and 03 owns the enum, so I request
rather than mint them: `ci_lanes_reported`
(complete), `ci_lanes_missing` (incomplete), `ci_awaiting_rerun` (incomplete),
`ci_not_reported_yet` (unknown) — `no_emitter` already covers `unavailable`. All
four are enum values, so a coverage line still contains no author-written string.

**9.2 With ground truth §8.4 — resolved, in my favour.** The map's first draft
listed `ci.result` as a tenth envelope kind; §3.7 refused it and **§8.4a adopted
the refusal**. Nothing is open. The generalised rule drawn from it — *a record
that can originate outside an agent session gets its own route* — now binds the
other six writers.

**9.3 With PR #50** (§9.1 of the map). `server/src/db/schema.ts`: #50 appends
`pins`, `pin_files`, `team_settings`; my two tables append after — **#50 first**.
`server/src/constants.ts`: #50 appends `SUSPECT_*` at the tail (`:542` on that
branch), my `CI_*` block goes below it, #49 edits near the head — mine is a third
editor at the tail. `server/src/app.ts`: #50 adds three mounts, mine is a fourth,
appended. `bootstrap.sql` / `ddl-sync.test.ts`: #50 adds +92 / +27, mine after.
**Conceptual, not textual:** `services/suspect.ts` is the attribution consumer,
and its falsifier enum (`crosscheck-pins:services/suspect.ts:71-77`) is
pin-shaped — `recorded_break | not_recorded_broken | no_check_recipe |
reader_named_files`. A confirmed CI delta is a **fifth** shape ("a stably-green
test went red and stayed red on re-run"); extending that enum is the verdict
spec's call, not mine. I hand it `CiBehaviorDelta` and say so.

**TAKEN, 2026-09-14 — 04 §3.3a now carries it, and the shape it chose keeps #50's
enum closed.** The fifth value is `ci_confirmed_regression` on a **verdict-level**
`VerdictFalsifier` that maps suspect's four in and adds one, rather than widening
`SuspectFalsifierKind`. Until that landed, `deltaLane: "ci"` was a field with no
reachable outcome: 04's mapping keyed entirely off suspect's outcome and falsifier,
its legality rule made `ATTRIBUTED` illegal on anything but `recorded_break`, and
nothing in either spec wrote `pins.broke_at` from CI — so every CI-lane verdict
could reach only `INDETERMINATE`. 04 §3.3 now has three `ci`-lane rows and the
refusal that bounds them (04 §8.12: **no join from a `test_id` to a pin exists in
1.0**, and inferring one is semantic collision detection, cut), so a confirmed
regression attributes where a pin or the reader names the surface and is honestly
`INDETERMINATE` / `ci_no_surface` where neither does.

**9.4 Citations the first draft got wrong — corrected here**, so a reviewer who
checked the old numbers knows which moved.
**`packages/cli/src/render-surfaces.ts` is NOT free ground**: the first draft
called it free on §9.4 of the map; §9.1 corrects that — #50 takes it **3 → 6**
surfaces. **Measured**: main has exactly three `name:` entries (`:15`, `:22`,
`:29`), `crosscheck-pins` has six, with `cli-pin-observability` (`:128`),
`cli-pin-list` (`:153`) and `cli-suspect` (`:166`) **ahead** of the three, which
now sit at `cli-doctor` `:178`, `cli-conference` `:185`, `cli-status` `:192`.
**Re-verified 2026-09-14, and this was the measurement the rest of the set was
missing:** because #50 *prepended*, `cli-suspect` and *"the array tail"* are **six
lines apart**, and three sibling specs had named the first while calling it the
second. 00 §9.1a now states the one convention — **append after `cli-status`
(`:192`)**, in build order — and 02, 04 and 07 are corrected to match.
`cli-ci-report` appends at that tail, **after `cli-claim-revalidate`** (02 lands
before 05 in the build order, 00 §9.7) — **sequence after #50**.

Also, and this is where the citation convention came from (00 §9.4a):
`capture-git-touches.ts` **does not exist on main** (a #50 file, cited unprefixed
before); `commit_evidence.reported_by` is `schema.ts:394-396` **on main** and
`crosscheck-pins:414-416` after #50's +143 — the earlier correction here gave
main's numbers as though they were post-#50 facts, which is the same defect one
level down; likewise `app.ts` mounts run `:26-50` with 17 mounts **on main** and
`crosscheck-pins:29-67` with 20 after #50's three. The `commit-evidence.ts` clamp
is `:57-64`, not `:34-42`; `requireAdmin` is `middleware/auth.ts:19-36`, not
`:22-45`; `ci.yml`'s concurrency loop is `:46-55` — all three files are untouched
by either PR (00 §9.5), so those numbers hold on both trees.

**9.5 `.github/workflows/ci.yml` — the mandatory declaration.** This spec adds
mutation entries, so per §9.2 of the map it declares: **it bumps the `MUTATIONS`
count and adds its own per-file `PRINTS:` line for `services/ci-delta.ts`, and
writes no post-merge total**, because it cannot know how many other specs land
first. **Measured**: the `VERIFY:` directive is at `ci.yml:119` and its
`PRINTS: 298` at `:120` — the map said `:117-118`; the code wins, and **the map and
03 §9 and 04 §9 are now corrected**, so nobody sends a builder to the wrong two
lines of a machine-checked guard again. Two further listings also need the new
line: the **per-file** block at `:127` and the **per-basename** block at `:239` on
main / `:246` on `crosscheck-pins`. **All three, always** — five sibling specs had
declared only the count and the per-file block, which leaves the third stale and
CI red on the next run; 00 §9.2 now makes the three-block rule binding, along with
the add-versus-bump rule the per-basename block needs (it keys on the basename, so
a new file whose basename already exists is a bump). My new line is
`services/ci-delta.ts`, new in both listings.

Specs 01 §7, 06 §9 and 07 §9 declare the same bump, which is precisely why **no
spec writes a literal total**: with both PRs and eight specs queued, any number
written by hand is wrong on arrival. **And the two PRs collide on that line with
each other before any spec starts** — 298 + 10 + 6 = 314, a number neither branch
contains; 00 §9.2 now carries the instruction for whoever merges the second one
(re-run the directive on the merged tree; take neither side). This spec has a
**second** reason to touch the file — the reporter step (§10 D4) — so it is the one
spec editing `ci.yml` for content as well as counts. **Sequence: eighth of the
eight** (00 §9.7: `#50 → #49 → 03 → 01 → 06 → 02 → 08 → **05** → 04 → 07`), after
both PRs and five specs' entries.

**9.6 With PR #49 and the other specs.** #49: none — it touches
`services/developers.ts` and `routes/developers.ts`, and this spec carries no
developer identity at all, which is the point of dropping `reported_by` (§3.2).
On `mutation-check.ts` this spec is **editor 8** in the build order (00 §9.7) —
*corrected from "a third editor", a seat 03 §9 and 06 §9 had each claimed as well;
**all eight specs** append to that array tail, so all eight conflict there and none
of them is third.* Sequence after both PRs and the five specs before it.

**03** consumes `readCiCoverage` and owns how `ci` composes with the other four
sources — I define the source, not the composition. Its `isJudgeable` now fails on
any `incomplete` source, which is what makes §2's AT-5 sentence true rather than
aspirational. **01** owns `seq` (Q2); I consume nothing from it, and `ci.result` is
not one of its event kinds (§8.4a). **07** calls `readCiCoverage` at report time and
writes nothing of mine.

**08** reads `ci_runs` / `ci_test_results` directly as `tool_observed` support —
and on **who writes the lane join we disagreed, so one answer is now written in
both files.** 08 §9 asks this spec to *"export `wasNonGreenAt(lane, commitSha,
testId)` from `services/ci-delta.ts`, so the lane join lives in one file"*; this
section previously said the opposite as though it were settled — that 08 *"writes
its own lane join rather than a second CI table — the right call"*. As written,
either the helper is never built and 08's `repository_verified` legs 3 and 4 have
no implementation seam, or 08 gains an export this spec says it does not owe.
**Resolved in 08's favour, because its argument is the stronger one:** §3.1's rule
that *nothing is ever compared across lanes* is this spec's invariant, and an
invariant enforced in two files is an invariant that will disagree with itself. So
**`services/ci-delta.ts` exports `wasNonGreenAt(lane, commitSha, testId): boolean`**,
reading `ci_runs` ∩ `ci_test_results` inside one lane and honouring the base window
and the `outcome = "completed"` rule (§3.5 step 1) — the same rule that decides what
a green means here. 08 adds no CI table and no second lane join. Cost: one exported
function and one more caller to keep in mind when the lane tuple changes, which is
exactly the coupling that keeps the rule single.

**04 (verdict)** — two things this section left open are now closed **there**, not
here: §9.3's fifth falsifier shape is 04 §3.3a's `ci_confirmed_regression`, and
*"whether `INDETERMINATE` or `unconfirmed` wins when both apply"* is answered
**neither** — they are different dimensions of the same verdict and both are
emitted, with the basis (`delta_unconfirmed`) saying why nobody is named (04 §3.3).
**AT-8 is this spec's, whole**; 04 discharges the verdict consequence.

---

## 10. Decisions for Nick

**D1 — Which token does CI hold?** *Default: a separate `CROSSCHECK_CI_TOKEN`* —
one env var, one middleware beside `requireAdmin`, no table. The admin token also
flips `pin_policy` and `suspect_attribution` (#50), and a workflow secret is a
wider place to keep it than a hub operator's shell. *Alternative:* reuse the
admin token — one fewer knob, blast radius the whole team's settings. Q5 flags
this as yours because the hub has two middlewares today and **no machine identity
at all**.

**D2 — Is a same-job re-run enough to say `confirmed`?** *Default: yes, and
record which kind it was.* Requiring `new_attempt` makes every confirmation wait
on a human clicking *Re-run failed jobs*, which makes the cheap test not cheap.
The cost: a `same_job` re-run shares the runner's state, so a host-level flake
survives it. Both kinds are stored, so a later rule can raise the bar without a
migration.

**D3 — Which jobs report?** *Default: the `test` job only, both matrix legs — two
lanes.* `budgets`, `concurrency` and `cpu-starved` are wall-clock and
environment-sensitive by design (`ci.yml:57-93`, `:342-359`), so their flakes are
findings about the host, not about a commit. Adding them later is two workflow
lines each.

**D4 — What exactly is added to `ci.yml`?** All inside the `test` job:
(1) `- run: bun test` (`:23`) → `- run: bun test --reporter=junit
--reporter-outfile=junit.xml` — **measured**, console output is unchanged;
(2) one new step, `if: always()`, running
`bun run packages/cli/scripts/ci-report.ts` with `--junit junit.xml --job test
--leg ${{ matrix.os }} --ref ${{ github.ref_name }}
--attempt ${{ github.run_attempt }} --run-id ${{ github.run_id }}
--sha ${{ github.event.pull_request.head.sha || github.sha }}`, and
`CROSSCHECK_HUB_URL` / `CROSSCHECK_CI_TOKEN` from secrets; (3) the reporter
re-runs the failed **files** into `junit-rerun.xml` and posts a second row with
`rerun_kind: "same_job"`. *Default: the reporter owns the re-run* — two edited
lines instead of four, one place to reason about. *Alternative:* a separate
`if: failure()` step, which reads better in the Actions log. **No
`workflow_dispatch` is needed**: GitHub's native re-run already produces attempt
2, which is `new_attempt`.

**D5 — `CI_FLAKE_BASE_RUNS = 5`.** *Default: 5.* Lower means more `confirmed` and
more false confirmations from a test only recently green; higher means a new lane
waits longer before it can say anything. Five is a deliberate non-tuning and, per
the corpora floor rule (`precision-corpus.test.ts:8-15`), is never lowered to
make a case pass.
