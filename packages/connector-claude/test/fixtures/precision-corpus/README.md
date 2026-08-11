# Golden-fixture precision corpus

The pre-launch tuning instrument named in DESIGN.md §4's telemetry bullet: a
2-developer team will not generate tuning volume for months, so the injection
pipeline's thresholds are held to a hand-labeled fixture corpus until real
`hint_deliveries` telemetry exists. §10 risk 1 is the reason it matters —
noise → trust collapse → uninstall — and this corpus is what keeps a
threshold or ranking change from degrading silently.

## Honesty: what these floors are and are not

**Every threshold this corpus exercises was chosen by reasoning, not data.**
The probe labels encode TODAY'S intent: what the current design says should
happen, decided at a desk. The metric floors sit at 1 because the corpus is
labeled to match defensible current behavior — not because the product is
believed perfect. The real tuning loop is the `hint_deliveries` telemetry
from the trial (delivered vs pulled); when telemetry contradicts a label,
relabel the probe WITH a rationale, or change the threshold RED-first with
the corpus updated in the same change. Never silently tune a threshold to
make the corpus pass, and never lower a floor without a written rationale
here.

Where current behavior is defensible but debatable, the probe says so in its
rationale instead of the corpus pretending the question is settled. Current
debatable probes:

- `pr_contra_debatable` (09): one side of a live cross-author deadlock is
  injected as substance — the tree is correctly unsolved for ranking, but the
  selector has no dispute gate.
- `pr_limits_oneword_debatable` (04): a prompt sharing exactly ONE
  mid-frequency word with one claim body receives full substance. Today's
  precision floor is tier membership alone (exact/fts), with no
  matched-token minimum and no rank floor. Building this corpus surfaced the
  same single-token path three times before the fixture vocabulary was
  disciplined ("key", "across", "retries" each delivered cross-domain
  hints), so this probe pins the behavior openly rather than hiding it.

## Harness-can-fail proof

A green harness is decoration until it has been watched going red for the
right reason. Two proofs, both against this corpus:

- Continuous: `scripts/mutation-check.ts` re-introduces "derived provenance
  counts as vouched" (`hints/select.ts` `isDeclared` → any non-empty
  provenance) and `test/precision-corpus.test.ts` must red on
  `pr_thumbs_derived` (substance precision, pointer discipline and pointer
  recall all fall below floor).
- Recorded at build time (2026-08-11): `SOLVED_DECAY_FLOOR = 0` in
  `packages/server/src/services/search.ts` turned exactly
  `pr_idx_solved_recall` red — "expected substance, observed pointer" — the
  70-day solved tree decayed below the three fresh noise contexts and fell
  out of `HINT_MAX_CONTEXTS`. Both edits were reverted; the suite is green
  at HEAD.

## What the harness drives

`drive.ts` seeds one REAL hub (`@crosscheck/server` over HTTP: real ingest
route, real search/hints/tripwire services, PGlite, frozen clock) and runs
every probe through the REAL connector hook entry points (`runHook` —
selector, seen-set, denylist, budgets, renderers all production code). No
selection logic is reimplemented. No embedder is configured: the corpus pins
the keyless default install's lexical behavior (DESIGN.md §6).

Determinism: the hub clock is frozen at `CORPUS_NOW_ISO`
(2026-08-01T12:00:00Z) and every fixture timestamp is fixed data, so decay,
tier eligibility, presence and the solved floor are identical on every run
and platform. The connector's wall clock feeds only display ages, which
classification never reads.

## File format

`developers.json` — the cast, shared by all scenarios:

```json
{
  "developers": [{ "name": "Riley", "email": "riley@corpus.test" }],
  "mutes": [{ "reader": "Morgan", "muted": "Vic" }]
}
```

`presenceOptOut: true` on a developer applies the hub-side presence opt-out
before any probe runs. Mutes are stored hub-side per reader, like the CLI
would.

`scenarios/*.json` — one scenario per file, loaded in filename order and
validated against the zod schemas in `format.ts` (unknown fields are
errors). All scenarios seed ONE hub together, so vocabulary is a shared
namespace: a content word reused across scenarios can make one scenario's
context a candidate for another scenario's probe. Keep meaningful stems
unique per scenario unless the collision is the point of the probe.

```json
{
  "id": "auth-jwt",
  "summary": "One sentence on what this scenario exercises.",
  "sessions": [
    {
      "id": "s_robin_auth",
      "developer": "Robin",
      "branch": "fix/jwt-rotation",
      "baseCommit": "c0ffee01",
      "status": "analyzing",
      "ended": false
    }
  ],
  "workContexts": [
    {
      "id": "wc_auth",
      "sessionId": "s_robin_auth",
      "title": "Login 500s after JWT key rotation",
      "status": "analyzing",
      "createdAt": "2026-07-30T12:00:00.000Z"
    }
  ],
  "targets": [
    { "workContextId": "wc_auth", "kind": "file", "value": "src/auth/refresh.ts" }
  ],
  "claims": [
    {
      "id": "clm_auth_neg",
      "workContextId": "wc_auth",
      "authorSessionId": "s_robin_auth",
      "kind": "rejected_approach",
      "body": "Reverting the edge proxy config does not stop the login 500s",
      "status": "rejected",
      "confidence": 0.8,
      "captureMode": "agent",
      "provenance": "declared",
      "evidenceRefs": ["clm_auth_obs"],
      "createdAt": "2026-07-31T09:00:00.000Z"
    }
  ],
  "edges": [],
  "probes": []
}
```

Field notes:

- Timestamps are ISO-8601 UTC, FIXED — place them relative to
  `CORPUS_NOW_ISO`, spanning fresh (hours) to stale (60+ days). Distinct
  values wherever ordering matters (claims in one context, sibling
  contexts).
- `sessions[].ended: true` ends the session AFTER its records are ingested
  (a live hub rejects late writes from ended producers). Sessions register
  at the frozen now, so a non-ended session reads as an ACTIVE teammate to
  the tripwire.
- Records are ingested through the real `/api/records` route by their
  authors, in order: contexts, targets, claims, edges — forward references
  within one array will be rejected by the hub, so order arrays by
  dependency.
- Claim/edge enums are the wire enums of `@crosscheck/schema` and invalid
  fixtures fail the seed loudly (the harness refuses a non-accepted record).

## Probes

A probe is one reader turn against the fully seeded hub: a `prompt`
(UserPromptSubmit path) or a `file-touch` (PreToolUse tripwire path), run as
`reader` with a fresh session state.

```json
{
  "id": "pr_auth_substance",
  "kind": "prompt",
  "reader": "Riley",
  "prompt": "why does src/auth/refresh.ts still 500 after the key rotation",
  "expect": "substance",
  "expectClaimId": "clm_auth_neg",
  "expectContextId": "wc_auth",
  "atSessionCap": false,
  "seenClaimIds": [],
  "rationale": "REQUIRED: why this label is right under today's thresholds."
}
```

Outcome classes:

- `substance` — a claim hint arrived (`crosscheck hint:`), and when
  `expectClaimId` is set, that claim's body framed in « » is the one
  delivered; `expectContextId` pins the source tree.
- `pointer` — a pointer arrived (`crosscheck pointer:`), or the tripwire
  asked (`permissionDecision: "ask"` — pointer-class by construction: it
  names a context, never a claim body).
- `silence` — the hook emitted nothing. For SILENCE probes silence is the
  assertion, not a pass-by-default.

`atSessionCap` pre-fills the session's delivered-hint refs to
`MAX_HINTS_PER_SESSION`; `seenClaimIds` pre-marks refs as delivered
(seen-set probes).

## Metrics and floors

Computed over all probes by `drive.ts`, asserted in
`test/precision-corpus.test.ts` against the named `FLOOR_*` constants:

- substance precision — correct substance / all substance delivered
- substance recall — correct substance / probes labeled substance (an
  always-silent selector must not pass)
- silence correctness — silence probes that stayed silent / silence probes
- pointer discipline — pointer probes NOT delivered as substance / pointer
  probes
- pointer recall — pointer probes delivered as pointers / pointer probes

Failures print one diff line per wrong probe (expected vs observed, plus the
rendered text), so a threshold change names exactly which team situations it
altered.
