/**
 * Repo shapes for the release gate (test/e2e/release-gate-nick-mike.e2e.test.ts),
 * on the landed-change fixtures' own git runner (`gitIn`: global and system
 * config shut out, per-command identity and date).
 *
 * Repo identity is git-derived, never mocked: every clone's `origin` names a
 * github.com URL, which is what the connector normalizes into the repo id,
 * and NOTHING ever fetches from it — a "fetch" is `git fetch <seed path>`,
 * the local seed repo standing in for the forge, so `origin/main` moves the
 * way a background fetch moves it and no byte leaves the machine.
 *
 * History is BACKDATED where the scenario's meaning depends on it: the
 * landed-change probe reads commit dates against a working-day window
 * (LANDED_RECENT_WORKING_DAYS), and the connector's clock is the real one.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { gitIn } from "../../../../connector-core/test/fixtures/landing-repos.ts";
import type { Person } from "../../../../connector-core/test/fixtures/landing-repos.ts";

export { gitIn };
export type { Person };

export const MS_PER_DAY = 86_400_000;

/** `days` before the real now, as git takes a date — the connector's clock, which no seam moves. */
export const daysAgo = (days: number): string => new Date(Date.now() - days * MS_PER_DAY).toISOString();

export const writeTree = async (root: string, files: Readonly<Record<string, string>>): Promise<void> => {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
};

/** Everything in the tree, committed as `as` at `date`; returns the sha. */
export const commitAll = async (root: string, message: string, as: Person, date: string): Promise<string> => {
  await gitIn(root, ["add", "-A"]);
  await gitIn(root, ["commit", "--no-verify", "-q", "-m", message], { as, date });
  return gitIn(root, ["rev-parse", "HEAD"]);
};

export const SEED_AUTHOR: Person = { name: "Seed", email: "seed@example.com" };

/** The forge: a plain repo on `main` that every clone fetches from by path. */
export const makeSeed = async (
  label: string,
  files: Readonly<Record<string, string>>,
  date: string,
): Promise<{ readonly root: string; readonly initial: string }> => {
  const root = await mkdtemp(join(tmpdir(), `cx-gate-${label}-seed-`));
  await gitIn(root, ["init", "-q", "--initial-branch=main"]);
  await gitIn(root, ["config", "user.email", SEED_AUTHOR.email]);
  await gitIn(root, ["config", "user.name", SEED_AUTHOR.name]);
  await writeTree(root, files);
  const initial = await commitAll(root, "initial import", SEED_AUTHOR, date);
  return { root, initial };
};

/**
 * A developer's clone at `<tmp>/<label>/monorepo`: `origin` re-pointed at the
 * forge's github.com URL so the connector derives the shared repo id, with
 * refs/remotes/origin/main and origin/HEAD kept from the clone.
 */
export const cloneFor = async (
  seedRoot: string,
  label: string,
  remoteUrl: string,
  person: Person,
): Promise<string> => {
  const parent = await mkdtemp(join(tmpdir(), `cx-gate-${label}-`));
  const root = join(parent, "monorepo");
  await gitIn(parent, ["clone", "-q", seedRoot, root]);
  await gitIn(root, ["remote", "set-url", "origin", remoteUrl]);
  await gitIn(root, ["config", "user.email", person.email]);
  await gitIn(root, ["config", "user.name", person.name]);
  return root;
};

/** A background fetch of the forge's main, without ever naming the remote. */
export const fetchMain = async (clone: string, seedRoot: string): Promise<void> => {
  await gitIn(clone, ["fetch", "-q", seedRoot, "+main:refs/remotes/origin/main"]);
};

export const addWorktree = async (clone: string, path: string, branch: string, startPoint: string): Promise<string> => {
  await gitIn(clone, ["worktree", "add", "-q", "-b", branch, path, startPoint]);
  return path;
};

export const addDetachedWorktree = async (clone: string, path: string, commit: string): Promise<string> => {
  await gitIn(clone, ["worktree", "add", "-q", "--detach", path, commit]);
  return path;
};

/** A teammate's PR landing: their branch merged `--no-ff` into the forge's main, dated. */
export const landOnMain = async (
  seedRoot: string,
  fromClone: string,
  branch: string,
  message: string,
  merger: Person,
  date: string,
): Promise<string> => {
  await gitIn(seedRoot, ["fetch", "-q", fromClone, `+${branch}:refs/heads/${branch}`]);
  await gitIn(seedRoot, ["merge", "--no-ff", "-q", "-m", message, branch], { as: merger, date });
  return gitIn(seedRoot, ["rev-parse", "HEAD"]);
};
