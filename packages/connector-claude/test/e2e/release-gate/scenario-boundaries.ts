/**
 * The boundary cases beside P1: N3 (truly landed days before — silent), N4
 * (one person, two worktrees — silent), N5 (a 300-file formatting sweep that
 * shares one file — NOT silent, but qualified and ranked below a focused
 * overlap: the line "Sweep ≠ Ignore" draws).
 *
 * Under a parallel profile (release-gate/profile.ts) the subagent work of N3
 * and N4 fans out, N4's two sessions run AT ONCE (two terminals), and N4's
 * sessions live: the first compacts before its next Stop, the second ends
 * and resumes — so Nick's own earlier life is one more "other session" the
 * hub must never present to him as a teammate.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { MIKE, NICK } from "../../../../connector-core/test/fixtures/landing-repos.ts";
import { checkoutFor, editEach, seedCase } from "./case-kit.ts";
import type { CaseRepo } from "./case-kit.ts";
import { MS_PER_DAY, addWorktree, commitAll, daysAgo, gitIn, landOnMain } from "./git.ts";
import type { Person } from "./git.ts";
import { openSession } from "./host.ts";
import type { HookRun, HostSession } from "./host.ts";
import type { TestHub } from "./hub.ts";
import { GENEROUS } from "./profile.ts";
import type { GateProfile } from "./profile.ts";
import { TINA } from "./scenario-long-session.ts";
import { makeDeveloper, targetsOf } from "./team.ts";
import type { GateDeveloper } from "./team.ts";

const pad = (value: number): string => String(value).padStart(3, "0");

/** Bash `git commit` as the agent runs it, dated as the scenario's day. */
const commitByBash = async (
  session: HostSession,
  worktree: string,
  as: Person,
  message: string,
  date: string,
): Promise<void> => {
  await session.bash(
    `git add -A && git commit -m "${message}"`,
    async () => {
      await commitAll(worktree, message, as, date);
    },
    { cwd: worktree },
  );
};

/** `paths` split into `count` near-equal runs, in order. */
const split = (paths: readonly string[], count: number): readonly (readonly string[])[] =>
  Array.from({ length: count }, (_, index) =>
    paths.slice(Math.floor((index * paths.length) / count), Math.floor(((index + 1) * paths.length) / count)),
  ).filter((part) => part.length > 0);

/** One subagent over all of `paths`, or — under a parallel profile — `workers` of them at once. */
const subagentsOver = async (
  session: HostSession,
  root: string,
  paths: readonly string[],
  note: string,
  profile: GateProfile,
  workers: number,
): Promise<void> => {
  const parts = profile.isParallel ? split(paths, workers) : [paths];
  await Promise.all(
    parts.map(async (part, index) =>
      session.subagent(`${note}-${String(index)}`, async (actor) => {
        await editEach(session, root, part, note, actor);
      }),
    ),
  );
};

// ── N3 ──────────────────────────────────────────────────────────────────────

const N3_FILES = [
  "apps/practice/mapping/PlayerMappingGrid.tsx",
  "apps/practice/mapping/mappingConfig.ts",
  "apps/practice/mapping/MappingRow.tsx",
  "apps/practice/mapping/mappingApi.ts",
  "apps/practice/mapping/mappingFilters.ts",
  "apps/practice/mapping/useMappingState.ts",
  "apps/practice/mapping/mappingSchema.ts",
  "apps/practice/mapping/index.ts",
];
/** Nick's parallel workers on the eight merged files. */
const N3_WORKERS = 4;

export interface LandedWorld {
  readonly repo: CaseRepo;
  readonly mike: GateDeveloper;
  readonly nick: GateDeveloper;
  readonly mikeSession: HostSession;
  readonly nickSession: HostSession;
  readonly mikeLastCommit: string;
  readonly nickWorktree: string;
  readonly nickStatusline: string;
  readonly cleanup: readonly string[];
}

/**
 * Mike's mapping work, merged nine days of HUB time before Nick starts on the
 * same files. The hub's clock seam places Mike's sessions there; his commits
 * are dated there for the connector-side landed-change probe, whose clock is
 * real. Mike resumes once after his first commit, as a person does the next
 * morning — the re-register that gives his session a base main does not yet
 * contain, which is what makes his merge LAND it (services/landed.ts). Every
 * async hook of a day has finished before the hub's clock moves on, so no
 * record is stamped on the wrong day.
 */
export const runLandedCase = async (hub: TestHub, profile: GateProfile = GENEROUS): Promise<LandedWorld> => {
  const host = { isProcessHost: profile.isProcessHost };
  const repo = await seedCase("landed-before", hub.url, [...N3_FILES, "apps/numlabs/sync.ts"]);
  const mike = await makeDeveloper(hub, MIKE, "n3-mike", profile.budget);
  const nick = await makeDeveloper(hub, NICK, "n3-nick", profile.budget);
  const mikeAt = await checkoutFor(repo, MIKE, "feat/mapping-v1", "mike");
  const mikeSession = openSession(mike, "n3-mike-mapping", mikeAt.worktree, host);

  hub.clock.setOffsetMs(-9 * MS_PER_DAY);
  mikeSession.label("mike-day-1");
  await mikeSession.start();
  await mikeSession.prompt("mapping v1: the player grid and its config");
  await editEach(mikeSession, mikeAt.worktree, N3_FILES.slice(0, 6), "mapping v1");
  await commitByBash(mikeSession, mikeAt.worktree, MIKE, "mapping v1", daysAgo(9));
  await mikeSession.stop();
  await mikeSession.settle();
  hub.clock.setOffsetMs(-8 * MS_PER_DAY);
  mikeSession.label("mike-day-2");
  await mikeSession.start("resume");
  await editEach(mikeSession, mikeAt.worktree, N3_FILES.slice(6), "mapping v1 schema");
  await commitByBash(mikeSession, mikeAt.worktree, MIKE, "mapping v1: schema", daysAgo(8));
  await mikeSession.stop();
  await mikeSession.end();
  await mikeSession.settle();
  const mikeLastCommit = await gitIn(mikeAt.worktree, ["rev-parse", "HEAD"]);
  await landOnMain(repo.seed, mikeAt.clone, "feat/mapping-v1", "Merge pull request #398 from acme/feat/mapping-v1", MIKE, daysAgo(7.5));
  hub.clock.setOffsetMs(0);

  const nickAt = await checkoutFor(repo, NICK, "feat/mapping-v2", "nick");
  const nickSession = openSession(nick, "n3-nick-mapping-v2", nickAt.worktree, host);
  nickSession.label("nick-after-merge");
  await nickSession.start();
  await nickSession.prompt("mapping v2 on top of the merged v1");
  await subagentsOver(nickSession, nickAt.worktree, N3_FILES, "mapping-v2", profile, N3_WORKERS);
  await nickSession.prompt("continue");
  await nickSession.stop();
  await nickSession.settle();
  const nickStatusline = await nickSession.statusline();
  return {
    repo,
    mike,
    nick,
    mikeSession,
    nickSession,
    mikeLastCommit,
    nickWorktree: nickAt.worktree,
    nickStatusline,
    cleanup: [repo.seed, mikeAt.parent, nickAt.parent, mike.home, nick.home],
  };
};

// ── N4 ──────────────────────────────────────────────────────────────────────

const N4_FILES = [
  "apps/practice/mapping/PlayerMappingGrid.tsx",
  "apps/practice/mapping/mappingConfig.ts",
  "apps/practice/mapping/MappingRow.tsx",
  "apps/practice/mapping/mappingApi.ts",
  "apps/practice/mapping/mappingFilters.ts",
  "apps/practice/mapping/index.ts",
];
/** Nick's parallel workers per session on the six files. */
const N4_WORKERS = 3;

export interface SelfWorld {
  readonly repo: CaseRepo;
  readonly nick: GateDeveloper;
  readonly first: HostSession;
  readonly second: HostSession;
  readonly statuslines: readonly string[];
  readonly cleanup: readonly string[];
}

/** The first session's turn: its subagents over all six files. */
const firstTurn = async (session: HostSession, root: string, profile: GateProfile): Promise<void> => {
  session.label("first");
  await session.start();
  await session.prompt("mapping a: grid and config");
  await subagentsOver(session, root, N4_FILES, "mapping-a", profile, N4_WORKERS);
  await session.stop();
};

/** The second session's turn: three files by hand, three by subagents. */
const secondTurn = async (session: HostSession, root: string, profile: GateProfile): Promise<void> => {
  session.label("second");
  await session.start();
  await session.prompt("mapping b: the same files, another approach");
  await editEach(session, root, N4_FILES.slice(0, 3), "b");
  await subagentsOver(session, root, N4_FILES.slice(3), "mapping-b", profile, N4_WORKERS);
  await session.stop();
};

/**
 * Nick alone, in two sessions on two worktrees of one clone, both in the same
 * six files — one after the other, or (parallel profile) at once. With the
 * lives, the second ends and resumes, and the first compacts, before each
 * touches a shared file again.
 */
export const runSelfCase = async (hub: TestHub, profile: GateProfile = GENEROUS): Promise<SelfWorld> => {
  const host = { isProcessHost: profile.isProcessHost };
  const repo = await seedCase("self-twins", hub.url, [...N4_FILES, "apps/numlabs/sync.ts"]);
  const nick = await makeDeveloper(hub, NICK, "n4-nick", profile.budget);
  const firstAt = await checkoutFor(repo, NICK, "feat/mapping-a", "nick-a");
  const secondTree = await addWorktree(firstAt.clone, join(firstAt.parent, "nick-b"), "feat/mapping-b", "origin/main");
  const first = openSession(nick, "n4-nick-a", firstAt.worktree, host);
  const second = openSession(nick, "n4-nick-b", secondTree, host);
  if (profile.isParallel) {
    await Promise.all([firstTurn(first, firstAt.worktree, profile), secondTurn(second, secondTree, profile)]);
  } else {
    await firstTurn(first, firstAt.worktree, profile);
    await secondTurn(second, secondTree, profile);
  }
  if (profile.hasCompactAndResume) {
    second.label("second-resumed");
    await second.end();
    await second.start("resume");
    await second.prompt("back to b after the reload");
    await editEach(second, secondTree, N4_FILES.slice(1, 2), "b again");
    await second.stop();
  }
  first.label("first-again");
  if (profile.hasCompactAndResume) {
    await first.start("compact");
  }
  await first.prompt("back to a");
  await editEach(first, firstAt.worktree, N4_FILES.slice(0, 1), "a again");
  await Promise.all([first.settle(), second.settle()]);
  return {
    repo,
    nick,
    first,
    second,
    statuslines: [await first.statusline(), await second.statusline()],
    cleanup: [repo.seed, firstAt.parent, nick.home],
  };
};

// ── N5 ──────────────────────────────────────────────────────────────────────

export const N5_SHARED_FILE = "apps/practice/mapping/PlayerMappingGrid.tsx";
const N5_FOCUSED = [N5_SHARED_FILE, "apps/practice/mapping/MappingRow.tsx", "apps/practice/mapping/mappingApi.ts"];
const N5_SWEEP = [N5_SHARED_FILE, ...Array.from({ length: 299 }, (_, index) => `apps/web/src/fmt/file${pad(index + 1)}.ts`)];
/** Enough Stops for the git lane, MAX_TARGETS_PER_INVOCATION (20) per Stop, to take all 300. */
const MAX_SWEEP_TURNS = 20;

export interface SweepWorld {
  readonly repo: CaseRepo;
  readonly mike: GateDeveloper;
  readonly nick: GateDeveloper;
  readonly tina: GateDeveloper;
  readonly mikeSession: HostSession;
  readonly nickSession: HostSession;
  readonly tinaSession: HostSession;
  /** How many of the 300 files the hub holds as Mike's targets when Nick edits. */
  readonly mikeTargetCount: number;
  /** Nick's runs for his edit of the one shared file. */
  readonly nickSharedEdit: readonly HookRun[];
  readonly nickStatusline: string;
  readonly cleanup: readonly string[];
}

const mikeTargets = async (hub: TestHub, repo: CaseRepo): Promise<number> =>
  (await targetsOf(hub.db, repo.repoId)).filter((target) => target.developer === "Mike").length;

/**
 * Tina works a focused change (3 files), then Mike runs a formatter over 300
 * files — one of Tina's among them — through Bash, and keeps working turn
 * after turn while the git lane picks the sweep up; his heartbeat is the
 * fresher one. Then Nick edits the one file all three touched, and Tina's two
 * others.
 */
export const runSweepCase = async (hub: TestHub, profile: GateProfile = GENEROUS): Promise<SweepWorld> => {
  const host = { isProcessHost: profile.isProcessHost };
  const repo = await seedCase("formatter-run", hub.url, [...new Set([...N5_SWEEP, ...N5_FOCUSED])]);
  const mike = await makeDeveloper(hub, MIKE, "n5-mike", profile.budget);
  const nick = await makeDeveloper(hub, NICK, "n5-nick", profile.budget);
  const tina = await makeDeveloper(hub, TINA, "n5-tina", profile.budget);
  const tinaAt = await checkoutFor(repo, TINA, "feat/mapping-perf", "tina");
  const mikeAt = await checkoutFor(repo, MIKE, "chore/prettier-3", "mike");
  const nickAt = await checkoutFor(repo, NICK, "feat/mapping-fix", "nick");
  const tinaSession = openSession(tina, "n5-tina-perf", tinaAt.worktree, host);
  const mikeSession = openSession(mike, "n5-mike-format", mikeAt.worktree, host);
  const nickSession = openSession(nick, "n5-nick-fix", nickAt.worktree, host);

  tinaSession.label("tina-focused");
  await tinaSession.start();
  await tinaSession.prompt("mapping perf: memoize the grid rows");
  await editEach(tinaSession, tinaAt.worktree, N5_FOCUSED, "perf");
  await tinaSession.stop();
  await tinaSession.settle();

  mikeSession.label("mike-sweep");
  await mikeSession.start();
  await mikeSession.prompt("upgrade prettier and reformat the repo");
  await mikeSession.bash(
    "bunx prettier@3 --write .",
    async () => {
      for (const path of N5_SWEEP) {
        const absolute = join(mikeAt.worktree, path);
        await writeFile(absolute, `${(await readFile(absolute, "utf8")).trimEnd()}\n// formatted\n`, "utf8");
      }
    },
    { cwd: mikeAt.worktree },
  );
  // Turn after turn: each Stop's git lane takes the next slice of the sweep.
  const counts: number[] = [];
  for (let turn = 0; turn < MAX_SWEEP_TURNS; turn += 1) {
    await mikeSession.stop();
    await mikeSession.settle();
    counts.push(await mikeTargets(hub, repo));
    if (counts.length > 1 && counts.at(-1) === counts.at(-2)) {
      break;
    }
    await mikeSession.bash("bunx prettier@3 --check .", async () => undefined, { cwd: mikeAt.worktree });
  }

  nickSession.label("nick-edits-shared");
  await nickSession.start();
  await nickSession.prompt("fix the mapping grid row height");
  const nickSharedEdit = await nickSession.edit(join(nickAt.worktree, N5_SHARED_FILE), "// fixed row height\n");
  nickSession.label("nick-edits-rest");
  await editEach(nickSession, nickAt.worktree, N5_FOCUSED.slice(1), "row height");
  await nickSession.settle();
  const nickStatusline = await nickSession.statusline();
  return {
    repo,
    mike,
    nick,
    tina,
    mikeSession,
    nickSession,
    tinaSession,
    mikeTargetCount: counts.at(-1) ?? 0,
    nickSharedEdit,
    nickStatusline,
    cleanup: [repo.seed, tinaAt.parent, mikeAt.parent, nickAt.parent, mike.home, nick.home, tina.home],
  };
};
