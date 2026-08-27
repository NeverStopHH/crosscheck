/**
 * The CLI package's render-surface registration (§4.4 of
 * DESIGN-agent-agnostic.md). Same contract as connector-core's
 * src/render-surfaces.ts: every module in this package that touches the
 * render layer appears here, and the meta-test
 * (connector-core/test/render-surface-registry.test.ts) fails the build on
 * one that does not. Both entries MOVED with their modules from
 * connector-claude's registry when Block 8 extracted `packages/cli`.
 */
import type { RenderSurface } from "@crosscheck/connector-core/render-surfaces.ts";

export const RENDER_SURFACES: readonly RenderSurface[] = [
  {
    kind: "composite",
    name: "cli-doctor",
    module: "src/cli/doctor.ts",
    note: "formatAge only — renderer-built ages, no untrusted interpolation",
  },
  {
    kind: "composite",
    name: "cli-conference",
    module: "src/cli/conference.ts",
    note: "the command's own stdout, not the page: the tree owner's display name through bareUntrusted before it is printed or composed into a draft body, and formatAge on a renderer-built age. The report itself is rendered by connector-core's registered conference-report surface, and the model's sentence reaches both already bounded, echo-checked and secret-scanned",
  },
  {
    kind: "composite",
    name: "cli-status",
    module: "src/cli/status.ts",
    note: "formatAbsenceLine + formatAge from the core render layer; absence names sanitized inside the renderer; teammate name/branch/status through bareUntrusted and the session intent through renderIntent (the one framed fragment)",
  },
];
