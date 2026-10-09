/**
 * I1 — ONE OF THE TWO OPTED OUT (the owner's decision on the batch-2
 * integration review's I1). The pilot's two people, live on the same files at
 * the same time, and Mike has run `crosscheck presence off` first. Before the
 * decision Nick was told nothing, which is the pilot's failure again for every
 * opted-out person. Now Nick must be told THAT a teammate is on the file right
 * now and never who, where or when, and Mike, whose opt-out hides only
 * himself, must still be told about Nick by name.
 *
 * Nick works as the pilot did: a main-thread edit, a second one, then a
 * subagent on the third shared file, a prompt, a stop and a resume the next
 * time he opens the session (whose briefing carries the ghost check).
 */
import { join } from "node:path";

import { PRESENCE_CACHE_TTL_MS } from "@crosscheck/connector-core/constants.ts";

import { MIKE, NICK } from "../../../../connector-core/test/fixtures/landing-repos.ts";
import { checkoutFor, editEach, fileSource, seedCase } from "./case-kit.ts";
import type { CaseRepo } from "./case-kit.ts";
import { openSession } from "./host.ts";
import type { HookRun, HostSession } from "./host.ts";
import type { TestHub } from "./hub.ts";
import { MIKE_BRANCH, TOPIC_BRANCH } from "./scenario-long-session.ts";
import { makeDeveloper } from "./team.ts";
import type { GateDeveloper } from "./team.ts";

/** The files both of them change: Mike first, then Nick while Mike is still live. */
export const SHARED_FILES = [
  "apps/practice/mapping/PlayerMappingGrid.tsx",
  "apps/practice/mapping/mappingConfig.ts",
  "apps/practice/mapping/MappingRow.tsx",
] as const;

const MIKE_OWN = "apps/streaming/feed.ts";
const NICK_OWN = "apps/numlabs/sync.ts";

/**
 * How far past the presence cache's freshness Mike's next prompt comes. A
 * person's next prompt is minutes away, not the second this scenario would
 * take: without the pause his connector answers from a presence read made
 * before Nick existed, and a group no presence answer lists is shown without
 * its name (scenario-long-session.ts waits the same window for the same
 * reason).
 */
const PROMPT_GAP_MS = PRESENCE_CACHE_TTL_MS + 1_500;

export interface OptedOutWorld {
  readonly repo: CaseRepo;
  readonly mike: GateDeveloper;
  readonly nick: GateDeveloper;
  readonly mikeSession: HostSession;
  readonly nickSession: HostSession;
  /** Nick's main-thread edit of the first shared file: the first he hears of the teammate. */
  readonly nickFirstEdit: readonly HookRun[];
  /** His main-thread edit of the second: the agent is asked again, the person already knows. */
  readonly nickSecondEdit: readonly HookRun[];
  /** The subagent's edit of the third, and the main thread's next prompt. */
  readonly nickSubagent: readonly HookRun[];
  /** The resumed session's start and first prompt: the briefing with its ghost check. */
  readonly nickResume: readonly HookRun[];
  /** Mike's edit of the first shared file once Nick is live on it. */
  readonly mikeEditAfterNick: readonly HookRun[];
  readonly nickStatusline: string;
  readonly mikeStatusline: string;
  readonly cleanup: readonly string[];
}

/** `crosscheck presence off`, as the CLI sends it (connector-core http/hub.ts putPresenceOptOut). */
const optOutOfPresence = async (hub: TestHub, developer: GateDeveloper): Promise<void> => {
  const response = await fetch(`${hub.url}/api/settings/presence`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${developer.account.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ optOut: true }),
  });
  if (!response.ok) {
    throw new Error(`${developer.name}'s presence opt-out failed: ${String(response.status)}`);
  }
};

const editOne = (session: HostSession, root: string, path: string, note: string): Promise<readonly HookRun[]> =>
  session.edit(join(root, path), fileSource(path, note));

/** Mike opts out and works on the shared files; Nick then works on them while Mike is still live. */
export const runOptedOutCase = async (hub: TestHub): Promise<OptedOutWorld> => {
  const [first, second, third] = SHARED_FILES;
  const repo = await seedCase("opted-out", hub.url, [...SHARED_FILES, MIKE_OWN, NICK_OWN]);
  const mike = await makeDeveloper(hub, MIKE, "i1-mike");
  const nick = await makeDeveloper(hub, NICK, "i1-nick");
  await optOutOfPresence(hub, mike);
  const mikeAt = await checkoutFor(repo, MIKE, MIKE_BRANCH, "mike");
  const nickAt = await checkoutFor(repo, NICK, TOPIC_BRANCH, "nick");

  const mikeSession = openSession(mike, "i1-mike-streaming", mikeAt.worktree);
  mikeSession.label("mike-opted-out");
  await mikeSession.start();
  await mikeSession.prompt("streaming practice beta: the player mapping grid");
  await editEach(mikeSession, mikeAt.worktree, [MIKE_OWN, ...SHARED_FILES], "streaming beta");

  const nickSession = openSession(nick, "i1-nick-numlabs", nickAt.worktree);
  nickSession.label("nick-start");
  await nickSession.start();
  await nickSession.prompt("numlabs practices: map the players");
  await editEach(nickSession, nickAt.worktree, [NICK_OWN], "numlabs");
  nickSession.label("nick-first-shared");
  const nickFirstEdit = await editOne(nickSession, nickAt.worktree, first, "numlabs");
  nickSession.label("nick-second-shared");
  const nickSecondEdit = await editOne(nickSession, nickAt.worktree, second, "numlabs");
  nickSession.label("nick-subagent");
  await nickSession.subagent("mapping", async (actor) => {
    await editEach(nickSession, nickAt.worktree, [third], "numlabs", actor);
  });
  await nickSession.prompt("continue");
  await nickSession.stop();
  const nickStatusline = await nickSession.statusline();
  nickSession.label("nick-resume");
  const resumed = await nickSession.start("resume");
  const resumedPrompt = await nickSession.prompt("pick the mapping up again");

  mikeSession.label("mike-after-nick");
  await Bun.sleep(PROMPT_GAP_MS);
  await mikeSession.prompt("keep going on the grid");
  const mikeEditAfterNick = await editOne(mikeSession, mikeAt.worktree, first, "streaming beta, again");
  await mikeSession.stop();
  const mikeStatusline = await mikeSession.statusline();

  return {
    repo,
    mike,
    nick,
    mikeSession,
    nickSession,
    nickFirstEdit,
    nickSecondEdit,
    nickSubagent: nickSession.runs().filter((run) => run.label === "nick-subagent"),
    nickResume: [...resumed, ...resumedPrompt],
    mikeEditAfterNick,
    nickStatusline,
    mikeStatusline,
    cleanup: [repo.seed, mikeAt.parent, nickAt.parent, mike.home, nick.home],
  };
};
