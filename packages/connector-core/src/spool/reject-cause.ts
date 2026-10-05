/**
 * WHY THE HUB REFUSED A RECORD, KEPT AS A WORD (docs/1.0/loss-accounting.md §4.3).
 *
 * A `rejected` ledger line used to be `{"at","count","reason":"rejected"}` and
 * nothing else, so the pilot's 433 dropped records could say THAT the hub
 * refused them and never WHY: it took the hub's own source to learn that 225
 * of them belonged to one conversation the hub held as ended. Ingest answers
 * every refused record with its issues (server services/records.ts), and the
 * flush now keeps the one fact a reader can act on.
 *
 * A CODE, NEVER THE SENTENCE. The hub's issue strings are prose from another
 * process — one of them carries a session id — and a ledger line is read back
 * into a terminal. So the sentence is matched against the hub's own wording
 * here and only a word from the closed list below is written; a sentence this
 * connector does not know is `other`. The matching is against the hub as it
 * has spoken since before 1.0, so a 0.10 hub's refusals are named too.
 */
import { addCount } from "./counts.ts";
import type { Counts } from "./counts.ts";

export const REJECT_CAUSES = [
  /** The producer session ended on the hub: a late write (records.ts checkProducerSession). */
  "session_ended",
  /** The hub never registered the producer session. */
  "session_unknown",
  /** The producer session belongs to another developer. */
  "session_foreign",
  /** The envelope named another developer than the key that sent it. */
  "developer_mismatch",
  /** Any refusal this connector has no word for. */
  "other",
] as const;

export type RejectCause = (typeof REJECT_CAUSES)[number];

/** The hub's wording, first issue of a refused record → its cause. */
const CAUSE_PATTERNS: readonly (readonly [RegExp, RejectCause])[] = [
  [/^producer\.sessionId: session has already ended/, "session_ended"],
  [/^producer\.sessionId: session ".*" not found$/, "session_unknown"],
  [/^producer\.sessionId: session belongs to another developer/, "session_foreign"],
  [/^producer\.developerId: does not match authenticated developer/, "developer_mismatch"],
];

export const rejectCauseOf = (issues: readonly string[] | undefined): RejectCause => {
  const first = issues?.[0] ?? "";
  return CAUSE_PATTERNS.find(([pattern]) => pattern.test(first))?.[1] ?? "other";
};

const isRejectCause = (name: string): name is RejectCause =>
  (REJECT_CAUSES as readonly string[]).includes(name);

/** A count map read back from a file: unknown words fold into `other`. */
export const screenCauses = (causes: Readonly<Record<string, number>>): Counts =>
  Object.entries(causes).reduce<Counts>(
    (screened, [cause, count]) =>
      count <= 0 ? screened : addCount(screened, isRejectCause(cause) ? cause : "other", count),
    {},
  );

/**
 * What each cause means to the person reading doctor, and what clears it —
 * each one reads after a count ("225 because …"). Renderer-owned literals;
 * the count beside them is the only number.
 *
 * THE SESSION NAMED IS THE ONE THAT DELIVERED THEM. The hub's issue is about
 * `producer.sessionId`, which the flush stamps with the FLUSHING session — not
 * the session that wrote the records, which may be another conversation's, and
 * not a claim that anything was resumed (review finding 5).
 */
export const REJECT_CAUSE_SENTENCES: Readonly<Record<RejectCause, string>> = {
  session_ended:
    "because the session delivering them was one the hub held as ended — its conversation " +
    "went on past an end (a resume, a reload, another window's SessionEnd); this connector now " +
    "moves such a session to its next life and re-sends what it may",
  session_unknown:
    "because the session delivering them was not registered on the hub — its register had " +
    "not landed; this connector now registers it when the hub says so",
  session_foreign: "because the session delivering them belongs to another developer on this hub",
  developer_mismatch: "because the developer they were delivered as is not this machine's login",
  other: "for a reason this connector does not name — the hub's response carries the sentence",
};

/**
 * Records never sent at all (spool/flush-heal.ts): the life that wrote them
 * was already ended on the hub, and any other life delivering them would file
 * them into it past its end. Reads after a count, like the sentences above.
 */
export const WITHHELD_SENTENCE =
  "withheld unsent — the life that wrote them had already been ended on the hub, and " +
  "delivering them under another life would have filed them after that end";

/** The `rejected` records no line said a cause for: ledgers from before the field. */
export const UNRECORDED_CAUSE_SENTENCE =
  "with no cause recorded — written by a connector before 1.0, whose ledger kept only the count";
