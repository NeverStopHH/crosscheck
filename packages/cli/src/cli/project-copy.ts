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
 * crosscheck's Cursor entries loading (review 2026-10-05). That command
 * strips the WHOLE project copy, not only its ignored files: a committed
 * `.mcp.json` holding crosscheck's server goes too, and the remedy says so.
 */
import {
  CLAUDE_SETTINGS_DIR,
  CLAUDE_SETTINGS_FILE,
  MCP_CONFIG_FILE,
} from "@crosscheck/connector-core/constants.ts";
import { isPathIgnored, isPathTracked } from "@crosscheck/connector-core/git/check-ignore.ts";
import { cursorTargets, readWiringState, removalTargets } from "./wiring-removal.ts";
import { projectCursorDir, projectWiringFiles } from "./wiring-scope.ts";

export interface ProjectCopy {
  /** M11: `true` = .claude/settings.json is gitignored here (null = git could not say). */
  readonly settingsIgnored: boolean | null;
  /** `true` = .claude/settings.json is committed — removing it is a team change. */
  readonly settingsTracked: boolean | null;
  /** `.cursor/` holds crosscheck's entries — only `init --remove --cursor` removes them. */
  readonly cursorWired: boolean;
  /**
   * `.mcp.json` is COMMITTED and holds crosscheck's server: the same removal
   * changes a file teammates share, even where `.claude/` is ignored (review
   * 2026-10-05 — the "ignored copy" remedy deleted a tracked `.mcp.json`).
   */
  readonly sharedMcp: boolean;
}

export const readProjectCopy = async (root: string): Promise<ProjectCopy> => {
  const files = await projectWiringFiles(root, false);
  const claudePair = await readWiringState(await removalTargets(files));
  return {
    settingsIgnored: await isPathIgnored(root, `${CLAUDE_SETTINGS_DIR}/${CLAUDE_SETTINGS_FILE}`),
    settingsTracked: await isPathTracked(root, `${CLAUDE_SETTINGS_DIR}/${CLAUDE_SETTINGS_FILE}`),
    cursorWired:
      (await readWiringState(await cursorTargets(await projectCursorDir(root)))).wired.length > 0,
    sharedMcp:
      claudePair.wired.some((file) => file.path === files.mcpPath) &&
      (await isPathTracked(root, MCP_CONFIG_FILE)) === true,
  };
};

/** The project-side removal, spelled with every flag it needs here. */
const projectRemoveCommand = (copy: ProjectCopy): string =>
  `\`crosscheck init --remove${copy.cursorWired ? " --cursor" : ""}\``;

/** The part of an ignored-copy removal that is NOT local, said aloud. */
const sharedMcpClause = (copy: ProjectCopy): string =>
  copy.sharedMcp
    ? `; ${MCP_CONFIG_FILE} is committed, though, and holds crosscheck's server — the same command changes it for the whole team: commit that change, or \`git restore -- ${MCP_CONFIG_FILE}\` to keep their mcp tools`
    : "";

/**
 * Where the project copy is NOT ignored, either side may go — and both are
 * commands now, never a hand-edit (review 2026-10-05). Whether removing the
 * project side is a team change is git's answer, not an assumption: a copy
 * `init` wrote and nobody committed is not shared with anyone yet.
 */
const eitherSideRemedy = (copy: ProjectCopy): string => {
  const both = `remove one side: \`crosscheck init --global --remove\`, or ${projectRemoveCommand(copy)}`;
  if (copy.settingsTracked === true) {
    return `${both} — .claude/settings.json is committed here, so removing the project side changes it for the whole team`;
  }
  return copy.settingsTracked === false
    ? `${both} for this repo's copy — it is not committed, so nobody else has it yet${sharedMcpClause(copy)}`
    : `${both} for this repo's copy${sharedMcpClause(copy)}`;
};

/** The double-wiring remedy; `null` = the project copy's facts were not read. */
export const doubleWiringRemedy = (copy: ProjectCopy | null): string => {
  if (copy === null) {
    return "remove one side: `crosscheck init --global --remove`, or `crosscheck init --remove` for this repo's copy";
  }
  return copy.settingsIgnored === true
    ? `keep the global install and remove the gitignored project copy with ${projectRemoveCommand(copy)} — .claude/settings.json is ignored in this repo, so it never reaches teammates and only the user-level install covers your worktrees${sharedMcpClause(copy)}`
    : eitherSideRemedy(copy);
};
