/**
 * The CLI's human-provenance surfaces (0.11 §5–§9), spread at the TAIL of
 * `RENDER_SURFACES` in render-surfaces.ts — the same registry, the same
 * meta-test, in a file of its own so the registry stays under the 800-line
 * ceiling.
 *
 *   - `crosscheck confirm` (cli/confirm.ts): counts by kind, the hub's RP IDs
 *     and fixed sentences — the payload in each slot the wire fills (a kind
 *     this client does not know, an RP ID);
 *   - the drafted label lines (cli/pilot-mark.ts) and the walk's drafted
 *     lines (cli/pilot-label-render.ts): ids and fixed words only, never a
 *     title — BARE, though the walk's other lines are framed, because these
 *     carry no text anybody else wrote.
 */
import type { RenderSurface } from "@crosscheck/connector-core/render-surfaces.ts";
import type { ConfirmStatus } from "@crosscheck/connector-core/http/confirm.ts";

import {
  CONFIRM_NOT_SERVED_LINE,
  HUB_MACHINE_ONLY_LINE,
  NO_HTTPS_LINE,
  confirmabilityLine,
  passkeyLine,
  pendingLine,
} from "./cli/confirm.ts";
import { labelRecordedLine, walkSummaryLines } from "./cli/pilot-label-render.ts";
import { markAnswerLine, markDraftedLine } from "./cli/pilot-mark.ts";

/** The hub url comes from the person's own config, never the wire: a fixed one. */
const HUB = "https://hub.example.ts.net";

const status = (overrides: Partial<ConfirmStatus>): ConfirmStatus => ({
  pending: 0,
  pendingByKind: {},
  humanConfirmation: "https",
  passkeys: { total: 1, atConfiguredRp: 1 },
  rpIds: [],
  ...overrides,
});

const WALK_TALLY = {
  total: 3,
  helpful: 1,
  noise: 1,
  unclear: 1,
  skipped: 0,
  already: 0,
  refused: 0,
  notReached: 0,
  drafted: 2,
};

export const PROVENANCE_SURFACES: readonly RenderSurface[] = [
  {
    kind: "corpus",
    name: "cli-confirm",
    delivery: "pulled",
    module: "src/cli/confirm.ts",
    // `crosscheck confirm` and doctor's confirmation lines. BARE: counts,
    // fixed words, and the hub's own hostnames through the untrusted class.
    framing: "bare",
    render: (payload) =>
      [
        pendingLine(status({ pending: 3, pendingByKind: { label: 1, [payload]: 2 } })),
        pendingLine(status({})),
        passkeyLine(status({ passkeys: { total: 0, atConfiguredRp: 0 } }), HUB),
        passkeyLine(status({ passkeys: { total: 2, atConfiguredRp: 0 }, rpIds: [payload, "hub.example.ts.net"] }), HUB),
        confirmabilityLine(status({ humanConfirmation: "none" })),
        confirmabilityLine(status({ humanConfirmation: "hub_machine_only" })),
        NO_HTTPS_LINE,
        HUB_MACHINE_ONLY_LINE,
        CONFIRM_NOT_SERVED_LINE,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
  },
  {
    kind: "corpus",
    name: "cli-drafted-marks",
    delivery: "pulled",
    module: "src/cli/pilot-mark.ts",
    // `crosscheck noise` / `helpful` / `pin --ok` on a hub that only drafts.
    framing: "bare",
    render: (payload) =>
      [
        markDraftedLine("hint_delivery", payload, false),
        markDraftedLine("hint_delivery", payload, false, "helpful"),
        markDraftedLine("hint_delivery", payload, true),
        markDraftedLine("pin", payload, false),
        markAnswerLine("pin", payload, { repeated: true, draft: true }),
      ].join(""),
  },
  {
    kind: "corpus",
    name: "cli-drafted-walk",
    delivery: "pulled",
    module: "src/cli/pilot-label-render.ts",
    // The walk's lines for a label the hub only drafted, and its summary.
    framing: "bare",
    render: () =>
      [
        labelRecordedLine("helpful", true, false, true),
        labelRecordedLine("noise", false, true, true),
        walkSummaryLines(WALK_TALLY, true),
      ].join("\n"),
  },
];
