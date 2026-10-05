/**
 * The facts about a repo's PROJECT copy of the wiring that decide how the
 * double-wiring remedy is worded — read once, here, so doctor's WARN and
 * init's note can never say different things about the same repo.
 *
 * The remedy has to know which side actually reaches a teammate (trial
 * finding M11). Where the project settings file is GITIGNORED — the monorepo
 * shape — `crosscheck init --global --remove` is the exactly wrong
 * instruction: it deletes the only wiring that covers worktrees and parent
 * workspaces, and leaves a project install nobody else will ever receive. So
 * that branch never names it; it names the PROJECT-side `crosscheck init
 * --remove` ("delete the gitignored project copy" left a pilot teammate
 * asking how, 2026-10), with `--cursor` whenever plain `--remove` would leave
 * crosscheck's Cursor entries loading (review 2026-10-05).
 */
import {
  CLAUDE_SETTINGS_DIR,
  CLAUDE_SETTINGS_FILE,
} from "@crosscheck/connector-core/constants.ts";
import { isPathIgnored } from "@crosscheck/connector-core/git/check-ignore.ts";
import { cursorTargets, readWiringState } from "./wiring-removal.ts";
import { projectCursorDir } from "./wiring-scope.ts";

export interface ProjectCopy {
  /** M11: `true` = .claude/settings.json is gitignored here (null = git could not say). */
  readonly settingsIgnored: boolean | null;
  /** `.cursor/` holds crosscheck's entries — only `init --remove --cursor` removes them. */
  readonly cursorWired: boolean;
}

export const readProjectCopy = async (root: string): Promise<ProjectCopy> => ({
  settingsIgnored: await isPathIgnored(root, `${CLAUDE_SETTINGS_DIR}/${CLAUDE_SETTINGS_FILE}`),
  cursorWired:
    (await readWiringState(await cursorTargets(await projectCursorDir(root)))).wired.length > 0,
});

/** The project-side removal, spelled with every flag it needs here. */
const projectRemoveCommand = (copy: ProjectCopy): string =>
  `\`crosscheck init --remove${copy.cursorWired ? " --cursor" : ""}\``;

/** The double-wiring remedy; `null` = the project copy's facts were not read. */
export const doubleWiringRemedy = (copy: ProjectCopy | null): string =>
  copy !== null && copy.settingsIgnored === true
    ? `keep the global install and remove the gitignored project copy with ${projectRemoveCommand(copy)} — .claude/settings.json is ignored in this repo, so it never reaches teammates and only the user-level install covers your worktrees`
    : "remove one side: `crosscheck init --global --remove`, or strip the repo's .claude/settings.json entries";
