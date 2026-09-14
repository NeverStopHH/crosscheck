# 03 — Coverage integrity at the answer layer

**Scope proposal, not an assertion of inclusion** (00 §0, Q1). Baseline:
`main@e9aab82` + PR #50 + PR #49, per 00 §9.3. Paths repo-relative under
`packages/`. A `crosscheck-pins:` prefix marks a line that exists only on #50.

**Two refusals about this document's own inputs.** The Cut Line HTML and the
handover are gone (00 §0), so **AT-1 and AT-9 do not exist as text**. The tests
in §7 are fresh, numbered `COV-1…COV-8`, and occupy the slots the brief called
AT-1 and AT-9 without pretending to restate them. Second: the brief's own
example sentence — *"coverage incomplete for commits A..F since Friday 08:13"*
— **cannot be built**. `commit_evidence` is an aggregate with PK
`(repo, author_email)` and **no hash column** (`server/src/db/schema.ts:384-399`,
00 §1.9). There is no list of commits to name. §3.4 gives the sentence that
*is* buildable.

---

## 1. Problem

**The hub answers questions about a repo it may not have been watching, and no
answer says so.**

`services/absences.ts` (191 lines) is the only coverage-shaped service in the
tree. Its output reaches exactly one renderer: the briefing takes
`absences?: readonly AbsenceEntry[]` (`connector-core/src/briefing/render.ts:105-106`)
already computed by `GET /api/absences`, and renders it as lines
(`briefing/render.ts:843-846`). It **gates nothing**.

Every other answer surface ignores coverage entirely (00 §5.2, re-verified):

- `services/search.ts` imports `agentSessions, claims, developers,
  workContextTargets, workContexts` and nothing else (`:24-46`).
- `services/hints.ts` — same table set (`:28-46`); it uses `presenceCutoff`
  for the liveness of *another session*, which is not coverage.
- `services/diagnosis.ts` — same (`:1-14`).

The concrete defect, at one line: `mcp/render.ts:1157` emits

```
No work context on this repo matched that query.
```

with no knowledge of whether anything was being recorded. A repo whose
connectors died on Friday produces that sentence on Monday, and the reading
model concludes nobody has worked on the problem. The file already knows this
is the expensive direction to be wrong in — `renderUnusableQuery`'s header
(`:1163-1174`): *"'nothing matched' tells a model its question was ASKED, so it
concludes nobody has worked on the problem and goes off to redo the work."* It
draws that distinction for a query it could not tokenise and for a filter it
could not resolve (`renderUnappliedFilters`, `:1237-1264`) — **and not for an
archive it could not see.**

Nothing in the tree carries a per-source coverage record. The five sources of
00 §8.2 do not exist as a data structure anywhere.

## 2. Principles served

> **1. "Only judge when you know you were watching."** `UNATTRIBUTED` only
> under COMPLETE coverage; under a gap, `INDETERMINATE`.

Technically unenforceable today: `cli/doctor.ts` knows about capture health,
the judging layer has no channel to it. §3 gives that channel a shape and §5
makes every answer surface read it.

> **4. Non-negotiable — fail, never silently.** Every error path visible in
> status or doctor.

An empty answer over a gap is the purest silent failure the product has: no
crash, no latency, an answer that is wrong in the reassuring direction. #50
already states this in its own corner — *"coverage unknown is not coverage
fine, and a green meaning 'could not check' is worse than no check at all"*
(`crosscheck-pins:cli/doctor.ts`, the `checkPins` header) — and this spec
generalises that sentence from one check to every surface.

Not served here, deliberately: principle 3 (`explanation_timing`) needs `seq`,
which this spec does not consume — see §9.

## 3. Target model

### 3.1 The record — no scalar, five rows, always

New hub service `packages/server/src/services/coverage.ts`:

```ts
export const COVERAGE_SOURCES = [
  "agent_event", "git", "ci", "runtime", "human_edit",
] as const;
export const COVERAGE_STATES = [
  "complete", "incomplete", "unknown", "unavailable",
] as const;

export interface CoverageSourceRecord {
  readonly source: CoverageSource;
  readonly state: CoverageState;
  /** Renderer-owned enum, never prose — see 3.3. */
  readonly reason: CoverageReason;
  /** Start of the observed gap, ISO. Null unless state === "incomplete". */
  readonly gapSince: string | null;
  /** When the newest evidence for this source was collected. */
  readonly observedAt: string | null;
}

export interface CoverageRecord {
  readonly repo: string;
  readonly computedAt: string;
  /** EXACTLY five, fixed order of COVERAGE_SOURCES. Never filtered. */
  readonly sources: readonly CoverageSourceRecord[];
}
```

**There is no aggregate field and there will not be one.** No `overall`, no
count, no percentage (00 §8.5). A missing row cannot be read as `complete`
because rows are never missing: `readCoverage` emits five or throws.

One derived predicate, and it lives here so seven other specs cannot each
invent their own:

```ts
/** Principle 1, as a function. */
export const isJudgeable = (record: CoverageRecord): boolean =>
  stateOf(record, "agent_event") === "complete" &&
  stateOf(record, "git") === "complete";
```

### 3.2 How each source is computed

**Derived on read. No table, no column, no migration, no retention.** The
reason is `agent_sessions.reaped_at`: a reap is an inference from silence and
is **revocable** — `services/records.ts:71-79` revives a reaped session when a
record from it arrives (`schema.ts:138-145`). A stored coverage verdict would
outlive its own evidence. Coverage is a read-time derivation of current
knowledge, and that is a correctness requirement, not a performance choice.

**`agent_event`** — one aggregate over `agent_sessions` filtered by `repo`
within `COVERAGE_SESSION_WINDOW_DAYS`, riding
`agent_sessions_repo_idx` / `agent_sessions_heartbeat_idx` (`schema.ts:149-157`):

| state | predicate | `gapSince` |
|---|---|---|
| `complete` | ≥1 session in window, and none reaped, and none unclosed past `presenceCutoff` (`services/presence.ts:32-33`) | null |
| `incomplete` | ≥1 session with `reaped_at` NOT NULL, **or** ≥1 with `ended_at` NULL and `last_heartbeat_at <= presenceCutoff(now)` | `min(last_heartbeat_at)` over those sessions |
| `unknown` | no session row for this repo in the window | null |
| `unavailable` | never | — |

Zero sessions is `unknown`, not `complete`: no session is not proof nobody
worked.

**`git`** — computed from the rows `listAbsences` already reads
(`absences.ts:126-156`) plus one `max(collected_at)`:

| state | predicate | `gapSince` |
|---|---|---|
| `complete` | newest `collected_at` within `ABSENCE_EVIDENCE_MAX_AGE_DAYS` (7) **and** `listAbsences` returns zero findings | null |
| `incomplete` | evidence fresh but ≥1 finding, **or** newest `collected_at` older than the window | earliest non-null `lastSessionAt` among findings, else earliest `latestCommitAt` |
| `unknown` | no `commit_evidence` row for this repo at all | null |

`collectCommitEvidence` runs **only at SessionStart** (00 §4.3), which is
exactly why a stale `collected_at` is `incomplete` rather than ignorable.

**`ci` = `unavailable`, reason `no_emitter`.** Nothing in the tree emits
`ci.result` (00 §8.4). §8 states the flip condition.

**`runtime` = `unavailable`, reason `out_of_scope_1_0`.** Nothing exists, and
runtime invariant mining is on the cut list (00 §8.6).

**`human_edit` = `unavailable`, reason `no_platform_rung`.** 00 §8.2 names
`work_context_targets.source = "tool_edit"` as the closest signal; it is not
close enough to report. `tool_edit` records the **agent's** edit tool. A human
typing in vim with no session running fires no hook on any platform we support,
so the rung cannot exist — the `unavailable` case 00 §8.2 defines. The
git-touch lane (`crosscheck-pins:connector-core/src/flows/capture-git-touches.ts`)
is mtime-filtered to the *session* window and is deliberately not attributed to
a person; calling it `human_edit` would be the `coverage = 87%` lie in another
shape. Human edits surface through `git`, via `listAbsences`' `inactive`
finding, and that is the honest place for them.

### 3.3 `CoverageReason` — an enum, because prose on this line would be untrusted

`sessions_reported` · `session_reaped` · `session_silent` ·
`no_session_in_window` · `commits_reported` · `commit_authors_unreported` ·
`evidence_stale` · `no_commit_evidence` · `no_emitter` · `out_of_scope_1_0` ·
`no_platform_rung` · `hub_did_not_report`.

Consequence for §5: **a coverage line contains no author-written string.**
Enum values, ISO timestamps, small integers, renderer-owned literals. It adds
no untrusted slot to any surface it lands on.

### 3.4 The buildable sentence

Instead of the brief's unbuildable commit list:

```
Coverage incomplete: agent sessions on this repo went quiet 2026-09-05T08:13Z
(1 reaped); git evidence names 2 commit authors with no reported session.
```

Bounded by `MAX_COVERAGE_LINE_CHARS = 160`, one line, no names, no emails
(`absences.ts:34` — never an email), no commit hashes because there are none.

### 3.5 Wire

`coverage` is a sibling field on responses that already exist. No new endpoint:

| endpoint | today | after |
|---|---|---|
| `GET /api/absences` | `{ absences }` (`routes/absences.ts:30`) | `{ absences, coverage }` |
| `GET /api/search` | `{ ...response, filters }` (`routes/search.ts:172`) | `+ coverage` |
| `GET /api/hints/candidates` | `{ candidates, answers }` (`routes/hints.ts:76`) | `+ coverage` |
| `GET /api/hints/tripwire` | `{ sessions }` (`routes/hints.ts:93`) | `+ coverage` |
| `GET /api/work-contexts/:id/diagnosis` | diagnosis tree | `+ coverage` |

## 4. Migration

**No table, no index, no `bootstrap.sql` change, no `ddl-sync.test.ts` change.**
No existing row is redefined.

What *is* redefined is the meaning of a missing field, and it inverts the
tree's usual tolerant-parse convention. `SearchOutcome.filters` is `null` from
an older hub and *"then nothing is claimed"* — the renderer prints no filter
line (`connector-core/src/http/hub.ts:820-826`, `:852-862`). For coverage,
printing nothing is precisely the failure:

> **Absent coverage is `unknown`, never silence and never `complete`.** A
> response with no `coverage` block, or one that fails to parse, becomes
> `UNKNOWN_COVERAGE` — five rows, all `unknown`, reason `hub_did_not_report`.

The hub is the only authority; the connector does not substitute its own
knowledge of which emitters exist. `getAbsences` (`http/hub.ts:331-339`)
changes from `tolerantList("absences", …)` to a `SearchResponseSchema`-shaped
transform returning `{ absences, coverage }` — the precedent is one screen
away in the same file.

## 5. Where it renders, and the contract

### 5.1 The contract

**The empty-result rule (hard).** No surface may emit an empty-result phrasing
while `agent_event` or `git` is anything but `complete` — `unknown` included.
Binding on: `mcp/render.ts:1139-1161` (`noMatchLine`), the diagnosis empty
branch (`mcp/render.ts:852`), `NO_TARGETS` (`mcp/render.ts:613`), the hint and
tripwire silent paths, and `crosscheck status`.

**The annotation rule (soft).** On a **non-empty** answer the coverage note
renders only when a source is `incomplete` — a positively observed gap — never
on `unknown`. An `unknown` source beside real rows is the ordinary state of a
fresh install, and a caveat on every answer is the noise that teaches people to
ignore caveats. This is `checkAbsences`' own reasoning (`cli/doctor.ts:1305-1312`:
*"a warning nobody can act on teaches people to ignore doctor"*) and #50's
`MIN_SKIPS_TO_WARN`. `unknown` still reaches `doctor` and `crosscheck status`
every single time.

**Never blocks** (non-negotiable #1). The note annotates; no row is withheld,
no call is refused, no tool returns an error.

**Phrasing inherits `absences.ts:92-99` verbatim**: a factual observation, never
an inference about what somebody did. *"We see agent sessions, not keystrokes."*

### 5.2 Registry and corpus obligations — decided

**One new module, `packages/connector-core/src/coverage/render.ts`**, exporting
`coverageNote(record, now): string | null` and
`coverageClause(record, now): string`.

**Registered as one `kind: "composite"` surface**, not corpus:

```ts
{
  kind: "composite",
  name: "coverage-note",
  delivery: "unsolicited",
  module: "src/coverage/render.ts",
  note: "Enum values, ISO timestamps and integers only — no author-written
         string reaches this line (spec 03 §3.3), so there is no exposed slot
         for a corpus payload to occupy.",
  corpusCoveredBy: ["test/coverage-render.test.ts"],
}
```

`delivery: "unsolicited"` although the same text also lands on `pulled`
surfaces (`search-results`, `diagnosis`). One module carries one
classification, and `test/anchoring-separation.test.ts` walks that field —
so it takes the **tighter** of the two. Over-constraining a pulled line is
safe; under-constraining an unsolicited one is not.

**The obligation that is easy to miss.** `search-results-empty-filtered`
(`render-surfaces.ts:817-838`) exists *only* to attack the empty branch, which
the `search-results` entry cannot reach. Adding a coverage clause to
`noMatchLine` without passing a coverage record into that entry's closure means
the new clause is **never attacked by the corpus**. The entry's
`render` gains a fixed `incomplete` record. `COV-7` fails if it does not.

No change to `RENDER_LAYER_MODULES` or `RENDER_BARREL_MODULES`
(`render-surfaces.ts:138-154`): this is a surface, not a primitive.

`packages/cli/src/render-surfaces.ts` gains the `status` and `doctor` coverage
lines — appended **below** #50's +163-line block, never renumbered.

### 5.3 Placement in the briefing

**One line, first, above contradictions, never cut.** The briefing orders
contradictions → solved → drafts → absences (`briefing/render.ts:450-453`,
`:685-688`, `:745-749`) under `MAX_BRIEFING_CHARS = 2200`
(`connector-core/src/constants.ts:387`). Coverage is not another finding
competing in that order: it is a statement about how much of everything below
it can be trusted. **A caveat that can be cut is a caveat that lies.** At
`MAX_COVERAGE_LINE_CHARS = 160` it costs at most 7.3% of the budget
(160/2200), and the absence section keeps its `MAX_ABSENCE_LINES = 3`
(`constants.ts:613`) unchanged. This is 00 §10 Q8 answered for my line only;
the ordering spec owns `INDETERMINATE`.

## 6. Budget

**Zero new hub round trips on any hook path.** The 800 ms rule
(`connector-core/src/constants.ts:56-57`, `PRINTS: 800 800`) is untouched
because nothing new is requested.

- **SessionStart (1000 ms).** Coverage rides inside `GET /api/absences`, which
  `assembleBriefing` already fetches in its parallel block
  (`flows/briefing.ts:124`, `:157`, `:184`). A ninth parallel GET would look
  free in wall clock and is not: PGlite is *"an embedded single-connection WASM
  database"* (`services/search.ts:61-62`), so parallel GETs serialise on the
  hub. Riding an existing response costs one extra aggregate over
  `agent_sessions` (indexed, `schema.ts:149-157`) and one `max(collected_at)`
  over rows `listAbsences` reads anyway.
- **UserPromptSubmit / PreToolUse (800 ms each).** Coverage rides inside the
  existing `/api/hints/candidates` and `/api/hints/tripwire` responses. Bytes,
  not a round trip. `spareMs` (`config/hook-budget.ts:48-55`) is untouched;
  `MAX_HINTS_PER_PROMPT = 1` (`constants.ts:84`) is untouched — the coverage
  note is not a hint and does not consume the slot.
- **Stop.** Untouched. #50 already spends Stop's `spareMs` on the git lane
  (`crosscheck-pins:connector-claude/src/hooks/stop.ts`, +63).
- **MCP `search_related_work` / `get_diagnosis`.** Not on a hook path at all —
  `MCP_TIMEOUT_MS = 10_000`, `delivery: "pulled"`.
- **Hub job cost: none.** No background pass, no reaper change, no retention.

**Measurement refusal.** I have run no benchmark, so this spec states no
millisecond figure for the added query. `COV-8` requires one before merge, on
the harness that already exists (`connector-claude/test/capture-latency.test.ts`).

## 7. Acceptance tests

Fresh (see the header). Each must be able to fail, and each names the mutation
that must turn its guard red in `connector-core/scripts/mutation-check.ts`
(00 §7.2).

**COV-1 — an empty answer may not stand alone over a gap.** One reaped session
with `last_heartbeat_at = 2026-09-05T08:13Z`, a query matching nothing. Output
must not contain the bare sentence at `mcp/render.ts:1157` and must contain
`2026-09-05T08:13Z`. *Fails if* the unqualified sentence is emitted.
*Mutation:* delete the coverage clause from `noMatchLine`.

**COV-2 — five rows, no scalar.** `readCoverage` returns exactly five records
in `COVERAGE_SOURCES` order. *Fails if* one is dropped or an aggregate field
appears. *Mutation:* `sources.filter(s => s.state !== "unavailable")`.
Pinned by a `VERIFY:` re-deriving the count from `COVERAGE_SOURCES`, not from
prose (00 §7.1).

**COV-3 — absent coverage is `unknown`.** An `/api/absences` body with no
`coverage` key yields five `unknown` / `hub_did_not_report`, and COV-1's rule
still fires. *Fails if* the fallback is `complete` or the note is suppressed.
*Mutation:* change the fallback default to `complete`.

**COV-4 — a reaped end is not a clean end.** Two sessions identical but for
`reaped_at`: reported → `complete`; reaped → `incomplete` with
`gapSince = last_heartbeat_at`. *Fails if* a reap reads as an end.
*Mutation:* drop the `reaped_at IS NULL` term from the `complete` predicate.

**COV-5 — three rungs refuse, and doctor says so.** `ci`, `runtime`,
`human_edit` are `unavailable` with their named reasons, and `crosscheck
doctor` prints one PASS line each naming the missing rung. *Fails if* any is
omitted, or reported `unknown` (a rung that cannot exist must not read as one
that might) or `complete`. *Mutation:* map `ci` to `unknown`.

**COV-6 — no percentage reaches any surface.** No registered surface's output
for a coverage-bearing fixture contains a `%` in the coverage line, and
`CoverageRecord` exposes no numeric aggregate. *Fails if* either appears.
*Mutation:* add an `overall` ratio field and print it.

**COV-7 — the empty branch is corpus-attacked with coverage present.** The
`search-results-empty-filtered` registry entry passes an `incomplete` record.
*Fails if* the entry's closure omits it — the new clause would then be
unattacked while the registry still counts the surface.

**COV-8 — the budget is measured, not asserted.** SessionStart p95 on
`capture-latency.test.ts` with coverage riding `/api/absences`, against the
pre-change baseline, with a named allowance. *Fails if* no measurement exists.

## 8. Refusals

1. **No commit list.** `commit_evidence` has no hash column and no per-commit
   row (`schema.ts:384-399`). "Commits A..F" is unrenderable. Per-commit
   granularity is a new table colliding with `COMMIT_EVIDENCE_RETENTION_DAYS`
   and non-negotiable #6 — 00 §10 Q4, not reopened here.
2. **`ci` is `unavailable`, and stays so** until an emitter, a route, an auth
   story (CI holds no developer API key — `server/src/middleware/auth.ts`) and
   an `app.ts` mount exist. Flip condition, exactly: `readCoverage` reports
   `ci` from data only when a `ci.result` ingest path lands; until then the
   doctor line says *"no CI connector reports to this hub"*.
3. **`runtime` is `unavailable`, permanently for 1.0** (cut list, 00 §8.6).
4. **`human_edit` is `unavailable`** — §3.2. No hook fires on a human
   keystroke; the tool lane is the agent's, not a human's.
5. **No per-developer coverage.** Coverage is per repo, per source. A
   per-developer coverage figure is a per-developer dashboard, which the scale
   rule forbids, and `suspect.ts:21-25` already fixed the shape: sessions and
   intents, never people.
6. **No stored coverage.** §3.2.
7. **This spec does not judge.** It owns `CoverageRecord` and `isJudgeable`.
   The `ATTRIBUTED / UNATTRIBUTED / INDETERMINATE` mapping belongs to the
   verdict spec, which must call `isJudgeable` rather than recompute it.
8. **This spec does not redefine `suspect`.** #50's outcome enum
   (`ranked | no_separation | no_touch | withheld`,
   `crosscheck-pins:server/src/services/suspect.ts:79-87`) is closed ground.
   Note only that `no_touch` means *"no session touched this surface"* and is
   subject to the empty-result rule; who applies it there is the verdict spec.
9. **No `PROTECTED_CONFLICT` channel** (00 §10 Q6) — not mine.
10. **Nothing on `conference`** — tier 2, cut.
11. **#49's `emailsTruncated` blind spot is named, not modelled.** A member
    whose aliases were hidden gets attributed as `unconnected`
    (`crosscheck-dev-listing:server/src/services/developers.ts`), which makes
    `git` read `incomplete` for a reason that is an artefact. Modelling it
    needs a hub-side "the alias set is truncated" fact that does not exist.
    Refused for 1.0; listed so it is not mistaken for an oversight.

## 9. Collisions and sequencing

**Write after #50 and #49 both merge** (00 §9.3).

**PR #50 — one word, two meanings.** `GitTouchesOutcome.unavailable`
(`crosscheck-pins:connector-core/src/flows/capture-git-touches.ts:80-92`) means
*"git did not answer"*, which maps to coverage **`unknown`** — not coverage
`unavailable`, which means *"the rung cannot exist"*. Exactly one place in the
tree may translate between them: the mapper in `services/coverage.ts`, carrying
that sentence as a comment and a mutation anchor. Left implicit this is a
guaranteed future bug.

**PR #50 — `git-lane-cost.ts`** (`skipped` / `ran`, +117) is the connector-side
twin of my hub-side `git` source. They must never disagree in `doctor`: my
check reads the hub record, #50's `checkGitLane` reads session state, and both
lines appear under the same heading. Adopt #50's ladder exactly — *not
measured* is a PASS, *could not reach* is a WARN.

**PR #50 — free ground confirmed.** `git diff --stat e9aab82...HEAD` in
`crosscheck-pins` shows **no** change to `connector-core/src/render-surfaces.ts`,
`services/absences.ts`, `services/search.ts`, `services/hints.ts`,
`briefing/render.ts` or `mcp/render.ts`. It does add
`packages/cli/src/render-surfaces.ts` (+163) — append below it.

**PR #49 — no structural collision.** Identity resolution is unchanged; see
refusal 11 for the one semantic overlap.

**Shared files.** `server/src/constants.ts` — a `COVERAGE_*` block at the tail,
after #50's `SUSPECT_*`, with a `VERIFY:` pinning
`COVERAGE_SESSION_WINDOW_DAYS === SUSPECT_WINDOW_DAYS` so the attribution and
coverage windows cannot drift (00 §10 Q10).
`connector-core/src/constants.ts` — `MAX_COVERAGE_LINE_CHARS = 160` appended
below #50's block. `mutation-check.ts` — third editor after both PRs; expect
conflicts at the array tail.

**Other 1.0 specs.**
- *Event model (Q2, `seq`)*: **no dependency either way.** Coverage is derived
  from tables, not from the event stream, so it can land before `seq` is
  decided. If the event model later wants a `coverage.observed` kind, it is
  additive.
- *Verdict / fence*: consumes `isJudgeable`; must not recompute it.
- *CI ingestion (05)*: owns the flip in refusal 2. It changes `readCoverage`'s
  `ci` branch and nothing else in this spec.
- *Briefing ordering (Q8)*: must honour §5.3 — one line, first, uncuttable.
- Whichever spec touches `noMatchLine`, `NO_TARGETS` or the diagnosis empty
  branch inherits the empty-result rule; §5.1 is the single list.

## 10. Decisions for Nick

1. **Coverage rides inside `GET /api/absences`, or its own `GET /api/coverage`?**
   *Default: inside absences.* PGlite is single-connection
   (`search.ts:61-62`), so a ninth parallel GET at SessionStart serialises
   inside the 1000 ms budget. Cost of the default: the endpoint named
   "absences" returns coverage too, and its client return type stops being a
   bare list.
2. **Is the briefing's coverage line first and uncuttable, or last and
   cuttable?** *Default: first, uncuttable, ≤160 chars.* A caveat that can be
   cut lies. Cost: ≤7.3% of `MAX_BRIEFING_CHARS` on every SessionStart.
3. **`human_edit` = `unavailable`, or `incomplete` proxied by #50's git-touch
   lane?** *Default: `unavailable`.* The proxy would attribute worktree changes
   nobody can attribute.
4. **On a non-empty answer, annotate on `incomplete` only, or on `unknown`
   too?** *Default: `incomplete` only.* `unknown` still reaches doctor and
   status every time.
5. **Does the empty-result rule fire against an old hub that reports no
   coverage at all?** *Default: yes.* Every empty search on an un-upgraded hub
   then carries a sentence until the hub is upgraded. Accepting the noise is
   the point; the alternative is the exact lie this spec exists to stop.
6. **Who owns "UNATTRIBUTED requires complete"?** *Default: this spec owns the
   record and `isJudgeable`; the verdict spec owns the mapping.* Otherwise two
   specs compute principle 1 and one of them drifts.
