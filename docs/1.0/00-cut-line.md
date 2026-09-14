# The 1.0 cut line — scope, acceptance tests, proofs

Recovered 2026-09-14 from the published "Crosscheck 1.0 Cut Line" artifact after
both `/private/tmp` copies were lost to a reboot. It lives in the repo now for
exactly that reason: a scope decision that only exists in a temp directory is a
scope decision the next session has to re-invent.

Written against `origin/main` at e9aab82 (v0.9.0). Where this document and the
code disagree today, the code wins and the spec that touches it says so.

---

## Tier 1 — the 1.0 foundation

No open hypothesis. These are built because the answer is already known, not
because a pilot will tell us something.

- **Claim ↔ code binding.** Observed-at commit, affected surface, validity
  state, last revalidated, superseded by. Resolve the collision with the
  existing clock-based `stale_at` — one authoritative definition, not two
  silent ones.
- **Individual commit identity.** Hashes, not just counts and a latest
  timestamp.
- **Coverage integrity reaching the answer layer.** Every surface that asserts
  what the team knows carries the qualifier.
- **A per-session monotonic event sequence.** Happens-before, never wall clock.
- **A production writer for human authority.** An agent may not certify its own
  work.
- **Verdict semantics** — attributed, unattributed, indeterminate.
- **Fence authority and the human waiver.** Extend the garden fence already in
  flight; do not restart it.
- **Pilot instrumentation** for the five proofs below.

## Tier 2 — provisional, the pilot decides the shape

Built as a v1 because waiting produces data that cannot answer the question.

- Structured intent: desired delta, expected surface, non-goals, plus amendments.
- CI ingestion keyed to a commit, including a re-run of the same commit to
  separate flake from regression.
- The fence ratchet — how an invariant is promoted and tightened.
- A counterfactual injection benchmark across providers.
- The two evidence axes plus the calibration measurement over time.

## Tier 3 — cut from 1.0

Prepare the data model where it costs nothing; do not build the feature.

- Conference. Interesting, not load-bearing.
- Semantic collision detection. Keep file overlap as the sensor and stop
  promising more than it does.
- Auto-generated behavioral probes; runtime invariant mining.
- Elaborate change envelopes.
- Heavy intent inference from agent prose. Ask the agent to declare; do not
  guess from chatter.
- Calibration scoring surfaces. Collect the data, build the UI once it says
  something.

**Order of work:** git and code-state binding move ahead of the injection
benchmark. They are the only item that pays into three problems at once —
staleness, ground truth, and coverage integrity. Everything else buys one thing.

---

## The ten acceptance tests

Each is written so it can fail. The line under each one is the condition that
makes it fail — that is the part that has to be executable, not aspirational.

### AT-1 — Never "no prior work" under a coverage hole

With a teammate's connector silent for three days while their commits land, a
search that finds nothing must answer *"nothing in what was observed — coverage
incomplete for commits A..F since Friday 08:13."*

**Fails if** any code path can emit an empty-result phrasing while an absence
exists for that repo.

### AT-2 — A claim's authority decays with its code, not with the clock

A root cause recorded at commit X, after the affected symbol has been
substantially rewritten, stays readable but is no longer presented as a current
cause — and the downgrade names the commits that caused it.

**Fails if** a claim can be surfaced as current with no commit binding, or if
two staleness definitions disagree without one being authoritative.

### AT-3 — An agent cannot certify its own work

No claim written through an agent tool carries human authority. The human path
is separate and attested.

**Fails if** `publish_claim` or any agent surface can produce human capture
mode, or if the attempt is silently downgraded instead of refused.

### AT-4 — Declared-before is distinguishable from declared-after

Given a session that widened its intent, the system can say whether the
amendment preceded or followed the edit that exceeded the original scope.

**Fails if** the answer depends on wall-clock timestamps from two processes
rather than a monotonic per-session sequence.

### AT-5 — Unattributed requires complete coverage

A broken behavior may be labeled unattributed only when observation over the
relevant commit range was complete. Otherwise the verdict is indeterminate, and
it says why.

**Fails if** unattributed is reachable with a known coverage gap — the failure
mode that turns a reliability tool into a false accusation.

### AT-6 — A human fence outranks an agent

An agent cannot delete, weaken, or waive a human-declared invariant. A waiver is
human, recorded with author and reason, and expires.

**Fails if** any agent-reachable path mutates a human invariant, or if a waiver
has no expiry.

### AT-7 — Injection is measured by behavior, not by quoting

The same task twice: control without the hostile foreign claim, treatment with
it. Compare tool calls, files read and written, shell commands, plan changes,
final result. Attack success rate must be zero, per provider, measured.

**Fails if** the only evidence is that the text was correctly framed. Framing is
not behavior.

### AT-8 — A red test alone is not a regression

A fence fires only when the invariant's own verification ran and failed, *and*
the same verification was green at a named commit. Re-run the same commit to
separate flake from regression.

**Fails if** a test that was always red, or one failing for an environment
reason, can produce an attribution.

### AT-9 — Silence is loud everywhere, not only in doctor

Every surface that makes a claim about what the team knows carries the coverage
qualifier — briefing, search, hints, fence verdicts.

**Fails if** a person has to run doctor to learn that an answer was based on
partial observation.

### AT-10 — Provider parity is a contract test, not a claim

Each connector's conformance number is produced by running the contract suite. A
rung a platform genuinely cannot serve appears as a documented refusal in doctor.

**Fails if** there is any silent absence, any fake pass, or any published score a
third party cannot reproduce.

---

## The five proofs

Mutation counts are a strong engineering signal and the wrong argument for a
buyer. These five are what a VP Engineering buys on, and all five are **unknown**
until the trial has more than one reporting person.

1. **Duplicate investigations prevented** — over eight weeks, with the
   counterfactual named: what was surfaced, to whom, and what they would
   otherwise have re-investigated.
2. **Collisions caught before merge** — with the true and false split stated up
   front, and how many would plausibly have caused a regression.
3. **Attribution accuracy** — of N fence firings, how many named the change the
   eventual fix actually touched. Checked against the fix, not against opinion.
4. **Proactive precision** — helpful interventions per 100 sessions and the
   false proactive rate, with the target set before the measurement. This is the
   metric that decides whether people keep the tool switched on.
5. **Coverage integrity in the wild** — how often the system knew that it did not
   know, and what fraction of answers were correctly qualified. This is the proof
   no competitor can currently produce.

---

## Two decisions that are not an engineer's to make

**A — the standard.** The analogy offered was "OpenTelemetry for agentic
software engineering." OpenTelemetry won because it was a neutral standard under
a foundation, *not* a product. If that is the ambition, the canonical event model
and the conformance suite have to be given away and the revenue has to come from
elsewhere. Recommendation: give away the event model and the conformance suite;
earn on the graph.

**B — the merge gate.** "Crosscheck never blocks interactive agent work" stays,
and it does not forbid an enterprise from letting CI block a merge on a red
fence. But the moment a merge depends on it, every false positive becomes a
blocked release and the precision requirement jumps an order of magnitude.
Recommendation: gate only on human-declared invariants whose own verification ran
and failed. Never on anything derived. The gate belongs to CI; crosscheck
supplies the evidence.
