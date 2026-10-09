/**
 * P2 — MIKE HAS OPTED OUT OF PRESENCE, and works on files Nick is about to
 * change, right now.
 *
 * THE OWNER'S DECISION (batch-2 integration review, I1): opting out hides WHO
 * is working, WHERE (branch, topic) and WHEN; it no longer hides THAT someone
 * is working on a file the other side is about to change. Nick is to get an
 * anonymous live warning — "a teammate is working on <file> right now" —
 * and nothing of Mike. Without it, an opted-out teammate recreates the
 * pilot's failure for everyone who works beside them.
 *
 * Mike opts out, then works on four shared files on his branch and stays at
 * his desk. Nick's subagents edit three of them (at once under a parallel
 * profile), his main thread the fourth — the edit whose own PreToolUse must
 * tell him; his next prompt and the turn's end are the relay's channels.
 * Then Mike edits one more shared file: an opted-out person still SEES —
 * opting out hides him, not his view.
 *
 * ITS OWN HUB: one account per person per hub, and an opt-out must not reach
 * any other case's Mike.
 */
import { join } from "node:path";

import { MIKE, NICK } from "../../../../connector-core/test/fixtures/landing-repos.ts";
import { checkoutFor, editEach, fileSource, seedCase, whileAtDesk } from "./case-kit.ts";
import type { CaseRepo } from "./case-kit.ts";
import { openSession } from "./host.ts";
import type { HookRun, HostSession } from "./host.ts";
import type { TestHub } from "./hub.ts";
import { timed } from "./observe.ts";
import type { Moment } from "./observe.ts";
import type { GateProfile } from "./profile.ts";
import { makeDeveloper } from "./team.ts";
import type { GateDeveloper } from "./team.ts";

export const OPTED_OUT_BRANCH = "feat/streaming-quiet-mode";
/** The four files both work on; Nick's main thread edits the first. */
export const OPTED_OUT_FILES = [
  "apps/practice/mapping/PlayerMappingGrid.tsx",
  "apps/practice/mapping/mappingApi.ts",
  "apps/practice/mapping/MappingRow.tsx",
  "apps/practice/mapping/index.ts",
] as const;
export const OPTED_OUT_SHARED_FILE = OPTED_OUT_FILES[0];
/** Mike's edit after Nick's turn: a file Nick's subagent edited. */
const MIKE_LATER_FILE = OPTED_OUT_FILES[1];

export interface OptedOutWorld {
  readonly repo: CaseRepo;
  readonly mike: GateDeveloper;
  readonly nick: GateDeveloper;
  readonly mikeSession: HostSession;
  readonly nickSession: HostSession;
  /** Nick's main-thread edit of the shared file: its runs, and when it began and ended. */
  readonly nickSharedEdit: readonly HookRun[];
  readonly nickSharedEditMoment: Moment;
  /** Mike's edit after Nick's turn, of a file Nick's subagent edited. */
  readonly mikeLaterEdit: readonly HookRun[];
  readonly nickStatusline: string;
  readonly mikeStatusline: string;
  readonly cleanup: readonly string[];
}

/** Mike opts out of presence with his own key, as `crosscheck presence off` does. */
const optOut = async (hub: TestHub, developer: GateDeveloper): Promise<void> => {
  const response = await fetch(`${hub.url}/api/settings/presence`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${developer.account.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ optOut: true }),
  });
  if (!response.ok) {
    throw new Error(`${developer.name}'s presence opt-out failed: ${String(response.status)}`);
  }
};

/** Nick's subagents over three of the files (one each, at once, under a parallel profile). */
const nickSubagents = async (session: HostSession, root: string, profile: GateProfile): Promise<void> => {
  const files = OPTED_OUT_FILES.slice(1);
  const parts = profile.isParallel ? files.map((file) => [file]) : [files];
  await Promise.all(
    parts.map(async (part, index) =>
      session.subagent(`mapping-fix-${String(index)}`, async (actor) => {
        await editEach(session, root, part, "nick fix", actor);
      }),
    ),
  );
};

export const runOptedOutCase = async (hub: TestHub, profile: GateProfile): Promise<OptedOutWorld> => {
  const host = { isProcessHost: profile.isProcessHost };
  const repo = await seedCase("opted-out", hub.url, [...OPTED_OUT_FILES, "apps/numlabs/sync.ts"]);
  const mike = await makeDeveloper(hub, MIKE, "p2-mike", profile.budget);
  const nick = await makeDeveloper(hub, NICK, "p2-nick", profile.budget);
  await optOut(hub, mike);
  const mikeAt = await checkoutFor(repo, MIKE, OPTED_OUT_BRANCH, "mike");
  const nickAt = await checkoutFor(repo, NICK, "feat/mapping-fix", "nick");
  const mikeSession = openSession(mike, "p2-mike-quiet", mikeAt.worktree, host);
  const nickSession = openSession(nick, "p2-nick-fix", nickAt.worktree, host);

  mikeSession.label("mike-works");
  await mikeSession.start();
  await mikeSession.prompt("streaming quiet mode: the mapping grid and its api");
  await editEach(mikeSession, mikeAt.worktree, OPTED_OUT_FILES, "mike quiet");
  await mikeSession.settle();

  const nickTurn = await whileAtDesk(mikeSession, mikeAt.worktree, async () => {
    nickSession.label("nick-fix");
    await nickSession.start();
    await nickSession.prompt("fix the mapping grid row height and its api");
    await nickSubagents(nickSession, nickAt.worktree, profile);
    await nickSession.settle();
    nickSession.label("nick-shared-edit");
    const shared = await timed(async () =>
      nickSession.edit(join(nickAt.worktree, OPTED_OUT_SHARED_FILE), fileSource(OPTED_OUT_SHARED_FILE, "nick fix")),
    );
    nickSession.label("nick-fix-after");
    await nickSession.prompt("continue");
    await nickSession.stop();
    await nickSession.settle();
    return shared;
  });

  mikeSession.label("mike-later");
  const mikeLaterEdit = await mikeSession.edit(join(mikeAt.worktree, MIKE_LATER_FILE), fileSource(MIKE_LATER_FILE, "mike later"));
  await mikeSession.settle();
  return {
    repo,
    mike,
    nick,
    mikeSession,
    nickSession,
    nickSharedEdit: nickTurn.value,
    nickSharedEditMoment: nickTurn.moment,
    mikeLaterEdit,
    nickStatusline: await nickSession.statusline(),
    mikeStatusline: await mikeSession.statusline(),
    cleanup: [repo.seed, mikeAt.parent, nickAt.parent, mike.home, nick.home],
  };
};
