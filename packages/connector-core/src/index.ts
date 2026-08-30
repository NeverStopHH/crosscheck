/**
 * @crosscheck/connector-core — the agent-agnostic connector core.
 *
 * Extracted from @crosscheck/connector-claude by Block 1's mechanical move
 * (docs/adapters/DESIGN-agent-agnostic.md §1.2): spool, hub client, capture
 * primitives, render + sanitize, MCP server + tools, state, git, config.
 * These export lines are the moved half of the Claude connector's barrel,
 * verbatim — zero renames in this block; identity generalization is Block 2.
 */
export {
  QUOTED_DATA_NOTICE,
  renderBriefing,
  formatAge,
  groupTeammates,
} from "./briefing/render.ts";
export type { BriefingInput, TeammateGroup } from "./briefing/render.ts";
export {
  resolveCommitDrift,
  resolveDriftByBaseCommit,
} from "./git/commit-drift.ts";
export type { CommitDrift } from "./git/commit-drift.ts";
export {
  REDACTED_SPAN,
  REDACTED_TITLE,
  redactionNote,
  sanitizeUntrusted,
  spanRedactedUntrusted,
} from "./briefing/sanitize.ts";
export { containsSecret } from "./capture/secret-scan.ts";
export {
  collectCommitEvidence,
  commitEvidenceRecord,
} from "./capture/commit-evidence.ts";
export { fingerprint, normalizeFailureText } from "./capture/fingerprint.ts";
export {
  DEFAULT_DENYLIST,
  isDenied,
  matchesGlob,
  resolveDenylist,
} from "./capture/denylist.ts";
export type { DenylistConfig, DenylistMode } from "./capture/denylist.ts";
export {
  normalizeRemoteUrl,
  resolveRepoIdentity,
} from "./git/repo-identity.ts";
export type { RepoIdentity } from "./git/repo-identity.ts";
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
export {
  ACP_AGENT_KIND_FALLBACK,
  ACP_AGENT_KIND_PREFIX,
  ACP_HOST_KEY_PREFIX,
  CURSOR_AGENT_KIND,
  CURSOR_HOST_KEY_PREFIX,
  acpAgentKind,
  acpHostSessionKey,
  agentSlug,
  cursorHostSessionKey,
} from "./state/host-session-key.ts";
export * from "./constants.ts";
