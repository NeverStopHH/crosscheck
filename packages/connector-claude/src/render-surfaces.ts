/**
 * The Claude connector's render-surface registration (§4.4 of
 * DESIGN-agent-agnostic.md). Same contract as connector-core's
 * src/render-surfaces.ts: every module in this package that touches the
 * render layer appears here, and the meta-test
 * (connector-core/test/render-surface-registry.test.ts) fails the build on
 * one that does not.
 */
import type { RenderSurface } from "@crosscheck/connector-core/render-surfaces.ts";

import { resolveWorkContextTitle } from "./hooks/session-start.ts";

// The model-failure line is no longer registered here: runner.ts moved to
// connector-core (src/model/runner.ts) so every connector can spawn a model,
// and its registration moved with it (core's `model-failure-line`). A row
// here would name a module this package no longer contains.
export const RENDER_SURFACES: readonly RenderSurface[] = [
  {
    kind: "corpus",
    name: "claude-work-context-title",
    delivery: "outbound",
    module: "src/hooks/session-start.ts",
    framing: "sanitized",
    // The one untrusted path this package OWNS: Claude's session_title on its
    // way into a work-context record. Everything else session-start shows an
    // agent goes through renderBriefing, a registered core surface.
    render: (payload) =>
      resolveWorkContextTitle(payload, "feat/x", "github.com/acme/api"),
  },
  // The prompt-hint path is the core `selectAndRenderHint` flow since Block 5
  // (registered in core as hint-flow). user-prompt-submit.ts touches the
  // render layer again for ONE thing of its own, the subagent collision relay
  // registered below.
  {
    kind: "composite",
    name: "claude-subagent-collision-relay",
    delivery: "unsolicited",
    module: "src/hooks/user-prompt-submit.ts",
    note: "emits renderSubagentCollisionRelay output verbatim (core's collision-subagent-relay surface) ahead of the prompt's own delivery, joined by a blank line; the groups it renders are the session state's own records of rows the tripwire already projected",
    corpusCoveredBy: ["test/collision-notice-hook.test.ts"],
  },
  // `claude-ghost-draft` is no longer registered here: the ghost worker moved
  // to connector-core (src/derive/ghost/worker.ts) so Cursor and ACP can pay
  // the same debt, and its registration moved with it (core's
  // `derive-ghost-draft`). A row here would name a module this package no
  // longer contains.
  {
    kind: "composite",
    name: "claude-summarizer-probe-line",
    // `crosscheck doctor` stdout: the reader ran the command and is waiting
    // for exactly this answer.
    delivery: "pulled",
    module: "src/summarizer/probe.ts",
    note: "the two model-derived fields doctor prints from a probe — the answer's first line and the version token — are produced ONLY by bareSummarizerLine, the BARE-class door core registers as model-failure-line and attacks with the whole injection corpus there; this module composes nothing else from the model's output",
    corpusCoveredBy: ["../connector-core/test/render-surface-registry.test.ts"],
  },
  {
    kind: "composite",
    name: "claude-tripwire-ask",
    delivery: "unsolicited",
    module: "src/hooks/pre-tool-use.ts",
    note: "emits renderTripwireReason output verbatim as both permissionDecisionReason and additionalContext (the same rendered string, #25), plus appendOutcomeClause where the hub records outcomes; for the teammate groups new to the session, renderCollisionNotices output verbatim as systemMessage and the renderer-owned COLLISION_RELAY_SENTENCE after the model's copy only — or, on an edit with no ask left to state, the same notices and sentence as the model's copy; all registered core surfaces, covered in test/tripwire-hook.test.ts, test/collision-notice-hook.test.ts and test/collision-order-hook.test.ts",
  },
  {
    kind: "composite",
    name: "claude-statusline",
    delivery: "unsolicited",
    module: "src/statusline/statusline.ts",
    note: "teammate names via groupTeammates (sanitize inside toGroup); a terminal line, capped and joined from sanitized fields, led by renderOverlapIndicator output verbatim (core's collision-overlap-indicator surface) in a bound of its own",
  },
  // doctor/status moved to packages/cli in Block 8; their composite
  // registrations (cli-doctor, cli-status) moved with them into that
  // package's own src/render-surfaces.ts.
];
