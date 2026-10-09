/**
 * THE RELEASE GATE: the pilot's Nick/Mike collision, end to end, at pilot
 * scale and at PRODUCTION budgets — and negative controls that must stay
 * silent, so nobody reaches 100% recall by warning about everything.
 *
 * THE PILOT. Two developers changed 11 shared files over two days and
 * crosscheck warned nobody. 180 of Nick's 190 files reached the hub; three
 * things hid them: (a) one long detached session filed every topic under one
 * context titled after a stale branch; (b) a teammate's report stamped that
 * context landed because its base commit was already in main; (c) contexts
 * over 50 files counted as a "sweep" and were excluded. Also: 6 files were
 * created only by Bash and never captured; 91% of edits came from subagents,
 * whose tripwire hits reached only the subagent; hints reached only agents,
 * never a person (157 delivered, 0 opened).
 *
 * AS A DEVELOPER'S MACHINE RUNS IT (release-gate/profile.ts PRODUCTION; the
 * review of batch 2, M12, found the gate blind at 10× budget, one hook at a
 * time, with no session ever resumed):
 *  - production budgets: no CROSSCHECK_TIMEOUT_MS — 400 ms per request, each
 *    hook its ratio (PreToolUse 800 ms, SessionStart 1000 ms);
 *  - every hook a real `crosscheck hook <name>` process, an event's hooks at
 *    once, async hooks in the background (release-gate/host.ts);
 *  - Nick's turn fans out twelve subagents at once, two of them outliving the
 *    turn so `turn-end` and the next prompt race their edits, and the relays
 *    race the workers still running (release-gate/scenario-nick-work.ts);
 *  - his conversation COMPACTS before a Stop, with Bash-only files landing
 *    between the turn's lane and the compaction; after Mike's morning check
 *    it ENDS and RESUMES and works on (L1–L4 read that);
 *  - a warm hub (release-gate/case-kit.ts `warmHub`).
 * Everything else is as real as before: the settings plan that decides which
 * hooks fire, the hub over PGlite on a random loopback port, git repos with
 * worktrees and backdated history.
 *
 * EXPECTED FAILURES (release-gate/expected.ts `BATCH_2_FINDINGS`): an
 * assertion that fails ONLY because of a review finding another track is
 * fixing is a `test.failing`, and that table names the finding, the track and
 * its branch. Every other assertion is plain: red means a gap nobody is
 * fixing yet.
 *
 * DETERMINISM AND RUNTIME: see the lane's job in .github/workflows/ci.yml.
 */
import { afterAll, beforeAll, describe } from "bun:test";
import { rm } from "node:fs/promises";

import { warmHub } from "./release-gate/case-kit.ts";
import { BATCH_2_FINDINGS } from "./release-gate/expected.ts";
import type { Expectations } from "./release-gate/expected.ts";
import { describeGenerated, describeLanded, describeSelf, describeSweep } from "./release-gate/gate-controls.ts";
import { describePilot, describeScaleTwin } from "./release-gate/gate-pilot.ts";
import type { GateContext } from "./release-gate/gate-pilot.ts";
import { startHub } from "./release-gate/hub.ts";
import type { TestHub } from "./release-gate/hub.ts";
import { announceGateLaneSkip, inGateLane } from "./release-gate/lane.ts";
import { PRODUCTION } from "./release-gate/profile.ts";

const FILE = "packages/connector-claude/test/e2e/release-gate-nick-mike.e2e.test.ts";
/** Starting the hub and warming every route a hook calls, unmeasured. */
const WARM_UP_TIMEOUT_MS = 120_000;

/** The findings this lane shows, each with its track and branch (release-gate/expected.ts). */
const EXPECTED: Expectations = BATCH_2_FINDINGS;

const held: { hub: TestHub | null } = { hub: null };
const cleanups: string[] = [];

announceGateLaneSkip(FILE, "production");

describe.skipIf(!inGateLane("production"))("release gate — production budgets, parallel subagents, compaction and resume", () => {
  beforeAll(async () => {
    held.hub = await startHub();
    cleanups.push(...(await warmHub(held.hub)));
  }, WARM_UP_TIMEOUT_MS);

  afterAll(async () => {
    await held.hub?.close();
    await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
  });

  const ctx: GateContext = {
    profile: PRODUCTION,
    hub: () => {
      if (held.hub === null) {
        throw new Error("the gate's hub did not start");
      }
      return held.hub;
    },
    cleanups,
    expected: EXPECTED,
  };

  describePilot(ctx);
  describeScaleTwin(ctx);
  describeGenerated(ctx);
  describeLanded(ctx);
  describeSelf(ctx);
  describeSweep(ctx);
});
