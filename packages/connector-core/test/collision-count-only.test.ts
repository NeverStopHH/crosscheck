/**
 * A RELAY THAT CAN ONLY COUNT SAYS WHAT IT KNOWS (review of
 * feat/collision-visible, round 3, F-L2). When every group a subagent queued
 * was one the record had to let go of, the person read "crosscheck: +3 more
 * teammate overlaps not shown" with nothing shown above it, and the agent was
 * asked to mention "this overlap" with no overlap in its context (probe r3a
 * N3). The count-only case now has its own line on both copies.
 */
import { describe, expect, test } from "bun:test";

import {
  COLLISION_RELAY_SENTENCE,
  COUNT_ONLY_RELAY_SENTENCE,
  SUBAGENT_RELAY_HEADER,
  renderCollisionNotices,
  renderSubagentCollisionRelay,
  tripwireCollision,
} from "../src/hints/collision-notice.ts";

const NOW = new Date("2026-10-07T12:00:00.000Z");

const THREE_LINE =
  "crosscheck: a subagent ran into 3 teammate overlaps whose details were not kept — talk to your team before you merge";

const nick = tripwireCollision(
  {
    sessionId: "cc_nick",
    developerId: "dev_nick",
    developerName: "Nick",
    branch: "feat/refresh-fix",
    status: "implementing",
    lastHeartbeatAt: "2026-10-07T11:59:30.000Z",
    workContextId: "wc_nick",
    workContextTitle: "t",
  },
  "src/auth/refresh.ts",
);

describe("a relay of only dropped groups (round 3, F-L2)", () => {
  test("the person reads how many overlaps there were, not '+3 more' of nothing", () => {
    // Act
    const person = renderCollisionNotices([], NOW, 3);

    // Assert
    expect(person).toBe(THREE_LINE);
    expect(person).not.toContain("more");
  });

  test("one dropped group is counted in the singular", () => {
    // Act
    const person = renderCollisionNotices([], NOW, 1);

    // Assert
    expect(person).toBe(
      "crosscheck: a subagent ran into 1 teammate overlap whose details were not kept — talk to your team before you merge",
    );
  });

  test("the agent is asked to pass on the count, never to mention 'this overlap'", () => {
    // Act
    const agent = renderSubagentCollisionRelay([], NOW, 3);

    // Assert
    expect(agent).toBe([SUBAGENT_RELAY_HEADER, THREE_LINE, COUNT_ONLY_RELAY_SENTENCE].join("\n"));
    expect(agent).not.toContain(COLLISION_RELAY_SENTENCE);
  });

  test("with a named group beside the dropped ones, the tail still reads '+N more'", () => {
    // Act
    const person = renderCollisionNotices([nick], NOW, 2);
    const agent = renderSubagentCollisionRelay([nick], NOW, 2);

    // Assert
    expect(person.split("\n").at(-1)).toBe("crosscheck: +2 more teammate overlaps not shown");
    expect(agent.split("\n").at(-1)).toBe(COLLISION_RELAY_SENTENCE);
  });

  test("nothing at all is still nothing", () => {
    // Act / Assert
    expect(renderCollisionNotices([], NOW, 0)).toBe("");
    expect(renderSubagentCollisionRelay([], NOW, 0)).toBe("");
  });
});
