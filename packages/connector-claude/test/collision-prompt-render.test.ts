/**
 * ONE PROMPT, ONE BOUNDED LINE FOR THE PERSON (review of
 * feat/collision-visible, round 2, L4). A prompt that drained a subagent's
 * relay AND paid a late briefing's ghost rows rendered the two halves through
 * two renders, each capped on its own, and joined them: probe r2 E, seven
 * queued groups and seven ghost rows, gave one `systemMessage` of eight
 * lines. Both halves now go through one `renderCollisionNotices`.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { runHook } from "../src/index.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import { COLLISION_NOTICE_MAX_CHARS, COLLISION_NOTICE_MAX_LINES } from "@crosscheck/connector-core/constants.ts";
import { tripwireCollision } from "@crosscheck/connector-core/hints/collision-notice.ts";
import { writePresenceCache } from "@crosscheck/connector-core/state/presence-cache.ts";
import {
  readSessionState,
  updateSessionState,
  withCollisionNotices,
  withQueuedCollisionRelays,
} from "@crosscheck/connector-core/state/session-state.ts";
import {
  REPO_ID,
  SESSION_ID,
  cleanupCollisionFixtures,
  deferredGhostFixture,
  mikeGhostRow,
  parsed,
  promptPayload,
} from "./fixtures/collision-fixture.ts";

afterEach(cleanupCollisionFixtures);

const SEVEN = 7;

/** Seven ghost teammates, one shared file each. */
const ghostRows = (): readonly Record<string, unknown>[] =>
  Array.from({ length: SEVEN }, (_, index) => ({
    ...mikeGhostRow([{ kind: "file", value: `src/ghost${String(index)}.ts` }], 1),
    workContextId: `wc_g${String(index)}`,
    developerId: `dev_g${String(index)}`,
    developerName: `Ghost${String(index)}`,
  }));

/** Seven teammates a subagent ran into, queued for this prompt. */
const queuedGroups = (): readonly ReturnType<typeof tripwireCollision>[] =>
  Array.from({ length: SEVEN }, (_, index) =>
    tripwireCollision(
      {
        sessionId: `cc_q${String(index)}`,
        developerId: `dev_q${String(index)}`,
        developerName: `Queued${String(index)}`,
        branch: "feat/q",
        status: "implementing",
        lastHeartbeatAt: new Date().toISOString(),
        workContextId: `wc_q${String(index)}`,
        workContextTitle: "t",
      },
      `src/q${String(index)}.ts`,
    ),
  );

describe("a relay and a late briefing's ghost rows on one prompt (round 2, L4)", () => {
  test("seven queued and seven ghosts are five lines and one count, inside the character bound", async () => {
    // Arrange: a late-registered session owed its briefing, with a full relay queue
    const { repo, home, env } = await deferredGhostFixture("pr-seven-seven", ghostRows());
    const queued = queuedGroups();
    await updateSessionState(home, SESSION_ID, (fresh) =>
      withQueuedCollisionRelays(withCollisionNotices(fresh, queued), queued.map((group) => group.key)),
    );
    await writePresenceCache(
      home,
      repoKey(env["CROSSCHECK_HUB_URL"] ?? "", REPO_ID),
      queued.map((group) => ({
        sessionId: `cc_${group.developerId}`,
        developerId: group.developerId,
        developerName: group.name,
        branch: "feat/q",
        status: "implementing",
        lastHeartbeatAt: new Date().toISOString(),
        isSelf: false,
      })),
      new Date(),
    );

    // Act
    const output = parsed(await runHook("user-prompt-submit", promptPayload(repo), env));

    // Assert: every queued group and every ghost the briefing showed is a line or counted
    const person = (output.systemMessage ?? "").split("\n");
    const told = (await readSessionState(home, SESSION_ID))?.collisionNotices ?? [];
    expect(told.length).toBeGreaterThan(SEVEN);
    expect(person).toHaveLength(COLLISION_NOTICE_MAX_LINES + 1);
    expect(person.at(-1)).toBe(
      `crosscheck: +${String(told.length - COLLISION_NOTICE_MAX_LINES)} more teammate overlaps not shown`,
    );
    expect((output.systemMessage ?? "").length).toBeLessThanOrEqual(COLLISION_NOTICE_MAX_CHARS);
    // The relay leads the person's line, as it leads the agent's text.
    expect(person[0]).toContain("Queued0");
  });
});
