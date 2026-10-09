/**
 * A TEAMMATE WHO OPTED OUT IS STILL A COLLISION (the owner's decision on the
 * batch-2 integration review's I1), end to end through the hooks: the hub's
 * tripwire answers one nameless row, and the person and the agent are told
 * THAT a teammate is working on the file right now — never who, where or
 * since when — on the edit, on the statusline, and on the main thread when a
 * subagent ran into it. Without it, Nick was told nothing while an opted-out
 * Mike edited the same files: the pilot's failure, back for every opted-out
 * person.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { runHook, runStatusline } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { activeTeammateSession, TEAMMATE_DEVELOPER_ID } from "../../connector-core/test/fixtures/hint-hub.ts";
import { COLLISION_RELAY_SENTENCE } from "@crosscheck/connector-core/hints/collision-notice.ts";
import {
  BEHAVIOUR_TIMING,
  NICK_NOTICE,
  OVERLAP_FILE,
  SECOND_FILE,
  SESSION_ID,
  SUBAGENT,
  cleanupCollisionFixtures,
  collisionFixture,
  deferredGhostFixture,
  editPayload,
  ghostFixture,
  parsed,
  pastRecheckWindow,
  presentNow,
  promptPayload,
  sessionStartPayload,
} from "./fixtures/collision-fixture.ts";

afterEach(cleanupCollisionFixtures);

const LIVE_LINE = "crosscheck: A teammate is working on refresh.ts right now — talk to your team before you change it";
const PAST_LINE = "crosscheck: A teammate recently worked on refresh.ts — talk to your team before you change it";
const AGENT_LINE = "crosscheck: A teammate is working on src/auth/refresh.ts right now — talk to your team before you change it.";
const ANONYMOUS_ROWS = [{ anonymous: true }];
/** Wide enough that the relay's own refresh cap, not the request timeout, decides (collision-relay-unconfirmed.test.ts). */
const ROOMY_TIMEOUT_MS = "2000";
const GHOST_LINE = "crosscheck: A teammate's work in progress also touches 3 of your files — talk to your team before you change them";
const BRIEFING_GHOST_LINE = "- A teammate's work in progress also touches 3 of your files";

/** A session whose hub names nobody on the file, and says a teammate it will not name is live on it. */
const anonymousFixture = async (label: string): ReturnType<typeof collisionFixture> => {
  const fix = await collisionFixture(label);
  fix.hub.setTripwireSessions([]);
  fix.hub.setTripwireAnonymous(ANONYMOUS_ROWS);
  return fix;
};

const statusline = (repo: string, env: Env): Promise<string> =>
  runStatusline(JSON.stringify({ session_id: SESSION_ID, cwd: repo }), env);

describe("a teammate the hub will not name, live on the file being edited", () => {
  test("the person and the agent are told a teammate is working on it right now, and nothing of who", async () => {
    const { repo, env } = await anonymousFixture("ca-ask");

    const stdout = await runHook("pre-tool-use", editPayload(repo, OVERLAP_FILE), env);
    const output = parsed(stdout);

    expect(output.systemMessage).toBe(LIVE_LINE);
    expect(output.hookSpecificOutput?.permissionDecision).toBe("ask");
    expect(output.hookSpecificOutput?.permissionDecisionReason).toContain(AGENT_LINE);
    expect(stdout).not.toContain("Nick");
    expect(stdout).not.toContain("get_diagnosis");
  });

  test("a second edit of her file inside the window asks the hub nothing: a nameless teammate's file rests like a named one's", async () => {
    // Arrange: Nick asked about her and told on the first edit
    const fix = await anonymousFixture("ca-rest");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env);
    const calls = fix.hub.calls.tripwire;

    // Act
    const second = await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env);

    // Assert
    expect(second).toBe("");
    expect(fix.hub.calls.tripwire).toBe(calls);
  });

  test("a second file asks the agent again, tells the person nothing new, and the statusline counts one teammate", async () => {
    const { repo, env } = await anonymousFixture("ca-second");
    await runHook("pre-tool-use", editPayload(repo, OVERLAP_FILE), env);

    const second = parsed(await runHook("pre-tool-use", editPayload(repo, SECOND_FILE), env));
    const line = await statusline(repo, env);

    expect(second.systemMessage).toBeUndefined();
    expect(second.hookSpecificOutput?.permissionDecisionReason).toContain("A teammate is working on src/auth/rotate.ts right now");
    expect(line.startsWith("⚠ overlap: 1 teammate · 2 files · ")).toBe(true);
  });

  test("a named teammate on the same file is asked first, the person hears both, and the next edit asks about the other", async () => {
    const { repo, hub, env } = await anonymousFixture("ca-both");
    hub.setTripwireSessions([activeTeammateSession()]);

    const first = parsed(await runHook("pre-tool-use", editPayload(repo, OVERLAP_FILE), env));
    const again = parsed(await runHook("pre-tool-use", editPayload(repo, OVERLAP_FILE), env));

    expect(first.systemMessage).toBe(`${NICK_NOTICE}\n${LIVE_LINE}`);
    expect(first.hookSpecificOutput?.permissionDecisionReason).toContain("Nick");
    expect(again.hookSpecificOutput?.permissionDecisionReason).toContain(AGENT_LINE);
    expect(again.systemMessage).toBeUndefined();
  });

  test("an owed rest's recheck tells the person of a nameless teammate who joined the file, and names nobody", async () => {
    // Arrange: Nick settled on the file (asked, told, resting); then an opted-out teammate joins it
    const fix = await collisionFixture("ca-rest", BEHAVIOUR_TIMING);
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env);
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE), fix.env);
    fix.hub.setTripwireAnonymous(ANONYMOUS_ROWS);
    await pastRecheckWindow(fix.home);

    // Act: the next prompt pays the rest
    const prompt = parsed(await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env));

    // Assert
    expect(prompt.systemMessage).toBe(LIVE_LINE);
    expect(prompt.hookSpecificOutput?.additionalContext).toContain(`${LIVE_LINE}\n${COLLISION_RELAY_SENTENCE}`);
  });

  test("a nameless teammate's unfinished work on the reader's files is told at SessionStart, counted and time-free", async () => {
    const { repo, env } = await ghostFixture("ca-ghost", [], { sharedFileCount: 3 });

    const told = parsed(await runHook("session-start", sessionStartPayload(repo, "startup"), env));
    const line = await statusline(repo, env);

    expect(told.systemMessage).toBe(GHOST_LINE);
    expect(told.hookSpecificOutput?.additionalContext).toContain(BRIEFING_GHOST_LINE);
    expect(line.startsWith("⚠ overlap: 1 teammate · 3 files · ")).toBe(true);
  });

  test("a late briefing paid at the first prompt tells the same", async () => {
    const { repo, env } = await deferredGhostFixture("ca-ghost-late", [], { sharedFileCount: 3 });

    const prompt = parsed(await runHook("user-prompt-submit", promptPayload(repo), env));

    expect(prompt.systemMessage).toBe(GHOST_LINE);
  });

  test("a subagent's hit reaches the main thread unnamed and in the past tense, even beside a teammate presence lists", async () => {
    const fix = await anonymousFixture("ca-relay");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    await presentNow(fix, [TEAMMATE_DEVELOPER_ID]);

    const prompt = parsed(await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env));

    expect(prompt.systemMessage).toBe(PAST_LINE);
    expect(prompt.hookSpecificOutput?.additionalContext).toContain(PAST_LINE);
    expect(JSON.stringify(prompt)).not.toContain("Nick");
  });

  test("with no presence answer to hold it to, the relay still says it as nobody in particular", async () => {
    // Arrange: a subagent's hit, no presence cache, and a hub whose presence
    // answer cannot be read — the one path that relays a hit as its row
    // named it, so the group read back from the session state must still
    // know it was nameless.
    const fix = await anonymousFixture("ca-relay-blind");
    const env = { ...fix.env, CROSSCHECK_TIMEOUT_MS: ROOMY_TIMEOUT_MS };
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), env);

    // Act
    const prompt = parsed(await runHook("user-prompt-submit", promptPayload(fix.repo), env));

    // Assert
    expect(prompt.systemMessage).toBe(PAST_LINE);
    expect(prompt.hookSpecificOutput?.additionalContext).toContain(PAST_LINE);
  });
});
