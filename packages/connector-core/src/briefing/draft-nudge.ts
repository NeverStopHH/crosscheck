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
 * review the agent has no handle to perform. To fit MAX_HINT_TEXT_LENGTH,
 * lines are dropped whole from the tail and counted in "+N more not shown" —
 * down to DRAFT_NUDGE_POINTERS_BEFORE_CLAUSES; below that the header's
 * descriptive clauses go first (kinds, then the backlog in all, then the
 * retention count), and a nudge that would name NO draft is not rendered.
 * Measured at the realistic size (clm_<uuid> ids, bodies past the 80-char
 * cut, five kinds, floor and retention on), the full header left room for
 * none.
 *
 * Kinds are the wire spelling of the claim kinds, which is also what
 * publish_claim and review_draft speak; a kind this client does not know is
 * counted as "other" and never printed — it is hub text, and the header
 * carries no quote frame.
 */
import { CLAIM_KINDS, MAX_HINT_TEXT_LENGTH } from "@crosscheck/schema";

import {
  DRAFT_NUDGE_MIN_AGE_HOURS,
  DRAFT_NUDGE_POINTERS_BEFORE_CLAUSES,
  DRAFT_RETENTION_HORIZON_DAYS,
  MAX_DRAFT_NUDGE_POINTERS,
} from "../constants.ts";
import type { DraftEntry } from "../http/hub.ts";
import { formatAge } from "./age.ts";
import {
  DRAFT_DUE_AGE_MS,
  DRAFT_HORIZON_AGE_MS,
  amountOf,
  backlogSize,
  countAtLeastAged,
  oldestAgeMs,
  reachableAtLeastAged,
} from "./draft-backlog.ts";
import type { DraftBacklog, DraftCount } from "./draft-backlog.ts";
import { formatDraftLine, OWN_DRAFTS_QUOTED_DATA_NOTICE } from "./render.ts";

export interface DraftNudgeInput {
  /** The hub's listing, already counted (briefing/draft-backlog.ts). */
  readonly backlog: DraftBacklog;
  readonly now: Date;
}

const OTHER_KIND = "other";

/**
 * Every clause is a fact about the hub, and two of them were once false: a
 * teammate CAN read an unreviewed draft (get_diagnosis returns its body,
 * marked derived, and a word in it surfaces the tree in search), and a
 * discard deletes nothing — it appends a rejected copy that stays in the
 * history. What is true is narrower: no draft is ever PUSHED to anyone, and
 * a rejected one is never offered as a finding (the declared-only hint gate,
 * contradictions and solved pointers all skip it).
 */
const VISIBILITY =
  " Drafts are never pushed to teammates; one shows, marked derived, only to whoever opens or searches your notes.";

const ASK =
  "When this request is done, ask the person — do not decide yourself — whether to " +
  "confirm, edit or discard each, and call review_draft only with their answer: " +
  "confirm or edit publishes it as your claim; discard marks it rejected " +
  "(kept in history, never offered as a finding).";

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

/** The kinds are of the rows in hand; when those are fewer than the count, it says which. */
const kindsClause = (
  reachable: { readonly rows: readonly DraftEntry[]; readonly end: "oldest" | "newest" },
  due: DraftCount,
): string =>
  reachable.rows.length < due.count || due.floor
    ? `of the ${reachable.end} ${String(reachable.rows.length)}: ${kindSummary(reachable.rows)}`
    : kindSummary(reachable.rows);

const retentionSentence = (old: DraftCount): string =>
  old.count === 0
    ? ""
    : ` ${old.floor ? "At least " : ""}${String(old.count)} ${old.count === 1 ? "is" : "are"} older than ` +
      `${String(DRAFT_RETENTION_HORIZON_DAYS)} days; drafts are never deleted or auto-discarded.`;

/** The backlog in all, said only when the hub (or a short listing) makes it exact. */
const backlogSentence = (backlog: DraftBacklog, now: Date): string => {
  const size = backlogSize(backlog);
  const oldest = oldestAgeMs(backlog, now);
  return size.floor || oldest === null
    ? ""
    : ` ${String(size.count)} in all, the oldest ${formatAge(oldest)} old.`;
};

/** Which descriptive clauses the header still carries; the count, visibility and ask always stay. */
interface HeaderClauses {
  readonly kinds: boolean;
  readonly backlog: boolean;
  readonly retention: boolean;
}

/** Each step gives up one more clause, in the order the module comment names. */
const CLAUSE_LEVELS: readonly HeaderClauses[] = [
  { kinds: true, backlog: true, retention: true },
  { kinds: false, backlog: true, retention: true },
  { kinds: false, backlog: false, retention: true },
  { kinds: false, backlog: false, retention: false },
];

const headerLine = (
  input: DraftNudgeInput,
  reachable: { readonly rows: readonly DraftEntry[]; readonly end: "oldest" | "newest" },
  clauses: HeaderClauses,
): string => {
  const due = countAtLeastAged(input.backlog, DRAFT_DUE_AGE_MS, input.now);
  const verb = due.count === 1 && !due.floor ? "has" : "have";
  const kinds = clauses.kinds ? ` (${kindsClause(reachable, due)})` : "";
  return (
    `crosscheck: ${amountOf(due)} of your own auto-captured draft claims ${verb} waited over ` +
    `${String(DRAFT_NUDGE_MIN_AGE_HOURS)}h for review${kinds}.` +
    (clauses.backlog ? backlogSentence(input.backlog, input.now) : "") +
    VISIBILITY +
    (clauses.retention ? retentionSentence(countAtLeastAged(input.backlog, DRAFT_HORIZON_AGE_MS, input.now)) : "")
  );
};

const compose = (
  fixed: readonly string[],
  pointers: readonly string[],
  shown: number,
  due: DraftCount,
): string =>
  [
    ...fixed,
    ...pointers.slice(0, shown),
    ...(due.count > shown
      ? [`(+${due.floor ? "at least " : ""}${String(due.count - shown)} more not shown)`]
      : []),
  ].join("\n");

/** Counts from `from` down to `to`, both included; empty when `from` < `to`. */
const countDown = (from: number, to: number): readonly number[] =>
  Array.from({ length: Math.max(0, from - to + 1) }, (_, i) => from - i);

/**
 * Every (clauses, shown) pair in order of preference: at each clause level
 * the most ids down to DRAFT_NUDGE_POINTERS_BEFORE_CLAUSES, and only once
 * every clause is gone, fewer — never zero.
 */
const layouts = (most: number): readonly { readonly clauses: HeaderClauses; readonly shown: number }[] => {
  const kept = Math.min(most, DRAFT_NUDGE_POINTERS_BEFORE_CLAUSES);
  const bare = CLAUSE_LEVELS[CLAUSE_LEVELS.length - 1] ?? CLAUSE_LEVELS[0];
  return [
    ...CLAUSE_LEVELS.flatMap((clauses) => countDown(most, kept).map((shown) => ({ clauses, shown }))),
    ...(bare === undefined ? [] : countDown(kept - 1, 1).map((shown) => ({ clauses: bare, shown }))),
  ];
};

/**
 * "" when no draft in hand is due, or when none of them has a line to print —
 * a nudge naming no id is unnameable, and the flow never spends the slot on
 * it. The nudge names drafts by id, so it names rows a page actually
 * returned: the oldest-first page's when the flow fetched one
 * (flows/draft-nudge.ts does whenever the backlog runs past the newest-first
 * page), and review_draft reaches both ends.
 */
export const renderDraftNudge = (input: DraftNudgeInput): string => {
  const reachable = reachableAtLeastAged(input.backlog, DRAFT_DUE_AGE_MS, input.now);
  const pointers = reachable.rows.flatMap((entry) => {
    const line = formatDraftLine(entry, input.now);
    return line === null ? [] : [line];
  });
  if (pointers.length === 0) {
    return "";
  }
  const due = countAtLeastAged(input.backlog, DRAFT_DUE_AGE_MS, input.now);
  const most = Math.min(MAX_DRAFT_NUDGE_POINTERS, pointers.length);
  const fits = layouts(most)
    .map(({ clauses, shown }) =>
      compose([headerLine(input, reachable, clauses), ASK, OWN_DRAFTS_QUOTED_DATA_NOTICE], pointers, shown, due),
    )
    .find((text) => text.length <= MAX_HINT_TEXT_LENGTH);
  return fits ?? "";
};
