/**
 * The connector kit (DESIGN-agent-agnostic.md §1.3) — the narrow, documented
 * surface a NEW connector programs against. README.md in this package is the
 * prose half of this contract: what a connector must provide, what core gives
 * back, and the five session flows composed from these exports.
 *
 * A FACADE, DELIBERATELY: re-exports and types only, no wrapping and no new
 * behavior. Every binding here is reference-identical to its home module's
 * (test/kit.test.ts pins that), so there is exactly one implementation of
 * everything — the same one-copy rule the render classes live by.
 *
 * The design's flow-level helpers are ALL extracted now: Block 4 peeled
 * `registerSessionFlow`, `captureFileTargets`, `captureFailure`,
 * `heartbeatMaybe` and `endSessionFlow` out of the Claude hooks into
 * `src/flows/`, and Block 5 (the first non-Claude injection block) did the
 * same for `assembleBriefing` and `selectAndRenderHint` — extraction, not
 * invention; both §5 scheduling-note entry steps discharged. The hooks and
 * the ACP proxy call the same functions.
 */

// ── Identity ────────────────────────────────────────────────────────────────
export {
  crosscheckSessionIdFor,
  deleteSessionState,
  deriveSessionState,
  readSessionState,
  updateSessionState,
  withBriefingSolvedRefs,
  withDeliveredHint,
  withSeenTargets,
  withTripwireAsked,
  workContextIdFor,
  writeSessionState,
  SessionStateSchema,
} from "./state/session-state.ts";
export type {
  DeriveSessionStateInput,
  SessionState,
  SessionStateInput,
} from "./state/session-state.ts";
export {
  ACP_AGENT_KIND_FALLBACK,
  ACP_AGENT_KIND_PREFIX,
  ACP_HOST_KEY_PREFIX,
  ACP_KEY_DELIMITER,
  CURSOR_AGENT_KIND,
  CURSOR_BACKGROUND_AGENT_KIND,
  CURSOR_HOST_KEY_PREFIX,
  MAX_ACP_SESSION_ID_CHARS,
  MAX_AGENT_SLUG_CHARS,
  acpAgentKind,
  acpHostSessionKey,
  agentSlug,
  cursorHostSessionKey,
  safeAcpSessionId,
  safeHostSessionId,
} from "./state/host-session-key.ts";

// ── Config + paths ──────────────────────────────────────────────────────────
export {
  isDisabled,
  isSummarizerChild,
  loadConfig,
  normalizeHubUrl,
  readStoredConfig,
  rememberDeveloper,
  resolveTimeoutMs,
  saveConfig,
} from "./config/config.ts";
export type {
  Config,
  LoadConfigOptions,
  ResolvedConfig,
} from "./config/config.ts";
export { crosscheckHome, repoKey, sessionSlug } from "./config/paths.ts";
export type { Env } from "./config/paths.ts";
export { isOwnedMcpEntry, mergeMcpConfig } from "./config/mcp-config.ts";
export type { McpServerEntry } from "./config/mcp-config.ts";
export {
  isEphemeralInstallPath,
  isOwnCrosscheckBin,
  realpathOrSelf,
  resolveCommandPrefix,
  resolveLauncher,
  resolveMcpLauncher,
} from "./config/launcher.ts";
export type { Launcher, UsableLauncher } from "./config/launcher.ts";
export {
  DEFAULT_AGENT_KIND,
  HEARTBEAT_MIN_INTERVAL_MS,
} from "./constants.ts";
export {
  hookBudget,
  resolveHookBudget,
  withBudget,
} from "./config/hook-budget.ts";
export type { HookBudget, ResolvedHookBudget } from "./config/hook-budget.ts";

// ── Repo identity ───────────────────────────────────────────────────────────
export { normalizeRemoteUrl, resolveRepoIdentity } from "./git/repo-identity.ts";
export type { RepoIdentity } from "./git/repo-identity.ts";
export {
  resolveCommitDrift,
  resolveDriftByBaseCommit,
} from "./git/commit-drift.ts";
export type { CommitDrift } from "./git/commit-drift.ts";

// ── Spool ───────────────────────────────────────────────────────────────────
export { appendRecords } from "./spool/append.ts";
export type { AppendResult } from "./spool/append.ts";
export { flushSpool } from "./spool/flush.ts";
export type { FlushInput, FlushOutcome } from "./spool/flush.ts";
export { reapSpool } from "./spool/reap.ts";
export type { DeferredEnder, ReapResult } from "./spool/reap.ts";

// ── Hub client ──────────────────────────────────────────────────────────────
export {
  endSession,
  getAbsences,
  getContradictions,
  getDrafts,
  getHintCandidates,
  getPresence,
  getSolvedMatches,
  getTripwireSessions,
  getWorkContexts,
  heartbeatSession,
  registerSession,
} from "./http/hub.ts";
export type {
  HintClaimCandidate,
  HintContextCandidate,
  HubContext,
  HubResult,
  PresenceEntry,
  RegisterSessionInput,
  SolvedMatchEntry,
  TripwireSession,
  WorkContextEntry,
} from "./http/hub.ts";

// ── The session flows (§1.3, extracted in Block 4) ──────────────────────────
export {
  fallbackWorkContextTitle,
  registerSessionFlow,
} from "./flows/register-session.ts";
export type {
  RegisterSessionFlowInput,
  RegisterSessionFlowResult,
} from "./flows/register-session.ts";
export {
  captureFailure,
  captureFileTargets,
} from "./flows/capture-targets.ts";
export type {
  CaptureFailureInput,
  CaptureFileTargetsInput,
} from "./flows/capture-targets.ts";
/**
 * THE CAPTURE ENTRY POINT FOR A NEW CONNECTOR is `captureTouchedFiles`, not
 * the `captureFileTargets` above it. The raw call's `resolveRoot` hook is
 * OPTIONAL, and an ABSENT one means "resolve every touch against the session
 * checkout" — the pre-#17 behaviour that lost every edit made in a linked
 * worktree with nothing to show for it (finding H1: 371 worktree edits → 0
 * targets). `captureTouchedFiles` is the resolver pre-pass and the capture as
 * ONE pair, and it is the only place in the repo that builds the raw call;
 * all three shipped connectors go through it. `withCaptureBookkeeping` is the
 * matching counter fold — the caller still owns `updateSessionState`, because
 * the three hosts genuinely batch their state writes differently.
 */
export { captureTouchedFiles } from "./flows/capture-touched-files.ts";
export type { CaptureTouchedFilesInput } from "./flows/capture-touched-files.ts";
export { withCaptureBookkeeping } from "./state/capture-bookkeeping.ts";
export type { CaptureBookkeepingInput } from "./state/capture-bookkeeping.ts";
export { resolveTouchedRoots } from "./capture/touched-root.ts";
export type {
  KnownWorktreeRoot,
  ResolveTouchedRootsInput,
  TouchedRootsResolution,
} from "./capture/touched-root.ts";
export { heartbeatMaybe } from "./flows/heartbeat.ts";
export type { HeartbeatMaybeInput } from "./flows/heartbeat.ts";
export { endSessionFlow } from "./flows/end-session.ts";
export type {
  EndSessionFlowInput,
  EndSessionFlowResult,
} from "./flows/end-session.ts";
export {
  assembleBriefing,
  recordBriefingDeliveries,
} from "./flows/briefing.ts";
export type {
  AssembleBriefingInput,
  AssembledBriefing,
  RecordBriefingDeliveriesInput,
} from "./flows/briefing.ts";
export { selectAndRenderHint } from "./flows/hint.ts";
export type { SelectAndRenderHintInput } from "./flows/hint.ts";

// ── Capture ─────────────────────────────────────────────────────────────────
export {
  UNKNOWN_DEVELOPER_ID,
  buildEnvelope,
  hintDeliveryRecord,
  targetRecord,
  withProducer,
  workContextRecord,
} from "./capture/records.ts";
export type { Producer, TargetKind } from "./capture/records.ts";
export { fingerprint, normalizeFailureText } from "./capture/fingerprint.ts";
export { extractFailureText } from "./capture/failure-text.ts";
export { containsSecret } from "./capture/secret-scan.ts";
export {
  DEFAULT_DENYLIST,
  isDenied,
  resolveDenylist,
} from "./capture/denylist.ts";
export type { DenylistConfig } from "./capture/denylist.ts";
export {
  collectCommitEvidence,
  commitEvidenceRecord,
} from "./capture/commit-evidence.ts";
export { toRepoRelative } from "./capture/target-paths.ts";

// ── Render discipline: the three classes, then the finished renderers ───────
export {
  bareUntrusted,
  safeId,
  sanitizeUntrusted,
} from "./briefing/sanitize.ts";
export { quoted } from "./mcp/render.ts";
export {
  QUOTED_DATA_NOTICE,
  groupTeammates,
  renderBriefing,
} from "./briefing/render.ts";
export type { BriefingInput } from "./briefing/render.ts";
export {
  renderClaimHint,
  renderPointerHint,
  renderTripwireReason,
} from "./hints/render.ts";

// ── Hints ───────────────────────────────────────────────────────────────────
export { selectHint } from "./hints/select.ts";
export type { HintSelection, SelectHintInput } from "./hints/select.ts";
export { hintBodyHash, isEchoOfDeliveredHint } from "./hints/echo.ts";

// ── MCP ─────────────────────────────────────────────────────────────────────
export { runMcpServer } from "./mcp/server.ts";
export { resolveOwnWorkContext } from "./mcp/session.ts";
export type { OwnWorkContext } from "./mcp/session.ts";
