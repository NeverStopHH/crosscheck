/**
 * WHO A JUDGEMENT CAME FROM (human provenance, 0.11 §3) — the words the hub,
 * the database and every client must agree on.
 *
 * EXACTLY THREE CLASSES are ever assigned to a write, by the hub, from the
 * door it arrived through — never from a claim in its body:
 *
 *   - `agent_asserted` — the agent's own door (`mark_hint_outcome`), and any
 *     settings change made with the API key;
 *   - `interactive_terminal_asserted` — a door the CLI takes only behind its
 *     person gate (a terminal, no agent-host marker). A TECHNICAL CHANNEL,
 *     never a human: a pty, tmux send-keys or a curl with the key reach it;
 *   - `human_passkey_confirmed` — written only by a verified passkey ceremony
 *     over a frozen batch that names this exact item. The ONE human class.
 *
 * `unknown_legacy` is not a class: it marks a row written before 0.11, for
 * which no class was ever recorded. It is never upgraded and never human.
 */

export const PROVENANCE_CLASSES = [
  "agent_asserted",
  "interactive_terminal_asserted",
  "human_passkey_confirmed",
] as const;

export type ProvenanceClass = (typeof PROVENANCE_CLASSES)[number];

/** The one class every pilot metric may count as a person's judgement. */
export const HUMAN_PROVENANCE = "human_passkey_confirmed" as const satisfies ProvenanceClass;

/** The marker on a row from before provenance was recorded — no class at all. */
export const LEGACY_PROVENANCE = "unknown_legacy" as const;

export type StoredProvenance = ProvenanceClass | typeof LEGACY_PROVENANCE;

/** A draft is what a key wrote and nobody has confirmed: never the human class. */
export const DRAFT_PROVENANCES = [
  "agent_asserted",
  "interactive_terminal_asserted",
] as const satisfies readonly ProvenanceClass[];

export type DraftProvenance = (typeof DRAFT_PROVENANCES)[number];

/**
 * What a row in a record that COUNTS may carry (`pilot_marks`, `hint_outcomes`,
 * `noise_reassertions`, `pins`, `developer_mutes`): a confirmation, or the
 * legacy marker. Drafts never reach those tables.
 */
export const STORED_JUDGEMENT_PROVENANCES = [LEGACY_PROVENANCE, HUMAN_PROVENANCE] as const;

/** True for the human class alone — any other word, a misspelling included, is not a person. */
export const isHumanProvenance = (value: string): boolean => value === HUMAN_PROVENANCE;

/**
 * Every human-only write a key can only DRAFT: a label on an intervention,
 * `pin --ok`, an outcome, a pin, its retraction, a mute, an unmute, and
 * switching presence back on. Going more private (presence off) is no draft:
 * it takes effect at once and is recorded with its class.
 */
export const DRAFT_KINDS = [
  "label",
  "pin_ok",
  "outcome",
  "pin",
  "pin_broke",
  "mute",
  "unmute",
  "presence_on",
] as const;

export type DraftKind = (typeof DRAFT_KINDS)[number];

/** What a person decides about one pending draft in a confirmation batch. */
export const DRAFT_DECISIONS = ["confirm", "discard", "keep"] as const;

export type DraftDecision = (typeof DRAFT_DECISIONS)[number];
