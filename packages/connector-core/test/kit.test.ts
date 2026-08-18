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
import * as repoIdentity from "../src/git/repo-identity.ts";
import * as append from "../src/spool/append.ts";
import * as flush from "../src/spool/flush.ts";
import * as reap from "../src/spool/reap.ts";
import * as hub from "../src/http/hub.ts";
import * as records from "../src/capture/records.ts";
import * as fingerprint from "../src/capture/fingerprint.ts";
import * as secretScan from "../src/capture/secret-scan.ts";
import * as denylist from "../src/capture/denylist.ts";
import * as briefingRender from "../src/briefing/render.ts";
import * as sanitize from "../src/briefing/sanitize.ts";
import * as hintsRender from "../src/hints/render.ts";
import * as hintsSelect from "../src/hints/select.ts";
import * as mcpRender from "../src/mcp/render.ts";
import * as mcpServer from "../src/mcp/server.ts";
import * as mcpSession from "../src/mcp/session.ts";
import * as mcpConfig from "../src/config/mcp-config.ts";

/** [kit export name, the home module's own binding] — one row per capability. */
const FACADE_ROWS: readonly (readonly [string, unknown])[] = [
  // Identity: keys, deterministic ids, filename derivation
  ["crosscheckSessionIdFor", sessionState.crosscheckSessionIdFor],
  ["workContextIdFor", sessionState.workContextIdFor],
  ["sessionSlug", paths.sessionSlug],
  ["acpHostSessionKey", hostKey.acpHostSessionKey],
  ["cursorHostSessionKey", hostKey.cursorHostSessionKey],
  ["acpAgentKind", hostKey.acpAgentKind],
  ["agentSlug", hostKey.agentSlug],
  // Config
  ["loadConfig", config.loadConfig],
  ["isDisabled", config.isDisabled],
  ["rememberDeveloper", config.rememberDeveloper],
  ["crosscheckHome", paths.crosscheckHome],
  ["repoKey", paths.repoKey],
  ["mergeMcpConfig", mcpConfig.mergeMcpConfig],
  // Repo identity
  ["resolveRepoIdentity", repoIdentity.resolveRepoIdentity],
  // State
  ["readSessionState", sessionState.readSessionState],
  ["writeSessionState", sessionState.writeSessionState],
  ["updateSessionState", sessionState.updateSessionState],
  ["deleteSessionState", sessionState.deleteSessionState],
  ["deriveSessionState", sessionState.deriveSessionState],
  ["withSeenTargets", sessionState.withSeenTargets],
  ["withDeliveredHint", sessionState.withDeliveredHint],
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
  // Capture
  ["buildEnvelope", records.buildEnvelope],
  ["workContextRecord", records.workContextRecord],
  ["targetRecord", records.targetRecord],
  ["hintDeliveryRecord", records.hintDeliveryRecord],
  ["fingerprint", fingerprint.fingerprint],
  ["containsSecret", secretScan.containsSecret],
  ["resolveDenylist", denylist.resolveDenylist],
  ["isDenied", denylist.isDenied],
  // Render discipline — the three classes and the finished renderers
  ["sanitizeUntrusted", sanitize.sanitizeUntrusted],
  ["bareUntrusted", sanitize.bareUntrusted],
  ["safeId", sanitize.safeId],
  ["quoted", mcpRender.quoted],
  ["QUOTED_DATA_NOTICE", briefingRender.QUOTED_DATA_NOTICE],
  ["renderBriefing", briefingRender.renderBriefing],
  ["renderClaimHint", hintsRender.renderClaimHint],
  ["renderPointerHint", hintsRender.renderPointerHint],
  ["renderTripwireReason", hintsRender.renderTripwireReason],
  // Hints
  ["selectHint", hintsSelect.selectHint],
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

  test("the kit never exports the legacy identity spelling", () => {
    // claudeSessionId survives only as the tolerant READ inside the schema —
    // a new connector must never see it in the API it programs against.
    expect(Object.keys(kit).some((name) => name.includes("claudeSession"))).toBe(false);
  });
});
