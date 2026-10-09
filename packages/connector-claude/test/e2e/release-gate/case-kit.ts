/**
 * The small-team cases' common ground (N2–N5): one connected repo per case —
 * its seed carries the committed `.crosscheck.json` `crosscheck init` writes,
 * which the capture trust rule needs to follow an edit into a worktree — and
 * a developer's clone plus a worktree on their branch.
 */
import { dirname, join } from "node:path";

import { renderRepoConfig } from "@crosscheck/connector-core/config/repo-config.ts";
import { PRESENCE_TTL_MS } from "@crosscheck/connector-core/constants.ts";

import { addWorktree, cloneFor, daysAgo, makeSeed } from "./git.ts";
import type { Person } from "./git.ts";
import type { Actor, HostSession } from "./host.ts";
import { MAIN_THREAD, openSession } from "./host.ts";
import type { TestHub } from "./hub.ts";
import { makeDeveloper } from "./team.ts";

export interface CaseRepo {
  readonly label: string;
  readonly repoId: string;
  readonly remoteUrl: string;
  readonly seed: string;
}

export const fileSource = (path: string, note = "seed"): string => `// ${path} (${note})\nexport const value = ${String(path.length)};\n`;

/** A forge for `label` holding `paths` (and any literal `extra` files), dated well outside every recency window. */
export const seedCase = async (
  label: string,
  hubUrl: string,
  paths: readonly string[],
  extra: Readonly<Record<string, string>> = {},
): Promise<CaseRepo> => {
  const files = {
    ...Object.fromEntries(paths.map((path) => [path, fileSource(path)])),
    ...extra,
    "README.md": `# ${label}\n`,
    ".crosscheck.json": renderRepoConfig(hubUrl),
  };
  const { root } = await makeSeed(label, files, daysAgo(60));
  return { label, repoId: `github.com/acme/${label}`, remoteUrl: `git@github.com:acme/${label}.git`, seed: root };
};

export interface Checkout {
  readonly clone: string;
  readonly worktree: string;
  /** The directory holding both — what a case deletes. */
  readonly parent: string;
}

/** `person`'s clone of the case repo and a worktree on `branch` cut from origin/main. */
export const checkoutFor = async (repo: CaseRepo, person: Person, branch: string, tag: string): Promise<Checkout> => {
  const clone = await cloneFor(repo.seed, `${repo.label}-${tag}`, repo.remoteUrl, person);
  const worktree = await addWorktree(clone, join(dirname(clone), tag), branch, "origin/main");
  return { clone, worktree, parent: dirname(clone) };
};

/**
 * A third of the presence window (PRESENCE_TTL_MS): however slow the machine,
 * a developer at their desk never ages out of presence.
 */
const AT_DESK_EVERY_MS = PRESENCE_TTL_MS / 3;

/**
 * `session`'s developer STAYS AT THEIR DESK while `body` runs — "both at their
 * desks" held by what keeps a person live rather than by how fast the machine
 * is: every AT_DESK_EVERY_MS their agent runs their tests (a Bash call: its
 * PostToolUse capture carries the heartbeat, and it asks no tripwire, so a
 * case's tripwire answers are exactly what they would be without it). On a
 * starved machine a teammate's fan-out outlasts the presence window, and a
 * teammate the presence answer no longer lists is counted, never named — by
 * design, and not what such a phase is about.
 */
export const whileAtDesk = async <T>(session: HostSession, worktree: string, body: () => Promise<T>): Promise<T> => {
  const finished = Promise.withResolvers<boolean>();
  const desk = (async (): Promise<void> => {
    for (;;) {
      const isStillWorking = await Promise.race([Bun.sleep(AT_DESK_EVERY_MS).then(() => true), finished.promise]);
      if (!isStillWorking) {
        return;
      }
      session.label("at-desk");
      await session.bash("bun test", async () => undefined, { cwd: worktree });
    }
  })();
  try {
    return await body();
  } finally {
    finished.resolve(false);
    await desk;
  }
};

const WARM_UP: Person = { name: "Warm Up", email: "warm-up@example.com" };

/**
 * A WARM HUB. A team's hub has served for days, so the first plan of every
 * statement it runs is not the product's latency — on a fresh PGlite it is
 * hundreds of milliseconds, which a production budget would book as a loss
 * the product never has. One unmeasured session in a throwaway repo, in
 * process and at the generous budget, walks every route a hook calls
 * (register, briefing, prompt hint, tripwire, capture, the turn's lane,
 * statusline, end). Returns what to delete afterwards.
 */
export const warmHub = async (hub: TestHub): Promise<readonly string[]> => {
  const repo = await seedCase("warm-up", hub.url, ["src/warm.ts", "src/cold.ts"]);
  const developer = await makeDeveloper(hub, WARM_UP, "warm-up");
  const at = await checkoutFor(repo, WARM_UP, "feat/warm-up", "warm-up");
  const session = openSession(developer, "warm-up", at.worktree);
  await session.start();
  await session.prompt("warm the hub up");
  await editEach(session, at.worktree, ["src/warm.ts", "src/new.ts"], "warm");
  await session.subagent("warm-up", async (actor) => {
    await editEach(session, at.worktree, ["src/cold.ts"], "warm", actor);
  });
  await session.stop();
  await session.statusline();
  await session.end();
  return [repo.seed, at.parent, developer.home];
};

/** One Edit/Write per path, in order, as `actor`. */
export const editEach = async (
  session: HostSession,
  root: string,
  paths: readonly string[],
  note: string,
  actor: Actor = MAIN_THREAD,
): Promise<void> => {
  for (const path of paths) {
    await session.edit(join(root, path), fileSource(path, note), actor);
  }
};
