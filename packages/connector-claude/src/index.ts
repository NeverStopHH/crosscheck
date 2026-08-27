export { runHook, isHookName } from "./hooks/index.ts";
export type { HookName, HookContext } from "./hooks/runner.ts";
export { runStatusline } from "./statusline/statusline.ts";
// The Tier-1 summarizer surface (Claude-specific by construction, DESIGN.md
// §3): the worker entry the bin's `summarize-turn` subcommand runs, and the
// cost read/format pair `status`/`doctor` print — all consumed from
// `packages/cli` since Block 8 moved the bin there.
export { runSummarizeWorker } from "./summarizer/worker.ts";
export {
  formatSummarizerCost,
  isSummarizerAlwaysRejected,
  isSummarizerSilentlyDead,
  readSummarizerCost,
} from "./summarizer/cost.ts";
// The derived-intent surface (trial finding #16): the worker entry the
// prompt hook spawns, and the cost read/format pair `status`/`doctor` print.
export { runIntentWorker } from "./intent/worker.ts";
export { formatIntentCost, isIntentSilentlyDead, readIntentCost } from "./intent/cost.ts";
export type { IntentCost } from "./intent/cost.ts";
// The gated ghost-check surface (VISION.md §3): the worker entry the prompt
// hook spawns when a recorded intent still owes a comparison.
export { runGhostWorker } from "./ghost/worker.ts";
export {
  formatGhostCost,
  isGhostSilentlyDead,
  readGhostCost,
  summarizeGhostCost,
} from "./ghost/cost.ts";
export type { GhostCost } from "./ghost/cost.ts";
// The agent conference's model half (VISION.md §2): what `crosscheck
// conference` shows the model, how it labels the sessions so an answer can be
// attributed deterministically, and how the answer is read back. No worker
// entry — a conference is a command a human runs, never a detached spawn.
export {
  CONFERENCE_PROMPT,
  estimateInputTokens,
  fitSessions,
  labelSessions,
  parseConferenceAnswer,
  renderConferenceInput,
  resolveConferenceArgv,
} from "./conference/prompt.ts";
export type {
  ConferenceAnswer,
  LabelledSession,
  ParsedFinding,
} from "./conference/prompt.ts";
// The shared model-cost scan's per-counter summarizers (state/session-state.ts
// readLiveSessionStates reads the directory once for all three).
export { summarizeSummarizerCost } from "./summarizer/cost.ts";
export { summarizeIntentCost } from "./intent/cost.ts";
// The runner's own surface for `doctor` (trial finding #14): the real argv,
// the real worker env, the booked-failure formatter and the active probe.
export {
  SUMMARIZER_LEAN_FLAGS,
  formatSummarizerFailure,
  resolveSummarizerArgv,
  resolveSummarizerTimeoutMs,
  runSummarizer,
} from "./summarizer/runner.ts";
export type {
  SummarizerFailure,
  SummarizerResult,
} from "./summarizer/runner.ts";
export {
  PARENT_SESSION_MARKER_PATTERN,
  ensureSummarizerCwd,
  summarizerWorkerEnv,
} from "./summarizer/worker-env.ts";
export {
  isBelowSummarizerVersionFloor,
  probeSummarizerRunner,
} from "./summarizer/probe.ts";
export type { SummarizerProbe } from "./summarizer/probe.ts";

export {
  extractFailureText,
  extractFilePaths,
  isFailureResponse,
  parseHookPayload,
} from "./capture/tool-events.ts";
export {
  buildSettingsPlan,
  mergeClaudeSettings,
  removeClaudeSettings,
  isOwnedCommand,
} from "./cli/settings-merge.ts";
export type {
  MatcherGroup,
  MergeResult,
  RemovalResult,
  SettingsPlan,
} from "./cli/settings-merge.ts";
export {
  claudeUserDir,
  claudeUserMcpPath,
  claudeUserSettingsPath,
} from "./cli/user-paths.ts";

// The agent-agnostic core, re-exported so this package's surface is unchanged
// by the Block 1 extraction (DESIGN-agent-agnostic.md §1.2): every name that
// used to be exported from the moved modules still resolves from here.
export * from "@crosscheck/connector-core";
