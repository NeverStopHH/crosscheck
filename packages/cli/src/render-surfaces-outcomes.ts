/**
 * The CLI's two hint-outcome surfaces (1.0 spec 07 §13), spread at the TAIL
 * of `RENDER_SURFACES` in render-surfaces.ts — the same registry, the same
 * meta-test, kept in a file of its own so the registry stays under the
 * 800-line ceiling.
 *
 * Every sentence each module writes is in its document, with the payload in
 * every slot the wire fills: the ref, the outcome words, the hub's sentence;
 * and for `--mine`, the repo, the window, a teammate's name and a reason.
 */
import type { RenderSurface } from "@crosscheck/connector-core/render-surfaces.ts";
import type { MyHintOutcomes } from "@crosscheck/connector-core/http/hint-outcomes.ts";

import {
  AGENT_DRAFT_LINE,
  DELIVERY_HELD_AMBIGUOUS_LINE,
  DELIVERY_HELD_NO_LIVE_SESSION_LINE,
  DELIVERY_STILL_ON_THIS_MACHINE_LINE,
  OUTCOMES_NOT_SERVED_LINE,
  REASON_REQUIRED_LINE,
  REASON_SECRET_LINE,
  agentHostDraftLine,
  outcomeRecordedLine,
  reasonTooLongLine,
} from "./cli/outcome-render.ts";
import { MINE_JSON_REFUSAL, MINE_NOT_SERVED_LINE, renderMyOutcomes } from "./cli/pilot-mine-render.ts";

/** 0.11's surfaces, passed through here so the registry's import line stays one line. */
export { PROVENANCE_SURFACES } from "./render-surfaces-provenance.ts";

const TALLY = { received: 3, followed: 1, overrode: 1, notRelevantNow: 0, noise: 1, unmarked: 0 };

/** The payload in every untrusted slot at once — the corpus adapter rule. */
const mineWith = (payload: string): MyHintOutcomes => ({
  repo: payload,
  days: 56,
  sinceIso: payload,
  untilIso: payload,
  ...TALLY,
  bySource: [
    { source: payload, ...TALLY },
    { source: null, ...TALLY },
  ],
  bySourceBeyondList: 1,
  reasons: [
    { outcome: payload, reason: payload, source: payload },
    { outcome: "overrode", reason: payload, source: null },
  ],
  reasonsBeyondList: 1,
  yourWork: { periodStartIso: payload, periodEndIso: payload, followed: null, withheld: payload },
});

export const HINT_OUTCOME_SURFACES: readonly RenderSurface[] = [
  {
    kind: "corpus",
    name: "cli-hint-outcome",
    delivery: "pulled",
    module: "src/cli/outcome-render.ts",
    // `crosscheck followed` / `crosscheck overrode`. BARE, like the label
    // shortcuts': ids, outcome words and fixed sentences — the reason the
    // person just typed is never echoed.
    framing: "bare",
    render: (payload) =>
      [
        outcomeRecordedLine(payload, { id: payload, deliveryId: payload, outcome: payload, repeated: false, replaced: payload }),
        outcomeRecordedLine(payload, { id: payload, deliveryId: payload, outcome: payload, repeated: true, replaced: null }),
        outcomeRecordedLine(payload, { id: payload, deliveryId: payload, outcome: "followed", repeated: false, replaced: null }),
        outcomeRecordedLine(payload, { id: payload, deliveryId: payload, outcome: payload, repeated: false, replaced: "noise", stands: payload }),
        outcomeRecordedLine(payload, { id: payload, deliveryId: payload, outcome: payload, repeated: true, replaced: null, stands: payload }),
        // Human provenance (0.11 §5): a hub that only drafts the word.
        outcomeRecordedLine(payload, { id: payload, deliveryId: payload, outcome: payload, repeated: false, replaced: null, draft: true }),
        outcomeRecordedLine(payload, { id: payload, deliveryId: payload, outcome: payload, repeated: true, replaced: null, draft: true }),
        AGENT_DRAFT_LINE,
        agentHostDraftLine("CLAUDECODE"),
        DELIVERY_STILL_ON_THIS_MACHINE_LINE,
        DELIVERY_HELD_NO_LIVE_SESSION_LINE,
        DELIVERY_HELD_AMBIGUOUS_LINE,
        OUTCOMES_NOT_SERVED_LINE,
        REASON_REQUIRED_LINE,
        REASON_SECRET_LINE,
        reasonTooLongLine(201),
      ].join(""),
  },
  {
    kind: "corpus",
    name: "cli-pilot-mine",
    delivery: "pulled",
    module: "src/cli/pilot-mine-render.ts",
    // `crosscheck pilot --mine`. FRAMED: a teammate's display name reaches
    // the by-source lines and a reason — the caller's or their agent's —
    // reaches the why-lines, quoted. The empty view and both refusals are in
    // the document too.
    framing: "framed",
    render: (payload) =>
      [
        renderMyOutcomes(mineWith(payload)),
        renderMyOutcomes({ ...mineWith(payload), received: 0, bySource: [], reasons: [], reasonsBeyondList: 0 }),
        MINE_NOT_SERVED_LINE,
        MINE_JSON_REFUSAL,
      ].join("\n"),
  },
];
