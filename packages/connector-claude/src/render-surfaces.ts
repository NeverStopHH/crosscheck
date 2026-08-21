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
import { formatSummarizerFailure } from "./summarizer/runner.ts";

export const RENDER_SURFACES: readonly RenderSurface[] = [
  {
    kind: "corpus",
    name: "claude-summarizer-failure-line",
    module: "src/summarizer/runner.ts",
    framing: "bare",
    // What the nested claude SAID when a run was lost (trial finding #14) —
    // CLI/model stdout, untrusted — on its way into session state
    // (summarizerLastFailure) and from there onto the status and doctor
    // lines: its first line through bareUntrusted, the whole line bounded
    // to SUMMARIZER_FAILURE_MAX_CHARS. The probe's first-line and version
    // fields come through the same function (bareSummarizerLine).
    render: (payload) =>
      formatSummarizerFailure({
        ok: false,
        reason: "exit",
        exitCode: 1,
        detail: payload,
        elapsedMs: 0,
      }),
  },
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
  // doctor/status moved to packages/cli in Block 8; their composite
  // registrations (cli-doctor, cli-status) moved with them into that
  // package's own src/render-surfaces.ts.
];
