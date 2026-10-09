/**
 * EVERY RELATION THAT CAN REACH A SESSION, DECLARED (1.0 spec 01a §3.3b, §3.3f).
 *
 * "Retention requires positive proof to delete, not positive proof to keep."
 * A sweep that deletes a session's skeleton asserts that NOTHING still
 * depends on that session's order, and the only way to make the assertion
 * checkable is to write down, as data, every relation that references a
 * session and what it means for retention:
 *
 *   root               — independently live; while live, it keeps the session
 *   non_retaining_edge — references the session but depends on nothing in its
 *                        order (ownership, a display record); needs a reason
 *   skeleton           — the skeleton itself
 *
 * THE SWEEP IS GENERATED FROM THIS LIST (services/retention.ts) and has no
 * clause of its own, so a root cannot be declared and forgotten. The list is
 * checked against the DDL BY FOREIGN KEY (test/retention-registry.test.ts,
 * CSK-12): a column that references `agent_sessions(id)` under any name and
 * has no entry here fails the build, so a seventh relation cannot arrive
 * silently and be deleted underneath.
 *
 * LIVENESS IS OWNED BY THE SPEC THAT OWNS THE ROOT, never invented here
 * (§8.3). Where it is not defined yet the entry says `undefined_pending_spec`
 * and names who owes it: the root keeps everything it reaches, and `doctor`
 * prints what that costs.
 *
 * WORK CONTEXTS ARE NOT A ROOT (Nick, 2026-09-17): every session has one, so
 * "a work context references it" is unbounded storage by another route.
 * Belonging says nothing about whether anybody still depends on the order.
 */
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { RetentionRootName } from "@crosscheck/schema";

import { PILOT_RETENTION_DAYS } from "../constants.ts";

/**
 * `while_exists`: live for as long as the row exists — the owning feature has
 * no retirement in 1.0. `undefined_pending_spec`: the owning spec has not
 * said when a row stops being live, so the root keeps everything it reaches
 * and `doctor` names who owes the rule (RETENTION_ROOT_LIVENESS_OWNER in
 * @crosscheck/schema — one map, so the registry and the sentence agree).
 */
export type RootLiveness = "while_exists" | "undefined_pending_spec";

interface RelationBase {
  /** The referencing table and column, exactly as the DDL spells them. */
  readonly table: string;
  readonly column: string;
}

export interface RootRelation extends RelationBase {
  readonly semantics: "root";
  readonly name: RetentionRootName;
  /**
   * `not_built`: declared, its table not yet created. While any root is, the
   * sweep does not run at all (§3.3b, CSK-26) — a table somebody is committed
   * to building will reference sessions the sweep would already have deleted.
   */
  readonly status: "built" | "not_built";
  readonly liveness: RootLiveness;
  /**
   * The condition under which this root reaches the session whose id is
   * `session`. The sweep uses it as `NOT EXISTS (…)` and the report as
   * `EXISTS (…)`, so the two can never disagree about what a root keeps.
   */
  readonly reaches: (session: SQL) => SQL;
}

export interface NonRetainingRelation extends RelationBase {
  readonly semantics: "non_retaining_edge";
  /** Why this reference depends on nothing in the session's order. */
  readonly reason: string;
  /**
   * How long this relation's OWN rows live, when they age out at all (07
   * §13.9, D-O6) — declared here, beside why they keep nothing alive, so the
   * statement that they may be deleted and the bound they are deleted at sit
   * in one place and are checked together (test/hint-outcome-retention.test.ts).
   * Absent: the rows have no age limit of their own.
   */
  readonly ownRetentionDays?: number;
}

export interface SkeletonRelation extends RelationBase {
  readonly semantics: "skeleton";
}

export type RetentionRelation =
  | RootRelation
  | NonRetainingRelation
  | SkeletonRelation;

export const RETENTION_REGISTRY: readonly RetentionRelation[] = [
  {
    table: "session_events",
    column: "session_id",
    semantics: "skeleton",
  },
  {
    table: "claims",
    column: "author_session_id",
    semantics: "root",
    name: "claims",
    status: "built",
    // The tree decides "current" in six places (00 §1.5); which one is the
    // retention predicate is 02's and 04's to name. Until then every claim
    // keeps its author session.
    liveness: "undefined_pending_spec",
    reaches: (session) =>
      sql`SELECT 1 FROM claims c WHERE c.author_session_id = ${session}`,
  },
  {
    table: "claim_edges",
    column: "author_session_id",
    semantics: "root",
    name: "claim_edges",
    status: "built",
    liveness: "undefined_pending_spec",
    reaches: (session) =>
      sql`SELECT 1 FROM claim_edges ce WHERE ce.author_session_id = ${session}`,
  },
  {
    // A pin reaches a session through the FILE, not a column: the pin's
    // identity history (every name it has watched, §3.3d) against the
    // session's own touches. The listed column is where the chain starts.
    table: "pin_file_refs",
    column: "file_ref",
    semantics: "root",
    name: "pins",
    status: "built",
    // A broken pin is not a dead pin: `broke_at` marks the violated invariant
    // whose history an investigation needs first. Pins have no retirement.
    liveness: "while_exists",
    reaches: (session) => sql`SELECT 1 FROM session_events pe
      JOIN pin_file_refs pr ON pr.file_ref = pe.file_ref
      WHERE pe.session_id = ${session}`,
  },
  {
    table: "work_context_intents",
    column: "author_session_id",
    semantics: "root",
    name: "intent_versions",
    status: "built",
    // Append-only; whether an amended-away version is still live is exactly
    // the question 06 owes (§3.3b).
    liveness: "undefined_pending_spec",
    reaches: (session) =>
      sql`SELECT 1 FROM work_context_intents wi WHERE wi.author_session_id = ${session}`,
  },
  {
    table: "pilot_sessions",
    column: "session_id",
    semantics: "root",
    name: "pilot_sessions",
    status: "built",
    // 07 §11.8 DECLARES both pilot relations non-retaining — nothing the pilot
    // reads is in the skeleton — for Nick to confirm (D-E). Until he does,
    // they are registered as the alternative 07 itself names, root while the
    // row exists: a wrong KEEP costs rows and can be undone, a wrong DELETE
    // costs history and cannot. Confirming D-E moves both entries below the
    // non-retaining line, and CSK-22's Record over root names moves with them.
    liveness: "while_exists",
    reaches: (session) =>
      sql`SELECT 1 FROM pilot_sessions ps WHERE ps.session_id = ${session}`,
  },
  {
    table: "pilot_attributions",
    column: "top_session_id",
    semantics: "root",
    name: "pilot_attributions",
    status: "built",
    // D-E, as for pilot_sessions above.
    liveness: "while_exists",
    reaches: (session) =>
      sql`SELECT 1 FROM pilot_attributions pa WHERE pa.top_session_id = ${session}`,
  },
  {
    table: "work_contexts",
    column: "session_id",
    semantics: "non_retaining_edge",
    reason:
      "ownership, not dependence: every registered session has one, so retaining through it keeps every session for ever (Nick, 2026-09-17)",
  },
  {
    table: "work_contexts",
    column: "updated_by_session_id",
    semantics: "non_retaining_edge",
    reason:
      "names which session delivered the latest update, for coverage's scope; reads no position in that session's order",
  },
  {
    table: "hint_deliveries",
    column: "session_id",
    semantics: "non_retaining_edge",
    reason: "records what was shown to a session and reads no position",
  },
  {
    // 07 §13. Reaches a session through the delivery it answers — the way a
    // pin reaches one through a file — so it is declared here although its
    // column names a delivery, not a session.
    table: "hint_outcomes",
    column: "delivery_id",
    semantics: "non_retaining_edge",
    reason:
      "a word about what a delivery led to (followed, overrode, not relevant now); reads no position in the receiving session's order",
    // D-O6: pilot measurement, so the pilot's rule — and nothing references
    // an outcome, so deleting one at this bound strands nothing (01a, principle 6).
    ownRetentionDays: PILOT_RETENTION_DAYS,
  },
  {
    // 07 §13.11 (review H-B). The person saying noise again, a row of its own
    // beside the label; reaches a session through its delivery, as an outcome does.
    table: "noise_reassertions",
    column: "delivery_id",
    semantics: "non_retaining_edge",
    reason: "a person saying again that a delivery was noise; reads no position in the receiving session's order",
    // The outcomes' rule, which it stands beside; nothing references it (01a, principle 6).
    ownRetentionDays: PILOT_RETENTION_DAYS,
  },
  {
    // Human provenance (review M4): a draft names the delivery and the session a
    // label or an outcome is about INSIDE its payload — no foreign key, so
    // declared here by hand. Decided rows are kept, their reason aging out at
    // the pilot's bound; a draft nobody decided dies whole there (round-2
    // R2-L3, services/pilot.ts).
    table: "human_drafts",
    column: "payload",
    semantics: "non_retaining_edge",
    reason: "a draft of a person's word about a delivery, naming its session as data; reads no position in that session's order",
  },
  {
    // The same names, in the content a confirmation signed; its reason ages out with the draft's.
    table: "human_confirmation_items",
    column: "content",
    semantics: "non_retaining_edge",
    reason: "what a person confirmed about a delivery, naming its session as data; reads no position in that session's order",
  },
  {
    table: "questions",
    column: "author_session_id",
    semantics: "non_retaining_edge",
    reason:
      "no skeleton kind projects a question, so nothing a question depends on is in the skeleton",
  },
  {
    // 01a §3.3b's own classification. Not a root: retaining through it would
    // keep every declaring session for ever. Not skeleton either: the sweep
    // must not take it, because the cap a contradicting row wrote here is
    // the only trace of that row once the row itself is swept.
    table: "session_causal_guarantees",
    column: "session_id",
    semantics: "non_retaining_edge",
    reason: "a declaration about a session, not a dependence on its order",
  },
];

export const retentionRoots = (
  registry: readonly RetentionRelation[] = RETENTION_REGISTRY,
): readonly RootRelation[] =>
  registry.filter((relation): relation is RootRelation => relation.semantics === "root");
