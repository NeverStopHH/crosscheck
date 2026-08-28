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
    module: "src/hooks/session-start.ts",
    framing: "sanitized",
    // The one untrusted path this package OWNS: Claude's session_title on its
    // way into a work-context record. Everything else session-start shows an
    // agent goes through renderBriefing, a registered core surface.
    render: (payload) =>
      resolveWorkContextTitle(payload, "feat/x", "github.com/acme/api"),
  },
  // The prompt-hint path is the core `selectAndRenderHint` flow since Block 5
  // (registered in core as hint-flow); user-prompt-submit.ts no longer touches
  // the render layer itself, so a row here would be a decorative registration
  // the registry test rejects.
  // `claude-ghost-draft` is no longer registered here: the ghost worker moved
  // to connector-core (src/derive/ghost/worker.ts) so Cursor and ACP can pay
  // the same debt, and its registration moved with it (core's
  // `derive-ghost-draft`). A row here would name a module this package no
  // longer contains.
  {
    kind: "composite",
    name: "claude-tripwire-ask",
    module: "src/hooks/pre-tool-use.ts",
    note: "emits renderTripwireReason output verbatim (registered core surface); covered in test/tripwire-hook.test.ts",
  },
  {
    kind: "composite",
    name: "claude-statusline",
    module: "src/statusline/statusline.ts",
    note: "teammate names via groupTeammates (sanitize inside toGroup); a terminal line, capped and joined from sanitized fields",
  },
  // doctor/status moved to packages/cli in Block 8; their composite
  // registrations (cli-doctor, cli-status) moved with them into that
  // package's own src/render-surfaces.ts.
];
