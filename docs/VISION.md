# Vision — beyond coordination

Status: forward-looking, 2026-07-26. Nothing here is scheduled. The foundation described in [DESIGN.md](DESIGN.md) ships first; this document records where the project goes once that foundation is real, and — more usefully — **which foundation decisions were made specifically to keep these doors open**.

The through-line: crosscheck starts as coordination (*who is doing what?*) and becomes collective intelligence (*what does the team, as a system, now know?*).

## 1. Collective memory — cross-session learning

**Today's scope is the present tense:** who is investigating what right now. The temporal dimension is the natural extension.

When a problem is solved, its diagnosis tree — symptom → hypotheses → evidence → confirmed root cause → fix — stops being live coordination state and becomes durable team knowledge. Three months later, a different developer hits a similar symptom and their agent opens with: *"This behavior was diagnosed in March. The visible failure was in competition resolution; the confirmed root cause was the ingestion mapping. Here is that tree, and the two hypotheses that were ruled out with evidence."*

**Why the foundation already supports this:** claims are append-only and nothing is ever deleted — `rejected` and `stale` claims stay queryable as history (DESIGN.md §5 calls this the long-term team-memory byproduct). Once the search block lands (FTS + embeddings over normalized symptom documents), matching *solved* trees against a new symptom is a ranking rule, not a new subsystem. This is the highest-value/lowest-cost item on this page.

## 2. Autonomous synthesis — agent conferences

When several developers are investigating entangled problems in parallel, background agent sessions cross-analyze the accumulated claims overnight and produce one synthesis for the morning: *"Three separate investigations are open. They share one root cause. Here is the evidence chain, and here is what each of you can stop doing."*

**Why this is the riskiest of the four:** it inverts the injection discipline the foundation is built on. Today, unverified hypotheses are only ever offered as pointers the agent must deliberately pull, precisely so a teammate's wrong theory cannot anchor a healthy investigation (DESIGN.md §4). A synthesis document asserts a *shared* conclusion — and a confidently wrong "common root cause" delivered at standup is worse than three separate, honest investigations. If built: opt-in, scheduled, cost-capped, and formatted as the referee output of §4 (evidence for each position) rather than a verdict.

## 3. Ghost commits — simulating side effects at intent level

Before a line of code exists, check whether developer A's *planned* change breaks what developer B is *currently designing*: a shadow integration of two intents, evaluated by an LLM against the actual code, surfacing contract and architecture conflicts pre-implementation.

**Why the foundation already supports this:** `work_contexts.intent` is a first-class jsonb field (planned changes, APIs likely to change, expected side effects), and `work_context_targets` already carries file and symbol granularity. Ghost commits are an escalation *above* the deterministic overlap detection — the tier that catches "different files, incompatible designs."

**Sequencing constraint:** this only works if intent capture is reliable first. Simulating conflicts between two poorly-captured intents produces noise with a very high price tag. Capture quality gates this feature, not model capability.

## 4. Referee mode — structured decision briefs on deadlock

Two agents hold contradictory root causes for the same symptom. The system doesn't block and doesn't pick a winner; it prepares the case file: evidence for position A, evidence for position B, what each side already ruled out, and the one test that would separate them.

**Why this is nearly free:** `contradicts` edges plus per-claim `evidence_refs` *are* the case file. Contradiction candidates (high similarity, opposite status) are already flagged at the ingest gate. Referee mode is largely a renderer over data the system collects anyway — which makes it the natural first item to build after the search block, since it turns those contradiction candidates into something a human can act on in thirty seconds.

## Ordering, if and when

1. **Referee mode** — smallest delta over the foundation, immediately useful.
2. **Collective memory** — a ranking change over data already retained; the biggest compounding return.
3. **Ghost commits** — gated on intent-capture quality, not on model capability.
4. **Agent conferences** — highest cost and highest anchoring risk; only after the injection-precision telemetry (`hint_deliveries`) proves the team trusts what the system says.

None of this changes the v0/v0.5/v1 roadmap in [DESIGN.md §8](DESIGN.md). The point of writing it down is narrower: when a foundation decision looks like over-engineering (append-only claims, typed edges, intent as structured data rather than prose), this is what it is buying.