import { and, eq, inArray, sql } from "drizzle-orm";
import {
  MAX_INTENT_CHAIN_VERSIONS,
  containsSecret,
  isBindableCommit,
  isSeqStamp,
} from "@crosscheck/schema";
import type {
  Claim,
  ClaimCommitBinding,
  ClaimEdge,
  Intent,
  SeqField,
  SeqKind,
  Target,
  WorkContext,
} from "@crosscheck/schema";

import { EVENT_KINDS } from "../constants.ts";
import {
  agentSessions,
  claimEdges,
  claimSurfaces,
  claims,
  workContexts,
  workContextTargets,
} from "../db/schema.ts";
import { appendEvent } from "./events.ts";
import { appendIntentVersion } from "./intent-ledger.ts";
import { refreshNormalizedDoc } from "./normalized-doc.ts";
import {
  recordSessionEvent,
  targetDigest,
  windowFloorOf,
} from "./session-events.ts";
import {
  DECLARED_PROVENANCE,
  applyCrossSimilarity,
  embedClaimBody,
  findSimilarOwnClaim,
} from "./similarity-gate.ts";
import type { Db, DbExecutor } from "../db/client.ts";
import type { Embedder } from "./embedder.ts";
import type { Clock } from "../types.ts";

interface Deps {
  readonly db: Db;
  readonly now: Clock;
  /** Optional so handler unit tests without a vector tier stay minimal. */
  readonly embedder?: Embedder | null;
}

/** Handler dependencies bound to an open transaction (or the root db). */
interface ExecutorDeps {
  readonly db: DbExecutor;
  readonly now: Clock;
}

export type RecordStatus = "accepted" | "duplicate" | "ignored" | "rejected";

export interface HandlerOutcome {
  readonly status: RecordStatus;
  readonly id?: string;
  readonly issues?: readonly string[];
}

export const rejectedOutcome = (issue: string): HandlerOutcome => ({
  status: "rejected",
  issues: [issue],
});

const accepted = (id?: string): HandlerOutcome => ({
  status: "accepted",
  ...(id === undefined ? {} : { id }),
});

const duplicate = (id?: string): HandlerOutcome => ({
  status: "duplicate",
  ...(id === undefined ? {} : { id }),
});

/**
 * THE RECORD SURVIVED; THE CHANGE INSIDE IT DID NOT.
 *
 * `ignored` has always been a first-class outcome of this endpoint and the
 * work-context path had no constructor for it, so the only way to refuse a
 * change here was `rejected` — which DESTROYS the record, because the
 * connector's flush advances its spool cursor on any 2xx and a refused batch
 * is a delivered batch as far as the spool is concerned.
 *
 * THE ISSUE IS NOT OPTIONAL. An ignored record with nothing to read is a
 * silent drop, and the author would go looking for their sentence on their own
 * work context and find the previous one with no explanation anywhere.
 */
const ignored = (id: string, issue: string): HandlerOutcome => ({
  status: "ignored",
  id,
  issues: [issue],
});

/**
 * THE HUB SCREENS WHAT ONLY THE HUB SEES EVERY WRITER OF.
 *
 * `set_intent` screens its `summary` before anything leaves the machine, and
 * that is the right place for it — a hit means the record never travels. But
 * spec 06 added two more agent-written text fields, an amendment `reason` and
 * every `intent_scope.value`, and NEITHER the tool nor the hub looked at
 * them. Measured against a real hub: a `reason` reading
 * "ZQXMARK5 AKIA…" and a scope value carrying a `ghp_` token were both
 * accepted, stored, and rendered into every reader of that work context —
 * the scope value OUTSIDE the quoting frame.
 *
 * The repo's rule is "one helper, every writer" (capture-bookkeeping.ts). The
 * connector is not every writer: anything posting to `/api/records` reaches
 * these fields without passing a tool. So the screen is here as well, where
 * every writer does pass, and the scanner moved to `schema` so both sides
 * share one definition rather than two that can drift.
 *
 * REFUSED, NOT REDACTED. A redacted derivative still leaks structure, and the
 * author has to learn that the sentence did not land — silently storing a
 * blanked one would tell them it did.
 */
const INTENT_SECRET_ISSUE =
  "intent: a credential-shaped value was found in the amendment reason or a " +
  "declared path, so this intent was not recorded — an intent is pushed into " +
  "every teammate's reader unasked, and a redacted copy still leaks structure";

/** Every agent-written text field an intent carries, for the screen above. */
const intentTexts = (intent: Intent): readonly string[] => {
  const raw = intent as Record<string, unknown>;
  const reason = typeof raw["reason"] === "string" ? [raw["reason"]] : [];
  const scope = (["expectedSurface", "nonGoals"] as const).flatMap((key) => {
    const declared = raw[key];
    return Array.isArray(declared)
      ? declared.flatMap((entry: unknown) => {
          const value = (entry as Record<string, unknown> | null)?.["value"];
          return typeof value === "string" ? [value] : [];
        })
      : [];
  });
  // The summary is screened at the tool and screened again here: a second
  // writer that skips the tool is exactly the door this closes.
  return [intent.summary, ...reason, ...scope];
};

/**
 * What the author reads when the chain is full. It names the bound, because
 * "not recorded" without a number reads like a failure rather than a limit.
 */
export const INTENT_CAP_ISSUE =
  `intent: this work context already holds the ${String(MAX_INTENT_CHAIN_VERSIONS)} intent ` +
  "versions the ledger keeps, so this sentence was not recorded and the stored " +
  "intent is unchanged — open a new work context to state a new goal";

const resolveSessionOwner = async (
  db: DbExecutor,
  sessionId: string,
): Promise<string | undefined> => {
  const rows = await db
    .select({ developerId: agentSessions.developerId })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  return rows[0]?.developerId;
};

/**
 * The owner AND the session of a work context in one lookup.
 *
 * The session half is what keeps a position out of the wrong sequence: a
 * `target` body carries only a workContextId, and `producer.sessionId` is
 * rewritten to the FLUSHING session by every spool drain, so the context's own
 * session is the only honest answer to "whose order does this edit belong to".
 */
const resolveWorkContextOwner = async (
  db: DbExecutor,
  workContextId: string,
): Promise<
  { readonly developerId: string; readonly sessionId: string } | undefined
> => {
  const rows = await db
    .select({
      developerId: agentSessions.developerId,
      sessionId: workContexts.sessionId,
    })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(eq(workContexts.id, workContextId))
    .limit(1);
  return rows[0];
};

// Deliberately does not check endedAt: author sessions MAY already be ended —
// a spool flush from a successor session is legitimate. Only the producer
// session must be live (enforced by checkProducerSession in records.ts).
// Exported for the hint-delivery handler, which asks the identical question
// about the RECEIVING session (services/hint-deliveries.ts).
export const checkOwnedSession = async (
  db: DbExecutor,
  developerId: string,
  sessionId: string,
  field: string,
): Promise<string | null> => {
  const ownerId = await resolveSessionOwner(db, sessionId);
  if (ownerId === undefined) {
    return `${field}: session "${sessionId}" not found`;
  }
  if (ownerId !== developerId) {
    return `${field}: session belongs to another developer`;
  }
  return null;
};

/**
 * WHICH COMMIT A CLAIM IS BOUND TO, decided at INSERT and never revisited
 * (1.0 spec 02 §3.1). Three outcomes, in this order:
 *
 *   reported      — the emitter sent its own HEAD. The wire schema has already
 *                   held it to COMMIT_SHA_PATTERN.
 *   session_base  — nothing on the wire, so the author session's base_commit
 *                   stands in.
 *   none          — that base_commit is not an object name.
 *
 * THE PATTERN TEST ON THE FALLBACK IS LOAD-BEARING, and it is not paranoia
 * about a hostile caller. `agent_sessions.base_commit` is `text NOT NULL` and
 * `SessionSchema.baseCommit` is `z.string().min(1)`, so any non-empty string
 * is stored — and one is, by this repo's own CLI: `crosscheck conference`
 * registers with the literal "conference" (cli/src/cli/conference.ts), and
 * resolveRepoIdentity falls back to NO_COMMIT_SHA when git cannot name HEAD.
 * The placeholder is SEVEN HEX CHARACTERS, so the pattern alone accepts it —
 * `isBindableCommit` is the predicate that refuses both, in one place.
 *
 * `session_base` IS AN APPROXIMATION IN BOTH DIRECTIONS, stated here because
 * the tempting sentence — "a lower bound, so the claim goes stale early, the
 * safe direction" — is measurably false. registerSession UPDATEs base_commit
 * on every re-registration (services/sessions.ts, under its own comment
 * "Branch and base commit may still move — checkouts are normal"), and a
 * PostToolUse recovery or a SessionStart re-fire re-registers mid-session with
 * the CURRENT HEAD. This function reads the row at FLUSH time, so the value
 * can be a commit LATER than the observation, which NARROWS the revalidation
 * window and makes the claim read fresher than it is. That is why
 * `commit_binding` is stored beside the sha rather than thrown away: a reader
 * can tell an emitter's own answer from ingest's guess.
 */
const resolveCommitBinding = async (
  db: DbExecutor,
  body: Claim,
): Promise<{
  readonly observedAtCommit: string | null;
  readonly commitBinding: ClaimCommitBinding;
  /** The author session's repo — what claim_surfaces rows are keyed by. */
  readonly repo: string;
}> => {
  // ONE lookup whatever the branch: the repo is needed for claim_surfaces
  // even when the commit came in on the wire.
  const rows = await db
    .select({ baseCommit: agentSessions.baseCommit, repo: agentSessions.repo })
    .from(agentSessions)
    .where(eq(agentSessions.id, body.authorSessionId))
    .limit(1);
  const repo = rows[0]?.repo ?? "";
  // THE REPORTED VALUE IS HELD TO THE SAME PREDICATE AS THE FALLBACK. The wire
  // schema only proves it looks like an object name, and NO_COMMIT_SHA is
  // seven hex characters — so a connector in a repository with no commits
  // reports the placeholder and it would otherwise be filed as a precise
  // observation point that git can never resolve.
  const reported = body.observedAtCommit;
  if (reported !== undefined && isBindableCommit(reported)) {
    return { observedAtCommit: reported, commitBinding: "reported", repo };
  }
  if (reported !== undefined) {
    return { observedAtCommit: null, commitBinding: "none", repo };
  }
  const baseCommit = rows[0]?.baseCommit ?? "";
  return isBindableCommit(baseCommit)
    ? { observedAtCommit: baseCommit, commitBinding: "session_base", repo }
    : { observedAtCommit: null, commitBinding: "none", repo };
};

type WorkContextRow = typeof workContexts.$inferSelect;

/**
 * The intent MERGE rule (trial finding #16). Title, status and description
 * keep replace semantics — every registration re-sends them — but an intent
 * is captured ONCE and a later work_context record usually carries none
 * (SessionStart re-fire on `--resume`, the mid-session recovery, Cursor's
 * late registration): `body.intent ?? null` wiped it on every such record.
 * So: a record WITHOUT the field keeps the stored intent; a record WITH one
 * replaces it — except that a DERIVED intent never overwrites a DECLARED one
 * (a late-flushed derived spool record must not undo `set_intent`; declared
 * over declared is the re-declare supersede). Hub-enforced, because spool
 * replay order is nobody's promise.
 */
const mergeIntent = (
  current: Record<string, unknown> | null,
  next: Intent | undefined,
): Record<string, unknown> | null => {
  if (next === undefined) {
    return current;
  }
  if (
    current !== null &&
    current["provenance"] === DECLARED_PROVENANCE &&
    next.provenance !== DECLARED_PROVENANCE
  ) {
    return current;
  }
  return next;
};

const workContextChanges = (
  current: WorkContextRow,
  body: WorkContext,
): Partial<WorkContextRow> | null => {
  const next = {
    title: body.title,
    description: body.description ?? null,
    intent: mergeIntent(current.intent ?? null, body.intent),
    status: body.status,
  };
  // Accepted v0 limitation: JSON.stringify intent comparison is key-order
  // sensitive, so a semantically equal intent with reordered keys counts as
  // a change and triggers a harmless no-op-ish update.
  const hasChange =
    next.title !== current.title ||
    next.description !== current.description ||
    JSON.stringify(next.intent) !== JSON.stringify(current.intent) ||
    next.status !== current.status;
  return hasChange ? next : null;
};

const updateExistingWorkContext = async (
  deps: ExecutorDeps,
  developerId: string,
  body: WorkContext,
  seq: SeqField | undefined,
): Promise<HandlerOutcome> => {
  const rows = await deps.db
    .select({ workContext: workContexts, ownerId: agentSessions.developerId })
    .from(workContexts)
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(eq(workContexts.id, body.id))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("work context insert conflicted but row was not found");
  }
  if (row.ownerId !== developerId) {
    return rejectedOutcome("id: work context belongs to another developer");
  }
  const changes = workContextChanges(row.workContext, body);
  if (changes === null) {
    return duplicate(body.id);
  }
  // THE LEDGER IS WRITTEN BEFORE THE HEAD, AND THE HEAD BECOMES A COPY OF WHAT
  // THE LEDGER STORED. Writing the head from `changes` instead would let the
  // two disagree the moment the hub stamps anything the body did not carry —
  // which it now does, for the position and for `amends_version`.
  //
  // `mergeIntent` DECIDES WHETHER THERE IS AN INTENT CHANGE AT ALL, and a
  // refused merge appends nothing: a derived intent arriving behind a declared
  // one is not intent evolution, and recording it would put a model sentence
  // nobody accepted within reach of every renderer.
  const appended =
    changes.intent === undefined ||
    changes.intent === null ||
    JSON.stringify(changes.intent) === JSON.stringify(row.workContext.intent)
      ? null
      : await appendIntentVersion(deps, {
          workContextId: body.id,
          // THE SESSION THAT WROTE IT, NOT THE ONE THAT OPENED THE CONTEXT.
          // This read `row.workContext.sessionId` — the CREATING session — so
          // a second session of the same developer had its sentence filed
          // under the first session's name. The ownership check above cannot
          // catch that: it is developer-scoped and never asks which SESSION
          // is writing.
          //
          // The direction is what makes it serious. Step 3 of the ladder
          // keeps an entry only while `authorSessionId === edit.event
          // .sessionId`, so a misfiled row becomes COMPARABLE with edits it
          // has no relation to, and a comparable pair can answer
          // `predeclared` — the value that exonerates. Filed honestly the
          // same pair answers `absent / different_session`, which is the
          // truth: there is no cross-session order to have. The create path
          // one branch over already used `body.sessionId`; this is that rule,
          // applied where it was missing.
          authorSessionId: body.sessionId,
          intent: changes.intent as Intent,
          seq,
        });
  // A CAPPED APPEND LEAVES THE HEAD EXACTLY WHERE IT WAS, stated rather than
  // implied: falling through to `changes` here would move the head to a
  // sentence the ledger refused to store, so `max(version)` would name one
  // sentence and `work_contexts.intent` would show another — and the head
  // would lose the hub-stamped position and `amends_version` it had, since
  // the body never carries either. Every other field on the record still
  // lands; only the intent stays put.
  const stored =
    appended === null
      ? changes
      : appended.capped
        ? { ...changes, intent: row.workContext.intent }
        // THE HEAD, NOT THE WHOLE RECORD. §8.6 keeps the chain off every
        // unsolicited surface, and this jsonb is projected WHOLE into
        // presence, search, suspect, conference, hints and ghost-overlap —
        // so a head that copied the wire carried the amendment reason and
        // the declared scope onto all of them in payload.
        : { ...changes, intent: appended.headWire };
  // session_id stays the creating session — updates never re-home a context.
  await deps.db
    .update(workContexts)
    .set({ ...stored, updatedAt: deps.now() })
    .where(eq(workContexts.id, body.id));
  await refreshNormalizedDoc(deps.db, body.id);
  // Outbox discipline: ids and metadata only — WHICH fields changed, never
  // their text (the feed phrases "intent" from the list, no summary crosses).
  await appendEvent(deps, EVENT_KINDS.WORK_CONTEXT_UPDATED, {
    workContextId: body.id,
    developerId,
    changed: Object.entries(stored)
      .filter(([field, value]) => value !== row.workContext[field as keyof WorkContextRow])
      .map(([field]) => field),
  });
  // THE CAP IS REPORTED, NOT SWALLOWED. Every other field on this record did
  // land — the title, the status, the description — so the record is not
  // rejected; the one thing that did not land is named, and the outcome says
  // `ignored` rather than `accepted` so a connector can tell its author.
  return appended !== null && appended.capped
    ? ignored(body.id, INTENT_CAP_ISSUE)
    : accepted(body.id);
};

export const ingestWorkContext = async (
  deps: Deps,
  developerId: string,
  body: WorkContext,
  seq?: SeqField,
): Promise<HandlerOutcome> => {
  // One transaction so the conflict probe, the ownership check, and the
  // update all act on the same snapshot — no TOCTOU between them.
  // Context-doc embedding happens ONCE PER FLUSH in ingestRecords, not here:
  // a batch touching one context must not re-embed it per record.
  return deps.db.transaction(async (tx) => {
    const txDeps: ExecutorDeps = { db: tx, now: deps.now };
    const sessionIssue = await checkOwnedSession(
      tx,
      developerId,
      body.sessionId,
      "sessionId",
    );
    if (sessionIssue !== null) {
      return rejectedOutcome(sessionIssue);
    }
    // BEFORE ANYTHING IS STORED, and before either path branches: this is the
    // one point both the create and the update pass through, so one check
    // here cannot be bypassed by whichever path a record happens to take.
    if (
      body.intent !== undefined &&
      body.intent !== null &&
      intentTexts(body.intent).some((text) => containsSecret(text))
    ) {
      return rejectedOutcome(INTENT_SECRET_ISSUE);
    }
    const inserted = await tx
      .insert(workContexts)
      .values({
        id: body.id,
        sessionId: body.sessionId,
        title: body.title,
        description: body.description ?? null,
        intent: body.intent ?? null,
        status: body.status,
        createdAt: new Date(body.createdAt),
        updatedAt:
          body.updatedAt === undefined ? null : new Date(body.updatedAt),
      })
      .onConflictDoNothing()
      .returning({ id: workContexts.id });
    if (inserted[0] === undefined) {
      return updateExistingWorkContext(txDeps, developerId, body, seq);
    }
    // THE FIRST VERSION CAN BE BORN ON THIS PATH, and an UPDATE-only ledger
    // would miss it. `set_intent` posts DIRECTLY over HTTP while the
    // work-context create travels via the SPOOL, so a set_intent issued before
    // the session's first flush reaches the hub first and CREATES the context
    // already carrying an intent. `workContextChanges` never runs on that
    // record, so appending only where it reports a change leaves that sentence
    // outside the ledger entirely: the head reads v1 and max(version) says
    // nothing at all.
    if (body.intent !== undefined) {
      const appended = await appendIntentVersion(txDeps, {
        workContextId: body.id,
        authorSessionId: body.sessionId,
        intent: body.intent,
        seq,
      });
      await tx
        .update(workContexts)
        // THE HEAD PROJECTION, on this path too. The update path was fixed to
        // store `headWire` and this one still stored the whole wire record —
        // the same §8.6 leak on the path that runs when `set_intent` beats the
        // spool, which is the ORDINARY case for a session that declares its
        // intent before its first flush. `work_contexts.intent` is projected
        // whole to presence, search, suspect, hints and ghost-overlap, so the
        // amendment reason and the declared scope travelled every unsolicited
        // surface from here while the other path was clean.
        .set({ intent: appended.headWire })
        .where(eq(workContexts.id, body.id));
    }
    await refreshNormalizedDoc(tx, body.id);
    await appendEvent(txDeps, EVENT_KINDS.WORK_CONTEXT_CREATED, {
      workContextId: body.id,
      sessionId: body.sessionId,
      developerId,
    });
    return accepted(body.id);
  });
};

/**
 * THE TWO CANONICAL NAMES A TARGET PROJECTS TO, and the two it does not.
 * `symbol` and `component` are target kinds no 1.0 event name covers, and
 * inventing one for them would put a word in the shared vocabulary that means
 * nothing on any host.
 */
const TARGET_EVENT_KINDS = {
  file: "file.modified",
  error_fingerprint: "tool.failed",
} as const;

/**
 * WHICH LANE'S POSITION THIS IS (spec 01 §3.2), derived here and never sent —
 * a connector that could choose its own `seq_kind` could promote an upper
 * bound to a happens-before.
 *
 * `tool_edit` is EMITTED ONLY WHEN THE EMITTER BRACKETED ITS TOOL, and the
 * first draft of this map got that wrong in the one direction that matters.
 * The host reports the edit, but the position is taken AFTERWARDS, in the hook
 * that runs once the tool has returned — so on its own it is an upper bound on
 * a change that already happened, and any emitter that allocated inside that
 * window holds a LOWER position than the edit. Comparing the numbers then
 * reports the explanation as predeclared, the value that exonerates, in the
 * one shape AT-4 exists to detect. Measured: an Edit and an MCP publish issued
 * in ONE parallel tool batch inverted 10 trials out of 10.
 * A bracketing emitter sends the position it took BEFORE starting the tool
 * (`seq.after`), which turns the upper bound back into an interval a
 * happens-before question may be asked of. An emitter that cannot send one —
 * a host with no pre-tool signal, a hook installed mid-tool — gets `observed`,
 * the upper bound it actually has, and the refusal that goes with it. THE
 * CONNECTOR STILL CHOOSES NOTHING: omitting the bracket can only downgrade.
 * `git_diff` is OBSERVED: the Stop-time lane sees the working tree at the end
 * of a turn and cannot say when inside it `sed -i`, a codemod or a generator
 * touched the file — and it cannot see work COMMITTED during the turn or
 * UNTRACKED new files at all.
 * `both` is EMITTED and is a STORED label only — no connector sends it
 * (STORED_TARGET_SOURCES), so this entry exists for completeness. The mapping
 * is read off THIS RECORD's source rather than off the stored row's upgraded
 * label, because each event is ONE OBSERVATION: when the git lane later sights
 * a file the tool lane already reported, the row becomes "both" while that
 * second event is still an upper bound, and stamping it emitted would let a
 * happens-before question answer from a position that cannot support one.
 */
const SEQ_KIND_BY_SOURCE = {
  tool_edit: "emitted",
  git_diff: "observed",
  both: "emitted",
} as const;

/**
 * The lane's own answer, downgraded to the upper bound it really is when the
 * emitter sent no usable bracket. `git_diff` is `observed` either way — that
 * lane sees a working tree at the end of a turn and has no window at all.
 *
 * EXPORTED for the connector tests that assert on `compareEvents`: an
 * unbracketed tool-lane position is refused because it is stored `observed`,
 * and a test that restated that rule instead of asking THIS function could
 * pass while the hub's own answer changed underneath it.
 */
export const seqKindFor = (
  source: keyof typeof SEQ_KIND_BY_SOURCE,
  seq: SeqField | undefined,
): SeqKind =>
  SEQ_KIND_BY_SOURCE[source] === "emitted" &&
  isSeqStamp(seq) &&
  windowFloorOf(seq) !== null
    ? "emitted"
    : "observed";

export const ingestTarget = async (
  deps: Deps,
  developerId: string,
  body: Target,
  seq?: SeqField,
): Promise<HandlerOutcome> => {
  const owner = await resolveWorkContextOwner(deps.db, body.workContextId);
  if (owner === undefined) {
    return rejectedOutcome(
      `workContextId: work context "${body.workContextId}" not found`,
    );
  }
  if (owner.developerId !== developerId) {
    return rejectedOutcome(
      "workContextId: work context belongs to another developer",
    );
  }
  const source = body.source;
  const eventKind = TARGET_EVENT_KINDS[body.kind as keyof typeof TARGET_EVENT_KINDS];
  /**
   * PROJECTED ON BOTH BRANCHES, accepted AND duplicate. The git lane's
   * `file.modified` for a file the tool lane already saw arrives on the
   * duplicate branch below — the primary key collapses the two observations
   * into one target row — and that second observation is exactly the one a
   * happens-before question cares about. Writing the event only on `accepted`
   * would leave `seq_kind = observed` a value no real row ever carries.
   */
  const project = async (): Promise<void> => {
    if (eventKind === undefined) {
      return;
    }
    await recordSessionEvent(deps, {
      sessionId: owner.sessionId,
      kind: eventKind,
      seq,
      seqKind: seqKindFor(source, seq),
      refKind: "target_digest",
      refId: targetDigest(body.workContextId, body.kind, body.value),
    });
  };
  const inserted = await deps.db
    .insert(workContextTargets)
    .values({
      workContextId: body.workContextId,
      kind: body.kind,
      value: body.value,
      source,
      // First-seen age for the targets-only pointer (#19). onConflictDoNothing
      // below means a duplicate touch never bumps it — the honest age.
      createdAt: deps.now(),
    })
    .onConflictDoNothing()
    .returning({ workContextId: workContextTargets.workContextId });
  if (inserted[0] === undefined) {
    // The row exists. If the OTHER lane saw this file too, the label is
    // upgraded to "both" — the primary key collapses the two observations
    // into one row, and without this the lane that arrived first would
    // silently own the label and `suspect` would report a second source as
    // dead. Still a DUPLICATE record either way: nothing new was learned
    // about the file, only about who saw it.
    await deps.db
      .update(workContextTargets)
      .set({ source: "both" })
      .where(
        and(
          eq(workContextTargets.workContextId, body.workContextId),
          eq(workContextTargets.kind, body.kind),
          eq(workContextTargets.value, body.value),
          sql`${workContextTargets.source} NOT IN (${source}, 'both')`,
        ),
      );
    await project();
    return duplicate();
  }
  // The doc regenerates so the new target value is searchable. Not wrapped in
  // a transaction with the insert: a crash between the two leaves a doc one
  // target short until the next ingest touches the context — self-healing,
  // and the record itself is already durable.
  await refreshNormalizedDoc(deps.db, body.workContextId);
  await project();
  // No per-target event: a busy session emits dozens of targets and would
  // flood the outbox, drowning the signals SSE consumers care about.
  return accepted();
};

// Accepted v0 limitation: homoglyph lookalikes (e.g. Cyrillic "а" for "a")
// bypass this normalization; the similarity block's embedding dedup covers
// visually-identical bodies.
const normalizeClaimBody = (body: string): string =>
  body.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Ingest dedup gate, deterministic v0 (DESIGN.md §3): same work context, same
 * kind, same author developer, same provenance, same status, normalized-equal
 * body. Similarity/embedding dedup arrives with the search block. NEVER dedup
 * across developers — provenance is the product; cross-author near-duplicates
 * become relates_to edges in the search block instead of merged rows.
 *
 * PROVENANCE AND STATUS ARE PART OF THE SCOPE, and the promotion loop is why
 * (DESIGN.md §3 Tier 1): promoting a draft posts a DECLARED claim with the
 * draft's exact body plus a supersedes edge, and discarding posts the same
 * body with status REJECTED. Dedup exists to collapse re-observations — which
 * arrive with identical provenance and status — not append-only revisions;
 * without this scope the revision collapsed into the draft row and the edge
 * bounced off a claim id that was never inserted.
 *
 * Accepted v0 limitation: candidates are loaded and normalized in JS; the
 * SQL normalized column that pushes this into the query comes with the
 * search block.
 */
const findDedupMatch = async (
  db: DbExecutor,
  developerId: string,
  body: Claim,
): Promise<{ readonly id: string } | undefined> => {
  const candidates = await db
    .select({ id: claims.id, body: claims.body })
    .from(claims)
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .where(
      and(
        eq(claims.workContextId, body.workContextId),
        eq(claims.kind, body.kind),
        eq(agentSessions.developerId, developerId),
        eq(claims.provenance, body.provenance),
        eq(claims.status, body.status),
      ),
    );
  const normalized = normalizeClaimBody(body.body);
  return candidates.find(
    (candidate) => normalizeClaimBody(candidate.body) === normalized,
  );
};

/** A claim id can only conflict with itself (spool replay) or a foreign owner. */
const classifyClaimIdConflict = async (
  db: DbExecutor,
  developerId: string,
  claimId: string,
): Promise<HandlerOutcome> => {
  const rows = await db
    .select({ ownerId: agentSessions.developerId })
    .from(claims)
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .where(eq(claims.id, claimId))
    .limit(1);
  const ownerId = rows[0]?.ownerId;
  if (ownerId !== undefined && ownerId !== developerId) {
    return rejectedOutcome("id: claim id already used by another developer");
  }
  // Spool replay of an already-stored claim id with a drifted body.
  return duplicate(claimId);
};

/**
 * Pre-transaction probe: will the transaction classify this claim as a
 * duplicate without needing its vector? Advisory only — the transaction
 * re-checks under its own snapshot — but it decides whether an embedding
 * provider gets paid: a spool replay (the NORMAL path when a flush times out)
 * and a deterministic re-observation must not cost an HTTP call each.
 */
const isDeterministicDuplicate = async (
  db: DbExecutor,
  developerId: string,
  body: Claim,
): Promise<boolean> => {
  const byIdRows = await db
    .select({ id: claims.id })
    .from(claims)
    .where(eq(claims.id, body.id))
    .limit(1);
  if (byIdRows[0] !== undefined) {
    return true;
  }
  return (await findDedupMatch(db, developerId, body)) !== undefined;
};

/**
 * The vector a claim will be stored with, decided BEFORE any transaction: an
 * external HTTP call must never hold a transaction open on single-connection
 * PGlite. Null = keyless install, a failed embed, or a claim the
 * deterministic gate will classify anyway — in every case the similarity gate
 * silently stands down and the deterministic gate still runs (DESIGN.md §6
 * degradation).
 *
 * Exported with `ingestClaimWithin` below because a question ANSWER is a
 * claim written inside a WIDER transaction (services/questions.ts writes the
 * claim and its `answers` edge atomically), and that caller has to do the two
 * halves in the same order this one does.
 */
export const prepareClaimVector = async (
  deps: Deps,
  developerId: string,
  body: Claim,
): Promise<readonly number[] | null> => {
  const embedder = deps.embedder ?? null;
  if (
    embedder === null ||
    (await isDeterministicDuplicate(deps.db, developerId, body))
  ) {
    return null;
  }
  return embedClaimBody(embedder, body.body);
};

/**
 * The claim ingest gate, INSIDE a caller-owned transaction: dedup match,
 * INSERT, dedup_count bump, cross-similarity, doc refresh, outbox row.
 *
 * Split out of `ingestClaim` rather than copied, so an answer's claim passes
 * the identical gate a published claim does — same dedup scope, same
 * ownership check, same similarity rules. A second implementation would be a
 * second place for the asymmetry to drift.
 */
export const ingestClaimWithin = async (
  tx: DbExecutor,
  deps: Deps,
  developerId: string,
  body: Claim,
  claimVector: readonly number[] | null,
  seq?: SeqField,
): Promise<HandlerOutcome> => {
  const embedder = deps.embedder ?? null;
  const txDeps: ExecutorDeps = { db: tx, now: deps.now };
  const authorIssue = await checkOwnedSession(
    tx,
    developerId,
    body.authorSessionId,
    "authorSessionId",
  );
  if (authorIssue !== null) {
    return rejectedOutcome(authorIssue);
  }
  // The work context must exist but may belong to another developer:
  // extending someone else's diagnosis tree is the product (DESIGN.md §3).
  const contextRows = await tx
    .select({ id: workContexts.id })
    .from(workContexts)
    .where(eq(workContexts.id, body.workContextId))
    .limit(1);
  if (contextRows[0] === undefined) {
    return rejectedOutcome(
      `workContextId: work context "${body.workContextId}" not found`,
    );
  }

  const dedupMatch = await findDedupMatch(tx, developerId, body);
  if (dedupMatch !== undefined) {
    if (dedupMatch.id === body.id) {
      // Exact spool replay: a retransmission, not a re-observation —
      // dedup_count and last_seen_at stay untouched.
      return duplicate(body.id);
    }
    await tx
      .update(claims)
      .set({
        dedupCount: sql`${claims.dedupCount} + 1`,
        lastSeenAt: deps.now(),
      })
      .where(eq(claims.id, dedupMatch.id));
    return duplicate(dedupMatch.id);
  }

  // Similarity dedup (DESIGN.md §3): same scope as the deterministic gate —
  // same developer, same context, same kind — with cosine > 0.93 standing in
  // for body equality. 15 rewordings of one re-observed error become one
  // weighted claim, not 15 rows.
  if (claimVector !== null && embedder !== null) {
    const similar = await findSimilarOwnClaim(
      tx,
      developerId,
      body,
      claimVector,
      embedder.model,
    );
    if (similar !== undefined) {
      await tx
        .update(claims)
        .set({
          dedupCount: sql`${claims.dedupCount} + 1`,
          lastSeenAt: deps.now(),
        })
        .where(eq(claims.id, similar.id));
      return duplicate(similar.id);
    }
  }

  const createdAt = new Date(body.createdAt);
  // AFTER the dedup gates, so a re-observation never costs the lookup: a
  // duplicate keeps the binding the first INSERT stamped, which is the honest
  // one — the second observation is the same claim, not a new assertion.
  const binding = await resolveCommitBinding(tx, body);
  // evidenceRefs are persisted as-is; materializing supports-edges from them
  // is a follow-up — referenced claims may arrive later in the same flush.
  const inserted = await tx
    .insert(claims)
    .values({
      id: body.id,
      workContextId: body.workContextId,
      authorSessionId: body.authorSessionId,
      kind: body.kind,
      body: body.body,
      status: body.status,
      confidence: body.confidence,
      captureMode: body.captureMode,
      provenance: body.provenance,
      evidenceRefs: body.evidenceRefs,
      observedAtCommit: binding.observedAtCommit,
      commitBinding: binding.commitBinding,
      embedding: claimVector === null ? null : [...claimVector],
      embeddingModel:
        claimVector === null || embedder === null ? null : embedder.model,
      lastSeenAt: createdAt,
      createdAt,
    })
    .onConflictDoNothing()
    .returning({ id: claims.id });
  if (inserted[0] === undefined) {
    return classifyClaimIdConflict(tx, developerId, body.id);
  }
  // The DECLARED half of the affected surface (spec 02 §3.2), written with
  // the claim and never after: like the two binding columns, it is part of
  // what the author asserted, not a later annotation. onConflictDoNothing
  // because a spool replay of the same claim id is a retransmission.
  if (body.affectedPaths.length > 0) {
    await tx
      .insert(claimSurfaces)
      .values(
        body.affectedPaths.map((path) => ({
          claimId: body.id,
          repo: binding.repo,
          path,
        })),
      )
      .onConflictDoNothing();
  }
  // Cross-session similarity: relates_to edge or contradiction candidate
  // (similarity-gate.ts). After the insert so both edge endpoints exist.
  if (claimVector !== null && embedder !== null) {
    await applyCrossSimilarity(
      tx,
      deps.now,
      developerId,
      body,
      claimVector,
      embedder.model,
    );
  }
  await refreshNormalizedDoc(tx, body.workContextId);
  // Outbox discipline: ids and metadata only — never the claim body text.
  await appendEvent(txDeps, EVENT_KINDS.CLAIM_ADDED, {
    claimId: body.id,
    workContextId: body.workContextId,
    authorSessionId: body.authorSessionId,
    developerId,
    kind: body.kind,
    status: body.status,
  });
  // IN THE SAME TRANSACTION as the row it projects — one pipeline, not two.
  // The session is the claim's OWN author, never the producer: a spool drained
  // by a successor session rewrites the producer, and A's positions inside B's
  // sequence would break B's whole order for a reason that is not B's.
  // A DERIVED CLAIM IS A WORKER'S, AND A WORKER'S POSITION IS OBSERVED. The
  // summarizer, ghost and intent workers run detached and summarise a slice
  // from EARLIER in the session, so the position they allocate records when
  // the row was written, not when the fact it describes was seen. Sorting such
  // a claim after edits it actually predates would be a confident wrong
  // answer. An agent calling `publish_claim` is DECLARING on its own account,
  // synchronously, and that position is emitted.
  await recordSessionEvent(txDeps, {
    sessionId: body.authorSessionId,
    kind: "claim.created",
    seq,
    seqKind: body.provenance === "derived" ? "observed" : "emitted",
    refKind: "claim",
    refId: body.id,
  });
  return accepted(body.id);
};

export const ingestClaim = async (
  deps: Deps,
  developerId: string,
  body: Claim,
  seq?: SeqField,
): Promise<HandlerOutcome> => {
  const claimVector = await prepareClaimVector(deps, developerId, body);
  // One transaction so dedup match, INSERT, and dedup_count bump are atomic —
  // two concurrent flushes cannot both miss the match and double-insert.
  // Context-doc embedding happens once per flush in ingestRecords.
  return deps.db.transaction((tx) =>
    ingestClaimWithin(tx, deps, developerId, body, claimVector, seq),
  );
};

/**
 * WHICH EDGE KINDS INVALIDATE A CLAIM. `contradicts` says the target is wrong;
 * `supersedes` says a revision replaces it. `supports`, `relates_to` and
 * `deeper_cause_of` add to a tree without taking anything away from it, and
 * projecting them as `claim.invalidated` would make the name a lie on every
 * `extend_diagnosis` call that merely connected two findings.
 */
const INVALIDATING_EDGE_KINDS: ReadonlySet<string> = new Set([
  "contradicts",
  "supersedes",
]);

const findEdgeIdByTriple = async (
  db: DbExecutor,
  body: ClaimEdge,
): Promise<string | undefined> => {
  const rows = await db
    .select({ id: claimEdges.id })
    .from(claimEdges)
    .where(
      and(
        eq(claimEdges.fromClaimId, body.fromClaimId),
        eq(claimEdges.toClaimId, body.toClaimId),
        eq(claimEdges.kind, body.kind),
      ),
    )
    .limit(1);
  return rows[0]?.id;
};

/** Disambiguates which unique constraint swallowed the edge INSERT. */
const classifyEdgeConflict = async (
  db: DbExecutor,
  body: ClaimEdge,
): Promise<HandlerOutcome> => {
  const byIdRows = await db
    .select({
      fromClaimId: claimEdges.fromClaimId,
      toClaimId: claimEdges.toClaimId,
      kind: claimEdges.kind,
    })
    .from(claimEdges)
    .where(eq(claimEdges.id, body.id))
    .limit(1);
  const existing = byIdRows[0];
  if (existing !== undefined) {
    const isSameTriple =
      existing.fromClaimId === body.fromClaimId &&
      existing.toClaimId === body.toClaimId &&
      existing.kind === body.kind;
    return isSameTriple
      ? duplicate(body.id)
      : rejectedOutcome("id: already used by a different edge");
  }
  return duplicate(await findEdgeIdByTriple(db, body));
};

export const ingestClaimEdge = async (
  deps: Deps,
  developerId: string,
  body: ClaimEdge,
  seq?: SeqField,
): Promise<HandlerOutcome> => {
  const authorIssue = await checkOwnedSession(
    deps.db,
    developerId,
    body.authorSessionId,
    "authorSessionId",
  );
  if (authorIssue !== null) {
    return rejectedOutcome(authorIssue);
  }
  const endpointIds = [body.fromClaimId, body.toClaimId];
  const found = await deps.db
    .select({ id: claims.id, ownerId: agentSessions.developerId })
    .from(claims)
    .innerJoin(agentSessions, eq(claims.authorSessionId, agentSessions.id))
    .where(inArray(claims.id, endpointIds));
  const foundIds = new Set(found.map((row) => row.id));
  const missing = endpointIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    return rejectedOutcome(`claim(s) not found: ${missing.join(", ")}`);
  }
  // supersedes is same-author revision semantics (DESIGN.md §5); cross-author
  // disagreement uses contradicts/deeper_cause_of, which stay cross-author by
  // design (extend_diagnosis).
  if (body.kind === "supersedes") {
    const hasForeignEndpoint = found.some((row) => row.ownerId !== developerId);
    if (hasForeignEndpoint) {
      return rejectedOutcome(
        "kind: supersedes requires ownership of both claims",
      );
    }
  }

  const inserted = await deps.db
    .insert(claimEdges)
    .values({
      id: body.id,
      fromClaimId: body.fromClaimId,
      toClaimId: body.toClaimId,
      kind: body.kind,
      authorSessionId: body.authorSessionId,
      note: body.note ?? null,
      createdAt: new Date(body.createdAt),
    })
    .onConflictDoNothing()
    .returning({ id: claimEdges.id });
  if (inserted[0] === undefined) {
    return classifyEdgeConflict(deps.db, body);
  }
  await appendEvent(deps, EVENT_KINDS.CLAIM_EDGE_ADDED, {
    edgeId: body.id,
    fromClaimId: body.fromClaimId,
    toClaimId: body.toClaimId,
    kind: body.kind,
    developerId,
  });
  if (INVALIDATING_EDGE_KINDS.has(body.kind)) {
    await recordSessionEvent(deps, {
      sessionId: body.authorSessionId,
      kind: "claim.invalidated",
      seq,
      seqKind: "emitted",
      refKind: "claim_edge",
      refId: body.id,
    });
  }
  return accepted(body.id);
};