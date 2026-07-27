# crosscheck

> Your agent talks to your teammates' agents — before the code exists.

Crosscheck is a coordination layer for teams where every developer works with a local coding agent (Claude Code first, agent-agnostic later). It shares what git cannot see: who is investigating what **right now**, which hypotheses were already tested and rejected, which root causes are confirmed, and which in-flight changes are about to collide — semantically, not just at file level.

The name is the aviation ritual: *"arm doors and cross-check"* — independent operators verifying each other's work before anything takes off.

## Status

**Design phase.** No code yet. Start here:

- [docs/DESIGN.md](docs/DESIGN.md) — the v0.1 architecture (synthesized from 3 independent design passes + 2 adversarial reviews)
- [docs/RESEARCH.md](docs/RESEARCH.md) — prior-art landscape, protocol verdicts, Claude Code integration surface, storage decisions
- [docs/VISION.md](docs/VISION.md) — where this goes after the foundation, and which foundation decisions keep those doors open
- [docs/CONCEPT.de.md](docs/CONCEPT.de.md) — the original concept document (German)

## The one-paragraph pitch

Two developers debug the same symptom in parallel. Developer A's agent concludes "the bug is in plan resolution." Developer B's agent has already discovered that plan resolution only *surfaces* the bug — the root cause is a missing entity mapping at import. Today these two investigations never meet until conflicting PRs appear. With crosscheck, B's agent extends A's diagnosis ("your root cause is my symptom"), and A's agent gets that finding injected into its context before it builds the wrong fix. GitHub sees the past; crosscheck sees the present.
