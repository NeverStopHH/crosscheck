/**
 * DECLARED CAUSAL GUARANTEES (1.0 spec 01a §3.6) — per connector and per
 * canonical kind, what that connector COULD observe and in what order. A
 * structural statement, beside the loss report's runtime one
 * (docs/1.0/loss-accounting.md §4.9): "this host cannot observe X" is
 * `unavailable / no_emitter` here and never a loss there, and a reported loss
 * never lowers a declaration — only a ROW that contradicts it does (the hub's
 * services/causal-guarantees.ts).
 *
 * WHY IT LIVES IN `schema`. The connector sends it on the session register
 * body and the hub folds it into `session_causal_guarantees`; both import this
 * package and neither can import the other — the argument that put the loss
 * report here (telemetry-loss.ts).
 *
 * THE FOLD IS THE CONTRACT, and it only ever weakens. A connector is
 * untrusted and may be newer than its hub, so the block is loose on the wire
 * and nothing in it is refused: a value this hub cannot read becomes
 * `undeclared / provider_undeclared`, the weakest reading there is — never the
 * state it arrived with — and a block it cannot read at all is stored as
 * nothing, which reads the same.
 */
import { z } from "zod";

import { LEDGER_EVENT_KINDS, SESSION_EVENT_KINDS } from "./session-event.ts";

/** Weakest first: the fold over a scope is the MINIMUM by this order (01a §3.7). */
export const CAUSAL_GUARANTEES = ["undeclared", "unavailable", "partial", "guaranteed"] as const;

export type CausalGuarantee = (typeof CAUSAL_GUARANTEES)[number];

export const CAUSAL_GUARANTEE_REASONS = [
  /** guaranteed: every producing lane opens the position before the tool runs. */
  "bracketed_by_pre_tool",
  /** guaranteed: n = 0 or the terminal position, with no tool to race. */
  "lifecycle",
  /** partial: some producing lane positions only after the fact. */
  "unbracketed_lane",
  /** partial: the kind is produced only by an observing lane (git diff, a collection). */
  "observed_lane_only",
  /** partial: a derived record is positioned when written down, after the turn it describes. */
  "derived_after_the_fact",
  /** partial: the MCP picker's ambiguity (01 D1) can withhold the position. */
  "ambiguous_session_possible",
  /** unavailable: this connector never produces the kind. */
  "no_emitter",
  /** unavailable: the kind's producer does not exist yet. */
  "not_built",
  /** undeclared: the session sent no declaration — or one this hub could not read. */
  "provider_undeclared",
] as const;

export type CausalGuaranteeReason = (typeof CAUSAL_GUARANTEE_REASONS)[number];

/**
 * THE ONE STATE EACH REASON BELONGS TO, read off the comments above. A triple
 * whose pair disagrees with this map is incoherent, and the fold reads it as
 * undeclared rather than trusting either half: `guaranteed / no_emitter` says
 * two opposite things, and picking the strong one would be the exoneration.
 */
export const GUARANTEE_OF_REASON: Readonly<Record<CausalGuaranteeReason, CausalGuarantee>> = {
  bracketed_by_pre_tool: "guaranteed",
  lifecycle: "guaranteed",
  unbracketed_lane: "partial",
  observed_lane_only: "partial",
  derived_after_the_fact: "partial",
  ambiguous_session_possible: "partial",
  no_emitter: "unavailable",
  not_built: "unavailable",
  provider_undeclared: "undeclared",
};

/**
 * THE NINE KINDS A DECLARATION COVERS: the seven `session_events` projects and
 * the two the intent ledger positions on its own rows (06). "At most nine enum
 * triples" (01a §3.6) is this list's length.
 */
export const GUARANTEE_KINDS = [...SESSION_EVENT_KINDS, ...LEDGER_EVENT_KINDS] as const;

export type GuaranteeKind = (typeof GUARANTEE_KINDS)[number];

/**
 * THE KINDS A PRE-TOOL BRACKET CAN POSITION: the two a `target` record
 * projects to (server record-handlers.ts `TARGET_EVENT_KINDS`; a server test
 * holds the two lists equal). The hub stores a target row `emitted` only when
 * it carries the bracket's floor (`seqKindFor`), so no other kind has one.
 */
export const BRACKETABLE_KINDS = ["file.modified", "tool.failed"] as const satisfies readonly GuaranteeKind[];

/**
 * THE `guaranteed` REASONS EACH KIND CAN BE TRUE OF (review H2). A connector is
 * untrusted, and coherence alone (reason ↔ state) let any client store a claim
 * the hub can itself prove false:
 *   - `lifecycle` is n = 0 or the terminal position: only the two session kinds;
 *   - `bracketed_by_pre_tool` needs a tool window: only BRACKETABLE_KINDS;
 *   - `commit.observed` never: the hub stores every commit row `observed`
 *     (server commit-evidence.ts);
 *   - `claim.*` and `intent.*` never: the MCP tools withhold the position when
 *     the session picker is ambiguous (connector-core mcp/tools/shared.ts
 *     `allocateToolSeq`), and a derived one is stored `observed`.
 * Every weaker reason is admissible on every kind: it can only lower the fold.
 */
const STRONG_REASONS_OF_KIND: Readonly<Record<GuaranteeKind, readonly CausalGuaranteeReason[]>> = {
  "session.started": ["lifecycle"],
  "tool.failed": ["bracketed_by_pre_tool"],
  "file.modified": ["bracketed_by_pre_tool"],
  "claim.created": [],
  "claim.invalidated": [],
  "commit.observed": [],
  "session.ended": ["lifecycle"],
  "intent.declared": [],
  "intent.amended": [],
};

/** Can this kind carry this reason? Only a `guaranteed` reason is ever refused. */
export const isAdmissibleReason = (kind: GuaranteeKind, reason: CausalGuaranteeReason): boolean =>
  GUARANTEE_OF_REASON[reason] !== "guaranteed" || STRONG_REASONS_OF_KIND[kind].includes(reason);

/**
 * THE COVERAGE RECORD'S `order` REASONS (01a §3.7): a declared reason, or one
 * of three only the reading side can know. `declaration_contradicted` — a row
 * of the session rules the declaration out (the hub's cap); `no_session_in_scope`
 * — the fold had nothing to fold, so it may not answer the strongest value;
 * `hub_did_not_report` — the connector's reading of a hub that sent no order
 * block, 03's COV-3 rule (absent is never silence) applied to the new block.
 */
export const ORDER_REASONS = [
  ...CAUSAL_GUARANTEE_REASONS,
  "declaration_contradicted",
  "no_session_in_scope",
  "hub_did_not_report",
] as const;

/**
 * EVERY ORDER REASON, WEAKEST FIRST — the one order every fold here resolves
 * ties by: the connector's lane fold (connector-core guarantees/declarations.ts
 * reads the causal reasons out of it) and the hub's fold over a coverage scope.
 * A reason's state is fixed (`stateOfOrderReason`), and the list keeps the
 * states in CAUSAL_GUARANTEES' order, so ranking by reason alone never lets a
 * weaker state outrank a stronger one. Inside `partial`: a contradicted
 * declaration first (a row disproved it); then the derived worker (§3.6: "the
 * summarizer's claims are a weaker lane than MCP ambiguity"); then the
 * unbracketed and observing lanes, whose positions are upper bounds; then the
 * MCP lane, whose positions are emitted when present.
 */
export const ORDER_REASON_STRENGTH: readonly OrderReason[] = [
  "no_session_in_scope",
  "hub_did_not_report",
  "provider_undeclared",
  "not_built",
  "no_emitter",
  "declaration_contradicted",
  "derived_after_the_fact",
  "unbracketed_lane",
  "observed_lane_only",
  "ambiguous_session_possible",
  "bracketed_by_pre_tool",
  "lifecycle",
];

/**
 * The weaker of two reasons by ORDER_REASON_STRENGTH (review L1): ranking by
 * the reason ranks by state first, and breaks a tie inside one state the way
 * the hub's fold over a scope does, so a kind sent twice, or re-registered,
 * keeps the weaker of two `partial` reasons rather than whichever came first.
 */
export const isWeakerReason = (candidate: OrderReason, held: OrderReason): boolean =>
  ORDER_REASON_STRENGTH.indexOf(candidate) < ORDER_REASON_STRENGTH.indexOf(held);

/** The state an order reason belongs to: a declared reason's own, the reader's three below. */
export const stateOfOrderReason = (reason: OrderReason): CausalGuarantee => {
  if (isMember(CAUSAL_GUARANTEE_REASONS, reason)) {
    return GUARANTEE_OF_REASON[reason];
  }
  return reason === "declaration_contradicted" ? "partial" : "undeclared";
};

/**
 * WHAT A HUB'S `session_causal_guarantees.reason` CAN HOLD: a declared reason,
 * or the cap a contradicting row wrote over a `guaranteed` one (01a §3.6,
 * "rows outrank declarations"). The cap is stored, not derived on read, so it
 * survives the rows that caused it — a swept skeleton must not lift it.
 */
export const STORED_GUARANTEE_REASONS = [
  ...CAUSAL_GUARANTEE_REASONS,
  "declaration_contradicted",
] as const;

export type StoredGuaranteeReason = (typeof STORED_GUARANTEE_REASONS)[number];

export type OrderReason = (typeof ORDER_REASONS)[number];

/** The coverage record's order block: a state and its reason, and NO count (03 COV-6). */
export interface CoverageOrder {
  readonly state: CausalGuarantee;
  readonly reason: OrderReason;
}

export interface CausalGuaranteeTriple {
  readonly kind: GuaranteeKind;
  readonly guarantee: CausalGuarantee;
  readonly reason: CausalGuaranteeReason;
}

/**
 * The largest block a hub folds: the nine kinds, doubled, so a connector two
 * vocabularies ahead of this hub is still read — the MAX_LOSS_KIND_ENTRIES
 * rule. A longer block is stored as nothing rather than cut, because a cut
 * keeps whichever triples came first, and those may be the strong ones.
 */
export const MAX_GUARANTEE_TRIPLES = GUARANTEE_KINDS.length * 2;

/** A field longer than this is nobody's enum value. */
export const MAX_GUARANTEE_FIELD_CHARS = 64;

const GUARANTEE_RANK: Readonly<Record<string, number>> = Object.fromEntries(
  CAUSAL_GUARANTEES.map((state, rank) => [state, rank]),
);

const rankOf = (state: CausalGuarantee): number => GUARANTEE_RANK[state] ?? 0;

/** The weaker of two states — the direction every fold here goes. */
export const weakerGuarantee = (
  left: CausalGuarantee,
  right: CausalGuarantee,
): CausalGuarantee => (rankOf(right) < rankOf(left) ? right : left);

const isMember = <T extends string>(list: readonly T[], value: string): value is T =>
  (list as readonly string[]).includes(value);

const UNDECLARED = { guarantee: "undeclared", reason: "provider_undeclared" } as const;

const WireTripleSchema = z.object({
  kind: z.string().min(1).max(MAX_GUARANTEE_FIELD_CHARS),
  guarantee: z.string().min(1).max(MAX_GUARANTEE_FIELD_CHARS),
  reason: z.string().min(1).max(MAX_GUARANTEE_FIELD_CHARS),
});

/**
 * One entry, read: null for an entry nothing can be said about. A pair is kept
 * only when the reason is its state's own AND the kind can carry it; anything
 * else reads `undeclared`, never the state it arrived with.
 */
const foldTriple = (raw: unknown): CausalGuaranteeTriple | null => {
  const parsed = WireTripleSchema.safeParse(raw);
  if (!parsed.success || !isMember(GUARANTEE_KINDS, parsed.data.kind)) {
    return null;
  }
  const { kind, guarantee, reason } = parsed.data;
  const coherent =
    isMember(CAUSAL_GUARANTEE_REASONS, reason) &&
    GUARANTEE_OF_REASON[reason] === guarantee &&
    isAdmissibleReason(kind, reason);
  return coherent ? { kind, guarantee: GUARANTEE_OF_REASON[reason], reason } : { kind, ...UNDECLARED };
};

/**
 * The declaration a hub stores for a register body's `guarantees` value.
 * Unknown kinds drop (no question asks about them); unknown or incoherent
 * values become `undeclared`; a kind sent twice keeps the weaker reason; an
 * unreadable or oversized block is stored as nothing. Ordered by
 * GUARANTEE_KINDS, so two equal declarations are equal values.
 */
export const foldGuaranteeDeclaration = (raw: unknown): readonly CausalGuaranteeTriple[] => {
  if (!Array.isArray(raw) || raw.length > MAX_GUARANTEE_TRIPLES) {
    return [];
  }
  const byKind = raw.reduce<ReadonlyMap<GuaranteeKind, CausalGuaranteeTriple>>((kept, entry) => {
    const triple = foldTriple(entry);
    if (triple === null) {
      return kept;
    }
    const held = kept.get(triple.kind);
    const weaker = held !== undefined && !isWeakerReason(triple.reason, held.reason) ? held : triple;
    return new Map([...kept, [triple.kind, weaker]]);
  }, new Map());
  return GUARANTEE_KINDS.flatMap((kind) => {
    const triple = byKind.get(kind);
    return triple === undefined ? [] : [triple];
  });
};
