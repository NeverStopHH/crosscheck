/**
 * One OS process that writes ONE ledger entry the way a hook does, at a
 * shared instant — real processes, because in-process promises share one
 * event loop and never interleave a read and a write the way racing hooks do
 * (test/ledger-concurrency.test.ts).
 *
 * argv: <kind: fired | refused-loss | foreign-hub> <home> <index> <startAtMs>
 */
import type { ForeignHub } from "../../src/config/key-binding.ts";
import { recordHookFired } from "../../src/state/fired-markers.ts";
import { recordForeignHubRefusal } from "../../src/state/foreign-hub.ts";
import { recordCaptureLoss } from "../../src/state/loss-ledger.ts";

const [kind = "", home = "", indexText = "0", startText = "0"] = process.argv.slice(2);
const index = Number(indexText);
const startAt = Number(startText);

const FOREIGN_HUB: ForeignHub = {
  hubOrigin: "http://127.0.0.1:2",
  keyOrigin: "http://127.0.0.1:1",
  hubSource: "repo",
  keySource: "login",
};

while (Date.now() < startAt) {
  await Bun.sleep(1);
}

if (kind === "fired") {
  await recordHookFired(home, "repo-key", `hook-${String(index)}`, new Date());
} else if (kind === "refused-loss") {
  await recordCaptureLoss(home, { kind: "hook_timed_out", count: 1, key: null, detail: "pre-tool-use", now: new Date() });
} else if (kind === "foreign-hub") {
  await recordForeignHubRefusal(home, {
    repoId: "github.com/acme/foreign",
    foreignHub: FOREIGN_HUB,
    surface: "pre-tool-use",
    sessionKey: `session-${String(index)}`,
    now: new Date(),
  });
} else {
  process.stderr.write(`unknown kind ${kind}\n`);
  process.exit(64);
}
process.exit(0);
