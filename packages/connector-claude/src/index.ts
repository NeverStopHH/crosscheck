export { runHook, isHookName } from "./hooks/index.ts";
export type { HookName, HookContext } from "./hooks/runner.ts";
export { runStatusline } from "./statusline/statusline.ts";
export { runCli } from "./cli/index.ts";
export type { CliResult } from "./cli/index.ts";

export {
  extractFailureText,
  extractFilePaths,
  isFailureResponse,
  parseHookPayload,
} from "./capture/tool-events.ts";
export {
  mergeClaudeSettings,
  isOwnedCommand,
} from "./cli/settings-merge.ts";
export type { SettingsPlan, MergeResult } from "./cli/settings-merge.ts";
export { buildSettingsPlan } from "./cli/init.ts";

// The agent-agnostic core, re-exported so this package's surface is unchanged
// by the Block 1 extraction (DESIGN-agent-agnostic.md §1.2): every name that
// used to be exported from the moved modules still resolves from here.
export * from "@crosscheck/connector-core";
