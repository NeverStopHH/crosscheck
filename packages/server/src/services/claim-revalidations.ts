/**
 * RECORDING what a clone reported about the code under some claims.
 *
 * THE HUB NEVER COMPUTES STALENESS. It has no checkout, so it cannot ask git
 * anything at all — the same division the pin sweep already draws. This
 * service records a reading and prunes what has aged out; the verdict itself
 * is derived on READ (services/claim-validity.ts), because a stored verdict
 * outlives its evidence.
 *
 * THE UPSERT IS DOWNGRADE-ONLY, IN SQL. `result: "unchanged"` never overwrites
 * a stored `"changed"`; `unknown → current`, `unknown → changed` and
 * `unchanged → changed` are all legal. The rule lives in the statement's
 * `setWhere` rather than in a branch here for the reason
 * `questions_addressee_check` is a CHECK: a rule a service enforces is a rule
 * the next writer of a second service does not.
 *
 * WHY IT MATTERS MORE THAN IT LOOKS. The unsolicited substance lane is gated
 * on `validity.state ∉ {stale, invalidated, superseded}`, `stale` comes from
 * this row, and the only producer is a report POSTed under `developerAuth` —
 * a bearer key in plaintext in ~/.crosscheck/config.json that any agent on
 * the machine can read. Without the rule, the agent that wrote a claim marks
 * its own stale claim `unchanged` and keeps it in teammates' prompts.
 *
 * THE COST, NAMED: a genuine revert — a file that really did move back —
 * leaves the claim `stale` until somebody re-publishes it. Returning a claim
 * to the substance lane then needs what the tree already requires for every
 * other revision, a NEW claim (services/hints.ts), which is authored and
 * attributable.
 */
import { and, eq, inArray, lt, ne, notExists, or, sql } from "drizzle-orm";
import type { ClaimRevalidationReport, ClaimValidity } from "@crosscheck/schema";

import { CLAIM_REVALIDATION_RETENTION_DAYS } from "../constants.ts";
import { agentSessions, claimRevalidations, claims } from "../db/schema.ts";
import type { Db, DbExecutor } from "../db/client.ts";
import { loadClaimValidities } from "./claim-validity.ts";
import type { Clock } from "../types.ts";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

const MS_PER_DAY = 86_400_000;

export interface ClaimRevalidationOutcome {
  /** Rows the report actually wrote. */
  readonly recorded: number;
  /**
   * Reports that would have walked a claim BACK toward current and were
   * refused. Counted rather than swallowed: doctor prints it, because a gate
   * that silently drops writes is indistinguishable from one that is broken.
   */
  readonly refusedDowngrades: number;
  /**
   * Readings refused because the claim can never be revalidated (§8.5).
   *
   * A claim whose `commit_binding` is `none` has no commit to measure FROM,
   * so "unchanged since" has no since. The hub stored such rows anyway, and
   * the only thing keeping that inert was `resolveState` testing the binding
   * ABOVE the rows — a row nobody reads, one refactor away from a row
   * somebody does. Counted rather than silent, for the same reason
   * `refusedDowngrades` is: a caller whose reading was dropped otherwise
   * cannot tell that from success.
   */
  readonly refusedUnbound: number;
  /** Rows deleted for age on this pass. */
  readonly pruned: number;
  /**
   * The DERIVED validity of every claim the report named, after the write.
   *
   * Returned so a reader who triggered the check sees the downgrade on the
   * pull that found it rather than the next one, and so the connector never
   * has to map a drift result to a state itself — `claimValidity()` stays the
   * only place a ClaimValidityState is minted. It also makes the refusals
   * visible: a report whose `unchanged` was refused gets `stale` back, which
   * is the truth about the claim rather than the truth about the request.
   */
  readonly validities: ReadonlyMap<string, ClaimValidity>;
}

/** Claim ids this hub does not have — reported, never silently dropped. */
export const unknownClaimIds = async (
  db: Db,
  repo: string,
  claimIds: readonly string[],
): Promise<readonly string[]> => {
  const unique = [...new Set(claimIds)];
  if (unique.length === 0) {
    return [];
  }
  // SCOPED TO THE REPO THE REPORT IS ABOUT, which it was not.
  //
  // The wire has always required a `repo`, and the POST handler never read
  // it: the lookup was by claim id alone, with no join to the authoring
  // session's repo, and `reportedBy` was stamped from the bearer key without
  // being compared to anything. So the hub accepted a git reading about repo
  // A as authority over a claim in repo B, from a developer holding no clone
  // of B at all.
  //
  // §3.7's trust argument is "any member may report, because the check is
  // reproducible from any clone" — and that assumes the reporter is reporting
  // about the repo they cloned. Nothing enforced it.
  //
  // The downgrade-only rule then makes it one-way. It bounds a forged UPGRADE
  // and leaves a forged DOWNGRADE permanent: no honest `unchanged` can undo
  // one, so a single request naming up to MAX_CLAIM_REVALIDATION_ENTRIES
  // claims empties a team's substance lane, and doctor reports it as an
  // ordinary `N stale` count with no reporter and no repo beside it.
  const rows = await db
    .select({ id: claims.id })
    .from(claims)
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .where(and(inArray(claims.id, unique), eq(agentSessions.repo, repo)));
  const known = new Set(rows.map((row) => row.id));
  return unique.filter((id) => !known.has(id));
};

/**
 * Which of these claims the reporting developer wrote themselves.
 *
 * PRINCIPLE 4: an agent may not certify its own work. Refusal 6 knowingly
 * left one self-certification path open — `unknown -> current` is a legal
 * UPSERT direction and nothing compared `reported_by` to the author — and
 * defended it with "`unknown` is ALREADY injectable under §5's gate, so the
 * move changes nothing a reader sees".
 *
 * THAT IS TRUE OF THE GATE AND FALSE OF THE RENDER. `claimValidityWord` maps
 * every state to a printed label with no exemption, so the label a teammate
 * reads flips from `validity unknown` to `validity current` on both
 * unsolicited surfaces — and `current` is the one POSITIVE certification the
 * vocabulary has, which this module's own header calls "a positive
 * measurement somebody took". Here the somebody is the claim's own author,
 * holding a key any agent on that machine can read. The residue was accepted
 * on a premise the implementation contradicts, so the decision was never made
 * against its real cost.
 *
 * ONLY THE UPGRADE IS REFUSED. An author reporting `changed` about their own
 * claim is weakening it, which needs no protection — principle 4 is about
 * certifying, not about retracting.
 */
const ownClaimIds = async (
  db: DbExecutor,
  developerId: string,
  claimIds: readonly string[],
): Promise<ReadonlySet<string>> => {
  const unique = [...new Set(claimIds)];
  if (unique.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({ id: claims.id })
    .from(claims)
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .where(
      and(inArray(claims.id, unique), eq(agentSessions.developerId, developerId)),
    );
  return new Set(rows.map((row) => row.id));
};

/**
 * Claims that can never carry a revalidation, by §8.5.
 *
 * `commit_binding = 'none'` means no `observed_at_commit` — the schema
 * enforces the two move together — so there is no anchor for a drift walk to
 * start at and no honest reading to store. The claim is permanently
 * pointer-only; that is a documented refusal, not a temporary gap.
 */
const unboundClaimIds = async (
  db: DbExecutor,
  claimIds: readonly string[],
): Promise<ReadonlySet<string>> => {
  const unique = [...new Set(claimIds)];
  if (unique.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({ id: claims.id })
    .from(claims)
    .where(and(inArray(claims.id, unique), eq(claims.commitBinding, "none")));
  return new Set(rows.map((row) => row.id));
};

export const ingestClaimRevalidations = async (
  deps: Deps,
  developerId: string,
  report: ClaimRevalidationReport,
): Promise<ClaimRevalidationOutcome> => {
  const now = deps.now();
  const retentionCutoff = new Date(
    now.getTime() - CLAIM_REVALIDATION_RETENTION_DAYS * MS_PER_DAY,
  );
  // One short write, and NOTHING awaited inside it but SQL: PGlite is
  // single-connection, so a transaction held open across an HTTP call would
  // block the whole hub (record-handlers.ts states the constraint).
  return deps.db.transaction(async (tx) => {
    const own = await ownClaimIds(
      tx,
      developerId,
      report.entries.map((entry) => entry.claimId),
    );
    const unbound = await unboundClaimIds(
      tx,
      report.entries.map((entry) => entry.claimId),
    );
    let recorded = 0;
    let refusedDowngrades = 0;
    let refusedUnbound = 0;
    for (const entry of report.entries) {
      // §8.5 BEFORE THE WRITE, not above the read. A claim with no commit
      // binding has nothing to be unchanged SINCE, so there is no reading to
      // store — and storing one puts a row in the table whose only defence is
      // that the one current reader happens to check the binding first.
      if (unbound.has(entry.claimId)) {
        refusedUnbound += 1;
        continue;
      }

      const written = await tx
        .insert(claimRevalidations)
        .values({
          claimId: entry.claimId,
          result: entry.result,
          basis: entry.basis,
          refCommit: entry.refCommit,
          touchingCommits: entry.touchingCommits,
          touchingTotal: entry.touchingTotal,
          revalidatedAt: now,
          reportedBy: developerId,
          // Stored so the RENDER can say who measured it. Refusal 6 accepted
          // the self-certification residue on the premise that `unknown` and
          // `current` are indistinguishable to a reader — true of §5's gate
          // and false of the label, which flips to the strongest word in the
          // vocabulary. The residue stays (a git reading is reproducible from
          // any clone, which is §3.7's whole trust argument); what changes is
          // that it is no longer invisible.
          selfReported: own.has(entry.claimId),
        })
        .onConflictDoUpdate({
          target: claimRevalidations.claimId,
          set: {
            result: sql`excluded.result`,
            basis: sql`excluded.basis`,
            refCommit: sql`excluded.ref_commit`,
            touchingCommits: sql`excluded.touching_commits`,
            touchingTotal: sql`excluded.touching_total`,
            revalidatedAt: sql`excluded.revalidated_at`,
            reportedBy: sql`excluded.reported_by`,
          },
          // THE RULE. A stored "changed" is only ever replaced by another
          // "changed"; every other stored value may move in any direction.
          setWhere: sql`${claimRevalidations.result} <> 'changed' OR excluded.result = 'changed'`,
        })
        .returning({ claimId: claimRevalidations.claimId });
      if (written[0] !== undefined) {
        recorded += 1;
        continue;
      }
      // The write did not land. Two causes, and only one is a refusal: the
      // setWhere blocked a downgrade, or the row is byte-identical to what is
      // already stored and Postgres still reports no RETURNING row on a
      // no-op. Asking which keeps the printed number meaningful.
      const blocked = await tx
        .select({ claimId: claimRevalidations.claimId })
        .from(claimRevalidations)
        .where(
          and(
            eq(claimRevalidations.claimId, entry.claimId),
            eq(claimRevalidations.result, "changed"),
          ),
        )
        .limit(1);
      if (blocked[0] !== undefined && entry.result !== "changed") {
        refusedDowngrades += 1;
        // PERSISTED, because the response is read by exactly one audience:
        // the caller whose report was refused. CCB-10 requires the refusal to
        // be counted and printed by DOCTOR, so a team lead can tell a hub
        // refusing forged upgrades every hour from one that has never seen
        // one — which the response alone could never do.
        await tx
          .update(claimRevalidations)
          .set({ refusedWalkBacks: sql`${claimRevalidations.refusedWalkBacks} + 1` })
          .where(eq(claimRevalidations.claimId, entry.claimId));
      }
    }
    // RETENTION RUNS LAST, AND NEVER OVER A MEASURED DOWNGRADE.
    //
    // It used to run FIRST, unconditionally, across the whole table — so the
    // downgrade-only rule, which fires only on a CONFLICT, never fired at
    // all once a `changed` row had aged past the cutoff. The prune deleted
    // it, the entry landed as a plain INSERT, and a claim its own author had
    // been refused on went from `stale` to `current` in one request. The
    // response then reported `refusedDowngrades: 0`, so the counter that
    // exists to make the refusal visible reported success, and the commits
    // that justified the downgrade were deleted with the row.
    //
    // The ordering alone does not close it, and the deeper half is the
    // reason this clause reads the way it does. A `changed` row is the
    // POSITIVE PROOF that a claim stopped describing the code. Deleting it
    // returns the claim to `unknown` — which §5's gate admits to the
    // unsolicited substance lane — so the deletion STRENGTHENS the claim's
    // standing. That is principle 5 inverted (missing evidence strengthening
    // a conclusion) and principle 6 broken (deletion without positive proof
    // to delete), on a timer, whatever the code actually did.
    //
    // So age retires an `unchanged` or an `unknown` reading — neither
    // carries a downgrade, and a stale "we looked and nothing had moved" is
    // exactly the kind of evidence that should expire. A `changed` reading
    // is retired only by positive proof: its claim is gone, so nothing can
    // reference the row any more.
    const pruned = await tx
      .delete(claimRevalidations)
      .where(
        and(
          lt(claimRevalidations.revalidatedAt, retentionCutoff),
          or(
            ne(claimRevalidations.result, "changed"),
            notExists(
              tx
                .select({ id: claims.id })
                .from(claims)
                .where(eq(claims.id, claimRevalidations.claimId)),
            ),
          ),
        ),
      )
      .returning({ claimId: claimRevalidations.claimId });
    return {
      recorded,
      refusedDowngrades,
      refusedUnbound,
      pruned: pruned.length,
      // Read back INSIDE the same transaction: a validity derived from a
      // second connection could reflect a write this one has not committed.
      validities: await loadClaimValidities(
        tx,
        now,
        report.entries.map((entry) => entry.claimId),
      ),
    };
  });
};
