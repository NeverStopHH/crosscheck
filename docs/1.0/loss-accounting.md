# 03a — Loss accounting: every known loss of telemetry reaches Coverage

**Tier 1, extension of 03.** 03 built the record that says *whether the hub was watching*; this note closes the
gap between that record and the places telemetry is actually lost. It owns no new AT. It discharges principle 5
(*"Missing evidence may weaken a conclusion. It must never strengthen one"*) for the capture pipeline, where today
a lost record makes an answer look **more** complete rather than less. Baseline `main@7a070b8`; paths repo-relative
under `packages/`. Two sentences from Nick are the contract, and every decision below is measured against them:

> **Unsupported telemetry may be ignored functionally, but never invisibly.**
>
> **Every known loss of relevant telemetry must produce a machine-readable coverage reason, or an explicit
> proof that the lost telemetry cannot affect the judgment.**

## 1. Problem

**The connector counts most of what it loses, and the hub's coverage knows none of it.** On Nick's own machine
`crosscheck doctor` prints *"382 records discarded in 343 batches"* and *"1 session end expired undelivered"*
(`cli/src/cli/doctor.ts:1281`, `:1303`), and `GET /api/absences` for the same repo answers `agent_event:
complete / sessions_reported`, because `readAgentEventCoverage` reads two columns of `agent_sessions` —
`reaped_at` and `last_heartbeat_at` (`server/src/services/coverage.ts:354-403`) — and nothing on the wire carries
a loss. `isJudgeable` (`:526-529`) then returns true over a repo whose connector has admitted, in writing, that it
did not deliver 382 records. That is AT-5's *"unattributed is reachable with a known coverage gap"* reached through
the spool rather than through a reap.

**One loss is invisible even to the connector.** Ingest answers four counts — `accepted`, `duplicates`, `ignored`,
`rejected` (`server/src/services/records.ts:53-59`, `:401-407`) — and `ignored` is what an older hub says about a
record kind it does not know (`:313-316`, the forward-compatibility rule) or a kind it never ingests over this
route (`:318-321`). The flush reads `rejected` alone (`connector-core/src/spool/flush.ts:114`) and moves the cursor
past the batch (`:143`), so a newer connector talking to an older hub loses whole record kinds with `spool drops:
none`. Review finding B2-01/B2-07 closed exactly this hole for `rejected` (`spool/drops.ts:53-63`) and left the
sibling count unread.

**Several losses are not counted anywhere.** A tool call that touches more than `MAX_TARGETS_PER_INVOCATION`
paths drops the rest with a `break` (`flows/capture-targets.ts:95-97`); the Stop-time git lane goes through the
same cap, after its own bound `MAX_GIT_TOUCH_CANDIDATES` (`capture-git-touches.ts`). A path the secret scan refuses is a `continue` (`:113`). A hook that exceeds its
budget resolves to `""` (`config/hook-budget.ts:58-70`) and the binary calls `process.exit` on that string
(`cli/src/bin/crosscheck.ts:42-44`, `:56`), abandoning whatever the handler had not yet written — an append cut
mid-write becomes a counted torn line, an append not yet started becomes nothing. The ACP engine skips wire lines
the observer could not parse and lines past its pending-bytes cap (`connector-acp/src/capture/engine.ts:1215-1222`)
into two in-memory counters that reach a log line at exit and no ledger. The Cursor runner books a payload that
lacks a field capture needs into a drift ledger (`connector-cursor/src/runner.ts:196-219`, `src/drift.ts:33-57`)
and captures nothing from it.

## 2. Principles served

> **Principle 1 — "Only judge when you know you were watching."** A connector that reports a loss has told the
> hub it was *not* watching, for the records it lost. The hub must read that as it reads a reap.

> **Principle 5 — the operational form.** *Ambiguous or unmatched closure can only reduce certainty.* Every rule
> below is checked in one direction: a loss report can move `agent_event` to `incomplete` and can never move it
> away; an unreadable report reads as *unknown*, never as zero; a report whose kind the hub cannot read still
> counts (§4.5).

> **Non-negotiable #4 — fail, never silently.** The `ignored` count is the purest instance in the tree: a 200, a
> cursor move, and a record kind gone. §4.3 makes it a ledger line, §5 a doctor line, §4.4 a hub column, §4.6 a
> coverage sentence.

## 3. Inventory — every place telemetry can be lost between a hook firing and a row the hub judges with

Columns: **counted** (where the number lives today), **hub** (does the hub learn of it), **judgment** (can the
loss change a verdict, `suspect`, an absence, a hint, a solved match, or an empty "no prior work" answer), **fix**.

| # | path | where it happens | counted | hub | judgment | fix |
|---|---|---|---|---|---|---|
| 1 | spool append refused at `MAX_SPOOL_BYTES` | `spool/append.ts:90-92` | `.drops` `cap` | no | **yes** — any record kind | report → `telemetry_lost` (§4) |
| 2 | short write / write failed on append | `append.ts:99-103`; `reap.ts:208-218` (rescue) | `.drops` `short-write`, `write-failed` | no | yes | report → `telemetry_lost` |
| 3 | torn line counted at flush | `flush.ts:97`, `:121-128` | `.drops` `unparsable` | no | yes | report → `telemetry_lost` |
| 4 | undelivered records of a dead session past `MAX_SPOOL_AGE_DAYS` | `reap.ts:280-283` | `.drops` `expired` | no | yes | report → `telemetry_lost` |
| 5 | hub answered 200 and refused the record | `flush.ts:114`, `:129-138` | `.drops` `rejected` | the hub saw it and persisted nothing | yes | report → `telemetry_lost` |
| 6 | **hub answered 200 and ignored the record's kind** | `records.ts:313-321`; connector reads nothing (`flush.ts:114`) | **not counted** | the hub counted and forgot | yes — a whole kind, e.g. a newer connector's evidence kinds | **new** `.drops` `ignored` with the kinds, report → `record_kinds_ignored` |
| 7 | ledger append itself failed | `drops.ts:148-164` marker | `unrecorded.dropmarker` (last batch only, a floor) | no | yes | its count joins the report total; the report's `total` is a floor while the marker exists |
| 8 | paths past `MAX_TARGETS_PER_INVOCATION` in one call | `capture-targets.ts:95-97` | **not counted** | no | yes — a `file` target lost; the git lane is capped too, first at `MAX_GIT_TOUCH_CANDIDATES` (counted since review M5) | **new** `.drops` `capture-capped`, report → `telemetry_lost` |
| 9 | path refused by the secret scan | `capture-targets.ts:113` | **not counted** | no | yes — a pin can name the path | **new** `.drops` `secret-path`, report → `telemetry_lost` |
| 10 | edit whose path resolved to no root of this repo | `capture/touched-root.ts:161`, booked `state/capture-bookkeeping.ts:163` | session state `outsideRootDrops` | no | **yes, one residual shape**: a linked worktree of the same repo that carries no committed config (`session-state.ts:196-205`) is *this* repo's file | **new** `.drops` `outside-root` when the event was an edit, report → `telemetry_lost` |
| 11 | touch of a DIFFERENT connected repo (first-wins) | `touched-root.ts:159`, `capture-bookkeeping.ts:162` | session state `foreignRepoDrops`, machine-wide doctor/status line (`state/foreign-drops.ts`) | no | **no, for the bound repo** — proof §4.8.1 | stays local; cross-repo attribution refused (§8.3) |
| 12 | denylisted path | `capture-targets.ts:110`, `capture/denylist.ts` | not counted | no | not a loss — proof §4.8.2 | stays local; residual handed to 04 (§10.4) |
| 13 | seen-set skip / `MAX_SEEN_TARGETS` eviction | `capture-targets.ts:113`; `session-state.ts:1103-1108` | n/a | n/a | no — proof §4.8.3 | none |
| 14 | hook exceeded its budget | `hook-budget.ts:58-70`; `hooks/runner.ts:284-295`, `:313-315`; `bin/crosscheck.ts:42-44` | **not counted** | no | yes — PostToolUse's targets, Stop's git lane, PostToolUseFailure's fingerprint may not have been written | **new** loss ledger `hook_timed_out` (§4.3), report → `telemetry_lost` |
| 15 | session end deferred, then expired undelivered | `flows/end-session.ts:104-109`; `reap.ts:452-463`; `spool/unclosed.ts:95-110` | `unclosed.endsummary` | the hub never hears the end | **no** — proof §4.8.4 | stays local (doctor `unclosed sessions`) |
| 16 | seq refusals `allocation_failed`, `ambiguous_session_assignment`, `foreign_session_delivery` | `capture/seq.ts:37-60`; spec 01 §3.7 | session state (`state/seq-cost.ts`), hub `session_events.seq_reason` | yes — as a per-row order state | no — proof §4.8.5 | none; 01 owns it |
| 17 | tool window evicted / missed (a lost bracket) | `seq-cost.ts:59-100` | session state | yes — the row travels as an upper bound | no — proof §4.8.5 | none |
| 18 | ACP wire line unparseable / oversized / past the pending cap | `connector-acp/src/observer.ts:30-40`; `engine.ts:1215-1222` | in-memory counters → one log line at exit (`engine.ts:1278-1282`) | no | yes — an edit `tool_call` whose diff made the line oversized loses its `locations` | **new** loss ledger `wire_unobserved` at engine shutdown, report → `telemetry_lost` |
| 19 | Cursor payload lacking a mapped field (contract drift) | `connector-cursor/src/runner.ts:196`, `:208`, `:219`; `src/drift.ts` | drift ledger (machine-wide, field names) | no | yes — an `afterFileEdit` with no `file_path` captures nothing | **new** loss ledger `host_contract_drift`, report → `telemetry_lost` |
| 20 | hub: unstorable text | `schema/src/envelope.ts:147-150` | answered `rejected` | yes, transiently | yes | already #5 |
| 21 | hub: intent text fails the secret re-scan | `server/src/services/record-handlers.ts:462-467` | answered `rejected` | yes, transiently | yes | already #5 |
| 22 | hub: `batch_too_large` 422 | `server/src/routes/records.ts:36-43` | HTTP failure, records stay on disk | no | not yet — the batch is retried; `MAX_INGEST_BATCH` is mirrored (`connector-core/src/constants.ts:402-403`) | none; a drifted mirror ends in #4 |
| 23 | HTTP / network failure on flush, heartbeat, register, end | `flush.ts:105-107`; `flows/heartbeat.ts:40`; `flows/register-session.ts:137` | `FlushOutcome.failed`, `lastSyncAt` | silence → the hub reaps | no — proof §4.8.6 | none |
| 24 | derived text refused (summarizer / intent / ghost: secret, echo, empty, not-a-sentence) | `session-state.ts:385-400`, `summarizer*`, `intent*`, `ghost*` counters | session state, doctor per rung | no | no — proof §4.8.7 | none |
| 25 | hint deliveries, tripwire, landed notices lost in the spool | any of #1–#7 | with the spool | with the spool | informational — but every spool loss is reported regardless (the ledger keeps counts, not kinds, for #1–#5) | covered by #1–#7 |
| 26 | hub's `session` / `hint` kinds "not ingestable" | `records.ts:64-69` | answered `ignored` | — | no connector sends them | covered by #6 |

Rows 6, 8, 9, 10, 14, 18, 19 are the uncounted or unreported paths this note connects. Rows 11, 12, 13, 15, 16,
17, 23, 24 stay local, each with a proof in §4.8. Rows 1–5, 7 were counted and stop at doctor; they travel now.

## 4. Target model

### 4.1 The report — counts and kinds, nothing else

New module `packages/schema/src/telemetry-loss.ts`, importable by both sides (the same reason the secret scan
lives there, `connector-core/src/capture/secret-scan.ts:3-13`):

```ts
export const LOSS_KINDS = [
  "spool_refused",        // append refused: file at MAX_SPOOL_BYTES, a short write, a write that failed
  "spool_torn",           // a complete line on disk that is not JSON, counted at flush
  "spool_expired",        // undelivered records of a dead session past MAX_SPOOL_AGE_DAYS
  "spool_withheld",       // records of a life the hub had ended, held back and never sent (review-2)
  "hub_rejected",         // the hub answered 200 and refused the record
  "hub_ignored",          // the hub answered 200 and ignored the record's kind
  "capture_capped",       // paths past MAX_TARGETS_PER_INVOCATION in one tool call
  "capture_secret_path",  // a path the secret scan refused to spool
  "touch_outside_root",   // an edit whose path resolved to no root of this repo
  "hook_timed_out",       // hooks that exceeded their budget before capture could finish (hooks, not records)
  "host_contract_drift",  // host payloads that lacked a field capture needs (payloads, not records)
  "wire_unobserved",      // ACP wire lines the observer could not read (lines, not records)
  "unattributed",         // counted before the ledger kept reasons, or a kind this hub does not know
] as const;
export const MAX_LOSS_COUNT = 2_147_483_647;               // int4, the type of loss_total (review C1)
export const TelemetryLossReportSchema = z.object({
  total: z.number().int().min(0).max(MAX_LOSS_COUNT),       // >= the sum of `kinds`; a floor while a ledger append failed
  kinds: z.record(z.string(), z.number().int().min(0).max(MAX_LOSS_COUNT)), // folded to LOSS_KINDS by the HUB
  oldestAt: z.iso.datetime().nullable(),
  newestAt: z.iso.datetime().nullable(),
  ignoredNewestAt: z.iso.datetime().nullable().optional(),  // the newest hub_ignored loss (review M3)
});
```

The connector saturates every count at `MAX_LOSS_COUNT` and checks the final report against this schema before
sending (`toWireReport`): one that still fails is sent as at least one undated `unattributed` loss.

**No path, no record text, no record kind name crosses the wire.** The `ignored` ledger line keeps the record
kinds the hub ignored (`{"claim_revalidation": 377}`) because doctor needs them to say *what* to upgrade for; they
are the connector's own `KNOWN_RECORD_KINDS`, validated against `/^[a-z][a-z0-9_]{0,40}$/` before they are
counted, and they stay on the machine. The hub gets `hub_ignored: 377`.

**`total` is a floor, and the report says nothing else about precision.** The `unrecorded.dropmarker` records
one batch — the most recent whose ledger append failed (`drops.ts:129-136`) — so `total` adds its count and
doctor keeps printing *"the total is a lower bound"*. Under-reporting a loss is the one direction a loss report
must not fail in; the marker's arithmetic is unchanged.

### 4.2 The channel — session register, heartbeat and end carry the report

`losses` is an optional field on the three session bodies: `RegisterSessionBodySchema` and
`SessionStatusBodySchema` (`server/src/http/schemas.ts:28-41`), and the three client calls that post them
(`connector-core/src/http/hub.ts:213-255`). The flows every host shares read one report and attach it:
`flows/register-session.ts:137`, `flows/heartbeat.ts:40`, `flows/end-session.ts:110`. Every new connector sends
it on every call, **zeros included** — an all-zero report is a statement, an absent one is not (§4.7).

**Why not a record kind, though the task allowed one.** Three reasons, each sufficient:

1. **The spool is one of the things that loses records.** A report that travels the spool is refused with the
   batch it describes at `MAX_SPOOL_BYTES` (#1) and expires with it (#4). The loss of a loss report is the
   silent failure this note exists to end.
2. **An older hub answers a new kind with `ignored` and a 200** (`records.ts:313-316`). The report would be
   discarded by the exact mechanism it exists to reveal, and the connector would need the session channel anyway
   to learn that it had been. Zod strips an unknown body field with a 200 too — verified rather than assumed,
   because `schemas.ts:15-19` calls these objects *strict*:

   VERIFY: cd packages/schema && bun -e 'import {z} from "zod"; console.log(JSON.stringify(z.object({a:z.string()}).safeParse({a:"x",extra:1})))'
   PRINTS: {"success":true,"data":{"a":"x"}}

   So neither channel can *ack* through an old hub. The difference is that the session channel needs no new
   round trip and no spool, and §5.2's doctor cross-check names the skew from data both sides already hold.
3. **Zero new hub round trips on any hook path** (03 §6's discipline). The heartbeat is throttled to one per
   `HEARTBEAT_MIN_INTERVAL_MS = 20_000` (`constants.ts:233`) and fires from every host through one flow
   (`flows/heartbeat.ts:1-15`: Claude, Cursor, ACP); registration is the call that runs right after `reapSpool`,
   which is where expiry (#4) and the unclosed count (#15) are written — so a dead session's post-mortem losses
   are reported by the next session on the machine; the end carries the final state.

**What each call costs.** The report is a local read: `readdir` of the repo's spool directory, the `.drops`
files still present (a ledger is folded into the archive once its newest entry is older than
`MAX_SPOOL_AGE_DAYS`, `reap.ts:299-326`), the archive line, the marker, and the loss ledger (bounded by
`MAX_LOSS_LEDGER_BYTES`, §4.3). `doctor` already performs the same reads on every run. **Measured** (LOSS-12,
`connector-claude/test/capture-latency.test.ts`, darwin/arm64, two runs of 20 interleaved samples): the read
alone p95 **1.46 / 1.37 ms** on a home loaded to the owner's worst shape (382 records in 343 batches, the
marker, a capture-loss ledger at its cap: 941 losses); SessionStart p95 **74.9 / 68.4 ms** on a home with no
ledgers against **69.7 / 67.5 ms** loaded — the difference is inside machine noise; the budget is 1000 ms.

**Not carried by the deferred ender** (`reap.ts:425-481`; the three enders at
`connector-claude/src/hooks/session-start.ts:182`, `connector-cursor/src/handlers/session-start.ts:74`,
`connector-acp/src/capture/engine.ts:1267`). A deferred end runs inside a SessionStart whose own registration
carried the same report a moment earlier; a second copy would say nothing new and would spend the reserve the
ender is bounded by.

### 4.3 The ledgers — one for records, one for events

**`.drops` keeps counting records** (`spool/drops.ts`) and its `DropReason` grows by four: `ignored` (#6, with
`kinds`), `capture-capped` (#8), `secret-path` (#9), `outside-root` (#10). The three capture reasons are written by
`captureFileTargets` and `captureTouchedFiles` — the two flows every host already goes through
(`flows/capture-touched-files.ts:45-47`, the directive that keeps a third builder from appearing) — and only when
the event was an edit, on the same argument `withCaptureBookkeeping` makes for its counters
(`capture-bookkeeping.ts:130-146`): an ACP read carrying `locations` outside the repo is not a lost edit. The
append.ts contract *"on disk awaiting flush, delivered to the hub, or COUNTED as a drop: there is no fourth
outcome"* (`append.ts:70-77`) becomes true of capture as well.

`readDropSummary` keeps its three fields and gains `byReason` and the span (`oldestAt`, `newestAt`), read from
the entries' own `at` the way `newestDropMs` already does (`drops.ts:254-261`). The archive line
(`archiveLedger`, `:331-360`) folds `byReason` in; an archive written before this field reports its count under
`unattributed`, which is the honest word for it.

**A second ledger for losses that are not records.** `state/loss-ledger.ts`: append-only JSONL at
`~/.crosscheck/state/losses.jsonl`, one line per event — `{"at", "kind", "count", "key", "detail"}` — where
`kind` is one of `hook_timed_out`, `host_contract_drift`, `wire_unobserved`; `key` is the repo key when the
writer knows it and `null` when it does not (a hook that timed out before repo identity resolved, a Cursor
payload with no workspace root); `detail` is the hook name or host event name from the writer's own enum,
bounded. Append-only for the sync-state lesson (`drops.ts:5-9`), bounded by `MAX_LOSS_LEDGER_BYTES` the way the
drift ledger is (`drift.ts:12-14`): past the cap the detail stops and the count is a floor, which doctor prints.

**A null key is charged to every repo this machine reports for.** A hook that dies before it knows its repo has
lost telemetry *somewhere*; the conservative reading is that it may have been here. On a one-repo machine the
charge is exact; on a many-repo machine it over-reports in the safe direction. Nick's decision 10.2.

**The three writers, as built.** *Hooks:* `raceHookBudget` (`config/hook-budget.ts`) says which side won the
race — `""` alone cannot tell a handler that chose silence from one the budget abandoned — and both runners
(`connector-claude/src/hooks/runner.ts`, `connector-cursor/src/runner.ts`) append `hook_timed_out` AFTER the race,
only on the timeout path and only for capture hooks, keyed once prepare resolved the repo, else by the rule
below. *Cursor:* every drift rung in `prepareCursorHook` books `host_contract_drift` beside its drift-ledger line,
by the same rule — drift is counted before repo resolution, so the payload's repo is known there only through its
conversation's state. *Claude's Stop* books a skipped or unanswered git lane (`hook_timed_out/stop-git-lane`,
keyed), and the lane's candidate cut is a `capture-capped` drop (review M5). *ACP:* `shutdown` books `ignored`
as `wire_unobserved/unreadable`, `dropped` as `wire_unobserved/pending-cap` and pending-map evictions as
`wire_unobserved/pending-evicted`, unkeyed — a line that could not be read names no session, and a lost
`session/new` may be a repo the proxy never registered — and BEFORE the live sessions end, so each end call
carries them (LOSS-13 proves it on the hub's row).

**Reading the ledgers back — a line is a file, and files get edited.** Five rules, each found by a test that
failed first, each in the direction §2 demands (`spool/ledger-read.ts` holds the shared ones):

1. *Instants count only inside four-digit years and are re-formatted before they are compared or sent.* The span
   travels to a hub whose schema takes ISO instants only; one torn `at`, or an extended year Date.parse reads
   (`+275760-…`), used to make every register, heartbeat and end a 400. Counts saturate at `MAX_LOSS_COUNT`.
2. *Undatable content takes its file's mtime as an upper bound* (review H2): no line was written after its file's
   last modification. Undated and unreadable lines make the OLDEST unknown and bound the NEWEST by that mtime —
   later than the truth, and finite, so the loss ages out instead of reading "current" for good. The archive keeps
   the bound of what it folded (`undatable`, `undatableBy`); reap ages a ledger with no datable line by its mtime.
3. *An unreadable line is at least one `unattributed` loss*, never nothing; and *only absence (ENOENT) reads as
   zero* (review M1): a file or directory that exists and cannot be read or parsed is at least one loss — or the
   count an unparseable archive still names — bounded by its mtime and said in doctor's lines.
4. *A full capture ledger keeps a refusal marker* (review H1, `state/losses.refused.json`): every refused append is
   counted and dated there, charged to every repo, and the append that fills the ledger records when it filled —
   so a full ledger reports a repo's new losses (it used to report them as zero), dates them, and ages out
   fourteen days after its last refusal. Only a full ledger with no readable marker reads its newest as unknown.
5. *Counts read own properties only* (`spool/counts.ts`): a reason named `constructor` used to turn `kinds` into
   strings the hub refuses.

**Which hooks are booked, and to whom** (review M4). Only hooks that capture: Claude's session-start,
post-tool-use, post-tool-use-failure and stop; Cursor's sessionStart, afterFileEdit, afterShellExecution,
postToolUse, postToolUseFailure, stop. PreToolUse and UserPromptSubmit spool only informational records (§3
row 25), beforeSubmitPrompt derives (§4.8.7), SessionEnd's end and drain leave records on disk (§4.8.4). A hook
or drift that never resolved its repo is keyed by its session's state file when one exists, booked unkeyed only
when a connected repo (a `.git` boundary that commits `.crosscheck.json`, or the `CROSSCHECK_HUB_URL` override)
sits above one of its paths (`config/connected-repo.ts mayBeConnectedRepo`), and not at all otherwise — where no
run of the hook would have captured for any repo. Unkeyed charges still over-report; they are never exact.

**`rejected` keeps its cause** (pilot, 2026-10-05). Nick's machine held 433 dropped records, every 0.10 line
`{"at","count":1,"reason":"rejected"}`, 225 of them from ONE Claude Code conversation resumed over a month. The
cause: a host keeps one session id for a conversation's whole life, every SessionEnd ends its crosscheck session
for good (`server/src/services/records.ts` checkProducerSession refuses later writes; only a REAPED end revives),
and the next life registers one rung up — `cc_<id>`, `~r1`, `~r2`. That ladder had three rungs. The fourth life
found all three ended, registered nothing, kept the base id the hub had just refused (`flows/register-session.ts`
before this fix), and every record it captured was rejected while the cursor moved past it — for the rest of the
conversation. Cursor (`conversation_id`) and ACP (`session/load`) shared the flow and the defect; Claude's
state-less recovery took the same 409 for "nothing to recover" and captured nothing, silently.

The fix keeps every end final and every order inside one `(session, epoch)` (01 §3.4): a life after an end is a
NEW crosscheck session on the next rung, with its own epoch and its own `session.started`, the ended ones kept
as they were. The walk is unbounded in practice and cheap: it starts at the newest life the machine knows — the
state file's, or the one `endSessionFlow` writes down in `sessions/<slug>.lineage` — and gallops from there
(`state/session-lineage.ts`, `REGISTER_LADDER_MAX_ATTEMPTS`). Nothing reopens an ended session, so a write after
a final end with no resume stays rejected. Records already rejected are gone; after the upgrade the next
SessionStart of a deaf conversation registers a live life and capture resumes. Coverage follows the evidence: a
deaf life touched no session row (register and heartbeat answered 409, every record refused), so its author read
as `commit authors with no reported session` on the git rung; the new life's register closes that, while the
rejected records travel in the loss report and keep the agent rung `incomplete / telemetry_lost` inside the window.
A deaf conversation's flush also stamped OTHER sessions' backlogs with its ended id (`spool/flush.ts` stamps the
flushing session; the drop is filed under the writer's ledger) — the likely source of the short sessions' one to
four `rejected` records each, which the new `causes` field will name from now on.

A `rejected` line now carries `causes`, the hub's refusal as a word from a closed list
(`spool/reject-cause.ts`: `session_ended`, `session_unknown`, `session_foreign`, `developer_mismatch`,
`author_unknown`, `other`),
matched against the hub's own sentence and never storing it; the archive folds it as `rejectedCauses`. Readers
from before the field parse the line unchanged (their schema is a loose object), and doctor's `hub rejected
records` line and `status`'s `losses:` say why — counting the lines that carry no cause as "cause not recorded".
The causes name the session that DELIVERED the records — the hub's issue is about `producer.sessionId`, which the
flush stamps with the flushing session — never the session that wrote them or a resume that may not have happened.

**A refused session heals mid-life** (`flows/heal-session.ts`, `spool/flush-heal.ts`). The ladder above ran only
at SessionStart, so a session the hub ended or never registered — a sibling process's SessionEnd after a reload, a
register that did not land, a conversation already deaf at upgrade — stayed refused until the host fired
SessionStart again. Now a flush whose records come back `session_ended` or `session_unknown` for its OWN
producer, or a heartbeat answered 409/404, walks the ladder once: at most one walk per flush, at most one per
`HEAL_COOLDOWN_MS` per session (stamped in `sessions/<slug>.heal` before the walk), each rung clamped to the
flush's deadline. A NEW life is registered with `session.started` at `(state epoch, 0)` — the counter runs on, so
no position is issued twice — the state switches to it, and its work context is spooled; a session the hub never
registered is registered as itself. The refused batch is re-sent under the life the walk landed on, except for one
class: a record whose body names its session (`target`, `claim`, `claim_edge`, `work_context`) and that the
refused life produced. The hub positions those in the session the body names, so under any other producer they
would land in an ended session past its end, or under an epoch it never had. They stay `rejected / session_ended`;
that life's stragglers in later flushes are never sent at all (`spool/refused-lives.ts`, one line per healed life)
and are counted under their own reason, `withheld`, with doctor's `withheld records` line — never as "rejected by the
hub", which would be a sentence about a request that did not happen. Everything
else is re-sent: producer-filed kinds lose their position on the way (`foreign_session_delivery`), and another
session's backlog lands where its body says, as any successor flush delivers it. The edits between the hub's end
and the heal are the cost; every edit after it is captured.

**A life the hub never registered keeps its work context** (review-2 finding 1). Every later record of such a
life names its work context, and the life may still be registered AS ITSELF — so a refusal no heal answered (a
flush with no healer, a walk the hub refused too) used to spend that one record, and after the hub recovered and a
heal registered the life, every edit was refused as `other` for a work context the hub never saw (`claude
--resume` while registers failed: every later edit of the conversation). Now a `session_unknown` refusal that
falls on the flusher's own `work_context` and is not healed keeps the batch on disk, as one that falls on another
conversation's records does; a life the hub ENDED is never registered again, so its own is still spent. And every
heal that lands spools the life's work context, a heal onto the same id too — the copy a heal finds missing was
spent by another conversation's flush or an older connector; a second copy is a duplicate to the hub. ACP's
registration flush now carries the healer, as SessionStart's does on the other hosts.

**One deferred end per life** (review-2 finding 3). The `.pending-end` marker was one per HOST session, so a
conversation resumed after a deferred end wrote the next life's marker over it: the earlier life was never ended
from this machine (left to the hub's reaper), its `session.ended` position was lost, and it never reached doctor's
`unclosed sessions` count, which counts markers as they age out. A later life's marker now carries its rung —
`<slug>.r<n>.pending-life`, the base life keeps `<slug>.pending-end` — reap lists both and reads the slug back
from before the last `.r<n>`, and each life's end waits for the conversation's backlog and lands — or ages out
and is counted — on its own. The later-life name is deliberately no `.pending-end` name (review-2 MEDIUM-2): every
reap before per-life markers lists those and reads the whole stem as a slug, and a proxy started before an upgrade
read the first spelling, `<slug>@r1.pending-end`, as a session with no spool, saw nothing pending, and ended the
life while `<slug>.jsonl` still held its records. An older reap never sees a `.pending-life` file at all. A stray
marker in that first spelling is still read right by this reap: `@` never occurs in a slug, so the part before it
is the slug (round 6 LOW-2).

**SessionEnd compares before it deletes** (review-2 finding 2). SessionEnd reads the life it ends at its start and
deleted the state unconditionally at its end; a mid-life heal landing in between (`K → K~r1`) left the healed life
open on the hub with no state naming it, and the next resume landed on it under a fresh epoch — `epoch_split`.
ACP's proxy reaches the same window from its exit, which races the dispatch chain against a timer while its
in-memory session still names the old life. The delete now runs under the state lock and reads what the state
names (`closeSessionState`): the state goes either way, and a life other than the one being ended is ended with
it — its own position past the counter, its own marker, written to the lineage — so the next resume starts above
it. The backlog is counted after the state goes, so a work context the heal spooled meanwhile holds both ends back.
And the heal owes that work context IN THE SAME LOCKED STEP that switches the state (review-2 LOW-4, as rebuilt
in round 6): switched first and spooled after, a SessionEnd in between found the new life with nothing on disk,
ended it, and the heal's re-send then went under an ended life — another conversation's backlog spent as
`session_ended`, against P7 — while a parallel capture could put a target ahead of the work context it names. Now
the state never names a life without its owed work context, and SessionEnd counts that debt as undelivered.

**A switch that meets a busy lock is not a lost race** (review-2 round 6, MEDIUM-1). The switch answered a plain
no, the heal took it for a sibling's win, found the state still on the refused id — the very life a same-id heal had
just registered — and retired it: the live life ended on the hub and its first window was refused as late writes.
The switch now answers swapped, `cas_lost` or `lock_busy`; a busy lock makes the heal `pending` with no cooldown
and no `failed` verdict, so the next hook walks again; and an orphan is retired only after a check under the state
lock that the state does not name it. A register that lands — a SessionStart re-fire after a failed walk — removes
the stamp and its `failed` verdict too (round 6 LOW-1): the hub knows the life, and the verdict kept every flush from
sending for the rest of the cooldown.

**A batch a walk leaves on disk is counted once** (review-2 finding 4). What a batch has lost whatever comes next
— torn lines, withheld stragglers, refusals no heal can carry — is written before the walk's register (review P3),
and a walk can leave the batch on disk: no life registered with another conversation's records at stake, no room
left to re-send. Every later walk wrote the same lines again — one torn line and one straggler read as
`{unparsable: 3, withheld: 3}` after three cooldowns, up to the spool's seven-day bound, all of it in the hub's
`loss_total`. The flush now notes on the cursor which lines' losses are in the ledger (`spool/batch-losses.ts`,
by each line's end offset in that data file; the cursor write that moves past the batch drops the note), and
writes only lines not on it — one line, one loss, whatever it was first counted as. The note is written right
after the ledger appends, inside the same step (review-2 LOW-3): written once the heal came back, it was missing
after a hook killed mid-walk, and the next flush counted the batch again.

**`withheld` travels as its own kind, `spool_withheld`** (review-2 honesty residual). The ledger kept `withheld`
apart from `rejected` from the start, but the loss report mapped both to `hub_rejected` — *"the hub answered 200
and refused the record"*, a sentence about a request that never happened. The kind is additive: this hub stores
it by name, and a hub that knows the loss report but not this kind folds it into `unattributed` by the rule it
already runs (`foldLossKinds`, unchanged since the report shipped), so the loss is still counted and the rung
still reads `incomplete / telemetry_lost`. `MAX_LOSS_KIND_ENTRIES` follows the vocabulary (`LOSS_KINDS.length × 2`,
now 26), as `MAX_GUARANTEE_TRIPLES` already did.

**An unregistered life beside a live conversation keeps its first window** (review-2 MEDIUM-1). The fix above
held while the unregistered life flushed alone. With a second live conversation in the repo, that conversation's
flush drained the deaf life's spool under its own name, the hub refused its work context ("session not found")
and its targets ("work context not found"), and they were spent as someone else's refusals; the heal five
minutes later registered the life as itself and spooled its work context at the TAIL, behind the very edit that
named it, and the seen-set kept every lost file from being captured again — of a, b, c, d edited, the hub held c
and d. Three changes, each needed: a successor flush leaves that life's records where they are (the ownership rule
below, which replaced round 6's `unregistered` hold); a heal sends the life's work context AHEAD of the batch it
re-sends (`flush-heal.ts`), the spooled copy a duplicate at worst; and every heal clears the seen-set, the same
id's too.

**The work context a heal owes is a persisted debt** (review-2 round 6, HIGH-1). That ahead copy rode only the
healing flush's one re-send: any failure of that POST — a 503, a timeout, no room left, or a full batch plus the
work context past `MAX_INGEST_BATCH` (100 + 1, refused whole) — left the backlog to a flush with no work context
ahead of it, and every record was refused `author_unknown` and spent: 100 of 100, 150 of 150, 3 of 3 with one
503. The heal now writes the debt — `<slug>.owed-wc` beside the spool, in the same locked step that switches the
state (`spool/owed-work-context.ts`) — and every drain that sends a batch carrying the life's records sends the
owed work context at its head, the batch sized one short of the limit, until the hub's answer for it is accepted
or a duplicate. The tail copy is gone (it could also revert a status `set_intent` set since). Beside the spool,
not in the state: SessionEnd deletes the state while the records the debt is owed for may still wait on disk, and
SessionEnd counts an open debt for the life it ends — or the one a heal moved it to — as undelivered and defers.
The life's own records refused `author_unknown` while its debt is open are kept, never spent. Reap removes a debt
with its spool, or once no live session and no spool can ever pay it.

**A flush sends only what is its own** (review-2 round 7). Round 6 held an `unregistered` life's records from
other flushers, and each repair of the hold opened another way to lose them: a mark that never cleared held a
crashed life's backlog until it expired; an hour of silence released a life that was idle but alive, and a
successor spent its records (P3); and a flusher healing its own life inside a batch of ANOTHER conversation's
owed life re-sent those records without the work context they were owed, so all three were refused
`author_unknown` (H1, P4). The hold, its mark, its expiry and its per-life cursor notes are gone. In their place is
one rule (`spool/ownership.ts`): a flusher sends its own host session's spool (the state names its life), an ENDED
one's (no state file), or an ABANDONED one's (a state silent past the bound session-reap deletes on,
`isPastReapBound`), and never another live conversation's. That conversation delivers its own records, heals
its own life and pays its own work context. Doctor says `N records wait for their own conversation (another live
session)` while any do. Cursor's sessionStart and the ACP proxy's shutdown reap stale session states as Claude's
SessionStart does, each sparing its own.

**One life per batch, and a debt with nothing to ride on is paid alone** (review-2 round 7). A batch is the head of
the spool up to the first line another life wrote, so at most one owed work context goes ahead of it, the debt of
the life it carries, settled under the spool that owes it; a heal inside it re-sends one life's records. Every
batch keeps the work context's slot (`MAX_INGEST_BATCH - 1` lines, debt or not), so a batch is the same lines on
every flush that meets it, and a walk's cursor note always lies inside the batch that settles it (L1). A spool that
owes a work context and holds no record to carry it, including after a heal that re-sent nothing because the batch
was the refused life's own, is drained like any other: the debt goes alone in the same drain. A payment that does
not land waits for the next drain, never the next batch.

**The owed work context is built when it is sent, and set_intent settles it** (review-2 round 7, M1). The heal wrote
the work context it owed with the status the state held then, and a debt still open when `set_intent` set a new
status was paid later with the old one, which reverted it (P2, p4b revert: `blocked` back to `analyzing`). The
payment is now built at each send from the title and status the life's state holds then, in a fresh envelope so the
hub never answers a stale copy `duplicate`, and settled by the work context's id. `set_intent`'s own post, once the
hub took it, settles the debt for that work context. The one window left is a payment already in flight when
`set_intent` posts (the hub keeps whichever lands last); both run in the same conversation, and the hosts run a
tool's hooks after the tool.

**A debt the hub refuses is bounded, and never stalls the drain** (review-2 round 7, M3, P1). A work context the hub
refused every time pinned its life's records for good, failed every drain of its own flusher, and held its
SessionEnd open. The debt now keeps its refusal count and the time of its first refusal. A refusal is the hub's
verdict on the record itself; a refusal of the session that sent it is the heal's to answer and never counts. A
refused debt goes once per drain, because its spool is passed over for the rest of that drain while every other
spool the flusher may send still goes. After `OWED_WORK_CONTEXT_MAX_REFUSALS` (3) refusals, or `MAX_SPOOL_AGE_DAYS`
after the first, the debt is released: it is counted as one drop with its own cause, `owed_wc_refused`, and so are
the life's records the hub refused for want of it, and the life's records then go like any others.

**The spool, simulated** (review-2 round 7). `connector-core/test/spool-simulation.test.ts` is a seeded,
deterministic, model-based test that runs the real register, flush, heal and SessionEnd code against the real hub (in-memory
PGlite) behind a fault-injecting proxy. Each seed is a scenario of one to three conversations on one repo spool. The
events are SessionStart (resumes climb the life ladder), edits, `set_intent`, SessionEnd, a sibling ending a live
life on the hub, an hour of idleness, a host that dies silently for good, an older connector's flush, 503s, answers
lost after the hub committed, refused registers, a work context the hub refuses for good, and a crash before or after
any hooked write (state, cursor, debt, stamps, markers, spool appends, ledger appends). After the scenario drains, six
invariants must hold, all checked against what the proxy and the write hooks logged:

- (I1) every captured record is delivered or counted once;
- (I2) no record goes under the wrong life, nor into a session the connector had been told was ended;
- (I3) no session's order breaks;
- (I4) no work context ends older than the newest status `set_intent` wrote;
- (I5) every drain keeps its deadline and the scenario settles;
- (I6) no flusher moves another live conversation's cursor or ledger.

A failing seed is shrunk to a minimal trace. CI runs 300 seeds, about 20 s; `SIM_SEEDS` widens the sweep, and 10,000
seeds ran clean before this round shipped. Every reviewer probe (P1–P5, p4b) is a fixed scenario, and so is every seed that failed
while the test was written. The sweep found these, and each is fixed:

- a SessionStart re-fire put the host's starting status back over `set_intent`'s, and so did the work context the
  register had spooled when `set_intent` reached the hub first. A spooled work context now goes with its life's state,
  or, once SessionEnd ran, with the title and status its end left on the deferred-end marker;
- a SessionStart whose ladder climbed past an ended life, a heartbeat or `set_intent` refused as ended, a flush
  refused as ended with no heal past it, and a lone debt refused as ended each left that life's records deliverable
  into it. Each now writes the life down as refused (once per life), and a debt of a refused life is settled as moot;
- a SessionStart killed between its register and its state write split the session's epoch. The register now
  reserves its epoch before the POST (`sessions/<slug>.epoch`, swept with the lineage notes);
- `set_intent` killed between a post the hub took and its state write let the next sender revert the status. It now
  writes the status into the state first, puts it back only when the hub surely did not take it, and keeps it when
  the post may have landed;
- the deferred end ended a life whose work context was still owed, and the payment was then filed past the end.

Residuals the invariants allow for, each counted, never silent:

- a record the hub took while the connector never learned it (the answer was lost, or the hook died before the cursor
  write) is counted as lost when a re-send is refused or the record is withheld, because the hub answers the producer
  before the duplicate;
- the ledger may over-count after a crash between a ledger append and the cursor write past it, the honest direction
  §4.3 already accepts;
- a record delivered into a session whose end only a sibling saw is filed past that end, because no flusher here was
  told;
- an older connector's flush neither honours ownership nor reads the refused-lives note. It spends a live
  conversation's records (author_unknown, counted; the P5 scenario shows it) and can send a spooled work context as it
  was spooled (L5).

**The edges the round-6 review left** (review-2 round 7):

- A heal that retires a life nobody names now ends it inside the walk's deadline, and makes no end call once nothing
  is left; the lineage still keeps a resume off that life (L3).
- A switch that meets a busy state lock no longer tries to retire anything. The retire needs the same lock, and the
  next walk lands on the very life this one registered (O27). A switch that loses its compare-and-swap decides
  under the state lock whether the life it registered is an orphan, so a SessionStart that moved the state onto that
  very life in between keeps it open.
- A SessionStart re-fire whose register fails keeps the failed walk's cooldown verdict (O29).
- A state file that will not parse still speaks for a live conversation until the file itself has been silent past
  the reap bound; then its records go as an abandoned conversation's (U19).
- The walk no longer writes the refused life down itself: the heal does for a refusal as ended, the ladder does
  for a 409 on the state's life, and a flush with no healer (SessionEnd's) does for its own refusal.
- Doctor reports what is owed: `WARN owed work contexts: N owed, waiting for their lives' next batch; M refused by the
  hub (k of 3 refusals before they are released); P debt files that will not parse`. A corrupt debt file is counted
  as the problem it is, never read as "nothing owed" (L4).

**The simulation, extended** (review-2 round 8). The round-7 review extended the simulation with three things it did
not model, and they are part of it now:

- two connector processes at once (`par`), interleaving at every file and network await: parallel tool calls, and a
  reload's SessionEnd beside its SessionStart;
- a slow hub that commits a record or register POST and holds its answer for 600, 1400 or 1700 ms;
- a host that dies while a week passes for every file on disk (`age`), not only its state.

The timing is production's: the request timeout is `HTTP_TIMEOUT_MS` (400 ms), and each hook's drain gets what its real
budget spares it (`config/hook-budget.ts`). A batch the hub committed after the connector stopped waiting is logged as
taken unheard, which at 400 ms against the in-memory hub is common, as on a laptop. CI runs 300 seeds in about 50 s and
prints the over-count with every run: records the ledger counts lost that the hub holds. Each seed the review's sweep
failed is a fixed scenario named by its seed and finding. Two of them, 1018 and 1034, were the checker's: it read a
conversation's phase before a step in which a parallel SessionEnd ended it, so a successor sending its spool looked
like a send while it was live. At production timing the sweep found the mirror image (seed 10009: a conversation a
parallel SessionStart restarted after the other process found it ended). A send counts as into a live conversation
now only when that conversation was live on both sides of the step.

**The simulation, extended again** (review-2 round 9). The round-8 review added five things, and they are part of the
simulation now, each a generator `SIM_ADD` picks:

- `io`: a disk that refuses a run of a step's writes (ENOSPC, EACCES), with the process living on, or exiting on the
  error;
- `sleep`: a night the hub reaps through (8 h), a week away for every file AND the hub, a conversation woken after it,
  connector-claude's state recovery on a PostToolUse, and a heartbeat with its heal;
- `focus`: two processes of one conversation around set_intent, SessionStart and SessionEnd, behind a slow hub, with
  an end the hub committed whose answer was lost.

An end the connector SENT counts as one it may know about, heard or not: I2 holds it to that. The review's probes (a
night with a heartbeat, a week asleep then a resume or a recovery, 64 SessionEnds, an end committed unheard) and every
seed its sweeps failed are fixed scenarios. Each one still open names the fix it waits for, and the sweep skips its
seed.

One class is a documented residual, I1u, and the sweep counts it without failing. It is a drop the disk refused to
write down anywhere: the ledger line and its fallback marker both failed, so nothing on that disk can count it. Each
`io` seed that found it is a fixed scenario asserting that this, and nothing else, happened.

**Three clocks that were one** (review-2 round 8, H1 and H2). The refused-lives note dropped an entry
`MAX_SPOOL_AGE_DAYS` after it was written. A flush reads a silent host session as abandoned after the same span. Reap
expired a spool whose data file was that old. So when a host died:

- its spool was released exactly when the notes saying which of its lives the hub had ended aged out, and a successor
  filed their stragglers into the ended sessions (H1, seeds 455, 10005 and 11379);
- the first successor SessionStart reaped the dead host's state, and the next one expired whatever that successor had
  not yet sent. In the review's probe that was 2605 of a 3000-record backlog, counted, but lost all the same (H2).

Now a refused-lives entry is kept while its host session still has records or a debt on that repo's disk, and never
less than `REFUSED_LIFE_KEEP_DAYS` (twice the bound). A spool's release is stamped once, when session-reap deletes its
stale state or a flush first sends it as abandoned, beside the spool as `<slug>.released`. Reap expires a released
spool `MAX_SPOOL_AGE_DAYS` after that stamp, never sooner. A spool its own SessionEnd released has no stamp and expires
from its last write, as before. The probe's backlog is now delivered over the successor's hooks, and none of it
expires (`connector-core/test/release-clock.test.ts`).

**A life SessionEnd ended is written down as refused** (review-2 round 8, M1). Every refusal as ended wrote the life
into the refused-lives note, but the end the connector sends itself never did. A record of the life appended after its
end was sent by a successor and filed into the ended session. That record comes from a reload's SessionStart re-fire
beside the old process's SessionEnd, or from a hook still in flight (seed 782, probe C1). SessionEnd's own end, and the
deferred end reap sends from its marker, now record the life once the hub took the end.

**A conversation re-bound to another repo is over for this one** (review-2 round 8, M2). Ownership never compared the
state's repo binding with the spool's. A conversation resumed from another checkout re-binds its state to that repo,
flushes that repo from then on, and never this one. Every flusher of this repo read its spool here as
`live-elsewhere`, and reap expires nothing while a state exists, so its records here waited for good (the review's
rebind probe: 2 lines left after a month). A state bound to another repo now reads as ended for this repo's spool, and
the next flusher here sends it.

Two residuals:

- A multi-repo workspace whose hooks capture into a second repo's spool for a conversation bound to the first has that
  spool sent by the second repo's flushers too. Its records are a live, registered life's, and the hub takes them.
- A straggler there of a life the hub has ended is withheld only if that repo's refused-lives note names the life.
  Refusals a flush or SessionEnd in that repo sees are written there, but a heal writes to the bound repo's note.

**A reaped state leaves its life's last word** (review-2 round 8, M3, seed 10895). A work context spooled or owed for a
life goes with the title and status its state holds when it is sent, or, once SessionEnd ran, with what its end
marker kept. A host that died has no SessionEnd. When session-reap deleted its state, nothing remembered the status
`set_intent` had set, and the copy spooled at SessionStart put the old one back. Before it deletes a stale state,
session-reap now writes the life's end marker (`spool/end-marker.ts`, the shape SessionEnd writes) with the state's last
title and status. The marker is also the dead life's deferred end: reap ends it on the hub once its backlog is gone,
unsequenced, since nothing allocated it a position. A marker a SessionEnd already wrote is never overwritten.

**I1 is per record, and the hub answers what it holds** (review-2 round 8, M4). The simulation's I1 compared totals
with allowances, so an over-count could cancel a silent loss of the same size. Now every drop carries its records'
envelope ids, though the ledger line does not keep them (`spool/drops.ts recordDrop`). Each captured record must be
delivered or counted exactly once: never both, never neither. A drop that counts records the code holds must name
every one of them.

The over-count was real. A connector that never heard the answer to a batch sends it again, and by then the hub may
have ended the life it sends under. The hub checked the producer before anything else and answered `rejected` for
records it held, so the connector counted them as lost. At production timing that was 94 of 1430 counted losses (6.6%)
over 4000 seeds, and the review measured 8.6% on the shipped generator.

The hub now keeps a receipt of every envelope it takes: its id, and the id it answered with (`record_receipts`, kept
`RECORD_RECEIPT_RETENTION_DAYS`). Where the producer check would refuse an envelope the hub holds, it answers
`duplicate`. The re-sent body may be newer, as a spooled work context re-sent with its life's current status is. Only
that change is not applied, and the life's own later posts carry it. While the producer can still write, the envelope
goes through every check as the update it is. The residuals I1 allows are each still counted:

- a record taken unheard and then withheld or expired, never re-sent, so no `duplicate` could tell the connector the
  hub has it;
- a record counted by a step that died between the ledger append and the cursor write past it.

**The simulation runs set_intent's own write** (review-2 round 8, M5). The simulation re-implemented `set_intent` instead
of calling it, and the tool's may-have-landed rule went unguarded. A plain 500, a timeout and an ignored post each
survived a mutation (R7-M5, R7-M6, R7-M7). The write is now one function, `mcp/tools/intent-write.ts writeIntent`:

- the status goes into the state first;
- then the post;
- then each answer decides what the state keeps, what is written down as refused, and whether an owed work context is
  paid.

The MCP tool calls it after its argument, secret, echo and contract checks. The simulation calls the same function,
and a status the tool's arguments refuse writes nothing there too. Tests pin all three cases: a 500 or a timeout
keeps the new status, and an ignored post puts the old one back.

**set_intent's state-first window, accepted** (review-2 round 8, L6). The status goes into the state BEFORE the post,
because a set_intent killed between a post that landed and a later state write left the old status in the state. The
next re-fire or debt then put that old status back on the hub (round 7, simulation seed 10). The cost is a window. From the
state write until the post's answer, every other sender of the work context reads the new status:

- a flush's spooled copy (`withLifeState`);
- an owed debt (`owedRecordNow`);
- a re-fire's register.

Any of them may carry the new status to the hub first. When the post then surely never landed (`dns`, `refused` or
`tls`), or the hub ignored or rejected it, set_intent puts the old status back in the state and says it failed. The hub
may hold the new one until the next sender of that work context carries the state's old status over it. Nothing is
lost or miscounted, but the hub can briefly show a status set_intent reported as failed. A post that may have landed
(a 500, a timeout) keeps the new status in the state, so the two agree. Closing the window would mean holding every
other sender of the work context for the post's round trip, and a status that converges is not worth that. The
simulation's I4 holds the converged end to account: once a scenario has settled, the hub's status must be the newest
the hub took from set_intent, or the newest set_intent left in the state.

**One host session key on two machines is a residual, counted** (review-2 round 8, M6). A cloud agent and a local
resume of the same conversation share a host session key, so both machines register the same life id. They capture
and flush as usual, and the hub's order for that session breaks (`epoch_split`, two epochs). One machine's
SessionEnd ends the life the other still writes under, and that machine's records are refused as late writes. It
then heals to the next life, which the first machine's later resume lands on, and that one splits too. This is
accepted for now, because nothing is silent:

- every record either machine captured is on the hub, or counted in that machine's loss ledger;
- the broken order is there for every reader of the session (`connector-core/test/two-machines.test.ts`).

The fix is an installation discriminator in the life id: a per-machine id minted once into the crosscheck home and
folded into `cc_<key>`. Two machines would then register two lives of one conversation, never one life twice.
Alternatively, the hub could refuse a live re-register that comes from another installation.

**A SessionStart re-fire keeps the status set_intent writes beside it** (review-2 round 8, L1). The re-fire read
the life's status before its register POST and published it after. A `set_intent` that ran in between was put back,
in the state and in the work context the register spools. The extended sweep found it on 13 seeds, plus 912, 1494
and 11268 at production timing, all `par[intent ‖ start]`. Two reads close it:

- the register reads the status AFTER its POST, so the work context it spools carries what `set_intent` wrote while
  it was out;
- the publish carries the file's title and status under the state lock (`withCarriedCapture`), so a `set_intent`
  between that read and the publish is kept too.

Before the fix, 97 of 128 replays of the 16 seeds broke I4; after it, none did. The fixed scenarios are ordinary tests
now, and `session-lives.test.ts` pins both windows.

**One life, one epoch, whatever runs beside its SessionStart** (review-2 round 8, L2). The hub filed a life's
`session.started` under one epoch while the state took another, so I3 broke with `epoch_split`. Five seeds found
three ways in:

- **Two SessionStarts at once** (seeds 134, 11285). Both read before either reserved, so each minted its own epoch. The
  register that landed and the state that was published first could disagree. The register now reads and reserves
  under the state lock, and the second finds the first's reservation.
- **A SessionEnd beside a re-fire** (1933, 11683). The end deleted the state while the re-fire's register was out.
  The register had climbed to the next life under the carried epoch, and its publish found nothing to carry, so it
  started the state on a fresh mint. Two changes close this:
  - the reservation now names whatever goes out, a carried epoch too;
  - a publish that finds nothing to carry starts on the epoch the register sent (`publishSessionState`'s
    `startEpoch`).

  A life the state already named keeps the fresh mint. Its counter is gone with the file, and its positions under the
  carried epoch were handed out. A split there costs comparability and never re-issues a position, which a test pins.
  The busy-lock fallback is unchanged.
- **A resume onto a life a heal opened unheard** (11974, production timing). A heal registered the next life under
  the state's epoch and stopped listening before the hub answered, so the state never moved. SessionEnd then ended the
  old life and deleted the file, and the resume landed on the open life under a fresh mint. The lineage that
  SessionEnd writes now carries the ended life's epoch. A state-less register takes its reservation first, then that
  epoch, and mints only when neither exists.

Before the fix, 35 of 40 replays of the five seeds broke I3; after it, none did. Their fixed scenarios are ordinary
tests, and no seed is open in the sweep any more.

**A torn debt file holds no drain** (review-2 round 8, L3). A spool with nothing left to send counted as pending
whenever its debt file existed. With a torn file there was nothing to pay, yet as the oldest pending spool it took
every batch of the drain. The unreadable-debt probe sent 0 records, and 11 waited behind it. A spool now owes alone only
a debt it can read. The torn file goes when reap removes its spool, as every debt does.

**Only a missing state file is an ended conversation** (review-2 round 8, L4). `ownerOf` read any failed `stat` of
a state file as "no file". A state the flusher may not look at, through EACCES or EIO, therefore handed a possibly live
conversation's records to whichever flusher came next. Now only absence (ENOENT, or ENOTDIR for a path that cannot
hold the file, the same rule as `ledger-read.ts isAbsence`) ends a conversation. Any other failure is a new owner,
`unreadable`, and its records are held like a live writer's. Doctor's waiting-records line names them, because nothing
sends them until the file can be read again.

**A stamp dated ahead of the clock ages from now** (review-2 round 8, L5). A heartbeat, a state file's write, or a
heal stamp written while the clock ran ahead (a VM resumed with a drifted clock, an NTP step back) read as fresh until
the clock caught up. In that time a dead host's state was never reaped and its spool never released, and a heal's
cooldown never ran out, so its life's records were held as long. Readers now treat any stamp past now plus
`CLOCK_SKEW_MS`, the hub's two-minute skew bound, as dated ahead. They clamp it to that bound and write the clamp down,
so it ages from there:

- SessionStart's state reap clamps the heartbeat and rewrites the file under its lock;
- the healer rewrites its stamp as a finished walk.

`future-stamps.test.ts` dates each stamp a year ahead. The state is reaped a week after the clamp, and the cooldown
ends one cooldown after it.

**The life's last status goes with its end** (review-2 round 8, L7). Every sender of a work context builds it from
the state, so the next one makes the hub agree with it. At SessionEnd no next sender comes. A set_intent post that may
have landed and did not left the hub on the old status for good. One that surely did not, put back after the window
above had carried the new status, left the hub ahead. The state now remembers the last status the hub ACCEPTED for its
work context (`workContextAcked`), from three sources:

- a flush's spooled copy or a paid debt (`spool/work-context-ack.ts`);
- set_intent's own post;
- the same record, carried across a SessionStart re-fire.

SessionEnd spools the work context once more, ahead of its drain, when the hub last accepted another status than the
state holds. It sends none for a work context the hub was never seen to take. That one's own copies are on their way
or counted, and one more would only be refused beside them. A state from before the life's `agentKind` was written
down has no producer to send it under.

Only `accepted` counts, never `duplicate`, and only the flusher's own state is written. Another conversation's state
file is its liveness, and a write there revived an abandoned host and held its backlog from every successor (the
release-clock probe caught it).

**Doctor's waiting-records line says how long, and until when** (review-2 round 8, L9). "N records wait for their own
conversation (another live session)" told a developer to wait, even for a process that was gone, whose records then
waited a week for the reap bound. The line now gives:

- the oldest waiting record's age;
- the day the records go to any flusher if no owner is heard from again (the reap bound past the most recent sign of
  life).

An owner silent past the hour doctor calls a state a zombie is named as a conversation that may have crashed, with that
release day. A conversation re-bound to another repo (M2) is now its own owner, `rebound`. Like an ended one it is
sendable by any flusher of this repo, and doctor says its records wait for this repo's next session.

**Two round-7 guards had no test** (review-2 round 8, L10). The reviewer showed that two mutations survived. Each now
has a test and an anchor:

- R7-M3: a debt refused `author_unknown` never counted a refusal. That happens when its own life was never registered
  on the hub, and such a debt never reached its bound and held SessionEnd open for good. `owed-debt-rules.test.ts`
  pays it alone and expects one refusal counted.
- R7-M9: a spooled work context went with the title it was spooled with, not its state's. A re-fire on a new branch
  spools that title while the state keeps the life's. `owed-work-context.test.ts` expects the state's title on the hub.
 `owed-work-context.test.ts` replays the probe, and all 11
records land.

**The hub's author-side refusals have a word, and a cooldown sends nothing** (review-2 LOW-5). A record whose own
session or work context the hub never saw is refused with `sessionId: session "…" not found` (also
`authorSessionId:`) or `workContextId: work context "…" not found` — the body's session, not the producer's — and
those were `other`, "a reason this connector does not name", for exactly the pilot's failure class. They are
`author_unknown` now; an older reader folds the word into `other`. And a flush whose own life's last walk
registered nothing sends nothing until that walk's cooldown is over (the stamp records the life it failed for):
a batch pinned on disk was re-sent, and refused again, by every hook for five minutes.

### 4.4 The hub — six columns, derived on read

No new table, so no entry in the retention registry (`server/src/services/retention-registry.ts:7-24`: a
session-bearing relation without a declared contract fails the build) and no change to the sweep: the columns die
with their row. Appended to `agent_sessions` (`server/src/db/schema.ts:157-202`) and mirrored in
`db/bootstrap.sql` with `ADD COLUMN IF NOT EXISTS`, the `reaped_at` pattern (`bootstrap.sql:34-38`):

| column | type | meaning |
|---|---|---|
| `loss_reported_at` | timestamptz | when the connector last sent a report; **NULL = never reported** (§4.7) |
| `loss_total` | integer NOT NULL DEFAULT 0 | the report's `total` |
| `loss_kinds` | jsonb | the report's `kinds`, keys folded to `LOSS_KINDS`, unknown keys summed into `unattributed` |
| `loss_oldest_at` | timestamptz | the report's `oldestAt` |
| `loss_newest_at` | timestamptz | the report's `newestAt` |
| `loss_ignored_at` | timestamptz | the newest `hub_ignored` loss (`ignoredNewestAt`), else an upper bound — the report's `newestAt`, else the report instant; NULL = no ignored kind (review C1, M3) |

`registerSession`, `heartbeatSession` and `endSession` (`server/src/services/sessions.ts`) write the six
when the body carries a report and touch none of them when it does not. The stored total is the larger of the
sent `total` and the folded kinds' sum, saturated at int4, and the kinds account for all of it (`settleLossReport`:
whatever they do not cover — a `__proto__` key zod's record parse drops — is `unattributed`). A block the hub
cannot read — a count past `MAX_LOSS_COUNT`, an unsafe integer, more kinds than any vocabulary, an instant no ISO
parser reads — is caught and stored as one undated loss (`UNREADABLE_LOSS_REPORT`, review M2): it no longer
refuses the register it rides, and a session whose registration fails is never registered at all. Last report wins: the report is a
snapshot of the machine's ledgers, not an increment, so two sessions on one machine reporting the same 382 is not
double counting — coverage carries no count (03 §3.1) and reads only *whether* and *since when*.

### 4.5 Coverage — the rule, and which way it falls

`readAgentEventCoverage` (`coverage.ts:354-403`) stays ONE aggregate over `agent_sessions` by repo in the window
and gains three filtered terms:

```
lost      = count(*) filter (where loss_reported_at is not null and loss_total > 0 and loss_newest_at > since)
ignored   = count(*) filter (where <lost> and loss_ignored_at > since)   -- no JSON cast (review C1)
lossSince = min(loss_oldest_at) filter (where <lost>)
```

| condition | state | reason | `gapSince` |
|---|---|---|---|
| zero sessions in window | `unknown` | `no_session_in_window` | null — unchanged |
| `ignored > 0` | `incomplete` | **`record_kinds_ignored`** | `min(lossSince, reap/silence gapSince)` |
| `lost > 0` | `incomplete` | **`telemetry_lost`** | same |
| gaps > 0, no loss | `incomplete` | `session_reaped` / `session_silent` | unchanged |
| otherwise | `complete` | `sessions_reported` | null |

**Direction, checked term by term.** A report can add `lost` and never subtract a gap: the reap and silence
predicates are untouched. An unparseable `kinds` key is folded into `unattributed` and still counts in
`loss_total`, so a hub older than a kind cannot read the kind as zero. A report with `total: 0` sets
`loss_reported_at` and no gap. `newest_at > since` is the ONE term that can read a loss as out of scope, and it
falls the right way: a loss at instant *X* concerns records created no later than *X*, so a window that opens
after *X* asks about records the loss could not have touched — the same approximation `no_session_in_window`
already makes about sessions.

**A loss outranks a reap in the reason word.** 03 lets a reap outrank a silence because *"a reap is a decision
this hub made and can revoke"* (`coverage.ts:256-257`). A reported loss is a fact the connector wrote down and
nobody can revoke; the reader should see that word first. Both instants feed `gapSince`, earliest wins, the
direction that cannot overstate what was seen. **`record_kinds_ignored` outranks `telemetry_lost`** because its
remedy is different and specific — upgrade the hub — and doctor prints both counts either way.

**The scope arm keeps lossy sessions, fail closed.** §3.2a's `paths` scope counts *"only the sessions that
touched the surface the question is about"* and already carries the rule *"the scope may narrow by what was
observed, never by what was not"* (`coverage.ts:286-301`): a reaped session with no target row stays in scope
because it may have touched the files before the silence. A session that reported a loss is the same case — the
lost record may be exactly the target on the pinned path — so `touchedScope` gains a third membership: sessions in
the window with an in-window loss are in every scope. It can only move an answer towards `incomplete` (LOSS-3).

**`gapSince` may be old, and that is stated rather than clamped.** The archive keeps `oldestAt` for as long as
the repo exists (`drops.ts:16-19`: *"the TOTAL is not bounded by anything, deliberately"*), so a repo that lost a
batch two years ago and one this week reports the older instant. "Observation has been unreliable since at least
here" is true of it. Clamping to the window edge would claim a later start — a narrower gap — which is the
strengthening direction; refused.

`isJudgeable` is unchanged: `incomplete` on `agent_event` already makes it false.

### 4.6 The two reasons — exact wording

`COVERAGE_REASONS` (`coverage.ts:91-108`) and its wire twin (`connector-core/src/http/coverage.ts:41-58`) gain
`telemetry_lost` and `record_kinds_ignored`, in that order, appended after `hub_did_not_report` and before the
four reserved `ci_*` values so 05's block stays contiguous. `test/coverage-wire.test.ts:181-187` pins the two
lists equal.

The coverage line (`connector-core/src/coverage/render.ts:143-183`) renders them on the `agent_event` rung with
the instant, the age and no count:

```
Coverage incomplete: agent telemetry on this repo was lost since 2026-09-05T08:13Z (10d ago); git evidence reported.
Coverage incomplete: the hub ignored agent record kinds on this repo since 2026-09-05T08:13Z (10d ago); git evidence reported.
```

The subject is always *on this repo*, never *on these files*, even under a `paths` scope: a loss is repo-wide by
construction (the ledger keeps no paths), and a sentence that narrowed it to the pinned files would claim a
precision the data does not have. Both fit `MAX_COVERAGE_LINE_CHARS = 160` with the git rung `complete`; with
both rungs gapped the existing `fit` drops the ages first (`render.ts:351-370`). No `%` (COV-6), no author-written
string (03 §3.3): the two new words are enum values and the instants are re-formatted from `Date.parse`.

### 4.7 Old connectors and old hubs

**An absent report is not zero and not a gap.** `loss_reported_at IS NULL` leaves the row exactly where 03 put
it: a session that heartbeats and ends reads `complete / sessions_reported`, a reaped one `incomplete /
session_reaped`. Three precedents decide it and all three point the same way. 03 §3.1: *"`unknown` on a rung
nobody reports is the ordinary state of a fresh install. AT-5 names a **known** gap, and `incomplete` is the only
state that is one."* 01 §4: a pre-`seq` connector's rows are `unsequenced / pre_seq_connector` *"forever, and say
so"* — a per-row instrumentation fact, not a state flip. 01 §3.7 (1): coupling an instrumentation fact to the
verdict *"silences attribution for every pre-`seq` connector — turning a statement about instrumentation into a
verdict about a person's work."* Flipping every un-upgraded connector's repo to `incomplete` would do precisely
that, and would make `UNATTRIBUTED` unreachable for a whole fleet overnight — the outcome this task forbids by
name.

**The residue is named, not modelled.** A `complete` row from a connector that never reported is the same
`complete` as one from a connector that reported zero, and the record does not distinguish them. It cannot
without a third `complete` reason, which would be the *"null on every row for a whole release"* field 03 §3.4
removed. §5.2's doctor line tells the person running the NEW connector whether the hub has recorded what it sent,
which is the one place the distinction can be acted on.

**An old hub strips the field with a 200** (§4.2's directive). The connector cannot see that from the call, so
doctor derives it from data it already fetches (§5.2). Coverage from such a hub is 03's own `unknown /
hub_did_not_report` or its five real rows, unchanged.

### 4.8 What stays local, with the proof that it cannot affect a judgment

**4.8.1 Foreign-repo drops (#11).** A session bound to repo A drops a touch of repo B (`touched-root.ts:159`).
Every judgment about A — a pin verdict over A's `work_context_targets`, `suspect` over A's sessions, a search or
absence over A — reads rows keyed by A's paths and A's sessions; a path of B is not a path of A and would have
been stored under B's key had it been captured. The loss is B's, and B is not told (§8.3): B may be connected to
a different hub, and sending its repo id to A's hub is a cross-hub disclosure this note refuses. B's own sessions
report B's own losses. Stays on the machine-wide `foreign-repo drops` line, where it is today.

**4.8.2 The denylist (#12)** is a declared exclusion, not a loss: the same patterns exclude the same paths for
every session and every developer (`capture/denylist.ts:2-5`, DESIGN.md §4), so no session's absence on those
paths is distinguishable from another's. What that leaves is not a capture gap but a *pin* question — a pin on a
denylisted path can never be attributed — and it belongs to 04's pin registration, not to coverage (§10.4).
Since 2026-10-02 the CLI's pin door refuses such a pin and the sweep refuses to move one there; §10 item 4 says
what the hub does not refuse.

**4.8.3 The seen-set (#13)** skips a path already captured in this session; the target row exists on the hub or
in the spool, and if the earlier append was refused, #1 counted it. `MAX_SEEN_TARGETS` eviction
(`session-state.ts:1103-1108`) re-captures a path, which the hub dedups on its natural key: a duplicate, never a
loss.

**4.8.4 A session end that expired undelivered (#15)** leaves the hub's row with `ended_at IS NULL`. Past
`presenceCutoff` that row is `incomplete / session_silent`; once the reaper reaches it, `incomplete /
session_reaped` (`coverage.ts:121-126`). Both are the fail-safe reading. The end that never landed would have
moved the row *towards* `complete`, so its loss cannot strengthen anything — it can only keep a session
`incomplete` that a clean end would have closed. The records that caused the deferral are #4 if they expired.

**4.8.5 Seq refusals and lost brackets (#16, #17)** lose a *position*, never a record: the refusal travels on the
envelope as a value (`seq.ts:16-27`), the row is stored, and every happens-before question against it is refused
(01 §3.7, `seq-cost.ts:95-98`: *"a missing bracket makes the hub REFUSE, never answer `predeclared`"*). Refusal is
the weakening direction by construction; 01 owns the vocabulary and its doctor lines.

**4.8.6 Network and HTTP failures (#23)** leave records on disk, and the hub reads the silence as a gap: a
heartbeat that fails leaves `last_heartbeat_at` behind, and `presenceCutoff` then `SESSION_REAP_STALE_HOURS`
turn that into `session_silent` and `session_reaped`. Records that stay on disk past `MAX_SPOOL_AGE_DAYS` are #4.
Nothing here is lost invisibly; it is lost late, and counted when it is.

**4.8.7 Derived text refused (#24)** — a summarizer, intent or ghost worker's answer dropped as a secret, an
echo, empty or not a sentence — is an inference the connector chose not to publish, capped at
`DERIVED_CONFIDENCE_CAP` when it is published (`schema/src/session.ts:28-38`). The observations it summarised
(targets, declared claims, the session row and its work context) are captured by the hooks and reach the hub
through the spool, where #1–#7 count any loss. A missing derived sentence removes a hint and a search snippet
about a session the archive still holds, so an empty answer over that session already carries 03's qualifier from
the session row; it cannot make the archive look watched where it was not.

### 4.9 Where Provider Guarantees meet this — one channel, two statements, no second mechanism

Nick's direction (2026-09-30): minimal Provider Guarantees follow this work, before the pilot — 01a §3.6's
declared causal guarantees per provider, *what a connector COULD observe* against *what was LOST*. They are not
built here; this section is what keeps the two from needing a second mechanism when they are.

**Same channel.** 01a §3.6 *Transport*: the declaration *"travels in the `session.started` record body — at most
nine enum triples"*. `session.started` is the register call (01 §3.2), the same body that carries `losses`
(§4.2). Registration therefore carries two optional, enum-only blocks — `losses` (runtime, what was lost) beside
`guarantees` (structural, what can be observed) — declared on the same `RegisterSessionBodySchema`, both
optional forever, both stripped by an older hub with the same 200, both read on the same coverage path.

**Same folding rule on the hub.** Unknown values are folded, never refused: an unknown `kinds` key becomes
`unattributed` here; an unknown guarantee reason will become `provider_undeclared` there. A session that sends
nothing is *not zero* in both: `loss_reported_at IS NULL` here, *"stored as nothing, and read as `undeclared`,
never as `guaranteed`"* (01a §3.6) there. Both folds are weakest-wins over the sessions in scope: any in-window
loss makes the rung `incomplete`; the minimum effective guarantee makes `order.state`; and *"an empty scope is
`undeclared`"* (01a §3.7) is the twin of §4.5's rule that a lossy session cannot leave a scope.

**Different rows in one record, on purpose.** A runtime loss lands in the `agent_event` SOURCE (§4.5) because it
is a statement about observation and gates `isJudgeable`. A structural guarantee lands in 01a §3.7's `order`
block because it is a statement about comparability and gates `isOrderable`'s callers — *"the coverage line stays
one record, and the two gates stay orthogonal"*. `COVERAGE_REASONS` is extended by this note (§4.6) and *not* by
01a; `LOSS_KINDS` is never extended with a structural word. Concretely: **"this host cannot observe X" is 01a's
`unavailable / no_emitter` on kind X, not a loss** — `telemetry_lost` must never fire for a kind a host never
promised, and a reported loss must never lower a declared guarantee (01a caps a guarantee only when a ROW
contradicts it). A reader of the record sees both sentences, each in its own place: *the hub ignored agent
record kinds on this repo since …* beside *order: unavailable (no_emitter) for commit.observed*.

**What the guarantees build inherits from here, and does not have to build.** The optional-block pattern on the
three session bodies with its strip-with-a-200 caveat (§4.2's directive); the per-session storage read by ONE
coverage aggregate (§4.4) — `session_causal_guarantees` joins that read as a second table only because it is
per-kind; the doctor ladder in §5.1, where a per-kind guarantee line sits beside `capture losses`; and the
cross-check discipline of §5.2, which names an old hub from data both sides hold rather than from an ack the wire
cannot give.

## 5. Where it renders, and the contract

### 5.1 One formatter, two commands

`connector-core/src/spool/loss-report.ts` exports `readTelemetryLossReport(home, key, now)` and
`formatLossLines(report)`; `doctor` and `status` both print its sentences, the spool-drops discipline
(`foreign-drops.ts:69-72`: *"doctor and status must agree"*). No new render surface: the lines land inside the
`cli-doctor` and `cli-status` closures (`cli/src/render-surfaces.ts:182-192`), whose `note` already covers
enum-derived states and renderer-built ages; the only strings that reach these lines are counts, `LOSS_KINDS`,
`DropReason`, hook and host event names from the writer's own enums, and record kind names screened by the regex
in §4.1.

`doctor` (`cli/src/cli/doctor.ts:1271-1289`):

```
WARN  spool drops         382 records discarded in 343 batches (expired 300, rejected 77, cap 5)
WARN  hub ignored records 377 records in 12 batches ignored by the hub (claim_revalidation 377) — a hub older
                          than this connector discards record kinds it does not know; upgrade the hub
WARN  capture losses      3 hooks exceeded their budget before capture could finish (post-tool-use 3) ·
                          2 host payloads lacked a field capture needs
PASS  capture losses      none
```

`status` prints one `losses:` line from the same fragments, above zero only, beside `spool:` (`status.ts:466`).

### 5.2 Doctor's cross-check — the one place an old hub is named

`coverageChecks` (`doctor.ts:1456-1500`) gains a line computed from two things it already holds — the local
report and the hub's `agent_event` row:

```
WARN  coverage reporting  local ledgers hold 382 telemetry losses, the newest at 2026-09-30T08:13Z, inside the
                          hub's 14-day coverage window, but the hub's coverage for this repo reads complete: the
                          hub has not recorded them — the next session registration or heartbeat from this
                          machine sends them, and a hub older than this connector discards them; if this
                          persists, upgrade the hub
PASS  coverage reporting  the hub's coverage reflects the losses this connector reported
PASS  coverage reporting  no recent losses to reflect
```

The count is the report's total (all time, archive included), so the sentence names the newest instant rather
than claiming every loss is recent; an undated newest reads *"the newest undated, which the hub reads as
current"*. The remedy names the benign cause first: a loss written after the last heartbeat is not yet on the
hub, and the WARN clears on the next beat.

It WARNs on exactly one contradiction: recent local losses and a `complete` agent rung. Any other hub answer
(`incomplete` for any reason, `unknown`, unreachable) is not a contradiction and gets no line of its own —
`coverage` one screen up already prints those. `HUB_COVERAGE_WINDOW_DAYS = 14` is mirrored into
`connector-core/src/constants.ts` with a `VERIFY:` pinning it to the server's `COVERAGE_SESSION_WINDOW_DAYS`, the
way `HUB_MAX_DIAGNOSIS_TARGETS` is pinned (`constants.ts:1817-1825`).

### 5.3 Every answer surface, automatically

The coverage clause and note (`render.ts:360-378`) read the reason enum; `mustQualifyEmptyAnswer` (`:381-383`)
reads the state. A loss makes `agent_event` `incomplete`, so every empty answer carries the sentence (03 §5.1's
hard rule) and every non-empty one the note (soft rule) with no change to any surface, and `isJudgeable` refuses
the pin lane. COV-9's registry walk is unaffected: no module gains or loses a coverage input.

## 6. Budget

**Zero new hub round trips.** The report rides three calls that already exist. Hub-side cost is five columns on
an UPDATE that already runs. The client-side read is bounded by the number of `.drops` files younger than seven
days plus two small files; LOSS-12 measured it (§4.2): 1.4 ms p95 on the worst shape seen, and SessionStart p95
indistinguishable with and without it. The heartbeat is throttled at 20 s, so the read happens at most three
times a minute per session while tools fire. A hook the budget abandoned pays one `stat` and one append after
its race, on the timeout path only.

## 7. Acceptance tests

Each names the mutation that must turn its guard red in `connector-core/scripts/mutation-check.ts`.

**LOSS-1 — a reported loss makes the rung incomplete, and only a reported loss.** Three sessions identical but
for their report: none → `complete / sessions_reported`; `total: 0` → the same; `total: 5, newestAt` in window →
`incomplete / telemetry_lost` with `gapSince = oldestAt`. *Mutation:* drop the `lost > 0` branch.

**LOSS-2 — the ignored kind gets its own word.** `kinds: {hub_ignored: 377}` → `record_kinds_ignored`;
`kinds: {spool_expired: 300}` → `telemetry_lost`. *Mutation:* always answer `telemetry_lost`.

**LOSS-3 — a lossy session cannot leave a scoped question.** A session with an in-window loss and no target on
the pinned paths: scoped `readCoverage` reads `incomplete`. *Mutation:* remove the third membership.

**LOSS-4 — a loss older than the window is not a gap.** `newestAt` a day before `since` → `complete`.
*Mutation:* drop the `newest_at > since` term.

**LOSS-5 — an unknown kind still counts and is never stored as text.** `kinds: {"<corpus>": 3}` → stored under
`unattributed`, `loss_total` unchanged, the stored JSON's keys are a subset of `LOSS_KINDS`. *Mutation:* store
the keys as sent.

**LOSS-6 — `ignored` is a counted drop with its kinds.** A hub answering `ignored: 2` with per-record results →
`.drops` carries `reason: "ignored", count: 2, kinds: {claim_revalidation: 2}`; a hub answering zero writes no
line. *Mutation:* read `ignored` as 0.

**LOSS-7 — the report folds every ledger.** Drops by reason, the unrecorded marker, the loss ledger's keyed and
unkeyed entries; `total >= sum(kinds)`; span from the entries. *Mutation:* leave the marker's count out.

**LOSS-8 — every session call carries the report.** Register, heartbeat and end bodies on an in-process hub carry
`losses` with the right totals; an all-zero machine still sends `total: 0`. *Mutation:* drop `losses` from the
heartbeat body.

**LOSS-9 — the two reasons render, without a count and without a path.** The clause for each carries the instant,
the age, no `%`; the corpus planted in `gapSince` never prints through. *Mutation:* remove `telemetry_lost` from
the label map.

**LOSS-10 — doctor names the contradiction and nothing else.** Local losses + hub `complete` → WARN; local losses
+ hub `telemetry_lost` → PASS; no local losses → PASS. *Mutation:* WARN on `incomplete` too.

**LOSS-11 — the capture cap, the secret path and the outside-root edit are counted.** Twenty-five paths → five
`capture-capped`; a path with a token → one `secret-path`; an edit outside every root → one `outside-root`; a
READ outside every root → none. *Mutation:* stop counting the cap.

**LOSS-12 — a hook that runs out of budget is a counted loss, keyed when it can be.** A PostToolUse whose handler
outlives its budget appends `hook_timed_out` with `detail: "post-tool-use"`. *Mutation:* record nothing on
timeout. And the budget is measured, not asserted: SessionStart p95 with and without the report.

**LOSS-13 — host drift and unobserved wire lines reach the ledger.** A Cursor `afterFileEdit` with no
`file_path` appends `host_contract_drift`; an ACP engine that skipped an oversized line appends `wire_unobserved`
at shutdown. *Mutation:* drop the Cursor append.

## 8. Refusals

1. **No per-record loss detail on the hub.** Counts and kinds only. The hub stores no path, no record kind name,
   no hook name; those stay in the machine's ledgers for doctor.
2. **No third `complete` reason for "never reported"** (§4.7): a reason that says *complete* while meaning *we
   could not tell* is the silent absence AT-10 forbids in a new shape.
3. **No cross-repo attribution of foreign-repo drops** (§4.8.1): a repo id may belong to another hub.
4. **No `gapSince` clamping** (§4.5).
5. **No new render surface, no new endpoint, no new table.**
6. **Not measured here:** the fraction of real installs that flip to `incomplete` on upgrade — a rollout
   observation for Nick (§10.3). The report's read cost is measured (§4.2).
7. **The seen-set is not a loss and denylist drops are not counted** (§4.8.2, §4.8.3); both are stated so they
   are not mistaken for oversights.
8. **No structural loss kind.** "This host cannot observe X" is a guarantee (01a §3.6), never a `LOSS_KINDS`
   entry (§4.9).

## 9. Collisions and sequencing

**`.github/workflows/ci.yml` — three listings, not two.** New `MUTATIONS` entries bump the count at `:119-120`,
the per-file block after `:127`, and the per-basename block after `:349`; `regen.py` rewrites all three and the
per-test block in the script. `mutation-check.ts` appends at the array tail — the seat every spec shares.

**`server/src/http/schemas.ts:15-19`** says the two session bodies are *strict* objects that would *refuse* an
undeclared field. Under zod 4 a `z.object` strips it (§4.2's directive); the comment's conclusion — the field
must be declared to be read — stands, and the comment is corrected to say why (done with the hub commit).

**`coverage-wire.test.ts:181-187`** pins the three enums. *As built, the two `COVERAGE_REASONS` lists did NOT
change in one commit:* the hub's list changed with the hub commit (164acf2) and the connector's with the next
(8c827c9), so that test is red at 164acf2 alone. History is not rewritten (no rebase on this branch); the lists
agree from 8c827c9 on, and the placement before 05's block is now pinned in both lists by its own test.

**Three existing anchors moved under the loss commits** — the seen-set check, the scoped-read plan and the
coverage age — and matched zero times until re-anchored (dff4149); `anchor-scan` reads `0 broken` again.

**`flush.ts`, `drops.ts`, `append.ts`** — editor after B2-01/B2-07; the `rejected` path is the template and is
not changed. **`capture-targets.ts` / `capture-touched-files.ts`** — the `resolveRoot` directive at
`capture-touched-files.ts:45-47` is unchanged; both flows gain an optional `editFired` (default true).

**01a (guarantees, next)** shares the register body and the coverage read (§4.9); it adds an `order` block and a
per-kind table and touches neither `COVERAGE_REASONS` nor `LOSS_KINDS`. **04 (verdict)** consumes `isJudgeable`,
unchanged. **07 (pilot)** stores the five triples as observed (`services/pilot.ts:386`); the new reason values
flow through as strings. **01** owns the seq vocabulary; nothing here touches `session_events`.

## 10. Decisions for Nick

1. **Report on register + heartbeat + end, or heartbeat only?** *Default: all three.* Register is the call right
   after reap, where expiry and unclosed counts are written; end is the last word. Cost: three call sites in the
   shared flows instead of one.
2. **A hook that dies before repo identity is charged to every repo on the machine** (§4.3). *Default: yes.*
   Exact on one-repo machines, over-reporting in the safe direction on many-repo machines. The alternative —
   charge it to no repo — is a known loss with no coverage reason, which the contract forbids.
3. **Rollout.** Every repo whose connector upgrades and whose ledgers hold a loss newer than fourteen days reads
   `incomplete` the moment its next heartbeat lands — on Nick's machine, on the first PostToolUse. That is the
   truth this note exists to state; whether the fleet is told first is a rollout note, not a code decision.
   **Decided by Nick 2026-10-02:** Ken and Mike are told in the update message that the new `incomplete` is
   correct — the losses were always there and are now counted — and not a new defect. No code change.
4. **Pins on denylisted paths** (§4.8.2) are a permanent attribution blind spot that no coverage rule can see.
   *Recommendation:* 04's pin registration refuses a path the default denylist matches, by name in the refusal
   list. Not built here.
   **Decided by Nick 2026-10-02: refuse. Built, in the CLI.** `crosscheck pin "<surface>" --files …` refuses
   the pin when the effective denylist excludes any of its files, and stores nothing. The list is the one capture
   applies on this machine — `resolveDenylist(config.denylist)`, the shipped defaults extended or replaced by
   `denylist` in the stored config — never a second copy of the rule (`cli/src/cli/pin.ts`, `Resolved.patterns`).
   The refusal names each excluded file with the rule that excludes it and says why in one sentence: *no
   session's touch of these files is ever recorded, so a guard over them could never say who broke them*
   (`cli/src/cli/pin-observability.ts`, `deniedPinPaths` and `pinDenylistRefusal`; the status and doctor shadow
   line ask the same `deniedPinPaths`). `crosscheck pin --sweep` never moves a pin onto such a path: a rename git
   followed into an excluded path goes to the hub as `missing`, so the pin reads BROKEN, and the sweep names the
   move and the rule. Those are the only two writers of pin paths (`createPin` and `sweepPins`, routes
   `POST /api/pins` and `POST /api/pins/sweep`); `--broke`, `--ok` and `--waive` add no path.
   *The hub does not refuse.* The list that decides capture is per machine: `denylist` lives in each
   developer's `~/.crosscheck/config.json`, may extend or replace the defaults, and never reaches the hub, and
   the server does not depend on connector-core, where the matcher lives. A hub-side check would be a second copy
   judging a list it cannot see: it would refuse a pin a `replace` team captures, and pass one a teammate's
   `extend` line blinds. *What still gets through:* a CLI older than this build, and a direct `POST /api/pins` or
   `POST /api/pins/sweep` with an api key, can still register a pin on an excluded path or move one there; and a
   pin made on one machine can be blind on a teammate's whose denylist differs. For all three the backstop is
   unchanged: `status` and `doctor` WARN `pin denylist` on every machine whose effective denylist shadows a live
   pinned path, naming the path and the pattern. Test: cli `pin-denylist-door`; anchors "a pin over a file the
   denylist excludes is registered as a guard", "the pin door asks the shipped denylist instead of the one this
   machine's capture applies", "the pin door names only the first file the denylist excludes", "the pin door
   refuses without saying why an excluded file can never be guarded", "a sweep moves a pin onto a path no capture
   observes", "a sweep records an excluded rename as missing without saying why".
   **Extended 2026-10-05 (Nick: as recommended): the door also refuses on the shipped defaults.** `deniedPinPaths`
   — the one question the door, the sweep, `status` and `doctor` ask — checks this machine's effective list AND
   `DEFAULT_DENYLIST`, because the list is per machine: a developer whose config replaces the defaults still has
   teammates who kept them, and on each of those machines a pin over `yarn.lock` is blind while it reads as a
   guard. Every match carries whether it binds this machine too (`here`) and which shipped rule matches it
   (`shippedPattern`, decided by a match, never by comparing rule text). That keeps each sentence true where it
   is read: a file this machine records is named as *never captured on machines that keep the shipped denylist*,
   never as unrecorded "no matter who did"; and the config remedy is offered only when some file is excluded by
   this machine's list alone, since no config here can lift a shipped rule. *The cost, stated:* a team whose every
   machine replaced the defaults can no longer pin a shipped-excluded file through the CLI — the conservative
   side, and the refusal points at the files those are made from. The first build of this extension judged
   "shipped" by the first matching rule's text and called every such file unrecorded everywhere; the adversarial
   review of 2026-10-05 found both, and both are fixed. Anchors "the pin door judges a pin by this machine's
   denylist alone", "a shipped rule is recognised by its text instead of by a match", "a file only the shipped
   list excludes is called excluded on this machine", "the shadow line calls every shadowed file never captured
   by anyone", "a pin refused by shipped rules is told to change the config", "a sweep says no session records a
   file this machine records", "a pin refused by shipped rules does not say they bind teammates".
5. **Loss outranks reap in the reason word** (§4.5). *Default: yes.* The alternative keeps 03's word on repos
   that have both, and hides the one with the different remedy.
6. **ACP wire lines are charged to every repo** (§4.3, the three writers). *Default taken: yes* — decision 2's
   rule, applied to a line that names no session. A chatty agent printing non-protocol lines on stdout marks
   every connected repo `incomplete` for fourteen days after its proxy exits.
7. ~~A capture-loss ledger at its cap keeps the newest loss "current" until cleared.~~ *Superseded by review
   H1:* the refusal marker dates every refused loss, so a full ledger ages out fourteen days after its last
   refusal; only a full ledger with no readable marker still reads "current". Doctor names the full ledger and
   when the file can be removed safely (fourteen days after its last write by any repo). Compaction is still not
   built; *recommendation unchanged:* fold old lines into an archive at reap, the race designed (rename, then fold).
8. **The git lane's cut counts every unexamined dirty path** (review M5). Paths past `MAX_GIT_TOUCH_CANDIDATES`
   (60) are booked `capture-capped` on every Stop, stale ones included: a worktree that stays more than 60
   files dirty reads `incomplete` for as long as it does. *Taken because their freshness is unknown.*
   *Alternative:* stat more candidates (a stat is microseconds; the bound guards against thousands) and count only
   the remainder.
   **Decided by Nick 2026-10-02: the alternative. Built.** `MAX_GIT_TOUCH_CANDIDATES` is now 2000
   (`connector-core/src/constants.ts`, where the measurement is written down): the lane's own loop, one
   sequential `stat` per path, took 21.7 ms median and 22.7 ms worst for 2000 paths on an Apple M4 Max under
   Bun 1.3.13 (about 11 µs a stat; 5000 paths took 59 ms). The rule is that the stat pass at the bound costs at
   most a tenth of the lane's own 250 ms git deadline, inside a Stop budget of 800 ms by default. A stale dirty
   path within the bound is examined and books nothing; every path past it is still booked `capture-capped`,
   so a worktree with thousands of dirty files stays on the weakening side. Downstream of the freshness filter
   nothing is dropped silently: the per-call cap (`MAX_TARGETS_PER_INVOCATION`, 20) books what it cuts as
   `capture-capped` (§3 row 8), the lane's seq block is the same 20, a refused spool append is §3 row 1, and an
   oversized upload batch is retried (§3 row 22). Test: core `capture-losses` §10 item 8; anchor "the git lane
   examines only sixty dirty paths and books the stale rest as lost".
9. **A skipped or unanswered git lane is booked on every turn it happens** (review M5), though the next turn's
   lane (window: the session's start) usually recovers the same touches. *Taken because the last turn's skip and
   a touch reverted before the next run are lost for good.* *Refinement:* book only an unrecovered skip — the
   session's last lane outcome, read at SessionEnd.
   **Decided by Nick 2026-10-02: kept as is.** Every skip is a loss event; a later successful check must not
   retroactively undo an earlier loss of observation. The refinement is not built. The noise this costs —
   repos reading `incomplete` for a skip a later turn recovered — is measured in the pilot.

Defaults taken in the build: 1 (all three carriers), 2 (null key charged to every repo — narrowed by review M4
to hooks a connected repo could own), 5 (loss outranks reap), 6, 8 and 9 as stated. 3 and 4 are not code
decisions. *Decided by Nick 2026-10-02:* 3 (the update message says the new `incomplete` is correct), 4 (built:
the CLI refuses the pin, the hub does not), 8 (built: 2000 candidates, only the remainder booked) and 9 (kept as
is).

## 12. Review 2026-10-01 — open list

Each finding of the adversarial review was fixed (commits on this branch: C1 1d9e69f + f607d16, M2 the same two,
H1 e468ed8, H2 d68b4f3, H3 c725e47, M1 e08ccb7, M3 3d34150, M4 8204550, M5 a03a970, LOW totals and `__proto__`
in 1d9e69f, LOW recovery register and suite timeout in a752eb5), except these, stated rather than fixed:

1. **`gapSince` can be narrower than the truth — display only.** `min(loss_oldest_at)` skips sessions whose
   oldest is null (now: undatable content), the oldest is when a loss was *recorded*, not when the lost records
   were made, and "lost since X" can show a reap's earlier instant. Coverage state never depends on it.
2. **Clock skew.** A connector clock behind the hub's places fresh losses before a narrowed search `since`, which
   then reads `complete`. The window is 14 days for the agent rung; narrowed scopes are the exposure.
3. **A conference session registers without the report** (`cli/conference.ts`). It has no heartbeat, so its row
   reads "never reported" and contributes no loss — the pre-loss behaviour. Strengthening only if it is the only
   session in the window *and* the machine's ledgers hold an in-window loss. Not fixed: its register runs only
   after a model produces a finding, and no cheap test reaches it.
4. **An old connector against a new hub loses the reason word**: the two new reasons fail an old client's strict
   enum per row, so a rung that read `incomplete / session_reaped` reads `unknown / hub_did_not_report` where a
   loss outranks the reap. Fails closed; §4.7 did not cover it.
5. **The ddl-sync test named "reach an EXISTING hub" runs on a fresh database** (text check plus a fresh
   bootstrap). An upgrade test from a pre-loss schema is the honest version.
6. **Privacy residue.** Unkeyed loss instants from other repos (and hubs) on the machine reach this repo's hub,
   as counts and timestamps only — never a path, kind name or key.

## 11. As built

Every LOSS-n has its test and at least one anchor in `connector-core/scripts/mutation-check.ts`, each proven
`caught` with `prove-labels` (`anchor-scan`: 1085 anchors, 0 broken, after the review's fixes). Each review
finding's guards carry the finding's name in the label's comment block at the tail of `MUTATIONS`.

| | test (package/test) | anchors (label) |
|---|---|---|
| LOSS-1 | server `coverage-losses` LOSS-1 | a reported loss leaves the agent rung complete · a report of zero turns the rung incomplete · an absent loss report is stored as a report of zero · the loss instant never reaches gapSince |
| LOSS-2 | server `coverage-losses` LOSS-2, outranks | an ignored record kind is answered as an ordinary loss · a reap outranks a reported loss in the reason word |
| LOSS-3 | server `coverage-losses` LOSS-3 | a lossy session leaves a scoped question |
| LOSS-4 | server `coverage-losses` LOSS-4 | a loss older than the window still gaps the window |
| LOSS-5 | server `coverage-losses` LOSS-5; schema `telemetry-loss`; server `ddl-sync` | a loss kind the hub does not know is stored under its own name · the loss-kind fold keeps a key the hub does not know · an existing hub never gains the loss columns |
| LOSS-6 | core `spool-ignored` | the flush reads the hub's ignored count as zero · an ignored drop forgets which record kinds the hub ignored |
| LOSS-7 | core `loss-report` | the loss report leaves the unrecorded marker's count out · an archive from before reasons reports its count under no kind · the four read-back rules (§4.3) and the two prototype-key anchors |
| LOSS-8 | core `session-losses` | the heartbeat body leaves the loss report behind · the heartbeat flow reads the report and never sends it · registration never carries the post-mortem losses · a session's end never carries its last report |
| LOSS-9 | core `coverage-render` (both sentences, corpus in `gapSince`); core `coverage-wire` (placement) | the telemetry_lost reason renders as a session that went quiet · the record_kinds_ignored reason renders as a session that went quiet · a loss sentence prints the hub's gapSince as sent |
| LOSS-10 | cli `doctor-losses` | doctor calls a hub that recorded the loss an old hub · doctor never names a hub that stripped the loss report · doctor holds a loss older than the hub's window against the hub · doctor drops the coverage-reporting line on its way out · doctor never prints the record kinds an older hub ignored · status never prints the losses line |
| LOSS-11 | core `capture-losses` | paths past the per-call cap are cut without a count · a path the secret scan refuses is dropped without a count · an ACP read the cap cut is counted as a lost edit · an edit outside every root of the repo is dropped without a count · a read outside every root is counted as a lost edit |
| LOSS-12 | claude `hook-timeout-loss`; cursor `drift-loss`; claude `capture-latency` (measured, §4.2) | a hook the budget abandoned leaves no loss behind · a hook the budget cut before its repo resolved books no loss · an abandoned hook's loss is never keyed to its own repo · a cursor-hook the budget abandoned leaves no loss behind |
| LOSS-13 | cursor `drift-loss`; acp `wire-loss` | a drifted Cursor payload never reaches the loss ledger · an ACP wire line the observer could not read never reaches the loss ledger · an ACP wire line past the pending cap never reaches the loss ledger |
| ledger | core `loss-ledger`, `loss-report` | a loss no repo could be named for is charged to no repo · the capture-loss ledger grows without bound · a capture-loss detail is stored as the writer passed it · an ignored line keeps a record kind outside the connector's vocabulary · a reason word a hand edit planted in a ledger reaches the terminal as written |
