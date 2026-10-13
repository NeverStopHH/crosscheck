/**
 * A RUN OF TARGETS IN A FEW STATEMENTS (release gate on ubuntu-latest,
 * 2026-10-13). A flush is mostly targets — a resumed life re-files its root
 * as two batches of 99 — and each one cost its own owner read, insert, doc
 * rebuild, event write, guarantee checks and receipt: about fifteen
 * statements, 318 ms for 99 on a laptop and past the connector's 400 ms
 * request bound on a hosted runner, where the connector abandoned a batch
 * the hub then stored. Consecutive targets of one flush are taken here as one
 * run (services/records.ts): one read of their owners, one insert, one
 * re-touch update per occurrence round, one doc rebuild per context and one
 * event write for the run (services/session-events.ts recordSessionEvents).
 *
 * EACH TARGET IS ANSWERED AS IT WAS ALONE, in the order sent: the first touch
 * of a (context, kind, value) is `accepted`, every later one — already on the
 * hub, or earlier in this run — a `duplicate` that re-touches the row, and a
 * context that is not there or not the sender's is a refusal for that record
 * only (spool semantics: partial success).
 */
import { eq, inArray, sql } from "drizzle-orm";
import { canonicalRepoPath } from "@crosscheck/schema";
import type { GeneratedSignal, SeqField, Target } from "@crosscheck/schema";

import { agentSessions, workContexts, workContextTargets } from "../db/schema.ts";
import type { DbExecutor } from "../db/client.ts";
import type { Clock } from "../types.ts";
import { hubGeneratedSignal } from "./generated-targets.ts";
import { refreshNormalizedDoc } from "./normalized-doc.ts";
import { TARGET_EVENT_KINDS, rejectedOutcome, seqKindFor } from "./record-handlers.ts";
import type { HandlerOutcome } from "./record-handlers.ts";
import { recordSessionEvents, targetDigest } from "./session-events.ts";
import type { RecordSessionEventInput } from "./session-events.ts";
import { touchFileRef } from "./skeleton-identity.ts";

interface Deps {
  readonly db: DbExecutor;
  readonly now: Clock;
}

/** One target record of the run, as parsed: its body and the position its envelope carried. */
export interface TargetRunItem {
  readonly body: Target;
  readonly seq: SeqField | undefined;
}

/**
 * The owner AND the session of a work context. The session half is what keeps
 * a position out of the wrong sequence: a `target` body carries only a
 * workContextId, and `producer.sessionId` is rewritten to the FLUSHING session
 * by every spool drain, so the context's own session is the only honest answer
 * to "whose order does this edit belong to".
 */
interface Owner {
  readonly developerId: string;
  readonly sessionId: string;
  readonly repo: string;
}

/** Every work context the run names, with its owner, in one read. */
const ownersOf = async (db: DbExecutor, ids: ReadonlySet<string>): Promise<ReadonlyMap<string, Owner>> => {
  if (ids.size === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      id: workContexts.id,
      developerId: agentSessions.developerId,
      sessionId: workContexts.sessionId,
      repo: agentSessions.repo,
    })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(inArray(workContexts.id, [...ids]));
  return new Map(rows.map((row) => [row.id, { developerId: row.developerId, sessionId: row.sessionId, repo: row.repo }]));
};

/** A file target's value in its one spelling, or as sent when it has none (01a §3.3d). */
const canonicalFileValue = (raw: string): string => {
  const canonical = canonicalRepoPath(raw);
  return canonical.ok ? canonical.path : raw;
};

/** A target the run will store: its owner, its stored value and label, and the row it is. */
interface Placed {
  readonly body: Target;
  readonly seq: SeqField | undefined;
  readonly owner: Owner;
  readonly value: string;
  readonly generated: GeneratedSignal | null;
  readonly key: string;
}

const place = (body: Target, seq: SeqField | undefined, owner: Owner): Placed => {
  // ONE SPELLING PER FILE (01a §3.3d). `suspect` and the retention graph join
  // a pin to a touch by exact string, so a connector that sent `./src/x.ts`
  // would otherwise be a touch no pin ever meets — an exoneration produced by
  // a spelling. A value that cannot be made canonical is KEPT as sent: a
  // touch is evidence, and dropping it would be deciding the question it
  // exists to answer.
  const value = body.kind === "file" ? canonicalFileValue(body.value) : body.value;
  // THE GENERATED-TARGET LABEL (services/generated-targets.ts): the
  // connector's, or the path signal applied here to a target that carries
  // none — so an older connector's nested lockfile is labelled all the same —
  // and never one for a target the connector marked authoritative. Stored,
  // never a reason to refuse or drop: the touch is kept either way.
  const generated = hubGeneratedSignal(body.kind, value, body.generated, body.authoritative);
  return { body, seq, owner, value, generated, key: `${body.workContextId}\n${body.kind}\n${value}` };
};

/** The run's first sightings of rows not yet stored, inserted at once: the keys that went in. */
const insertFirsts = async (deps: Deps, firsts: readonly Placed[]): Promise<ReadonlySet<string>> => {
  if (firsts.length === 0) {
    return new Set();
  }
  const inserted = await deps.db
    .insert(workContextTargets)
    .values(
      firsts.map((placed) => ({
        workContextId: placed.body.workContextId,
        kind: placed.body.kind,
        value: placed.value,
        source: placed.body.source,
        generated: placed.generated,
        // First-seen age for the targets-only pointer (#19). onConflictDoNothing
        // below means a duplicate touch never bumps it — the honest age.
        // `last_seen_at` stays null until the first re-touch (below); every
        // window reads greatest(created_at, last_seen_at) or coalesce(…), so a
        // first touch counts by its created_at.
        createdAt: deps.now(),
      })),
    )
    .onConflictDoNothing()
    .returning({ workContextId: workContextTargets.workContextId, kind: workContextTargets.kind, value: workContextTargets.value });
  return new Set(inserted.map((row) => `${row.workContextId}\n${row.kind}\n${row.value}`));
};

/**
 * THE RE-TOUCH, one statement for every row a round touches again (pilot
 * finding, 2026-10-05): `last_seen_at` moves to now and, only when the OTHER
 * lane saw it, the label is upgraded to "both" — the primary key collapses
 * the two observations into one row, and without this the lane that arrived
 * first would silently own the label and `suspect` would report a second
 * source as dead. First-seen stays where it was. The topic branch's session
 * windows read the same instant (DESIGN.md "One session, many topics").
 *
 * "both" is the TOOL lane and A GIT lane: two git lanes sighting one file (a
 * change, then its commit) are still one kind of observer, and the label must
 * not claim an Edit nobody reported (DESIGN.md "One session, many topics"
 * added `git_commit` beside `git_diff`).
 *
 * THE GENERATED LABEL IS THE LATEST TOUCH'S: a classification that could not
 * run this time sends none, and the row turns ordinary again rather than
 * staying silenced on an answer nobody can repeat — toward warning.
 *
 * A round names each row once; the run's second sighting of a row is the next
 * round's, so it re-touches after the first, as it did one record at a time.
 */
const retouch = async (deps: Deps, round: readonly Placed[]): Promise<void> => {
  if (round.length === 0) {
    return;
  }
  const rows = sql.join(
    round.map(
      (placed) =>
        sql`(${placed.body.workContextId}::text, ${placed.body.kind}::text, ${placed.value}::text,
             ${placed.body.source}::text, ${placed.generated}::text)`,
    ),
    sql`, `,
  );
  await deps.db.execute(sql`
    UPDATE work_context_targets AS t
       SET last_seen_at = ${deps.now()},
           source = case when ((t.source = 'tool_edit') <> (v.source = 'tool_edit')) and t.source NOT IN (v.source, 'both') then 'both' else t.source end,
           generated = v.generated
      FROM (VALUES ${rows}) AS v(work_context_id, kind, value, source, generated)
     WHERE t.work_context_id = v.work_context_id AND t.kind = v.kind AND t.value = v.value`);
};

/**
 * PROJECTED FOR EVERY STORED TOUCH, accepted AND duplicate. The git lane's
 * `file.modified` for a file the tool lane already saw arrives as a duplicate
 * — the primary key collapses the two observations into one target row — and
 * that second observation is exactly the one a happens-before question cares
 * about. Writing the event only on `accepted` would leave `seq_kind =
 * observed` a value no real row ever carries.
 */
const eventOf = (placed: Placed): RecordSessionEventInput | null => {
  const { body, owner, value, seq } = placed;
  const eventKind = TARGET_EVENT_KINDS[body.kind as keyof typeof TARGET_EVENT_KINDS];
  if (eventKind === undefined) {
    return null;
  }
  return {
    sessionId: owner.sessionId,
    kind: eventKind,
    seq,
    seqKind: seqKindFor(body.source, seq),
    refKind: "target_digest",
    refId: targetDigest(body.workContextId, body.kind, value),
    workContextId: body.workContextId,
    // THE FILE, in the identity a pin's history is written in (01a §3.3d):
    // the SESSION's repo and the canonical path, computed here on the hub
    // so two developers' connectors cannot disagree about it.
    ...(body.kind === "file" ? { fileRef: touchFileRef(owner.repo, value) } : {}),
  };
};

const isPlaced = (entry: Placed | HandlerOutcome): entry is Placed => "key" in entry;

/**
 * Stores a run of target records and answers each, in order. No per-target
 * event goes to the outbox: a busy session emits dozens of targets and would
 * flood it, drowning the signals SSE consumers care about.
 */
export const ingestTargetRun = async (
  deps: Deps,
  developerId: string,
  items: readonly TargetRunItem[],
): Promise<readonly HandlerOutcome[]> => {
  const owners = await ownersOf(deps.db, new Set(items.map((item) => item.body.workContextId)));
  const entries = items.map((item): Placed | HandlerOutcome => {
    const owner = owners.get(item.body.workContextId);
    if (owner === undefined) {
      return rejectedOutcome(`workContextId: work context "${item.body.workContextId}" not found`);
    }
    if (owner.developerId !== developerId) {
      return rejectedOutcome("workContextId: work context belongs to another developer");
    }
    return place(item.body, item.seq, owner);
  });
  const placed = entries.filter(isPlaced);
  // Each sighting's round: how many sightings of its row came before it in this run.
  const seen = new Map<string, number>();
  const rounds = placed.map((entry) => {
    const round = seen.get(entry.key) ?? 0;
    seen.set(entry.key, round + 1);
    return round;
  });
  const firsts = placed.filter((_, at) => rounds[at] === 0);
  const inserted = await insertFirsts(deps, firsts);
  const isAccepted = (entry: Placed, at: number): boolean => rounds[at] === 0 && inserted.has(entry.key);
  const lastRound = Math.max(-1, ...rounds);
  for (let round = 0; round <= lastRound; round += 1) {
    await retouch(deps, placed.filter((entry, at) => rounds[at] === round && !isAccepted(entry, at)));
  }
  // The doc regenerates so the new target values are searchable — once per
  // context the run added to. Not in a transaction with the insert: a crash
  // between the two leaves a doc short until the next ingest touches the
  // context — self-healing, and the records themselves are already durable.
  const grown = new Set(placed.filter(isAccepted).map((entry) => entry.body.workContextId));
  for (const workContextId of grown) {
    await refreshNormalizedDoc(deps.db, workContextId);
  }
  await recordSessionEvents(deps, placed.flatMap((entry) => {
    const event = eventOf(entry);
    return event === null ? [] : [event];
  }));
  const answers = new Map(placed.map((entry, at) => [entry, isAccepted(entry, at)]));
  return entries.map((entry): HandlerOutcome =>
    !isPlaced(entry) ? entry : answers.get(entry) === true ? { status: "accepted" } : { status: "duplicate" },
  );
};
