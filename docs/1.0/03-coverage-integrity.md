# 03 — Coverage integrity at the answer layer

**Tier 1** — *"coverage integrity reaching the answer layer: every surface that asserts what the team knows
carries the qualifier"* (`00-cut-line.md`). **Owns AT-1, AT-9 and AT-10; supplies the predicate AT-5 is
decided by.** AT-10 had four partial owners across the set (05 *"for its provider refusals"*, 07 *"I own AT-10 for these
surfaces"*, 08 *"an AT-10 half"*, and COV-5 here) and therefore no single failing test. **It is one AT with one owner: this
spec.** COV-5 and COV-9 are its mechanism — a rung that cannot exist is a printed doctor refusal, and every answering surface is
walked. 05, 07 and 08 each discharge an *instance* of that rule for their own rungs and say so; none of them owns it. The
README's table is the authority. Baseline `main@e9aab82` + PR #50 + PR #49 (00 §9.3); paths repo-relative under `packages/`, a
`crosscheck-pins:` prefix marks a line that exists only on #50.

**Revision, 2026-09-14.** This document previously opened with a refusal that *"AT-1 and AT-9 do not exist
as text"*. The cut line was recovered (00 §0.1) and that refusal is **withdrawn**; the `COV-*` tests stand
and §7 now names the AT each discharges. One refusal survives, narrowed: AT-1's example names *"commits
A..F"* and `commit_evidence` is an aggregate with PK `(repo, author_email)` and **no hash column**
(`server/src/db/schema.ts:384-399`) — §3.4.

## 1. Problem

**The hub answers questions about a repo it may not have been watching, and no answer says so.**
`services/absences.ts` (191 lines) is the only coverage-shaped service in the tree, and it reaches one
renderer: the briefing takes `absences?: readonly AbsenceEntry[]`
(`connector-core/src/briefing/render.ts:105-106`) already computed by `GET /api/absences` and rendered as
lines (`:843-846`). It **gates nothing**. Every other answer surface ignores coverage (00 §5.2,
re-verified): `services/search.ts` imports `agentSessions, claims, developers, workContextTargets,
workContexts` and nothing else (`:24-46`); `services/hints.ts` the same (`:28-46`), using `presenceCutoff`
only for another session's liveness, which is not coverage; `services/diagnosis.ts` the same (`:1-14`).

The concrete defect, at one line: `mcp/render.ts:1157` emits `No work context on this repo matched that
query.` with no knowledge of whether anything was being recorded. The file already knows this is the
expensive direction to be wrong in — `renderUnusableQuery`'s header (`mcp/render.ts:1165-1175`): *"'nothing
matched' tells a model its question was ASKED, so it concludes nobody has worked on the problem."* It draws
that distinction for a query it could not tokenise and for a filter it could not resolve
(`renderUnappliedFilters`, `:1246`) — **and not for an archive it could not see.** That is AT-1's failure
condition, live on main, and nothing in the tree carries a per-source coverage record: the five sources of
00 §8.2 do not exist as a data structure anywhere.

## 2. Principles and acceptance tests served

> **Principle 1 — "Only judge when you know you were watching."** `UNATTRIBUTED` only under
> COMPLETE coverage; under a gap, `INDETERMINATE`.

Unenforceable today: `cli/doctor.ts` knows about capture health, the judging layer has no channel to it. §3
gives that channel a shape, §5 makes every surface read it, and `isJudgeable` (§3.1) is the single predicate
**AT-5** is decided by — *"fails if unattributed is reachable with a known coverage gap."*

> **Non-negotiable #4 — fail, never silently.**

An empty answer over a gap is the purest silent failure the product has: no crash, no latency, an answer
wrong in the reassuring direction. #50 says so in its own corner — *"coverage unknown is not coverage fine,
and a green meaning 'could not check' is worse than no check at all"*
(`crosscheck-pins:cli/src/cli/doctor.ts:1693-1695`) — and this spec generalises it from one check to every
surface. That is **AT-9**: *"fails if a person has to run doctor to learn that an answer was based on
partial observation."*

## 3. Target model

### 3.1 The record — no scalar, five rows, always

New hub service `packages/server/src/services/coverage.ts` — 03's ground, consumed elsewhere (00 §9.6).

```ts
export const COVERAGE_SOURCES = ["agent_event","git","ci","runtime","human_edit"] as const;
export const COVERAGE_STATES = ["complete","incomplete","unknown","unavailable"] as const;

export interface CoverageSourceRecord {
  readonly source: CoverageSource;
  readonly state: CoverageState;
  readonly reason: CoverageReason;           // enum, never prose — §3.3
  readonly gapSince: string | null;          // ISO; null unless "incomplete"
  readonly observedAt: string | null;
}
export interface CoverageScope {              // §3.2a — what the question is about
  readonly sinceIso: string;                  // never older than the window ceiling
  readonly paths?: readonly string[];          // e.g. a pin's file set
}
export interface CoverageRecord {
  readonly repo: string;
  readonly computedAt: string;
  readonly scope: CoverageScope;
  readonly sources: readonly CoverageSourceRecord[];  // EXACTLY five, in order
}
/** Principle 1, as a function. AT-5 is decided by this and nothing else. */
export const isJudgeable = (record: CoverageRecord): boolean =>
  stateOf(record, "agent_event") === "complete" &&
  stateOf(record, "git") === "complete" &&
  record.sources.every((s) => s.state !== "incomplete");
```

**The third term is new, and without it AT-5 failed inside this spec's own
predicate.** The first shape read `agent_event` and `git` only. 04's mapping gates `no_touch` on `isJudgeable` and on nothing
else coverage-shaped, so once 05 lands and a repo's `ci` source reads `incomplete` — 05 §3.6: *"some expected lanes reported and
some did not, or any lane is truncated/crashed, or `awaitingRerun > 0`"* — a pin-lane `no_touch` answer still emitted
`UNATTRIBUTED`. The system would have said *"nobody in the record did this"* while knowing a lane it watches was mid-flight.
That is AT-5's "fails if" verbatim — *"unattributed is reachable with a known coverage gap"* — and 05 §2 states the requirement
explicitly (*"pushes `coverage.ci` off `complete`, so the verdict layer must reach `INDETERMINATE`, not `UNATTRIBUTED` — AT-5,
which 03 owns and this must not undercut"*). It was being undercut here.

**`incomplete` is the only disqualifying state for the other three, deliberately.** A rung that **cannot exist**
(`unavailable`) must not block judging, or with `runtime` permanently unavailable no verdict is ever reachable and the predicate
is useless; and `unknown` on a rung nobody reports is the ordinary state of a fresh install. AT-5 names a **known** gap, and
`incomplete` is the only state that is one. COV-10 now enumerates all five sources rather than the 16 combinations of two.

**`commitRange` is GONE — see §3.4.** A field that would be null on every row for the whole of 1.0 is the silent absence AT-10
forbids, and the type `CommitRange` was never defined by any spec in the set.

**There is no aggregate field and there will not be one** — no `overall`, no count, no percentage (00 §8.5
bans both). A missing row cannot be read as `complete` because rows are never missing: `readCoverage` emits
five or throws.

### 3.2 How each source is computed

**Derived on read. No table, no column, no migration, no retention**, because `agent_sessions.reaped_at` is
revocable — the column's own comment says so (`schema.ts:138-146`: *"an inference has to be revocable"*) and
`services/records.ts:71-79` revives a reaped session when a record from it arrives. A stored verdict would
outlive its evidence. **`agent_event`** is one aggregate over `agent_sessions` by `repo` within
`COVERAGE_SESSION_WINDOW_DAYS`, riding `agent_sessions_repo_idx` / `agent_sessions_heartbeat_idx`
(`schema.ts:148-158`); zero sessions is `unknown`, not `complete`, since no session is not proof nobody
worked:

| state | predicate | `gapSince` |
|---|---|---|
| `complete` | ≥1 session in window, none reaped, none unclosed past `presenceCutoff` (`services/presence.ts:31-33`) | null |
| `incomplete` | ≥1 with `reaped_at` NOT NULL, **or** ≥1 with `ended_at` NULL and `last_heartbeat_at <= presenceCutoff(now)` | `min(last_heartbeat_at)` |
| `unknown` | no session row for this repo in the window | null |
| `unavailable` | never | — |

### 3.2a The scope — measured against the question, not against the whole repo

**Without this, `agent_event = complete` is practically unreachable and `UNATTRIBUTED` is dead in the field.** The predicate
above says `complete` needs *≥1 session in window, none reaped, none unclosed past `presenceCutoff`* — across the **whole repo**
for the **whole window**. The tree's own measurement says that is the normal state, not the exception: *"the trial found 104 of
127 sessions never closed and no reaper"* (`connector-core/src/state/capture-health.ts:24-25`), the hub reaps at
`SESSION_REAP_STALE_HOURS = 6` (`server/src/constants.ts:79`), and `services/records.ts:71-79` records that the reap over-fires
— *"an afternoon of reading and planning looks like a killed terminal"*. One abandoned session anywhere in fourteen days flips
the entire repo to `incomplete`, forever. Two consequences the first draft did not notice: 04's `UNATTRIBUTED` branch becomes
unreachable in practice, and §5.1's annotation fires on nearly every non-empty answer — which is the exact outcome §5.1 cites to
justify **not** annotating on `unknown` (*"a caveat on every answer is the noise that teaches people to ignore caveats"*).

**The fix is granularity, not softening.** A gap is a gap; what was wrong is that the gap was measured about something other
than the question. `readCoverage(deps, repo, scope?)` takes an optional `CoverageScope`:

- `sinceIso` — the caller's relevant range, clamped to `COVERAGE_SESSION_WINDOW_DAYS` as a ceiling. A pin-lane verdict passes
  `pins.verified_at_commit`'s timestamp; a search passes its result window; the briefing and doctor pass nothing and get the
  repo-wide answer exactly as today.
- `paths` — where the question is about a surface (04 passes the pin's `pin_files.path` set). `agent_event` then counts only
  sessions with a `work_context_targets` row on one of those paths, and `git` only findings touching them.

An unscoped call is unchanged, so nothing that reads coverage today changes meaning. A scoped call asks *"were we watching the
thing you asked about"*, which is what principle 1 actually says. **No state is softened:** a reaped session that touched the
scope is still `incomplete`, and the reason enum still names it.

**And the distribution is measured before merge, not argued about** — COV-11. If `complete` proves unreachable even scoped, §5.1
and §10.4 are re-decided **with data**, not by the noise argument, whose premise this section inverts.

**`git`** comes from rows `listAbsences` already reads (`absences.ts:126-156`) plus one `max(collected_at)`:

| state | predicate | `gapSince` |
|---|---|---|
| `complete` | newest `collected_at` within `ABSENCE_EVIDENCE_MAX_AGE_DAYS` (7) **and** zero findings | null |
| `incomplete` | evidence fresh but ≥1 finding, **or** newest `collected_at` past the window | earliest non-null `lastSessionAt`, else earliest `latestCommitAt` |
| `unknown` | no `commit_evidence` row for this repo at all | null |

`collectCommitEvidence` runs **only at SessionStart** (00 §4.3), which is why a stale `collected_at` is
`incomplete` rather than ignorable. **`ci` = `unavailable` / `no_emitter`** — nothing on main emits CI
results (00 §8.2); 05 creates this source, §8 refusal 2 states the flip, and AT-10's *"no silent absence, no
fake pass"* is why this is a named refusal in doctor rather than an omitted row. **`runtime` = `unavailable`
/ `out_of_scope_1_0`** — nothing exists, runtime invariant mining is Tier 3.

**`human_edit` = `unavailable` / `no_platform_rung`.** 00 §8.2 names `work_context_targets.source =
"tool_edit"` as the closest signal; it is not close enough. `tool_edit` records the **agent's** edit tool,
and a human typing in vim with no session running fires no hook on any platform we support, so the rung
cannot exist. The git-touch lane (`crosscheck-pins:connector-core/src/flows/capture-git-touches.ts:80-92`)
is mtime-filtered to the *session* window and not attributed to a person; calling it `human_edit` would be
the `coverage = 87%` lie in another shape. Human edits surface through `git`, via the `inactive` finding
(`absences.ts:30`).

### 3.3 `CoverageReason` — an enum, because prose here would be untrusted

`sessions_reported` · `session_reaped` · `session_silent` · `no_session_in_window` · `commits_reported` ·
`commit_authors_unreported` · `evidence_stale` · `no_commit_evidence` · `no_emitter` · `out_of_scope_1_0` ·
`no_platform_rung` · `hub_did_not_report`. Four more are **reserved for 05 and dormant until it lands** —
`ci_lanes_reported` · `ci_lanes_missing` · `ci_awaiting_rerun` · `ci_not_reported_yet` — added here because
05 §9.1 requests rather than mints them and a second coverage enum is exactly the drift 00 §9.6 forbids.
Consequence for §5: **a coverage line contains no author-written string** — enum values, ISO timestamps,
integers, renderer-owned literals — so it adds no untrusted slot to any surface it lands on.

### 3.4 AT-1's sentence, and the half not buildable yet

AT-1 requires *"nothing in what was observed — coverage incomplete for commits A..F since Friday 08:13."*
**The qualifier is buildable today**, bounded by `MAX_COVERAGE_LINE_CHARS = 160`, one line, no names, no
emails (`absences.ts:34` — never an email):

```
Coverage incomplete: agent sessions on this repo went quiet 2026-09-05T08:13Z
(1 reaped); git evidence names 2 commit authors with no reported session.
```

**The commit range is not, and — corrected 2026-09-14 — it is not coming in 1.0 either.** `commit_evidence` stores
`commit_count` and `latest_commit_at` per `(repo, author_email)` and no hash (`schema.ts:384-399`), so there is no list of
commits to name. The first draft shipped `commitRange: CommitRange | null`, **null until the claim-binding spec's commit table
lands**, and sequenced AT-1's full sentence behind it. **02 refused that table.** 02 §3.4: *"Refused: a `commits` table … hashes
ride the bounded per-claim row"* — ≤ `MAX_CLAIM_TOUCHING_COMMITS = 5` hashes, scoped to **one claim's own surface**. A per-claim,
five-deep, surface-scoped list cannot answer a repo-wide *"coverage incomplete for commits A..F"*: different subject, different
scope, different bound.

> **AT-1's example sentence names commits, and 1.0 cannot name them.** The qualifier this spec ships is the timestamp and the
> author count; the commit range is **refused for 1.0**, in doctor, by name.

So `commitRange` is **removed from `CoverageSourceRecord`** rather than shipped null. A field that is null on every row for every
1.0 release is precisely the silent absence AT-10 forbids — worse than an absence, because a reader seeing the field concludes
the range is sometimes populated. `CommitRange` as a type was defined by no spec in the set; it is not minted here. COV-5's
doctor ladder gains a fourth PASS line:

```
coverage range — not in 1.0: commit_evidence is an aggregate with no hash column
  and 02 §3.4 refuses a commits table. The qualifier names the time and the
  author count; it never names commits.
```

Restoring it later is a table, a migration and a renderer change together — stated so nobody plans on a data-only flip (§10.6).

### 3.5 Wire

`coverage` is a sibling field on responses that exist; no new endpoint. `GET /api/absences`
(`routes/absences.ts:30`, today `ok(c, { absences })`), `/api/search` (`routes/search.ts:172`),
`/api/hints/candidates` (`routes/hints.ts:76`), `/api/hints/tripwire` (`:93`),
`/api/work-contexts/:id/diagnosis` (`routes/work-contexts.ts:64`) and — **added 2026-09-14** —
**`GET /api/suspect`** (`crosscheck-pins:server/src/routes/suspect.ts`) each gain it.

**Why suspect was missing and why it cannot be.** The first draft named five responses and omitted #50's route, while 04 §5
renders this spec's record on exactly that response: its verdict block, its `coverage_gap` basis and its *"an absent one becomes
`UNKNOWN_COVERAGE`"* rule all assume the field is there. 03 refusal 8 hands `suspect-render.ts:191` here in the first place, and
COV-9's registry walk would flag that module as an answer surface with no coverage input. It is the surface where an unqualified
answer costs the most — a name — so it is the last one that may be left off the list. **04 passes the pin's file set as the
`CoverageScope`** (§3.2a), so the gap it reads is a gap about the pinned surface.

## 4. Migration

**No table, no index, no `bootstrap.sql` change, no `ddl-sync.test.ts` change.** No existing row is
redefined. What *is* redefined is the meaning of a missing field, and it inverts the tree's tolerant-parse
convention: `SearchOutcome.filters` is `null` from an older hub and *"then nothing is claimed"*
(`connector-core/src/http/hub.ts:824`), so the renderer prints no filter line. For coverage, printing
nothing is the failure:

> **Absent coverage is `unknown`, never silence and never `complete`.** A response with no
> `coverage` block, or one that fails to parse, becomes `UNKNOWN_COVERAGE` — five rows, all
> `unknown`, reason `hub_did_not_report`.

The hub is the only authority; the connector does not substitute its own knowledge of which emitters exist.
`getAbsences` (`http/hub.ts:331-339`) changes from `tolerantList("absences", …)` to a transform returning `{
absences, coverage }`, a precedent one screen away.

## 5. Where it renders, and the contract

### 5.1 The contract — AT-1 and AT-9, as code

**The empty-result rule (hard) — AT-1.** No surface may emit an empty-result phrasing while `agent_event` or
`git` is anything but `complete` — `unknown` included. This is **stricter than AT-1's own "fails if"**,
which speaks only of an existing absence; a fresh or unreachable hub is covered too, on purpose. Binding on
`mcp/render.ts:1139-1161` (`noMatchLine`), the diagnosis empty branch (`:852`), `NO_TARGETS` (`:613`), the
hint and tripwire silent paths, and `crosscheck status`.

**The annotation rule (soft) — AT-9.** On a **non-empty** answer the note renders when a source is
`incomplete` — a positively observed gap — and not on `unknown`, the ordinary state of a fresh install; a
caveat on every answer is the noise that teaches people to ignore caveats, which is `checkAbsences`'
reasoning (`cli/src/cli/doctor.ts:1311-1312`: *"a warning nobody can act on teaches people to ignore
doctor"*). **This is the one place this spec bends an AT, and it is flagged, not hidden:** a strict AT-9
reading would annotate on `unknown` too. `unknown` still reaches `doctor` and `crosscheck status` every
time, so no state is invisible (§10.4).

**The honest caveat on that argument, added 2026-09-14.** The noise reasoning assumes `incomplete` is
occasional. Unscoped, over a whole repo and a whole window, **it is not** — 104 of 127 trial sessions never
closed (`state/capture-health.ts:24-25`), so the note would fire on nearly every answer and the rule would
be self-defeating in exactly the way it was written to prevent. §3.2a's scope is the structural answer, and
**COV-11 measures the resulting distribution before merge**. If `complete` is still unreachable when
scoped, §5.1 and §10.4 are re-decided on that measurement rather than on this paragraph.

**Never blocks** (non-negotiable #1): no row is withheld, no call refused, no tool errors. **Phrasing
inherits `absences.ts:88-99` verbatim** — a factual observation, never an inference about what somebody did.
*"We see agent sessions, not keystrokes."*

### 5.2 Registry and corpus obligations — decided

**One new module, `packages/connector-core/src/coverage/render.ts`**, exporting `coverageNote(record, now):
string | null` and `coverageClause(record, now): string`, **registered as one `kind: "composite"` surface**
(`render-surfaces.ts:122-130`), not corpus: `name: "coverage-note"`, `delivery: "unsolicited"`, `module:
"src/coverage/render.ts"`, `corpusCoveredBy: ["test/coverage-render.test.ts"]`, and a `note` pointing at
§3.3 for why no corpus payload has a slot here. That `note` must not contain the phrase `"corpus-covered"`,
banned at `render-surfaces.ts:115-119` because `corpusCoveredBy` is machine-checked and prose is not. It is
`unsolicited` even though the same text lands on `pulled` surfaces: one module, one classification,
`test/anchoring-separation.test.ts` walks the field, and the **tighter** of the two is safe.

**Three closure obligations easy to miss.** A registered surface whose `render` closure never builds a
coverage record leaves the clause **unattacked while the registry still counts the surface**:
`search-results-empty-filtered` (`render-surfaces.ts:817-840`) exists *only* to attack the empty branch
`search-results` cannot reach, and `cli-doctor` (`crosscheck-pins:cli/src/render-surfaces.ts:178`) and
`cli-status` (`:192`) already exist — 3 CLI surfaces on main, 6 with #50. **No new CLI surface is
registered;** the coverage lines land inside those two closures, and all three closures gain a fixed
`incomplete` record (`COV-7`). No change to `RENDER_LAYER_MODULES` / `RENDER_BARREL_MODULES`
(`render-surfaces.ts:138-155`): this is a surface, not a primitive.

### 5.3 Placement in the briefing

**One line, first, above contradictions, never cut.** The briefing orders contradictions → solved → drafts →
absences (`briefing/render.ts:450-453`, `:685-688`, `:745-749`) under `MAX_BRIEFING_CHARS = 2200`
(`connector-core/src/constants.ts:387`). Coverage is not another finding competing in that order: it states
how far everything below it can be trusted, and **a caveat that can be cut is a caveat that lies.** At 160
chars it costs ≤7.3% of the budget; `MAX_ABSENCE_LINES = 3` (`constants.ts:613`) is unchanged. This answers
00 §10 Q8 **for my line only**; `INDETERMINATE`'s place in that cut is the verdict spec's.

## 6. Budget

**Zero new hub round trips on any hook path.** The 800 ms rule (`connector-core/src/constants.ts:56-57`,
`PRINTS: 800 800`) is untouched because nothing new is requested.

- **SessionStart (1000 ms).** Coverage rides inside `GET /api/absences`, already in `assembleBriefing`'s
  parallel block of eight (`flows/briefing.ts:120-130`). A ninth parallel GET would look free in wall clock
  and is not: PGlite is *"an embedded single-connection WASM database"* (`services/search.ts:60-62`), so
  parallel GETs serialise on the hub. Riding an existing response costs one indexed aggregate over
  `agent_sessions` (`schema.ts:148-158`) and one `max(collected_at)` over rows `listAbsences` reads anyway.
- **UserPromptSubmit / PreToolUse (800 ms each).** Coverage rides inside the existing hint and tripwire
  responses — bytes, not a round trip. `MAX_HINTS_PER_PROMPT = 1` (`constants.ts:84`) is untouched: the note
  is not a hint and does not take the slot, which matters because 00 §10 Q6 already has `PROTECTED_CONFLICT`
  competing for it.
- **Stop** untouched (#50 already spends its spare budget on the git lane); **MCP** tools are not on a
  hook path; **hub job cost none** — no background pass, no reaper change, no retention.

**Measurement refusal.** I have run no benchmark, so this spec states no millisecond figure for the added
query; `COV-8` requires one before merge, on the existing harness
(`connector-claude/test/capture-latency.test.ts`).

## 7. Acceptance tests

Each names the AT it discharges and the mutation that must turn its guard red in
`connector-core/scripts/mutation-check.ts` (00 §7.2). Counts are `VERIFY:` directives, not prose.

**COV-1 — an empty answer may not stand alone over a gap. (AT-1)** One reaped session with
`last_heartbeat_at = 2026-09-05T08:13Z` and a query matching nothing: the output must not carry the bare
sentence at `mcp/render.ts:1157`, and must carry `2026-09-05T08:13Z`. *Fails if* the unqualified sentence is
emitted — AT-1's own "fails if". *Mutation:* delete the clause from `noMatchLine`.

**COV-2 — five rows, no scalar.** `readCoverage` returns exactly five records in `COVERAGE_SOURCES` order.
*Fails if* one is dropped or an aggregate appears. *Mutation:* `sources.filter(s => s.state !==
"unavailable")`, with a `VERIFY:` re-deriving the count.

**COV-3 — absent coverage is `unknown`. (AT-1)** A body with no `coverage` key yields five `unknown` /
`hub_did_not_report` and COV-1's rule still fires. *Fails if* the fallback is `complete` or the note
suppressed. *Mutation:* default it to `complete`.

**COV-4 — a reaped end is not a clean end.** Two sessions identical but for `reaped_at`: reported →
`complete`, reaped → `incomplete` with `gapSince = last_heartbeat_at`. *Fails if* a reap reads as an end.
*Mutation:* drop `reaped_at IS NULL`.

**COV-5 — three rungs refuse, and doctor says so. (AT-10's refusal clause)** `ci`, `runtime`, `human_edit`
are `unavailable` with their named reasons and doctor prints one PASS line each naming the missing rung.
*Fails if* any is omitted, or read `unknown` (a rung that cannot exist must not read as one that might) or
`complete`. *Mutation:* map `ci` → `unknown`. **When 05 lands it splits** (05 §9.1): `runtime` and
`human_edit` stay unconditional, `ci` turns conditional on a repo having a reporter.

**COV-6 — no percentage reaches any surface.** No registered surface's output for a coverage-bearing fixture
carries a `%` in the coverage line, and `CoverageRecord` exposes no numeric aggregate. *Mutation:* add an
`overall` ratio and print it. *Fails if* either appears.

**COV-7 — the empty and CLI branches are corpus-attacked with coverage present.** The
`search-results-empty-filtered`, `cli-doctor` and `cli-status` closures each pass a coverage record. *Fails
if* any omits it — the clause would be unattacked while the registry still counts the surface.

**COV-8 — the budget is measured, not asserted.** SessionStart p95 on `capture-latency.test.ts` with
coverage riding `/api/absences`, against the pre-change baseline and a named allowance. *Fails if* absent.

**COV-9 — the qualifier reaches every answer surface, not only doctor. (AT-9)** A registry-walking test:
every module rendering an answer about what the team knows either consumes a `CoverageRecord` or appears in
a literal `COVERAGE_EXEMPT_SURFACES` list with a one-line reason. *Fails if* a surface can answer without
coverage and without an explicit exemption — AT-9's "fails if", mechanised the way
`test/render-surface-registry.test.ts:25-28` mechanises non-negotiable #2. *Mutation:* add such a surface
**without touching the exempt list**; it must go red.

**The exempt list is bounded, counted and printed — otherwise COV-9 ships with an escape hatch wider than
the rule.** The first draft's mutation was *"add such a surface; it must go red"*, and the same author could
add the surface to `COVERAGE_EXEMPT_SURFACES` in the same edit and keep the build green; nothing pinned the
list's length, named its members anywhere a human looks, or capped it. That is weaker than the precedent
this spec cites — `corpusCoveredBy` is machine-checked and the phrase *"corpus-covered"* is banned from a
`note` precisely because a prose claim of coverage is not a claim
(`connector-core/src/render-surfaces.ts:115-119`) — and weaker than COV-5 one section up, which forces every
refused rung to be a printed doctor line. So:

1. **The length is a `VERIFY:` / `PRINTS:` directive** at the list, re-derived from the data (00 §7.1), so
   growing it is as visible in a diff as bumping the mutation count.
2. **Doctor prints one line per exempt surface with its reason**, on the COV-5 ladder — an exemption a
   person can read is an exemption somebody will argue with; one nobody sees is a silent absence (AT-10).
3. **`COVERAGE_EXEMPT_SURFACES_MAX = 3`**, minted here under the corpora floor rule (00 §6.2) and **never
   raised to make a case pass**. Three, because the honest exemptions are few and specific and a fourth
   should cost an argument.

*Second mutation:* raise the cap or delete the directive; COV-9 must go red.

**COV-10 — `isJudgeable` is false under any known gap, across ALL FIVE sources. (AT-5, my half)** Three
cases, because the first draft tested one: (a) over all 16 combinations of `agent_event` × `git` it is true
for exactly one — both `complete`; (b) with `agent_event` and `git` both `complete`, **each** of `ci`,
`runtime` and `human_edit` set to `incomplete` in turn makes it **false**; (c) those same three at
`unavailable` or `unknown` leave it **true**, because a rung that cannot exist and a rung nobody reports are
not known gaps and treating them as such makes every verdict `INDETERMINATE` for ever. *Fails if* (b)
returns true — that is AT-5's "fails if" reachable through 04's `no_touch` → `UNATTRIBUTED` row the moment
05 lands — or if (c) returns false. *Mutations:* drop the `sources.every(s => s.state !== "incomplete")`
term; and widen it to `s.state === "complete"`. **The other half of AT-5 is not mine:** that the verdict
spec's `UNATTRIBUTED` path calls this rather than recomputing it is that spec's test (§9).

**COV-11 — the state distribution is measured before merge, not assumed. (AT-5 / AT-9)** Against a fixture
shaped like the measured trial — 127 sessions, 104 never closed (`state/capture-health.ts:24-25`), reaped
under `SESSION_REAP_STALE_HOURS = 6` — the test records what fraction of answers reach `agent_event:
complete` **unscoped** and **scoped to a pin's file set** (§3.2a), and prints both. *Fails if* no
measurement exists. It asserts no threshold: its job is to make §5.1's noise argument and §10.4's default
decidable on data. Without it this spec cannot tell whether it has shipped an always-on caveat and an
unreachable `UNATTRIBUTED`, which is the state the first draft was in.

## 8. Refusals

1. **No commit list in 1.0, at all** (§3.4). Not "null until the claim-binding spec lands commit identity"
   — **02 §3.4 refuses the `commits` table**, and what it ships instead is ≤5 hashes per claim scoped to
   that claim's own surface, which cannot answer a repo-wide range. `commitRange` is therefore **removed
   from the record**, not shipped null, and doctor prints the refusal by name. AT-1's example sentence
   names commits; the sentence 1.0 ships names the time and the author count. No surface fabricates a
   range, and none has a field that looks like it might one day hold one.
2. **`ci` is `unavailable` and stays so** until 05's emitter, route, `requireCiToken` (00 §9.6) and
   `app.ts` mount exist. Flip condition exactly: `readCoverage` reports `ci` from data only when
   `readCiCoverage` (00 §8.2b) is callable; until then doctor says *"no CI connector reports to this hub"*.
3. **`runtime` is `unavailable`, permanently for 1.0** — Tier 3. **`human_edit` is `unavailable`**
   (§3.2): no hook fires on a human keystroke. **No stored coverage on a read path** (§3.2; one bounded
   exception, §9).
4. **No per-developer coverage** — per repo, per source. A per-developer figure is a dashboard the scale
   rule forbids, and `crosscheck-pins:server/src/services/suspect.ts:21-25` fixed the shape: *"SESSIONS AND
   INTENTS, NEVER PEOPLE."*
5. **This spec does not judge**, and does not redefine `suspect`. It owns `CoverageRecord` and
   `isJudgeable`; the `ATTRIBUTED / UNATTRIBUTED / INDETERMINATE` mapping is the verdict spec's, as is
   #50's closed outcome enum (`ranked | no_separation | no_touch | withheld`,
   `crosscheck-pins:server/src/services/suspect.ts:81-87`) — `no_touch` is subject to §5.1's empty-result
   rule, but who applies it there is that spec's call. **No `PROTECTED_CONFLICT` channel** (00 §10 Q6) and
   **nothing on `conference`** (Tier 3).
6. **Coverage never gates a merge.** `00-cut-line.md` decision B recommends gating only on human-declared
   invariants whose own verification ran and failed, *"never on anything derived"* — and every value in
   `CoverageRecord` is derived. The note is informational on every surface including CI, and non-negotiable
   #1 makes that unconditional.
7. **Proof 5 is instrumented, not scored** — a per-repo count of answers rendered under each state; no
   per-developer breakdown, no ratio on a surface (COV-6), no calibration UI (Tier 3). **I have measured
   nothing; there is no baseline in this document.**
8. **#49's `emailsTruncated` blind spot is named, not modelled.** A member whose aliases were hidden is
   attributed `unconnected` (`crosscheck-dev-listing:server/src/services/developers.ts:141-146,:267`),
   making `git` read `incomplete` for a reason that is an artefact; modelling it needs a hub-side "the alias
   set is truncated" fact that does not exist. Refused for 1.0, listed so it is not mistaken for an
   oversight.

## 9. Collisions and sequencing

**Write after #50 and #49 both merge** (00 §9.3). #50 is being actively fixed — re-read `crosscheck-pins`
before citing a line number from it.

**`.github/workflows/ci.yml` — binding on every writer (00 §9.2).** This spec adds `MUTATIONS` entries (§7),
so it bumps the guard count at **`ci.yml:119-120`** — **corrected**: the `VERIFY:` directive is at `:119`
and its `PRINTS:` at `:120`, measured identically on all three branches; `:117-118` was an error this spec
inherited from an earlier draft of the map and 05 §9.5 caught it first. The map is corrected too. **Three
listings, not two**: the count (`:119`), the per-file block (`:127`) and the per-basename block (`:246` on
`crosscheck-pins`, `:239` on main). New per-file lines for `services/coverage.ts` and
`connector-core/src/coverage/render.ts`; in the per-**basename** listing `coverage.ts` is new but
**`render.ts` is a BUMP, not a new line** — that block keys on the basename and `render.ts` already stands
at 26 (`crosscheck-pins:.github/workflows/ci.yml:312`). An earlier draft of this line said it *adds* a
per-basename line for `coverage/render.ts`; it does not. **It deliberately writes no post-merge total**, not
knowing how many specs land first: main is 298, #50 is 308, #49 is 304 — all three re-verified — and the
writer re-derives on the merged tree.

**PR #50 — one word, two meanings.** `GitTouchesOutcome.unavailable`
(`crosscheck-pins:connector-core/src/flows/capture-git-touches.ts:83-88`) means *"git DID NOT ANSWER — a
deadline, no repository, no binary"*, which maps to coverage **`unknown`** — not coverage `unavailable`,
*"the rung cannot exist"*. Exactly one place may translate between them: the mapper in
`services/coverage.ts`, carrying that sentence as a comment and a mutation anchor. Left implicit it is a
guaranteed future bug.

**PR #50 — `git-lane-cost.ts`** (`skipped` / `ran`, 117 lines) is the connector-side twin of my hub-side
`git` source and they must never disagree in doctor: my check reads the hub record, #50's `checkGitLane`
(`crosscheck-pins:cli/src/cli/doctor.ts:1660`) reads session state — adopt #50's ladder exactly, *not
measured* a PASS and *could not reach* a WARN. **`cli/src/render-surfaces.ts` is NOT free ground** (00
§0.2): 3 → 6 surfaces, and correcting this spec's earlier draft I register **no new CLI surface** (§5.2).
**Free ground confirmed** (00 §9.5): every hub service and renderer this spec edits.

**Divergences with 02 and 07, both answered.** 02's validity clause renders on `unknown` too (02 §9) —
**accepted**: §5.1 governs the *coverage note*, whose subject is the repo's archive, while 02's clause is
about one row's own currency; coverage first, validity second where both land. 07 asks 03's owner whether
`pilot_sessions.coverage` may store the five triples (07 §9) — **yes**: proof 5 cannot be recomputed once a
reap is revived, and refusal 3 forbids stored coverage *on a read path*, which this is not. It holds only
while all four of 07's bounds do — ≤50 sessions per enrolled repo, never read by an answer surface, never a
fallback for `readCoverage`, labelled `as observed`.

**Shared files.** `server/src/constants.ts` — a `COVERAGE_*` block at the tail, after the `SUSPECT_*`
block (#50) and `DEVELOPERS_MAX_LISTED` (#49), with a `VERIFY:` pinning `COVERAGE_SESSION_WINDOW_DAYS
=== SUSPECT_WINDOW_DAYS` so the two windows cannot drift (00 §10 Q10). `connector-core/src/constants.ts` —
`MAX_COVERAGE_LINE_CHARS = 160` appended below #50's block. `mutation-check.ts` — **editor 3**, the first
spec after both PRs (00 §9.7 puts 03 first). All eight specs append to that array tail, so all eight
conflict there; "third editor" is a seat 05 §9.6 and 06 §9 had each claimed as well, which was the evidence
that none of the three had sequenced against the others on this file. Editor 3 is this spec's, by order.

**Other 1.0 specs.** *Event model (Q2, `seq`)*: **no dependency either way** — coverage is derived from
tables, not the event stream, so it can land before `seq` is decided and a later `coverage.observed` kind
would be additive. *Claim binding (02)*: **it refused the commits table** (02 §3.4), so the range is not deferred, it is out
of 1.0, and `commitRange` is removed rather than shipped null (§3.4, refusal 1). Nothing is sequenced behind
02 here any more. *Verdict / fence (04)*: consumes `isJudgeable`, must not recompute it, owns the half of
AT-5 COV-10 cannot reach; it also **renders this record on `GET /api/suspect`**, which §3.5 now lists and
the first draft did not, and it passes the pin's file set as a `CoverageScope` (§3.2a). *CI ingestion (05)*:
owns the flip in refusal 2 and the COV-5 split; **sequence 03 first** (05 §9.1) — and `isJudgeable`'s third
term (§3.1) is what keeps 05 §2's *"must reach `INDETERMINATE`, not `UNATTRIBUTED`"* true once `ci` exists.
**Build order: 03 is first of the eight** (00 §9.7), because it owns `CoverageReason`, the COV-5 shape 05
must edit, and the predicate 04 and 07 both consume. *Briefing
ordering (Q8)*: honour §5.3. Whichever spec touches `noMatchLine`, `NO_TARGETS` or the diagnosis empty
branch inherits the empty-result rule; §5.1 is the single list.

## 10. Decisions for Nick

1. **Coverage rides inside `GET /api/absences`, or its own `GET /api/coverage`?** *Default: inside
   absences.* PGlite is single-connection (`search.ts:60-62`), so a ninth parallel GET at SessionStart
   serialises inside the 1000 ms budget. Cost: the endpoint named "absences" returns coverage too, and its
   client type stops being a bare list.
2. **Briefing line first and uncuttable, or last and cuttable?** *Default: first, uncuttable, ≤160 chars*
   (§5.3). Cost: ≤7.3% of `MAX_BRIEFING_CHARS` on every SessionStart.
3. **`human_edit` = `unavailable`, or `incomplete` proxied by #50's git-touch lane?** *Default:
   `unavailable`.* The proxy would attribute worktree changes nobody can attribute.
4. **On a non-empty answer, annotate on `incomplete` only, or on `unknown` too?** *Default: `incomplete`
   only* — the one place this spec bends an AT (§5.1). A strict AT-9 reading annotates `unknown` too; the
   cost is a caveat on every answer of every fresh install, which is how caveats get ignored.
5. **Does the empty-result rule fire against an old hub reporting no coverage at all?** *Default: yes.*
   Every empty search on an un-upgraded hub carries a sentence until it is upgraded; accepting that noise is
   the point, and the alternative is the exact lie this spec exists to stop.
6. **`commitRange` — RE-DECIDED, because its premise died.** The first draft offered "ship it null until
   commit identity exists", on the reading that 02 would land a commits table. **02 refused the table**
   (§3.4), so the field would be null on every row of every 1.0 release — not "if the table slips", but by
   design. *Default now: drop the field, print the refusal in doctor* (§3.4, refusal 1). A permanently null
   field is worse than an absent one: a reader who sees it concludes a range is sometimes there. Cost: AT-1's
   full example sentence is unreachable in 1.0 and restoring it later costs a table, a migration and a
   renderer change together, not a data flip. Saying no — keeping the null field — buys a promise the set
   cannot keep.
