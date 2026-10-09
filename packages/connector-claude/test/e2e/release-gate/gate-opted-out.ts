/**
 * P2 — Mike has opted out (release-gate/scenario-opted-out.ts), as a test
 * suite for any profile. Two halves that must hold together:
 *  - P2.told: Nick, about to change a file Mike is working on right now, is
 *    told in a line he reads that A TEAMMATE is working on it (the owner's
 *    decision on the review's I1);
 *  - P2.anonymous.*: opting out still hides WHO is working (the warning
 *    names nothing of Mike), WHERE (his branch reaches Nick nowhere) and
 *    WHEN (no "Mike last seen …" in Nick's statusline or briefing — the
 *    review's M5). The team's work-context listing names Mike's work as it
 *    always has: opting out hides location and liveness, not that the work
 *    exists.
 * And P2.mike: opting out hides Mike, not his view — he is still told of Nick.
 */
import { afterAll, beforeAll, describe, expect } from "bun:test";

import { warmHub } from "./case-kit.ts";
import { gateTest } from "./expected.ts";
import { CASE_TIMEOUT_MS, collisionBookings, crashedHooks, mentions } from "./gate-checks.ts";
import type { GateContext } from "./gate-pilot.ts";
import { agentTexts, personLines } from "./host.ts";
import { startHub } from "./hub.ts";
import type { TestHub } from "./hub.ts";
import { bookingsOf } from "./observe.ts";
import { OPTED_OUT_BRANCH, OPTED_OUT_SHARED_FILE, runOptedOutCase } from "./scenario-opted-out.ts";
import type { OptedOutWorld } from "./scenario-opted-out.ts";
import { targetsOf } from "./team.ts";

type Register = (id: string, name: string, body: () => void | Promise<void>) => void;

const SHARED_NAME = OPTED_OUT_SHARED_FILE.split("/").at(-1) ?? OPTED_OUT_SHARED_FILE;
/** An age or a last-seen: what says WHEN somebody was active ("2m ago", "last seen …"). */
const LAST_ACTIVE = /\b\d+\s*[smhd]\s+ago\b|\blast seen\b/i;

export const describeOptedOut = (ctx: GateContext): void => {
  describe(`P2 — Mike opted out: Nick is warned that a teammate is on the file, and told nothing of Mike [${ctx.profile.name}]`, () => {
    const held: { hub: TestHub | null; world: OptedOutWorld | null } = { hub: null, world: null };
    const hub = (): TestHub => {
      if (held.hub === null) {
        throw new Error("P2's hub did not start");
      }
      return held.hub;
    };
    const world = (): OptedOutWorld => {
      if (held.world === null) {
        throw new Error("P2's scenario did not run");
      }
      return held.world;
    };
    beforeAll(async () => {
      // Its own hub: Mike's opt-out must not reach any other case's Mike.
      held.hub = await startHub();
      ctx.cleanups.push(...(await warmHub(held.hub)));
      held.world = await runOptedOutCase(held.hub, ctx.profile);
      ctx.cleanups.push(...held.world.cleanup);
    }, CASE_TIMEOUT_MS);
    afterAll(async () => {
      await held.hub?.close();
    });
    const it: Register = (id, name, body) => gateTest(ctx.expected, id, name, body);

    it("P2.setup", "Mike's work on the shared file reached the hub while he was opted out, and so did Nick's", async () => {
      const targets = await targetsOf(hub().db, world().repo.repoId);
      expect(targets.some((target) => target.developer === "Mike" && target.value === OPTED_OUT_SHARED_FILE)).toBe(true);
      expect(targets.some((target) => target.developer === "Nick" && target.value === OPTED_OUT_SHARED_FILE)).toBe(true);
      expect(world().nickSharedEdit.some((run) => run.event === "PreToolUse")).toBe(true);
    });

    it("P2.setup.processes", "no hook process crashed or hung (a hook always exits 0)", () => {
      expect(crashedHooks([world().mikeSession, world().nickSession])).toEqual([]);
    });

    // The owner's decision on I1. The loaded lane also accepts a dated booking that names the untold warning.
    it("P2.told", `Nick's edit of ${SHARED_NAME}, which opted-out Mike works on right now, tells NICK a teammate is working on it`, async () => {
      const lines = personLines(world().nickSharedEdit);
      const told = lines.some((line) => line.includes(SHARED_NAME) && /\bteammate\b/i.test(line));
      const booked =
        ctx.profile.mayBookInsteadOfWarn &&
        collisionBookings(await bookingsOf(world().nick), world().nickSharedEditMoment).length > 0;
      expect(told || booked, JSON.stringify(lines)).toBe(true);
    });

    // WHO: the warning is anonymous. (The team's work-context listing names Mike's work as it
    // always did — opting out hides where and when, not that the work exists.)
    it("P2.anonymous.who", "the warning on Nick's edit names nothing of Mike: not his name, not his id, not his branch", () => {
      const { nickSharedEdit, mike } = world();
      const texts = nickSharedEdit.map((run) => run.stdout);
      const leaks = [mike.name, OPTED_OUT_BRANCH, mike.account.developerId].filter((needle) => mentions(texts, needle));
      expect(leaks).toEqual([]);
    });

    // WHERE: nothing anywhere carries the branch he works on.
    it("P2.anonymous.where", "nothing Nick is shown, nothing his agent is told and nothing the hub answers him carries Mike's branch", () => {
      const { nickSession, nickStatusline } = world();
      const texts = [
        ...nickSession.runs().map((run) => run.stdout),
        nickStatusline,
        ...hub()
          .wire.filter((entry) => entry.developer === "Nick")
          .map((entry) => entry.responseBody),
      ];
      expect(mentions(texts, OPTED_OUT_BRANCH)).toBe(false);
    });

    // WHEN (review M5): a creation instant must not become "Mike last seen …" for an opted-out Mike.
    it("P2.anonymous.when.statusline", "Nick's statusline does not say when Mike was last active", () => {
      const segments = world().nickStatusline.split(" · ").filter((segment) => segment.includes("Mike") && LAST_ACTIVE.test(segment));
      expect(segments).toEqual([]);
    });

    it("P2.anonymous.when.briefing", "Nick's briefing does not say when Mike was last active", () => {
      const starts = world()
        .nickSession.runs()
        .filter((run) => run.event === "SessionStart");
      const briefing = [...agentTexts(starts), ...personLines(starts)].flatMap((text) => text.split("\n"));
      expect(briefing.filter((line) => line.includes("Mike") && LAST_ACTIVE.test(line))).toEqual([]);
    });

    it("P2.mike", "opted-out Mike is still told of Nick on a file Nick's subagent changed: opting out hides him, not his view", () => {
      expect(mentions(personLines(world().mikeLaterEdit), "Nick"), JSON.stringify(personLines(world().mikeLaterEdit))).toBe(true);
    });
  });
};
