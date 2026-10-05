/**
 * The draft review nudge's ONE spelling (flows/draft-nudge.ts decides when it
 * is owed; this decides what it says).
 *
 * WHAT IT MUST SAY, and each clause is a requirement rather than a style:
 *   - how many drafts are due and of which kinds — counted from the hub's
 *     own answer, "at least" when that answer was cut at DRAFT_LISTING_CAP;
 *   - that the PERSON decides: confirm and edit publish a claim to the
 *     team, so the agent asks and calls review_draft only with the answer —
 *     review_draft's own contract is unchanged, this sentence is what keeps
 *     a machine guess from being published on the machine's say-so;
 *   - how many are past DRAFT_RETENTION_HORIZON_DAYS, and that they are KEPT
 *     (binding principle 6) — an old draft is never discarded for being old.
 *
 * The pointer lines are the briefing's own `formatDraftLine`, so a draft reads
 * the same in both places and its id survives: the briefing shows only
 * MAX_DRAFT_POINTERS of them, and a nudge that named no id would ask for a
 * review the agent has no handle to perform. Lines are dropped whole from the
 * tail to fit MAX_HINT_TEXT_LENGTH and counted in "+N more not shown".
 *
 * Kinds are the wire spelling of the claim kinds, which is also what
 * publish_claim and review_draft speak; a kind this client does not know is
 * counted as "other" and never printed — it is hub text, and the header
 * carries no quote frame.
 */
import { CLAIM_KINDS, MAX_HINT_TEXT_LENGTH } from "@crosscheck/schema";

import {
  DRAFT_NUDGE_MIN_AGE_HOURS,
  DRAFT_RETENTION_HORIZON_DAYS,
  MAX_DRAFT_NUDGE_POINTERS,
  MS_PER_DAY,
} from "../constants.ts";
import type { DraftEntry } from "../http/hub.ts";
import { formatDraftLine, QUOTED_DATA_NOTICE } from "./render.ts";

export interface DraftNudgeInput {
  /** The drafts already judged due, in the hub's order. */
  readonly due: readonly DraftEntry[];
  /** True when the hub's answer filled DRAFT_LISTING_CAP — the count is a floor. */
  readonly listedAtCap: boolean;
  readonly now: Date;
}

const OTHER_KIND = "other";

const ASK =
  "When the current request is done, ask the person — do not decide yourself — " +
  "whether to confirm, edit or discard each one, and call review_draft only with " +
  "their answer: confirm and edit publish the claim to the team, discard retires " +
  "it for good. Nothing is published or deleted until then.";

const kindSummary = (due: readonly DraftEntry[]): string => {
  const known = CLAIM_KINDS.map((kind) => ({
    kind,
    count: due.filter((entry) => entry.kind === kind).length,
  })).filter((entry) => entry.count > 0);
  const knownTotal = known.reduce((sum, entry) => sum + entry.count, 0);
  const other = due.length - knownTotal;
  // A copy is sorted, never `known` itself; the sort is stable, so equal
  // counts keep CLAIM_KINDS order.
  const ranked = [...known].sort((a, b) => b.count - a.count);
  return [
    ...ranked.map((entry) => `${String(entry.count)} ${entry.kind}`),
    ...(other > 0 ? [`${String(other)} ${OTHER_KIND}`] : []),
  ].join(", ");
};

/** How many are past DRAFT_RETENTION_HORIZON_DAYS — doctor's drafts line counts the same. */
export const countPastRetentionHorizon = (due: readonly DraftEntry[], now: Date): number =>
  due.filter((entry) => {
    const created = Date.parse(entry.createdAt);
    return !Number.isNaN(created) && now.getTime() - created > DRAFT_RETENTION_HORIZON_DAYS * MS_PER_DAY;
  }).length;

const retentionSentence = (old: number): string =>
  old === 0
    ? ""
    : ` ${String(old)} of them ${old === 1 ? "is" : "are"} older than ${String(DRAFT_RETENTION_HORIZON_DAYS)} days; ` +
      "crosscheck never deletes or auto-discards a draft, so they stay listed until settled.";

const headerLine = (input: DraftNudgeInput): string => {
  const count = input.due.length;
  const amount = `${input.listedAtCap ? "at least " : ""}${String(count)}`;
  const verb = count === 1 && !input.listedAtCap ? "has" : "have";
  return (
    `crosscheck: ${amount} of your own auto-captured draft claims ${verb} waited over ` +
    `${String(DRAFT_NUDGE_MIN_AGE_HOURS)}h for review (${kindSummary(input.due)}). ` +
    "No teammate is shown a draft until it is confirmed." +
    retentionSentence(countPastRetentionHorizon(input.due, input.now))
  );
};

const compose = (
  fixed: readonly string[],
  pointers: readonly string[],
  shown: number,
  total: number,
): string =>
  [
    ...fixed,
    ...pointers.slice(0, shown),
    ...(total > shown ? [`(+${String(total - shown)} more not shown)`] : []),
  ].join("\n");

/** "" when nothing is due; otherwise the whole nudge, within MAX_HINT_TEXT_LENGTH. */
export const renderDraftNudge = (input: DraftNudgeInput): string => {
  if (input.due.length === 0) {
    return "";
  }
  const fixed = [headerLine(input), ASK, QUOTED_DATA_NOTICE];
  const pointers = input.due.flatMap((entry) => {
    const line = formatDraftLine(entry, input.now);
    return line === null ? [] : [line];
  });
  const most = Math.min(MAX_DRAFT_NUDGE_POINTERS, pointers.length);
  const candidates = Array.from({ length: most + 1 }, (_, i) =>
    compose(fixed, pointers, most - i, input.due.length),
  );
  return candidates.find((text) => text.length <= MAX_HINT_TEXT_LENGTH) ?? "";
};
