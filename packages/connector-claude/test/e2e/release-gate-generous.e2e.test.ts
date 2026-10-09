/**
 * THE RELEASE GATE, GENEROUS VARIANT: the pilot's Nick/Mike collision and the
 * negative controls N1–N5, with every hook IN-PROCESS, strictly one at a
 * time, at 4000 ms per request (10× production). It is NOT the release gate —
 * release-gate-nick-mike.e2e.test.ts is, at production budgets, with real
 * hook processes, parallel subagents, a compaction and a resume.
 *
 * WHY IT IS KEPT — ONE THING. It is the only form of the gate that can run
 * inside the ordinary `bun test` on BOTH operating systems CI covers (ci.yml
 * "Test & Typecheck", ubuntu and macOS; the team develops on Macs, and the
 * realistic gate's lane runs on Linux only). In process, the hub's PGlite and
 * the hooks share one event loop: a hub statement blocks the very timer that
 * races it, so a production budget there would measure the harness, not the
 * product — hence the wide budget, and hence one hook at a time (parallel
 * hooks of one session contend for its state lock, and a busy lock is
 * fail-open silence). Under those conditions it pins WHAT the pipeline
 * computes — titles, topics, landed stamps, sweep qualification, coverage
 * rows, the `.env` denylist, silence — on macOS too, deterministically. It
 * says nothing about WHEN: nothing it shows survives a real budget until the
 * realistic gate shows it (review of batch 2, M12: at 10× and one at a time
 * this file could not see H1, H2, M1, M6 or M8).
 *
 * THE PILOT, for the record. Two developers changed 11 shared files over two
 * days and crosscheck warned nobody. 180 of Nick's 190 files reached the hub;
 * three things hid them: (a) one long detached session filed every topic
 * under one context titled after a stale branch; (b) a teammate's report
 * stamped that context landed because its base commit was already in main;
 * (c) contexts over 50 files counted as a "sweep" and were excluded. Also: 6
 * files were created only by Bash and never captured; 91% of edits came from
 * subagents, whose tripwire hits reached only the subagent; hints reached
 * only agents, never a person (157 delivered, 0 opened).
 *
 * NO EXPECTED FAILURES: on feat/crosscheck-batch-1006 every assertion passes
 * here; each case's comment keeps its provenance.
 *
 * RUNTIME: about two and a half minutes — some 1,400 in-process hook runs,
 * plus one deliberate wait per long session (a subagent that outlasts the
 * presence cache; release-gate/scenario-nick-work.ts says why).
 */
import { afterAll, beforeAll } from "bun:test";
import { rm } from "node:fs/promises";

import { NONE_EXPECTED } from "./release-gate/expected.ts";
import { describeGenerated, describeLanded, describeSelf, describeSweep } from "./release-gate/gate-controls.ts";
import { describePilot, describeScaleTwin } from "./release-gate/gate-pilot.ts";
import type { GateContext } from "./release-gate/gate-pilot.ts";
import { startHub } from "./release-gate/hub.ts";
import type { TestHub } from "./release-gate/hub.ts";
import { GENEROUS } from "./release-gate/profile.ts";

const held: { hub: TestHub | null } = { hub: null };
const cleanups: string[] = [];

beforeAll(async () => {
  held.hub = await startHub();
});

afterAll(async () => {
  await held.hub?.close();
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

const ctx: GateContext = {
  profile: GENEROUS,
  hub: () => {
    if (held.hub === null) {
      throw new Error("the gate's hub did not start");
    }
    return held.hub;
  },
  cleanups,
  expected: NONE_EXPECTED,
};

describePilot(ctx);
describeScaleTwin(ctx);
describeGenerated(ctx);
describeLanded(ctx);
describeSelf(ctx);
describeSweep(ctx);
