# 05 — CI ingestion keyed to a commit, with same-commit re-run

**Baseline.** `origin/main` at `e9aab82`, read at `/Users/nicknouschirvan/worktrees/crosscheck-main`.
Written against **main + #50 + #49 merged** (`00-ground-truth.md` §9.3). Facts on a
PR branch are cited `crosscheck-pins:<path>`. Measurements I ran are marked
**measured**; nothing else is a number.

**Scope claim.** This is a *proposal* for 1.0, not an assertion that it is in it
(§0/Q1 of the ground truth). It is the cheapest half of the thesis: *a test that
was green and is now red, in an area no active intent covers, is an unexplained
change* — CI + git + intents, no new evidence machinery.

---

## 1. Problem

**There is no `ci` coverage source, and nothing in the tree emits one.**
Ground truth §8.2 records `ci` as one of exactly five coverage sources and marks
its existing signal as **nothing exists**. I re-checked: no table, no route, no
record kind. `RECORD_BODY_SCHEMAS` (`packages/schema/src/envelope.ts:42-54`)
has eleven kinds and none of them is a CI result. `app.ts:25-49` mounts
seventeen routes and none is CI. The five services that answer questions —
`search.ts`, `hints.ts`, `diagnosis.ts`, `solved-matches.ts`, `conference.ts` —
import no CI anything (§5.2 of the ground truth).

**This repo's own CI cannot support the test either.** `.github/workflows/ci.yml`
is 411 lines and seven jobs (`test` `:9`, `concurrency` `:33`, `budgets` `:57`,
`mutation` `:105`, `cpu-starved` `:342`, `claims` `:377`, `secrets` `:400`).
Three defects for this purpose, all read:

1. **No result leaves the runner.** The `test` job is `- run: bun test`
   (`ci.yml:23`). Nothing writes a machine-readable report, nothing uploads one,
   nothing posts one. A red suite exists only as an exit code and a log.
2. **No re-run mechanism is wired.** `grep -rn "rerun\|re-run\|retry\|attempt"
   .github/workflows/` returns two hits, both prose in comments
   (`ci.yml:63`, `hook-contract-watch.yml:12`) — **measured**. `ci.yml` has no
   `workflow_dispatch` (only `hook-contract-watch.yml` has one) and no step
   reads `github.run_attempt`. GitHub's native *Re-run failed jobs* does re-run
   at the same commit and does increment the attempt, but nothing here records
   which attempt produced which result, so the two are indistinguishable.
   The one same-commit repetition that exists is `concurrency` (`ci.yml:46-56`),
   a hard-coded loop over **three** files, and it reports nothing either.
3. **The `pull_request` trigger's `github.sha` is the merge commit, not the
   branch head.** `ci.yml:4` triggers on `pull_request`. A CI row keyed on the
   merge sha can never join a session's `base_commit`
   (`schema.ts:123-146`) or a `landed_evidence` sha
   (`packages/schema/src/landed-evidence.ts:24-34`), because no developer's
   history contains it. Getting this wrong makes the whole feature silently
   join zero rows.

---

## 2. Principles served

**Principle 1 — "Only judge when you know you were watching."**
The flake filter's base window can be *absent* (a new lane), *short* (fewer than
`CI_FLAKE_BASE_RUNS` runs) or *unreliable* (a truncated run). Each of those
produces `behavior_delta: unconfirmed` with a named reason and pushes
`coverage.ci` off `complete`, so the verdict layer must reach `INDETERMINATE`
rather than `UNATTRIBUTED`. There is no path in this spec from "CI said nothing"
to a judgement.

**Principle 3 — "A reason written after a change is not evidence the reason
existed before it."** CI timestamps are wall-clock on somebody else's machine
and this spec **never** compares them to a session's clock. `started_at` and
`collected_at` are clamped to the hub clock plus skew on ingest, exactly as
`services/commit-evidence.ts:34-42` clamps its two sender-controlled timestamps,
and they are used only for retention, ordering *within one lane*, and display.
`explanation_timing` is decided over the per-session `seq` (ground truth §8.4,
open question Q2) and takes nothing from here.

**Non-negotiable #4 — "fail, never silently."** Every way this can fail to know
something is a value someone can read: run `outcome` (`completed | truncated |
crashed`), the `awaiting_rerun` reason, the `unavailable` coverage state for a
provider with no reporter, and a doctor line for each.

---

## 3. Target model

### 3.1 The lane — the only unit that may be compared

```
lane = (repo, provider, workflow, job, leg, ref)
```

`repo` is `normalizeRemoteUrl()`'s output
(`packages/connector-core/src/git/repo-identity.ts:26`), so a CI row joins the
same key a session carries. **Measured**: all four spellings of this repo's
remote (`https://…/crosscheck.git`, `git@github.com:…`, no `.git`,
`ssh://git@…`) normalise to `github.com/neverstophh/crosscheck`.
`leg` is the matrix leg (`ubuntu-latest`), `""` when the job has none.
`ref` is the branch name, because a base window that interleaves a PR branch
with `main` is a window that means nothing.

**Nothing is ever compared across lanes.** A `macos-latest` red and an
`ubuntu-latest` green are two facts, never one contradiction — `ci.yml:10-12`
already says the team keeps both legs precisely because they disagree.

### 3.2 `ci_runs` — one row per lane per attempt

| column | type | note |
|---|---|---|
| `id` | text PK | `cir_` + first 32 hex of `sha256(provider\nrepo\ncommit_sha\nworkflow\njob\nleg\nref\nrun_attempt\nrerun_kind)`. Deterministic, mirroring `hint_deliveries`' `hd_` id (`connector-core/src/capture/records.ts:66-82`), so a retried POST is a `duplicate`, never a second row. |
| `repo` | text NOT NULL | |
| `commit_sha` | text NOT NULL | `COMMIT_SHA_PATTERN` (`git/commit-drift.ts:17`) — reused, not re-minted. **The head sha, never a PR merge sha** (§1.3). |
| `provider` | text NOT NULL | `CI_PROVIDERS = ["github_actions"]` |
| `workflow` / `job` / `leg` / `ref` | text NOT NULL | each ≤ `MAX_CI_LANE_FIELD_CHARS` |
| `run_attempt` | int NOT NULL | ≥ 1; `GITHUB_RUN_ATTEMPT` |
| `external_run_id` | text NOT NULL | `GITHUB_RUN_ID` — opaque, so a human can open the log |
| `rerun_kind` | text NOT NULL | `CI_RERUN_KINDS = ["none","same_job","new_attempt"]` |
| `rerun_of` | text NULL FK→`ci_runs.id` | set on a re-run; hub rejects one whose target does not share repo+commit_sha+workflow+job+leg+ref |
| `outcome` | text NOT NULL | `CI_RUN_OUTCOMES = ["completed","truncated","crashed"]` |
| `tests` / `failures` / `skipped` | int NOT NULL | totals as the runner counted them |
| `duration_ms` | int NOT NULL | |
| `started_at` / `collected_at` | timestamptz NOT NULL | both clamped on write |
| `created_at` | timestamptz NOT NULL | |

Indexes (mirrored into `bootstrap.sql`, see §4):
`ci_runs_repo_commit_idx (repo, commit_sha)`,
`ci_runs_lane_started_idx (repo, provider, workflow, job, leg, ref, started_at DESC)`,
`ci_runs_rerun_of_idx (rerun_of)`.

**No `reported_by`.** `commit_evidence.reported_by` is a developer FK
(`schema.ts:391-393`); a CI run has no author, and inventing one is the phantom-
teammate trap ground truth Q9 names. Ownership lives in the token (§3.6).

### 3.3 `ci_test_results` — non-green rows only

| column | type | note |
|---|---|---|
| `ci_run_id` | text FK→`ci_runs.id` | |
| `test_id` | text NOT NULL | ≤ `MAX_CI_TEST_ID_CHARS`, see §3.4 |
| `repo` | text NOT NULL | **denormalised**, exactly as #50 denormalises `repo` into `pin_files` for its `(repo, path)` index (`crosscheck-pins:schema.ts`) |
| `status` | text NOT NULL | `CI_TEST_STATUSES = ["failed","errored","skipped"]` |
| `duration_ms` | int NOT NULL | |

PK `(ci_run_id, test_id)`; index `ci_test_results_repo_test_idx (repo, test_id)`.

**Only non-green rows are stored, and that is a contract, not an optimisation.**
**Measured**: 275 test files, 2584 `test(`/`it(` declarations, 651 `describe(`
declarations. Two legs × 2584 rows per attempt against a `MAX_INGEST_BATCH` of
100 (`server/src/constants.ts:88`) is 52 round trips to say "everything passed".
So a run row asserts *these are all the non-green tests I ran*, and **that
assertion is only usable when `outcome = "completed"`**. A `truncated` run — one
whose non-green list hit `CI_MAX_TEST_ROWS` — can never establish that any test
was green. This is `capture-git-touches.ts:27-33`'s rule ("nothing" and "no
answer" are different facts) applied to a suite.

`skipped` is stored rather than dropped because a test that stops running looks
green to a rule built on absence. **Measured**: this repo has 0 static
`test.skip` / `test.todo` / `describe.skip` and 2 conditional
(`skipIf`) declarations, so the cost is 2 rows per run.

### 3.4 `test_id` — derived from the runner's own report

**Measured**, `bun 1.3.13`, `bun test --reporter=junit --reporter-outfile=…`:

- console output is **preserved** alongside the XML file, so the CI log does not
  get worse;
- a `<testcase>` carries `name`, `classname`, `file`, `line`, `time`;
- `classname` is the describe chain **innermost first** and **double-escaped** —
  `describe("outer"){describe("inner"){test("leaf")}}` emits
  `classname="inner &amp;gt; outer"`, whose decoded value is the literal
  `inner &gt; outer`;
- `line` is the test's own line, so it moves on any edit above it;
- two same-named tests in one file emit identical `name` and `classname`;
- `<testsuite>` carries `hostname="MacBook-Pro-von-Nick.local"` — the runner's
  machine name.

Therefore:

```
test_id = "<file>::<describe chain, OUTERMOST first, joined by ' > '>::<name>"
```

The reporter reverses bun's chain, un-escapes it once, and **never** puts `line`
in the id. `hostname` is dropped and never sent (non-negotiable #6). The
`<failure>` element's message and stack are **never read** — only its presence —
because a failure message quotes source text, and content-derived text on the
hub is what #6 forbids.

**A duplicated `(file, chain, name)` triple is dropped and counted**, not given a
positional ordinal: an ordinal is stable only until somebody reorders the file,
and a test that cannot be identified cannot carry a verdict. The run then
carries `ambiguous_dropped > 0`, which doctor prints. **Measured**: a static scan
of all 275 files finds 3 repeated literal test names across 2 files
(`connector-core/test/session-state-transforms.test.ts`,
`cli/test/connector-capture-health.test.ts`) and **all three are disambiguated by
their enclosing `describe`**, so today's true ambiguity count under this rule is
0. I did not run the suite to confirm it; the drop rule exists because I did not.

### 3.5 The flake filter — `services/ci-delta.ts`

For each non-green `test_id` in the primary run (`rerun_kind = "none"`) of lane
L at `commit_sha` C:

1. **Base window** = the most recent `CI_FLAKE_BASE_RUNS` runs of lane L with
   `rerun_kind = "none"`, `outcome = "completed"`, distinct `commit_sha`,
   excluding C, within `CI_BASE_WINDOW_DAYS`.
   If lane L has fewer than that on its own `ref`, the window falls back to the
   same `(repo, provider, workflow, job, leg)` on the repo's default ref and the
   result is stamped `base_window_source: "default_ref_fallback"`. **The hub
   holds no repository and cannot check that the branch descends from that ref**
   — the fallback is an assumption, so it is labelled and rendered, never hidden.
2. `base.length < CI_FLAKE_BASE_RUNS` → `behavior_delta: unconfirmed`,
   reason `insufficient_base`. **Stop.**
3. The test is non-green in any base run → `unconfirmed`, `not_stably_green`.
   **Stop.**
4. No run exists with `rerun_of` = this run's id → `unconfirmed`,
   `awaiting_rerun`. **Stop.**
5. Re-run has the test green → **`behavior_delta: flaky`**, reason `rerun_green`.
   **No attribution is computed, requested or rendered for a flaky delta.**
6. Re-run has it non-green → `behavior_delta: confirmed`, reason `rerun_red`.

The returned shape, consumed by 03 and by the verdict spec:

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
re-run cannot rule out host state. See §10 D2.

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
(ground truth §8.1). States:

- **`unavailable`** — this repo has never reported a run, or its provider has no
  reporter. This is the default for every repo and stays the default.
- **`unknown`** — the repo reports, but nothing has arrived for this commit yet
  (still running, a fork PR with no secrets, a crashed runner).
- **`incomplete`** — some expected lanes reported and some did not, or any lane
  is `truncated`/`crashed`, or `awaiting_rerun > 0`.
- **`complete`** — every expected lane reported `completed` at this commit.

`lanesExpected` is derived, not declared: the lanes that reported in **all** of
the last `CI_LANE_QUORUM_COMMITS` distinct commits on this ref. A job added
yesterday is not yet expected; a job deleted yesterday stops being expected
after the quorum rolls past it.

### 3.7 Wire and route

**`POST /api/ci-runs`, its own route — not an envelope.** `EnvelopeSchema`
requires `producer: {developerId, agentKind, sessionId}`
(`envelope.ts:19-23,30-37`) and CI has none of the three. Minting a synthetic
session is the phantom teammate of Q9. So the CI reporter is not a producer, it
does not spool, and it does not go through `/api/records`. **This contradicts
ground truth §8.4, which lists `ci.result` as an `envelope.kind`** — see §9.

Body (`packages/schema/src/ci-run.ts`, `CiRunReportSchema`): the `ci_runs`
columns of §3.2 minus `id`/`created_at`, plus
`results: CiTestResult[]` (≤ `CI_MAX_TEST_ROWS`) and `ambiguousDropped: int`.
Bounds mirror #50's: `MAX_CI_TEST_ID_CHARS = 300` (`MAX_PIN_PATH_CHARS`),
`MAX_CI_LANE_FIELD_CHARS = 120` (`MAX_PIN_SURFACE_CHARS`),
`CI_MAX_TEST_ROWS = 200` (`MAX_PIN_SWEEP_UPDATES`). Clock skew reuses the
exported `MAX_COMMIT_CLOCK_SKEW_MS = 120_000`
(`packages/schema/src/commit-evidence.ts`) rather than minting a second number.

**Auth: a hub-level `CROSSCHECK_CI_TOKEN`**, compared with `isTokenEqual`,
middleware `requireCiToken` alongside `requireAdmin`
(`middleware/auth.ts:22-45`). Read (`GET /api/ci-runs?repo=&commit=`) is
`developerAuth`. Write-privileged / read-open is exactly #50's team-settings
asymmetry (`crosscheck-pins:routes/team-settings.ts:6-19`). Not the admin token:
that token also flips `pin_policy` and `suspect_attribution`, and putting it in
a GitHub Actions secret widens its blast radius to every fork-adjacent workflow
mistake. See §10 D1.

`app.ts` gains one mount, appended, not reordered: `app.route("/api/ci-runs",
ciRunsRoutes(deps))`.

### 3.8 Constants

Appended below #50's `SUSPECT_*` block in `packages/server/src/constants.ts`,
never renumbered: `CI_FLAKE_BASE_RUNS = 5`, `CI_BASE_WINDOW_DAYS = 14`,
`CI_LANE_QUORUM_COMMITS = 3`, `CI_RETENTION_DAYS = 30`.

Inherited by name, per ground truth Q10: `COMMIT_EVIDENCE_RETENTION_DAYS = 30`
(`constants.ts:98`) is what `CI_RETENTION_DAYS` matches and why;
`SUSPECT_WINDOW_DAYS = 14` (#50) is what `CI_BASE_WINDOW_DAYS` matches, so the
attribution window and the base window cannot drift apart;
`MAX_INGEST_BATCH = 100` (`constants.ts:88`) is *not* reused — this route posts
one run, and its own cap is `CI_MAX_TEST_ROWS`.

`CI_FLAKE_BASE_RUNS = 5` is a **deliberate non-tuning**, in the sense
`SUSPECT_SEPARATION_RATIO`'s comment uses: no dataset here justifies a sixth
run, and five is what a weekly-merging team accumulates in a day. It adopts the
corpora's floor rule (`precision-corpus.test.ts:9-16`) — it encodes today's
intent, and it is never lowered to make a case pass.

---

## 4. Migration

**Nothing existing is redefined.** Two new tables, one new route, four new hub
constants, one new schema module. No column changes anywhere.

- Existing rows: untouched. No backfill is possible or attempted — CI history
  before the reporter lands does not exist in any form the hub can read.
- `coverage.ci` moves from *no signal exists* (ground truth §8.2) to
  **`unavailable` for every repo**, and stays there until that repo's workflow
  runs the reporter. `unavailable` is a real answer, not a placeholder.
- `bootstrap.sql` gains both `CREATE TABLE IF NOT EXISTS` blocks and all four
  indexes, mirroring `schema.ts` — `packages/server/test/ddl-sync.test.ts` is
  what enforces it and it gains a case for `MAX_CI_TEST_ID_CHARS` matching the
  `ci_test_results.test_id` CHECK, following the two existing body-length cases
  (`ddl-sync.test.ts:17-42`).
- Retention: ingest prunes `ci_runs` (and cascades `ci_test_results`) past
  `CI_RETENTION_DAYS`, and clamps future-dated rows on write, exactly as
  `commit_evidence` does (`schema.ts:374-381`, `commit-evidence.ts:34-42`) —
  otherwise a forged `started_at` outruns retention forever.

---

## 5. Where it renders, who consumes it

| consumer | surface | obligation |
|---|---|---|
| **spec 03 (coverage)** | none of its own | `readCiCoverage()` is the whole contract |
| **the verdict layer** | its own | `CiBehaviorDelta[]`; a `flaky` delta is never handed an attribution question |
| **`crosscheck status`** | existing `cli-status` (`cli/src/render-surfaces.ts:26-31`), `delivery: "pulled"` | one line per non-green lane at the session's `base_commit` |
| **`crosscheck doctor`** | existing `cli-doctor` (`:14-19`), `delivery: "pulled"` | the refusals of §8, as `check(level, name, detail)` rows (`cli/src/cli/doctor.ts:182-190`) |
| **the reporter** | new `cli-ci-report`, `kind: "composite"`, `delivery: "pulled"` | prints **counts and its own outcome only, never a test name**, so it renders no untrusted text at all — that is the note it registers with |

**Corpus obligation — non-negotiable #2, and it is real here.** A `test_id` is
author-controlled text from a repository, and a fork PR can name a test
anything. Every surface that prints one takes the full
`INJECTION_CORPUS` (61 cases,
`connector-core/test/fixtures/injection-corpus.ts:164`) through
`sanitizeUntrusted`, under the `framed`/`sanitized` invariants of
`render-surfaces.ts:61-69`. `cli-status` and `cli-doctor` are both already
registered `composite` surfaces whose `corpusCoveredBy` files the registry test
checks exist and really run the corpus (`render-surfaces.ts:122-129`) — adding a
CI line to either means adding its probe to the named file, not editing the note.
The new `cli-ci-report` entry must be added to `packages/cli/src/render-surfaces.ts`
or the meta-test reddens the build (`render-surfaces.ts:1-19`).

**Explicitly not rendered in 1.0:** the briefing. `briefing/render.ts` orders
contradictions → solved → drafts → absences and cuts at
`MAX_BRIEFING_CHARS = 2200`; ground truth Q8 says that ordering is one product
decision, made once, not per spec. This spec adds nothing unsolicited.

---

## 6. Budget

**Hook-path cost: zero milliseconds, on every hook.** Nothing in this spec runs
in a hook. The reporter runs on a CI runner; the flake filter is a hub read
behind a CLI pull. The 800 ms of non-negotiable #5 —
`USER_PROMPT_SUBMIT_BUDGET_RATIO` (`connector-core/src/constants.ts:64`) and
`PRE_TOOL_USE_BUDGET_RATIO` (`:66`), both 2 × `HTTP_TIMEOUT_MS = 400` (`:6`),
machine-checked at `constants.ts:56-57` — is untouched, and `spareMs`
(`config/hook-budget.ts:31-33,48-55`) is unspent. This matters because #50
already spends part of Stop's `spareMs` on the git-touch lane
(`crosscheck-pins:hooks/stop.ts`); CI adds nothing on top of that.

**Hub-job cost.** Per ingest: one clamp+insert of one `ci_runs` row, one bulk
insert of ≤ 200 `ci_test_results` rows, one bounded retention delete. Per
`readCiCoverage`: two indexed reads (`ci_runs_repo_commit_idx`, then the lane
index for the quorum). Per `CiBehaviorDelta`: one lane read bounded by
`CI_FLAKE_BASE_RUNS = 5`, plus one `(repo, test_id)` read per non-green test,
bounded by `CI_MAX_TEST_ROWS = 200`.

**CI-runner cost**, and it is the one real cost: one extra `bun test` pass over
the failed files when the suite is red. On a green suite it is one HTTP POST.

---

## 7. Acceptance tests

**REFUSAL FIRST.** The Cut Line HTML at
`…/scratchpad/crosscheck-10-cut-line.html` **does not exist on this machine** —
I checked the path in my brief and the scratchpad directory it names
(**measured**: the directory exists and holds no such file). Ground truth §0
records the same absence. I was assigned "AT-8's CI half" and **I cannot restate
AT-8's `fails if` line, because I have never read it.** The tests below are
**fresh**, written by me, numbered `CI-1…CI-6` so nobody mistakes them for the
lost numbering. Whoever recovers the Cut Line must check them against AT-8
rather than assume they are it.

**CI-1 — the merge sha never becomes the key.** *Fails if* a report whose
`commit_sha` is a `pull_request` merge commit is accepted as the head. Test: two
reports for the same PR, one with the merge sha and one with the head sha;
assert `readCiCoverage(repo, headSha)` is `complete` and the merge-sha row joins
no session. Guarded by a reporter-level test that the sha it sends comes from
`github.event.pull_request.head.sha`, not `github.sha`.

**CI-2 — a truncated run cannot make a test green.** *Fails if* a base run with
`outcome = "truncated"` counts toward `CI_FLAKE_BASE_RUNS` or toward "the test
was green here". Test: five base runs, one truncated → `behavior_delta:
unconfirmed`, reason `insufficient_base`.

**CI-3 — flaky never attributes.** *Fails if* a green re-run yields anything but
`behavior_delta: flaky`, or if any attribution field is populated on a flaky
delta. Test: stable-green base, red primary, green re-run → `flaky` /
`rerun_green`, and the verdict caller receives no candidate list.

**CI-4 — an unrun re-run is not a confirmation.** *Fails if* a red primary with
a stable-green base returns `confirmed` before a re-run row exists. Test: no
`rerun_of` row → `unconfirmed` / `awaiting_rerun`, and `readCiCoverage` reports
`incomplete` with `awaitingRerun = 1`.

**CI-5 — lanes are never merged.** *Fails if* an `ubuntu-latest` green counts as
a base green for a `macos-latest` red, or if `lanesExpected` collapses the legs.
Test: two legs, one red; `lanesExpected = 2`, one delta, and the red leg's base
window contains no rows from the green leg.

**CI-6 — an ambiguous test id is dropped and said.** *Fails if* two identical
`(file, chain, name)` triples produce a stored row, or if `ambiguousDropped`
stays 0 when they do. Test: a junit fixture with a duplicate pair → zero rows for
it, `ambiguousDropped = 1`, and a doctor `WARN` naming the count.

**Mutation anchors required** (`connector-core/scripts/mutation-check.ts`,
`{label, file, from, to, test, because}` at `:38-47`; the file is at 4794 lines
with 298 entries, and both open PRs already extend it — §9):

| edit | guard that must go red |
|---|---|
| `outcome === "completed"` → `outcome !== "crashed"` in the base filter | CI-2 |
| `"flaky"` → `"confirmed"` on the `rerun_green` branch | CI-3 |
| drop the `rerun_of` existence check (treat missing as red) | CI-4 |
| remove `leg` from the lane tuple | CI-5 |
| keep the first of a duplicate triple instead of dropping both | CI-6 |
| `CI_FLAKE_BASE_RUNS` `5` → `1` | CI-2 |

And two `VERIFY:` directives, following the pattern of ground truth §7.2 (the
number is a named constant, the prose re-derives it from the data):
one printing `CI_PROVIDERS.length` beside the count of reporters that exist, and
one printing `CI_MAX_TEST_ROWS` beside the `ci_test_results` CHECK in
`bootstrap.sql`.

---

## 8. Refusals

Each is a **doctor line**, never a silent absence — `check(level, name, detail)`
at `cli/src/cli/doctor.ts:190`.

1. **GitLab CI is `unavailable`, and I am not designing it now.** The shape
   accepts `provider`, but `CI_PROVIDERS` ships with one member. GitLab has **no
   `run_attempt`**: retrying a job mints a new job id inside the same pipeline,
   so `rerun_kind: "new_attempt"` has nothing to bind to, and a synthesised
   attempt number is one the hub cannot verify. Doctor: `FAIL "ci provider" —
   "gitlab_ci has no reporter; ci coverage is unavailable"`.
2. **A local `bun test` is never CI.** A laptop run happens at an unknown sha in
   a dirty worktree; recording it as evidence about a commit is the same false
   accusation `capture-git-touches.ts:12-20` refuses for `git diff` dirt. There
   is no local-runner rung and there will not be one in 1.0.
3. **Fork pull requests report nothing.** `pull_request` from a fork gets no
   repository secrets, so the reporter has no hub token. It prints one line and
   **exits 0** — inform, never block (non-negotiable #1) — and the hub sees
   `coverage.ci: unknown` at that commit. Doctor says so by name rather than
   letting the gap read as a green suite.
4. **The hub never triggers a re-run.** That needs a GitHub token held by the
   hub, an API client and an outbound-call story. Out of scope; the re-run is
   produced by the workflow itself (`same_job`) or by a human clicking *Re-run
   failed jobs* (`new_attempt`).
5. **No failure messages, no stack traces, no `hostname`.** All three are in the
   junit file (**measured**) and none is sent. #6 forbids content-derived
   artifacts, and a failure message is source text.
6. **No per-commit `commit_evidence`.** Ground truth Q4 asks whether
   `commit.observed` needs per-commit rows; this spec does **not** need them.
   `ci_runs.commit_sha` is a sha CI already had, joined to a session's
   `base_commit`. It adds no new commit surface to the hub.
7. **Not in scope, named because a reader would expect them here:** runtime
   invariant mining, auto-generated behavioural probes, and semantic collision
   detection are all cut from 1.0 (ground truth §8.6). A test's *identity* is
   its name; this spec does not infer that two renamed tests are the same test.
   A rename therefore reads as one test disappearing and another arriving with
   no base — `unconfirmed` / `insufficient_base`, which is honest.
8. **`coverage.runtime` stays `unavailable`.** This spec creates the `ci` source
   and only that one. Ground truth Q5 asked about both; half of it is now
   answered, half is not.

---

## 9. Collisions and sequencing

**With ground truth §8.4 — a real disagreement, not a merge conflict.** §8.4
lists `ci.result` as an `envelope.kind` feeding the `ci` source. It cannot be
one: an envelope requires `producer.{developerId, agentKind, sessionId}`
(`envelope.ts:19-23`) and CI has none, so §8.4's own table would force the
phantom teammate its Q9 warns about. **The event-model spec (02) and this one
must not both be right.** My position: §8.4's row stays as *the fact the model
needs*, and its transport is `POST /api/ci-runs`, not the spool. If 02 keeps
`ci.result` as an envelope kind, one of the two must change before either lands.

**With PR #50** (`00-ground-truth.md` §9.1):
- `packages/server/src/db/schema.ts` — #50 appends `pins`, `pin_files`,
  `team_settings` after `question_answers`. My two tables append **after** those.
  Sequence: #50 first.
- `packages/server/src/constants.ts` — #50 appends a `SUSPECT_*` block at the
  tail; my `CI_*` block goes below it. #49 edits near line 10. Both PRs already
  edit this file; mine is a third editor at the tail.
- `packages/server/src/app.ts` — #50 adds three route mounts; mine is a fourth,
  appended, no reorder.
- `bootstrap.sql` / `ddl-sync.test.ts` — #50 adds +92 / +27; mine adds after.
- `connector-core/scripts/mutation-check.ts` — #50 +103, #49 +102, mine six more
  entries at the array tail. **Expect a conflict there; sequence after both.**
- `packages/cli/src/render-surfaces.ts` — free ground today (ground truth §9.4);
  the new `cli-ci-report` entry lands there.
- **Conceptual, not textual:** `services/suspect.ts` is the attribution consumer.
  Its falsifier enum (`crosscheck-pins:suspect.ts:69-77`) is pin-shaped —
  `recorded_break | not_recorded_broken | no_check_recipe | reader_named_files`.
  A confirmed CI delta is a **fifth** falsifier shape ("a stably-green test went
  red and stayed red on re-run"). Extending that enum is the verdict spec's call,
  not mine; I hand it `CiBehaviorDelta` and say so.

**With PR #49:** none. It touches `services/developers.ts` and
`routes/developers.ts`; this spec has no developer identity in it at all — which
is the point of dropping `reported_by` (§3.2).

**With the other seven specs:** 03 (coverage) consumes `readCiCoverage` and owns
how `ci` composes with the other four sources — I define the source, not the
composition. 02 (event model) owns `seq`; I consume nothing from it. The verdict
spec owns whether `INDETERMINATE` or `unconfirmed` wins when both apply.

---

## 10. Decisions for Nick

**D1 — Which token does CI hold?**
*Default (recommended): a separate `CROSSCHECK_CI_TOKEN`.* One env var, one
middleware beside `requireAdmin`, no table. The admin token also flips
`pin_policy` and `suspect_attribution` (#50), and a workflow secret is a wider
place to keep it than a hub operator's shell.
*Alternative:* reuse the admin token — one fewer knob, and the blast radius is
the whole team's settings.

**D2 — Is a same-job re-run enough to say `confirmed`?**
*Default: yes, and record which kind it was.* The alternative — requiring
`new_attempt` — means every confirmation waits on a human clicking *Re-run failed
jobs*, which makes the cheap test not cheap. The cost of the default is that a
`same_job` re-run shares the runner's state, so a host-level flake survives it.
Both kinds are stored, so a later rule can raise the bar without a migration.

**D3 — Which jobs report?**
*Default: the `test` job only, both matrix legs — two lanes.* `budgets`,
`concurrency` and `cpu-starved` are wall-clock and environment-sensitive by
design (`ci.yml:57-93`, `:342-359`), and their flakes are findings about the
host, not about a commit. Adding them later is two workflow lines each.

**D4 — What exactly is added to `ci.yml`?** (all inside the `test` job)
1. `- run: bun test` → `- run: bun test --reporter=junit --reporter-outfile=junit.xml`
   (**measured**: console output is unchanged).
2. one new step, `if: always()`, running
   `bun run packages/cli/scripts/ci-report.ts` with `--junit junit.xml
   --job test --leg ${{ matrix.os }} --ref ${{ github.ref_name }}
   --attempt ${{ github.run_attempt }} --run-id ${{ github.run_id }}
   --sha ${{ github.event.pull_request.head.sha || github.sha }}`
   and `CROSSCHECK_HUB_URL` / `CROSSCHECK_CI_TOKEN` from secrets.
3. the reporter itself re-runs the failed **files** into `junit-rerun.xml` and
   posts a second row with `rerun_kind: "same_job"`.
*Default: the reporter owns the re-run* (two edited lines in `ci.yml` instead of
four, one place to reason about). *Alternative:* a separate `if: failure()`
workflow step, which reads better in the Actions log.
**No `workflow_dispatch` is needed**: GitHub's native re-run already produces
attempt 2, which is `new_attempt`.

**D5 — `CI_FLAKE_BASE_RUNS = 5`.**
*Default: 5.* Lower means more `confirmed` and more false confirmations from a
test that was only recently green; higher means a new lane waits longer before
it can say anything. Five is a deliberate non-tuning and, per the corpora rule
(`precision-corpus.test.ts:9-16`), it is never lowered to make a case pass.
