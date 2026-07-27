export { runHook, isHookName } from "./hooks/index.ts";
export type { HookName, HookContext } from "./hooks/runner.ts";
export { runStatusline } from "./statusline/statusline.ts";
export { runCli } from "./cli/index.ts";
export type { CliResult } from "./cli/index.ts";

export { renderBriefing, formatAge, groupTeammates } from "./briefing/render.ts";
export type { BriefingInput, TeammateGroup } from "./briefing/render.ts";
export {
  resolveCommitDrift,
  resolveDriftByBaseCommit,
} from "./git/commit-drift.ts";
export type { CommitDrift } from "./git/commit-drift.ts";
export { sanitizeUntrusted, REDACTED_TITLE } from "./briefing/sanitize.ts";
export { containsSecret } from "./capture/secret-scan.ts";
export { fingerprint, normalizeFailureText } from "./capture/fingerprint.ts";
export {
  DEFAULT_DENYLIST,
  isDenied,
  matchesGlob,
  resolveDenylist,
} from "./capture/denylist.ts";
export type { DenylistConfig, DenylistMode } from "./capture/denylist.ts";
export {
  extractFailureText,
  extractFilePaths,
  isFailureResponse,
  parseHookPayload,
} from "./capture/tool-events.ts";
export {
  normalizeRemoteUrl,
  resolveRepoIdentity,
} from "./git/repo-identity.ts";
export type { RepoIdentity } from "./git/repo-identity.ts";
export {
  mergeClaudeSettings,
  isOwnedCommand,
} from "./cli/settings-merge.ts";
export type { SettingsPlan, MergeResult } from "./cli/settings-merge.ts";
export { buildSettingsPlan } from "./cli/init.ts";
export { appendRecords } from "./spool/append.ts";
export type { AppendResult } from "./spool/append.ts";
export { flushSpool } from "./spool/flush.ts";
export type { FlushInput, FlushOutcome } from "./spool/flush.ts";
export { reapSpool } from "./spool/reap.ts";
export type { DeferredEnder, ReapResult } from "./spool/reap.ts";
export { readSpoolLines, spoolDepth } from "./spool/files.ts";
export { readDropSummary } from "./spool/drops.ts";
export type { DropSummary } from "./spool/drops.ts";
export {
  readUnclosedSummary,
  recordUnclosedSession,
} from "./spool/unclosed.ts";
export type { UnclosedSummary } from "./spool/unclosed.ts";
export { repoKey, crosscheckHome } from "./config/paths.ts";
export type { Env } from "./config/paths.ts";
export { loadConfig, normalizeHubUrl, saveConfig } from "./config/config.ts";
export type { Config, ResolvedConfig } from "./config/config.ts";
export { readSyncState } from "./state/sync-state.ts";
export { readSessionState } from "./state/session-state.ts";
export * from "./constants.ts";
