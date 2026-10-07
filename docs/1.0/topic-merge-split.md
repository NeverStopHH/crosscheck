# Merging and splitting topics — the model, the resolution path, the follow-up

Status: **specified, not built.** The topic model this needs ships on `feat/topic-contexts`
(DESIGN.md §3 "One session, many topics"); the two human operations and the readers' resolution
are the follow-up below. Why the operations were not built with it is §6.

## 1. Why a person needs them

The topic rules (`connector-core/src/flows/topic-rules.ts`) are deterministic and CONSERVATIVE:
when a move in a worktree cannot be proven to continue a topic — a rewritten history, a branch cut
from elsewhere, a continued branch whose first edit touches files the topic never touched — they
open a new topic, because one topic hiding two pieces of work hides a collision, while two topics
for one piece of work only split its evidence. A person sometimes knows better:

- **merge**: two topics are one piece of work (the follow-up branch whose first edit was a new
  file; the same fix redone after a rebase);
- **split**: one topic is two pieces of work (a long-lived branch reused for an unrelated job, a
  detached HEAD on top of the work used for a different investigation, a continuation that only
  shared a config file).

## 2. What the shipped model already guarantees

1. **An id never changes and never names a branch.** A topic is `<rootKey>.<ordinal>` — the first
   12 hex of sha256(repo, worktree root) and its ordinal in that root — and its work context is
   `wc_<life>~t<id>` (`flows/topic-contexts.ts` `mintTopicId`). A merge or a split therefore never
   rewrites an id: it ADDS a record, and every record already on the hub keeps the id it was sent
   under.
2. **The affinity is explicit.** A topic carries its root, every branch the rules attached to it
   in the order they joined, the commit it was last seen at, and its files (its `~t<id>/` seen-set
   entries) — exactly the subsets a split moves.
3. **The hub holds what a selector needs.** A topic is one `work_contexts` row with `branch` and
   `base_commit`; each of its `work_context_targets` rows carries `created_at` (first sighting),
   `last_seen_at` and `source`.

## 3. The model: one append-only alias table

```
work_context_aliases
  id                      text primary key            -- wca_<uuid>
  repo                    text not null
  kind                    text not null               -- 'merge' | 'split' | 'revoke'
  from_work_context_id    text not null references work_contexts(id)
  to_work_context_id      text     references work_contexts(id)   -- null on 'revoke'
  selector                jsonb                        -- 'split' only, §3.2
  revokes                 text     references work_context_aliases(id)   -- 'revoke' only
  created_by_developer_id text not null references developers(id)
  created_at              timestamptz not null default now()
  index (from_work_context_id, created_at), index (to_work_context_id)
```

Rows are never updated or deleted. Undoing an alias is a `revoke` row naming it; resolution reads
the non-revoked rows only. **Who may write one**: the developer who owns BOTH contexts. Merging a
teammate's context into one's own is refused — DESIGN.md §3: never merge across authors,
provenance is the product.

### 3.1 Merge B → A

Every reader treats B's records as A's. Merges compose: C → B → A resolves C to A. A merge whose
`to` already resolves to its `from` is refused (409), so no cycle can be written, and resolution
follows at most `MAX_ALIAS_DEPTH` = 8 hops (a depth past it is refused at write, never truncated at
read). B stays readable by id — `get_diagnosis B` prints `merged into A` above its tree — and
disappears from every listing.

### 3.2 Split A → A′

A new work context A′ is created by the split (hub-minted `wc_<A's life>~s<uuid>`, the session of
A, a title the person gives, `branch` the selector's branch or A's), and the alias names which of
A's records are A′'s:

- `{"since": "2026-10-07T10:00:00.000Z"}` — A's targets first seen at or after the instant;
- `{"since": …, "paths": ["src/a.ts", …]}` — of those, only these values;
- `{"branch": "feat/x"}` — the targets A received while `feat/x` was the branch its worktree was
  on. The hub does not know that timeline today: the follow-up has the connector send it, as
  `branches: [{name, joinedAt}]` on the topic's work_context update whenever the rules attach a
  branch (`withTopicCapture`'s relabel), and the hub resolves a branch selector to the window from
  that branch's `joinedAt` to the next branch's.

Claims follow the same window when the selector names no paths, and stay on A when it does — a
claim is about the work, not about one file.

### 3.3 The resolution path

One place resolves, and every reader goes through it: two views.

- `resolved_targets(work_context_target_id, work_context_id, kind, value, …)`: each target row
  with its CANONICAL context — first the newest non-revoked split of its own context whose
  selector matches the row (splits of a split applied in creation order), then the merge chain
  from there to its root.
- `resolved_work_contexts`: the contexts no merge points away from, each with the canonical ids
  folded into it.

**A merge never double-counts**: every count a reader takes is over canonical ids, so B's and A's
shared files with a teammate are one context's. **A split never orphans**: every target row
resolves to exactly one visible context, because a split's `to` is a real row and the views are
total over `work_context_targets`.

### 3.4 The readers that move to the views

Every service that reads `work_context_targets` or lists `work_contexts` today:
`services/hints.ts` and the work-contexts listing route (briefing); `services/ghost-overlap.ts`,
`contradictions.ts`, `conference.ts` (overlap); `landed.ts`, `landed-context.ts`, `diagnosis.ts`,
`solved-matches.ts`, `solved.ts`, `suspect.ts`, `referee.ts`, `pins.ts`, `evidence-axes.ts`,
`coverage.ts`, `pilot-report.ts`, `search.ts`, `normalized-doc.ts` (outcomes, search, measurement).
Each swaps `work_context_targets` for `resolved_targets` and its context listing for
`resolved_work_contexts`; none changes what it computes.

### 3.5 The connector

Nothing changes there for correctness: after a merge the connector keeps sending under B's id,
and after a split it keeps filing new touches under A — the hub resolves both, because a split's
window is open-ended and every later target falls inside it. Optional: the connector reads its
repo's aliases at SessionStart and relabels, so new touches go to A′ directly.

## 4. The operations

- hub service `services/topic-aliases.ts`: `mergeTopics(from, into)`, `splitTopic(id, selector,
  title)`, `revokeAlias(id)` — ownership, same-repo, cycle and depth checks, one transaction each;
- routes `POST /api/work-contexts/:id/merge {into}`, `POST /api/work-contexts/:id/split {selector,
  title}`, `POST /api/work-context-aliases/:id/revoke`;
- CLI `crosscheck topics` (this developer's topics on this repo, with their branches and ids),
  `crosscheck topics merge <from> <into>`, `crosscheck topics split <id> (--branch <b> | --since
  <iso> [--path <p>]…) --title <t>`.

No MCP tool: a merge is a person's correction of the model's grouping, and an agent that could
merge its own topics could hide its own collisions.

## 5. Acceptance tests (the follow-up's bar)

- **M1, a merge never double-counts**: two of a developer's topics sharing two files with a
  teammate yield ONE ghost-overlap row after the merge, the conference's duplicated-work tier one
  line, and the pilot report one session-set member.
- **M2, a split never orphans**: Σ targets over `resolved_work_contexts` equals Σ before the split,
  per repo; every target resolves to exactly one visible context; a split by branch moves exactly
  the targets inside that branch's window.
- **M3, append-only**: no UPDATE or DELETE on the table (DDL-sync and a grep guard); a revoke
  restores the previous resolution exactly.
- **M4, ids never change**: a connector that keeps sending under B after the merge has every new
  target resolve to A.
- **M5, authorship**: merging a teammate's context is refused with a sentence saying why.

Each gets a mutation anchor in `connector-core/scripts/mutation-check.ts`, proven caught.

## 6. Why this was not built with the topics

The operations themselves are small; making them SAFE is not. A merge written while the readers
still read raw `work_context_targets` is the double-count this model exists to forbid, so the
operations cannot ship before the reading services of §3.4 resolve through the views — a
cross-cutting change to the hub's read side, with a test per reader, which the reviewer's own bar
("only if small") rules out of the topics branch. What shipped is what makes the follow-up purely
additive: stable ids that never encode a branch, an explicit affinity, and target rows that carry
the instants a selector needs.
