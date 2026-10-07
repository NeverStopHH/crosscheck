/**
 * `crosscheck init --remove` — the project-side uninstall (pilot, 2026-10).
 *
 * A teammate ran `crosscheck init` in his checkout and `crosscheck init
 * --global` as well. doctor's double-wiring WARN told him to keep the global
 * install and delete the gitignored project copy, and he asked "how?" — the
 * only `--remove` was `init --global --remove`, which deletes the side that
 * should stay. This removes THIS repo's crosscheck wiring and nothing else:
 *
 *   - crosscheck's hook entries and statusline in `.claude/settings.json`,
 *     and its server in `.mcp.json`; with `--cursor`, its entries in
 *     `.cursor/hooks.json` + `.cursor/mcp.json`;
 *   - identified by the SAME table `init --global --remove` walks
 *     (wiring-removal.ts), never by a second copy of the matching rule;
 *   - never `.crosscheck.json` (the team's repo connection), never a foreign
 *     entry, never a user-level file.
 *
 * Unlike the user-level removal, which skips a file it cannot parse, this
 * one REFUSES and writes nothing — the project install's rule: these files
 * belong to a repo, and a half-removed repo is the state doctor explains
 * worst. A file the strip leaves holding nothing but install-created
 * structure is deleted; any other changed file is rewritten atomically, its
 * original saved OUTSIDE the work tree and named (init-remove-plan.ts).
 */
import {
  EXIT_ABORTED,
  EXIT_FAIL,
  EXIT_OK,
} from "@crosscheck/connector-core/constants.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import {
  applyAll,
  planAll,
  planLine,
  removalBackupDir,
  saveOriginals,
} from "./init-remove-plan.ts";
import { afterRunLines, failureReport, teamChangeNote } from "./init-remove-report.ts";
import { REMOVE_RESTART_LINE, removalTargets } from "./wiring-removal.ts";
import {
  collisionSentence,
  findUserLevelCollision,
  projectWiringFiles,
} from "./wiring-scope.ts";
import type { CliResult } from "./login.ts";

export interface ProjectRemoveOptions {
  /** Include `.cursor/hooks.json` + `.cursor/mcp.json`, as `init --cursor` did. */
  readonly cursor: boolean;
}

export const runProjectRemove = async (
  options: ProjectRemoveOptions,
  env: Env,
  cwd: string,
): Promise<CliResult> => {
  const identity = await resolveRepoIdentity(cwd);
  if (identity === null) {
    return { stdout: "not a git repository\n", exitCode: EXIT_FAIL };
  }
  const root = identity.root;
  const targets = await removalTargets(await projectWiringFiles(root, options.cursor));
  // Before anything is read: a "project" file that IS a user-level one
  // ($HOME as the work tree, or a link into ~/.claude) is the install
  // doctor said to keep (review 2026-10-05).
  const collision = await findUserLevelCollision(
    targets.map((target) => target.path),
    env,
  );
  if (collision !== null) {
    return {
      stdout: `${collisionSentence(collision, root)}; \`crosscheck init --global --remove\` is the user-level removal\n`,
      exitCode: EXIT_ABORTED,
    };
  }
  const planned = await planAll(targets, root);
  if (!planned.ok) {
    return { stdout: `${planned.refusal}\n`, exitCode: EXIT_ABORTED };
  }
  const saved = await saveOriginals(planned.plans, root, removalBackupDir(env, root));
  if (!saved.ok) {
    return { stdout: `${saved.refusal}\n`, exitCode: EXIT_ABORTED };
  }
  const plans = saved.plans;
  const applied = await applyAll(plans);
  if (!applied.ok) {
    return { stdout: failureReport(applied), exitCode: EXIT_FAIL };
  }
  const notes = await Promise.all(plans.map((plan) => teamChangeNote(root, plan)));
  return {
    stdout: [
      ...plans.map(planLine),
      ...notes.flat(),
      ...(await afterRunLines(root, env, options.cursor, plans)),
      REMOVE_RESTART_LINE,
      "",
    ].join("\n"),
    exitCode: EXIT_OK,
  };
};
