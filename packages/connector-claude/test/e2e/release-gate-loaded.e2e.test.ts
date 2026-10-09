/**
 * THE RELEASE GATE UNDER LOAD: the realistic gate's scenario
 * (release-gate-nick-mike.e2e.test.ts — production budgets, real hook
 * processes, twelve subagents at once, a compaction and a resume) on a
 * machine whose every core is already busy with someone else's work
 * (release-gate/burners.ts: one spinning process per core, started after the
 * hub is warm, stopped by PID when the file ends).
 *
 * THE STANDARD (release-gate/profile.ts LOADED): a starved machine may cut a
 * fail-open hook — but never silently. Wherever a PERSON must be told of a
 * collision, the line must reach them OR the connector must have booked a
 * line that says why (release-gate/gate-checks.ts `collisionBookings`: a
 * landed-check cut or a briefing omission does not say why an edit's
 * collision went untold). Everything else — the hub's rows, the coverage,
 * the `.env` denylist — and every negative control is held exactly as in the
 * production lane: silence is silence under load too.
 *
 * THE LANE: the nightly / release-candidate workflow
 * (.github/workflows/simulation-nightly.yml, job `release-gate-loaded`),
 * never pull requests: it is slower, and a starved runner is the condition
 * it measures. Locally: CX_GATE_LANE=loaded bun test <this file>
 * (CX_GATE_BURNERS=<n> to choose the burners; one per core by default).
 */
import { afterAll, beforeAll, describe } from "bun:test";
import { rm } from "node:fs/promises";

import { burnerCount, startBurners } from "./release-gate/burners.ts";
import type { Burners } from "./release-gate/burners.ts";
import { warmHub } from "./release-gate/case-kit.ts";
import { BATCH_2_FINDINGS } from "./release-gate/expected.ts";
import type { Expectations } from "./release-gate/expected.ts";
import { describeGenerated, describeLanded, describeSelf, describeSweep } from "./release-gate/gate-controls.ts";
import { describePilot, describeScaleTwin } from "./release-gate/gate-pilot.ts";
import type { GateContext } from "./release-gate/gate-pilot.ts";
import { startHub } from "./release-gate/hub.ts";
import type { TestHub } from "./release-gate/hub.ts";
import { announceGateLaneSkip, inGateLane } from "./release-gate/lane.ts";
import { LOADED } from "./release-gate/profile.ts";

const FILE = "packages/connector-claude/test/e2e/release-gate-loaded.e2e.test.ts";
const WARM_UP_TIMEOUT_MS = 120_000;
/** No burner outlives this, even if the file's own `afterAll` never runs. */
const BURNERS_MAX_MS = 45 * 60_000;

/** The same findings as the production lane (release-gate/expected.ts), held to the loaded standard. */
const EXPECTED: Expectations = BATCH_2_FINDINGS;

const held: { hub: TestHub | null; burners: Burners | null } = { hub: null, burners: null };
const cleanups: string[] = [];

announceGateLaneSkip(FILE, "loaded");

describe.skipIf(!inGateLane("loaded"))("release gate under load — production budgets, every core busy", () => {
  beforeAll(async () => {
    held.hub = await startHub();
    cleanups.push(...(await warmHub(held.hub)));
    held.burners = startBurners(burnerCount(), BURNERS_MAX_MS);
    console.log(`${FILE}: ${String(held.burners.pids.length)} burners (pids ${held.burners.pids.join(" ")}), load ${held.burners.loadAtStart.toFixed(1)}`);
  }, WARM_UP_TIMEOUT_MS);

  afterAll(async () => {
    const loadAtStop = await held.burners?.stop();
    console.log(`${FILE}: burners stopped, load just before ${String(loadAtStop?.toFixed(1))}`);
    await held.hub?.close();
    await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
  });

  const ctx: GateContext = {
    profile: LOADED,
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
