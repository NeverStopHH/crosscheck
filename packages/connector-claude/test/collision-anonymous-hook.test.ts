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
/** The relay's live line for several of her files: the one nameless group, confirmed at the drain. */
const LIVE_LINE_TWO =
  "crosscheck: A teammate is working right now on 2 files you also touched, e.g. refresh.ts — talk to your team before you change them";
/** The relay's past tense: the subagent's edit is the reader's own moment, so no time of hers is said. */
const PAST_LINE = "crosscheck: A teammate was working on refresh.ts while your subagent edited it — talk to your team before you change it";
const PAST_LINE_TWO =
  "crosscheck: A teammate was working on 2 files you also touched, e.g. refresh.ts, while your subagent edited them — " +
  "talk to your team before you change them";
const AGENT_LINE = "crosscheck: A teammate is working on src/auth/refresh.ts right now — talk to your team before you change it.";
/** What a hub that cannot answer the tripwire returns. */
const SERVICE_UNAVAILABLE = 503;
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

  test("a subagent's hit reaches the main thread live and nameless while the hub still says a teammate is on the file, even beside a teammate presence lists", async () => {
    // Arrange: a subagent ran into her; presence lists Nick, who is not her
    const fix = await anonymousFixture("ca-relay");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    await presentNow(fix, [TEAMMATE_DEVELOPER_ID]);
    const asked = fix.hub.calls.tripwire;

    // Act: the drain asks the tripwire about her file once more
    const prompt = parsed(await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env));

    // Assert
    expect(prompt.systemMessage).toBe(LIVE_LINE);
    expect(prompt.hookSpecificOutput?.additionalContext).toContain(LIVE_LINE);
    expect(JSON.stringify(prompt)).not.toContain("Nick");
    expect(fix.hub.calls.tripwire).toBe(asked + 1);
  });

  test("with no presence answer to hold it to, the relay still says it live, as nobody in particular", async () => {
    // Arrange: a subagent's hit, no presence cache, and a hub whose presence
    // answer cannot be read — presence is the wrong oracle for her anyway;
    // the tripwire, which still answers her row, is the right one.
    const fix = await anonymousFixture("ca-relay-blind");
    const env = { ...fix.env, CROSSCHECK_TIMEOUT_MS: ROOMY_TIMEOUT_MS };
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), env);

    // Act
    const prompt = parsed(await runHook("user-prompt-submit", promptPayload(fix.repo), env));

    // Assert
    expect(prompt.systemMessage).toBe(LIVE_LINE);
    expect(prompt.hookSpecificOutput?.additionalContext).toContain(LIVE_LINE);
    expect(JSON.stringify(prompt)).not.toContain("Nick");
  });

  test("a nameless teammate who left the file since is relayed in the past tense, with no time of hers", async () => {
    // Arrange: her row was there at the subagent's edit and is gone at the drain
    const fix = await anonymousFixture("ca-relay-gone");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    fix.hub.setTripwireAnonymous(undefined);

    // Act
    const prompt = parsed(await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env));

    // Assert
    expect(prompt.systemMessage).toBe(PAST_LINE);
    expect(prompt.hookSpecificOutput?.additionalContext).toContain(PAST_LINE);
    expect(JSON.stringify(prompt)).not.toContain("recently");
  });

  test("a hub that will not answer the re-ask relays the hit in the past tense rather than claim she is still there", async () => {
    // Arrange
    const fix = await anonymousFixture("ca-relay-silent");
    await runHook("pre-tool-use", editPayload(fix.repo, OVERLAP_FILE, SUBAGENT), fix.env);
    fix.hub.setTripwireFailure(SERVICE_UNAVAILABLE);

    // Act
    const prompt = parsed(await runHook("user-prompt-submit", promptPayload(fix.repo), fix.env));

    // Assert
    expect(prompt.systemMessage).toBe(PAST_LINE);
  });

  test("several of her files are one group: live when any still answers her row, past tense when none does", async () => {
    // Arrange: two subagent hits, one nameless group of two files
    const live = await anonymousFixture("ca-relay-two");
    await runHook("pre-tool-use", editPayload(live.repo, OVERLAP_FILE, SUBAGENT), live.env);
    await runHook("pre-tool-use", editPayload(live.repo, SECOND_FILE, SUBAGENT), live.env);
    const asked = live.hub.calls.tripwire;
    const gone = await anonymousFixture("ca-relay-two-gone");
    await runHook("pre-tool-use", editPayload(gone.repo, OVERLAP_FILE, SUBAGENT), gone.env);
    await runHook("pre-tool-use", editPayload(gone.repo, SECOND_FILE, SUBAGENT), gone.env);
    gone.hub.setTripwireAnonymous(undefined);

    // Act
    const liveLine = parsed(await runHook("user-prompt-submit", promptPayload(live.repo), live.env)).systemMessage;
    const goneLine = parsed(await runHook("user-prompt-submit", promptPayload(gone.repo), gone.env)).systemMessage;

    // Assert: one re-ask per file, at most TURN_END_RECHECK_MAX_FILES
    expect(liveLine).toBe(LIVE_LINE_TWO);
    expect(live.hub.calls.tripwire).toBe(asked + 2);
    expect(goneLine).toBe(PAST_LINE_TWO);
  });
});
