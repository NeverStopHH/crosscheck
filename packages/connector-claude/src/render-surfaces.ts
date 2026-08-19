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
  {
    kind: "composite",
    name: "claude-cli-doctor",
    module: "src/cli/doctor.ts",
    note: "formatAge only — renderer-built ages, no untrusted interpolation",
  },
  {
    kind: "composite",
    name: "claude-cli-status",
    module: "src/cli/status.ts",
    note: "formatAbsenceLine + formatAge from the core render layer; absence names sanitized inside the renderer",
  },
];
