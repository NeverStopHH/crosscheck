/**
 * THE ANONYMOUS TEAMMATE (the owner's decision on the batch-2 integration
 * review's I1). A teammate who opted out of presence is still a collision:
 * the hub answers the tripwire with one nameless row and the ghost check with
 * a nameless count, and this module tells the person and the agent THAT
 * somebody is working on the file now — never who, where or since when — and
 * keeps it that way on every later surface: the relay, the rest recheck, the
 * turn end and the statusline.
 */
import { describe, expect, test } from "bun:test";

import {
  anonymousGhostCollision,
  anonymousTripwireCollision,
  relayedCollisions,
  renderCollisionNotice,
  renderCollisionNotices,
  renderOverlapIndicator,
  tripwireCollision,
} from "../src/hints/collision-notice.ts";
import { renderEditWarning } from "../src/hints/render.ts";
import type { TripwireSession } from "../src/http/hub.ts";

const NOW = new Date("2026-10-09T12:00:00.000Z");
const FILE = "src/auth/refresh.ts";
const SECOND = "src/auth/rotate.ts";

const LIVE_LINE = "crosscheck: A teammate is working on refresh.ts right now — talk to your team before you change it";
const PAST_LINE = "crosscheck: A teammate was working on refresh.ts while your subagent edited it — talk to your team before you change it";

const mike: TripwireSession = {
  sessionId: "cc_mike",
  developerId: "dev_mike",
  developerName: "Mike",
  branch: "feat/mike-refresh",
  status: "implementing",
  lastHeartbeatAt: new Date(NOW.getTime() - 30_000).toISOString(),
  workContextId: "wc_mike",
  workContextTitle: "Refresh rework",
  workContextIntent: null,
};

const presence = [{ developerId: "dev_mike", isSelf: false, branch: "feat/mike-refresh", lastHeartbeatAt: NOW.toISOString() }];

describe("an anonymous tripwire hit", () => {
  test("is told as a teammate on the file right now, with nothing that says who, where or when", () => {
    const group = anonymousTripwireCollision(FILE);

    expect(renderCollisionNotice(group, NOW)).toBe(LIVE_LINE);
    expect(group).toMatchObject({ name: "", branch: null, lastActiveAt: null, files: [FILE], fileCount: 1, anonymous: true });
  });

  test("is one group whoever it is, so a second file joins the first and the person is told once", () => {
    expect(anonymousTripwireCollision(SECOND).key).toBe(anonymousTripwireCollision(FILE).key);
    expect(anonymousGhostCollision(3).key).toBe(anonymousTripwireCollision(FILE).key);
  });

  test("tells the agent the same, and never points it at a teammate's work", () => {
    const reason = renderEditWarning({ live: null, anonymous: true, landed: null, file: FILE, now: NOW });

    expect(reason).toContain("crosscheck: A teammate is working on src/auth/refresh.ts right now — talk to your team before you change it.");
    expect(reason).not.toContain("get_diagnosis");
    expect(reason).not.toContain("heartbeat");
  });

  test("ranks after a named teammate on the same file in the agent's ask", () => {
    const reason = renderEditWarning({ live: mike, anonymous: true, landed: null, file: FILE, now: NOW });

    expect(reason.indexOf("Mike")).toBeGreaterThanOrEqual(0);
    expect(reason).not.toContain("A teammate is working on");
  });
});

describe("an anonymous group, shown later", () => {
  test("is relayed in the past tense and unnamed, whatever presence says, and never upgraded to a name", () => {
    const group = { ...anonymousTripwireCollision(FILE), developerId: "dev_mike" };
    const stored = anonymousTripwireCollision(FILE);

    expect(relayedCollisions([stored], presence, NOW).map((shown) => renderCollisionNotice(shown, NOW))).toEqual([PAST_LINE]);
    expect(relayedCollisions([stored], null, NOW).map((shown) => renderCollisionNotice(shown, NOW))).toEqual([PAST_LINE]);
    // Even a record that somehow carried a listed teammate's id stays unnamed: the flag decides.
    expect(relayedCollisions([group], presence, NOW).map((shown) => renderCollisionNotice(shown, NOW))).toEqual([PAST_LINE]);
  });

  test("is counted on the statusline as one teammate, beside the named ones", () => {
    const anonymous = [anonymousTripwireCollision(FILE), anonymousTripwireCollision(SECOND)];
    const named = tripwireCollision(mike, FILE);

    expect(renderOverlapIndicator(anonymous, presence)).toBe("⚠ overlap: 1 teammate · 2 files");
    expect(renderOverlapIndicator([named, ...anonymous], presence)).toBe("⚠ overlap: Mike · 1 file, +1 teammate · 2 files");
  });
});

describe("an anonymous ghost overlap", () => {
  test("says how many of the reader's files a teammate's work in progress touches, time-free and nameless", () => {
    expect(renderCollisionNotices([anonymousGhostCollision(3)], NOW)).toBe(
      "crosscheck: A teammate's work in progress also touches 3 of your files — talk to your team before you change them",
    );
    expect(renderCollisionNotice(anonymousGhostCollision(1), NOW)).toBe(
      "crosscheck: A teammate's work in progress also touches 1 of your files — talk to your team before you change it",
    );
  });
});
