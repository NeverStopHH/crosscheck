export { runHook, isHookName } from "./hooks/index.ts";
export type { HookName, HookContext } from "./hooks/runner.ts";
export { runStatusline } from "./statusline/statusline.ts";
// The Tier-1 summarizer surface (Claude-specific by construction, DESIGN.md
// §3): the worker entry the bin's `summarize-turn` subcommand runs, and the
// cost read/format pair `status`/`doctor` print — all consumed from
// `packages/cli` since Block 8 moved the bin there.
export { runSummarizeWorker } from "./summarizer/worker.ts";
export { formatSummarizerCost, readSummarizerCost } from "./summarizer/cost.ts";

export {
  extractFailureText,
  extractFilePaths,
  isFailureResponse,
  parseHookPayload,
} from "./capture/tool-events.ts";
export {
  buildSettingsPlan,
  mergeClaudeSettings,
  isOwnedCommand,
} from "./cli/settings-merge.ts";
export type {
  MatcherGroup,
  MergeResult,
  SettingsPlan,
} from "./cli/settings-merge.ts";

// The agent-agnostic core, re-exported so this package's surface is unchanged
// by the Block 1 extraction (DESIGN-agent-agnostic.md §1.2): every name that
// used to be exported from the moved modules still resolves from here.
export * from "@crosscheck/connector-core";
