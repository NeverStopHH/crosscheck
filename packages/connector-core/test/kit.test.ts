/**
 * The connector kit facade (DESIGN-agent-agnostic.md §1.3): the ONE narrow,
 * documented surface a new connector programs against. Two properties are
 * pinned here:
 *
 *   1. COMPLETENESS — every capability the README documents is exported:
 *      identity, config, repo identity, state, spool, hub client, capture,
 *      render discipline, hints, MCP. A connector should never need a deep
 *      import into core internals.
 *   2. FACADE, NOT FORK — each kit export is REFERENCE-IDENTICAL to its home
 *      module's export. The kit re-exports; it never wraps or copies, so
 *      there is exactly one implementation of everything (the same rule the
 *      render classes live by).
 */
import { describe, expect, test } from "bun:test";

import * as kit from "../src/kit.ts";
import * as sessionState from "../src/state/session-state.ts";
import * as hostKey from "../src/state/host-session-key.ts";
import * as config from "../src/config/config.ts";
import * as paths from "../src/config/paths.ts";
import * as constants from "../src/constants.ts";
import * as repoIdentity from "../src/git/repo-identity.ts";
import * as commitDrift from "../src/git/commit-drift.ts";
import * as append from "../src/spool/append.ts";
import * as flush from "../src/spool/flush.ts";
import * as reap from "../src/spool/reap.ts";
import * as hub from "../src/http/hub.ts";
import * as records from "../src/capture/records.ts";
import * as fingerprint from "../src/capture/fingerprint.ts";
import * as failureText from "../src/capture/failure-text.ts";
import * as registerFlow from "../src/flows/register-session.ts";
import * as captureFlows from "../src/flows/capture-targets.ts";
import * as heartbeatFlow from "../src/flows/heartbeat.ts";
import * as endFlow from "../src/flows/end-session.ts";
import * as secretScan from "../src/capture/secret-scan.ts";
import * as denylist from "../src/capture/denylist.ts";
import * as commitEvidence from "../src/capture/commit-evidence.ts";
import * as targetPaths from "../src/capture/target-paths.ts";
import * as briefingRender from "../src/briefing/render.ts";
import * as sanitize from "../src/briefing/sanitize.ts";
import * as hintsRender from "../src/hints/render.ts";
import * as hintsSelect from "../src/hints/select.ts";
import * as hintsEcho from "../src/hints/echo.ts";
import * as mcpRender from "../src/mcp/render.ts";
import * as mcpServer from "../src/mcp/server.ts";
import * as mcpSession from "../src/mcp/session.ts";
import * as mcpConfig from "../src/config/mcp-config.ts";

/**
 * [kit export name, the home module's own binding] — one row per capability.
 * EVERY runtime export has a row: the set-equality test below fails the build
 * on an export without a row or a row without an export.
 */
const FACADE_ROWS: readonly (readonly [string, unknown])[] = [
  // Identity: keys, deterministic ids, filename derivation
  ["crosscheckSessionIdFor", sessionState.crosscheckSessionIdFor],
  ["workContextIdFor", sessionState.workContextIdFor],
  ["sessionSlug", paths.sessionSlug],
  ["acpHostSessionKey", hostKey.acpHostSessionKey],
  ["cursorHostSessionKey", hostKey.cursorHostSessionKey],
  ["acpAgentKind", hostKey.acpAgentKind],
  ["agentSlug", hostKey.agentSlug],
  ["safeAcpSessionId", hostKey.safeAcpSessionId],
  ["MAX_ACP_SESSION_ID_CHARS", hostKey.MAX_ACP_SESSION_ID_CHARS],
  ["MAX_AGENT_SLUG_CHARS", hostKey.MAX_AGENT_SLUG_CHARS],
  ["ACP_AGENT_KIND_FALLBACK", hostKey.ACP_AGENT_KIND_FALLBACK],
  ["ACP_AGENT_KIND_PREFIX", hostKey.ACP_AGENT_KIND_PREFIX],
  ["ACP_HOST_KEY_PREFIX", hostKey.ACP_HOST_KEY_PREFIX],
  ["ACP_KEY_DELIMITER", hostKey.ACP_KEY_DELIMITER],
  ["CURSOR_AGENT_KIND", hostKey.CURSOR_AGENT_KIND],
  ["CURSOR_HOST_KEY_PREFIX", hostKey.CURSOR_HOST_KEY_PREFIX],
  // Config
  ["loadConfig", config.loadConfig],
  ["isDisabled", config.isDisabled],
  ["rememberDeveloper", config.rememberDeveloper],
  ["readStoredConfig", config.readStoredConfig],
  ["saveConfig", config.saveConfig],
  ["normalizeHubUrl", config.normalizeHubUrl],
  ["resolveTimeoutMs", config.resolveTimeoutMs],
  ["crosscheckHome", paths.crosscheckHome],
  ["repoKey", paths.repoKey],
  ["mergeMcpConfig", mcpConfig.mergeMcpConfig],
  ["isOwnedMcpEntry", mcpConfig.isOwnedMcpEntry],
  ["DEFAULT_AGENT_KIND", constants.DEFAULT_AGENT_KIND],
  ["HEARTBEAT_MIN_INTERVAL_MS", constants.HEARTBEAT_MIN_INTERVAL_MS],
  // Repo identity
  ["resolveRepoIdentity", repoIdentity.resolveRepoIdentity],
  ["normalizeRemoteUrl", repoIdentity.normalizeRemoteUrl],
  ["resolveCommitDrift", commitDrift.resolveCommitDrift],
  ["resolveDriftByBaseCommit", commitDrift.resolveDriftByBaseCommit],
  // State
  ["readSessionState", sessionState.readSessionState],
  ["writeSessionState", sessionState.writeSessionState],
  ["updateSessionState", sessionState.updateSessionState],
  ["deleteSessionState", sessionState.deleteSessionState],
  ["deriveSessionState", sessionState.deriveSessionState],
  ["withSeenTargets", sessionState.withSeenTargets],
  ["withDeliveredHint", sessionState.withDeliveredHint],
  ["withBriefingSolvedRefs", sessionState.withBriefingSolvedRefs],
  ["withTripwireAsked", sessionState.withTripwireAsked],
  ["SessionStateSchema", sessionState.SessionStateSchema],
  // Spool
  ["appendRecords", append.appendRecords],
  ["flushSpool", flush.flushSpool],
  ["reapSpool", reap.reapSpool],
  // Hub client
  ["registerSession", hub.registerSession],
  ["heartbeatSession", hub.heartbeatSession],
  ["endSession", hub.endSession],
  ["getPresence", hub.getPresence],
  ["getWorkContexts", hub.getWorkContexts],
  ["getHintCandidates", hub.getHintCandidates],
  ["getAbsences", hub.getAbsences],
  ["getContradictions", hub.getContradictions],
  ["getDrafts", hub.getDrafts],
  ["getSolvedMatches", hub.getSolvedMatches],
  ["getTripwireSessions", hub.getTripwireSessions],
  // The session flows (§1.3, extracted in Block 4)
  ["registerSessionFlow", registerFlow.registerSessionFlow],
  ["fallbackWorkContextTitle", registerFlow.fallbackWorkContextTitle],
  ["captureFileTargets", captureFlows.captureFileTargets],
  ["captureFailure", captureFlows.captureFailure],
  ["heartbeatMaybe", heartbeatFlow.heartbeatMaybe],
  ["endSessionFlow", endFlow.endSessionFlow],
  // Capture
  ["buildEnvelope", records.buildEnvelope],
  ["workContextRecord", records.workContextRecord],
  ["targetRecord", records.targetRecord],
  ["hintDeliveryRecord", records.hintDeliveryRecord],
  ["withProducer", records.withProducer],
  ["UNKNOWN_DEVELOPER_ID", records.UNKNOWN_DEVELOPER_ID],
  ["fingerprint", fingerprint.fingerprint],
  ["normalizeFailureText", fingerprint.normalizeFailureText],
  ["extractFailureText", failureText.extractFailureText],
  ["containsSecret", secretScan.containsSecret],
  ["resolveDenylist", denylist.resolveDenylist],
  ["isDenied", denylist.isDenied],
  ["DEFAULT_DENYLIST", denylist.DEFAULT_DENYLIST],
  ["collectCommitEvidence", commitEvidence.collectCommitEvidence],
  ["commitEvidenceRecord", commitEvidence.commitEvidenceRecord],
  ["toRepoRelative", targetPaths.toRepoRelative],
  // Render discipline — the three classes and the finished renderers
  ["sanitizeUntrusted", sanitize.sanitizeUntrusted],
  ["bareUntrusted", sanitize.bareUntrusted],
  ["safeId", sanitize.safeId],
  ["quoted", mcpRender.quoted],
  ["QUOTED_DATA_NOTICE", briefingRender.QUOTED_DATA_NOTICE],
  ["renderBriefing", briefingRender.renderBriefing],
  ["groupTeammates", briefingRender.groupTeammates],
  ["renderClaimHint", hintsRender.renderClaimHint],
  ["renderPointerHint", hintsRender.renderPointerHint],
  ["renderTripwireReason", hintsRender.renderTripwireReason],
  // Hints
  ["selectHint", hintsSelect.selectHint],
  ["hintBodyHash", hintsEcho.hintBodyHash],
  ["isEchoOfDeliveredHint", hintsEcho.isEchoOfDeliveredHint],
  // MCP
  ["runMcpServer", mcpServer.runMcpServer],
  ["resolveOwnWorkContext", mcpSession.resolveOwnWorkContext],
];

describe("the connector kit facade", () => {
  test.each(FACADE_ROWS)("kit.%s is the home module's own binding", (name, home) => {
    // Assert: present, and reference-identical — a facade, never a fork.
    const exported = (kit as Record<string, unknown>)[name as string];
    expect(exported, name as string).toBeDefined();
    expect(exported, name as string).toBe(home);
  });

  test("every runtime kit export is pinned — reference identity has no gaps", () => {
    // The review found 30 of 80 runtime exports unpinned: an export outside
    // FACADE_ROWS could silently become a wrapper or a copy. Set equality
    // makes the table the export list's mirror — adding one without the
    // other is a red build in both directions.
    const pinned = FACADE_ROWS.map(([name]) => name as string);
    const exported = Object.keys(kit);
    expect(exported.filter((name) => !pinned.includes(name)).sort()).toEqual([]);
    expect(pinned.filter((name) => !exported.includes(name)).sort()).toEqual([]);
    expect(new Set(pinned).size).toBe(pinned.length);
  });

  test("the kit never exports the legacy identity spelling", () => {
    // claudeSessionId survives only as the tolerant READ inside the schema —
    // a new connector must never see it in the API it programs against.
    expect(Object.keys(kit).some((name) => name.includes("claudeSession"))).toBe(false);
  });
});
