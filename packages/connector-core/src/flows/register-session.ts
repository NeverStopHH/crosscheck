/**
 * `registerSessionFlow` (DESIGN-agent-agnostic.md §1.3) — the session-start
 * recipe as an extracted function: register with `cc_<hostSessionKey>`
 * (+ the `~r<n>` life ladder on 409, state/session-lineage.ts) →
 * `writeSessionState` BEFORE any append (reap
 * infers "writer alive" from the state file, so a spool without state is an
 * orphan on sight) → spool the work-context record.
 *
 * EXTRACTED FROM `connector-claude/src/hooks/session-start.ts`, not invented:
 * the hook now calls this, so there is exactly one implementation — the
 * §5 scheduling note's entry step, discharged by Block 4 (the first
 * connector block that needed a flow). Host-specific parsing (payloads,
 * titles from session metadata) stays in each connector; this flow takes the
 * already-resolved values.
 */
import type { CausalGuaranteeTriple, SeqField } from "@crosscheck/schema";

import { z } from "zod";

import {
  readJsonOrNull,
  removeFile,
  sessionEpochPathForSlug,
  sessionHealPathForSlug,
  sessionSlug,
  writePrivateFile,
} from "../config/paths.ts";
import { registerSession } from "../http/hub.ts";
import type { HubContext } from "../http/client.ts";
import { appendRecords } from "../spool/append.ts";
import { readTelemetryLossReport } from "../spool/loss-report.ts";
import { recordRefusedLife } from "../spool/refused-lives.ts";
import {
  UNKNOWN_DEVELOPER_ID,
  workContextRecord,
} from "../capture/records.ts";
import {
  ladderRungs,
  ladderStart,
  lifeRungOf,
  lifeSessionId,
  readEndedLifeRung,
} from "../state/session-lineage.ts";
import {
  carriedSeqEpoch,
  claimSessionState,
  crosscheckSessionIdFor,
  publishSessionState,
  readSessionState,
  workContextIdFor,
} from "../state/session-state.ts";
import type { SessionState } from "../state/session-state.ts";

const HTTP_CONFLICT = 409;

/**
 * The hub's DISTINCT conflict code for "this id is a LIVE session bound to
 * another repo" (server routes/sessions.ts). In recovery mode the ladder
 * must stop on it — minting `~r1` for the foreign repo would be a re-home
 * by another name — while the generic "conflict" (somebody else's id, or an
 * ended session being reopened) keeps walking the suffixes.
 */
const REPO_MISMATCH_CODE = "repo_mismatch";

const LOCAL_REPO_PREFIX = "local:";

/**
 * Last segment of the shared repo id (`github.com/acme/api` → `api`), never a
 * local directory name: this title is uploaded and read by teammates. A
 * `local:` id has no shareable segment, so the branch alone has to carry it.
 */
const repoLabel = (repoId: string): string | null => {
  if (repoId.startsWith(LOCAL_REPO_PREFIX)) {
    return null;
  }
  const last = repoId.split("/").at(-1)?.trim();
  return last === undefined || last.length === 0 ? null : last;
};

/**
 * The honest work-context title when the host supplied none: branch @ repo,
 * never a fabricated task description — and never derived from prompt text
 * (the Claude connector's fallback and the ACP proxy's only title share this
 * privacy posture, design §2.4).
 */
export const fallbackWorkContextTitle = (
  branch: string,
  repoId: string,
): string => {
  const label = repoLabel(repoId);
  return label === null ? branch : `${branch} @ ${label}`;
};

export interface RegisterSessionFlowInput {
  readonly home: string;
  readonly repoKey: string;
  readonly hub: HubContext;
  readonly agentKind: string;
  /** The host's own id for this session (state/host-session-key.ts). */
  readonly hostSessionKey: string;
  readonly repoId: string;
  readonly repoRoot: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly hubUrl: string;
  /** Used when the hub does not answer (stored config identity). */
  readonly fallbackDeveloperId: string | null;
  readonly title: string;
  readonly status: string;
  readonly now: Date;
  /**
   * State-less MID-SESSION reconstruction (Claude's recoverState twin,
   * Cursor's requireSessionState): the caller read no state file and is
   * rebuilding one. Three behaviors flip together, all pinned in
   * session-flows.test.ts: the retry ladder STOPS on `repo_mismatch`
   * (first-wins — a live session must not spawn a foreign-repo sibling),
   * the state file is CLAIMED rather than overwritten (a sibling recovery
   * that published first keeps its binding), and a lost claim appends no
   * second work-context record. SessionStart callers stay on the overwrite
   * path: re-creating state on a re-fire is deliberate there.
   */
  readonly recovery?: boolean;
  /**
   * A recovery caller that OWES the session its briefing sets this: no
   * sessionStart ever delivered one, so the debt is recorded IN the claimed
   * state — atomically with the claim, the Claude recoverState's
   * `briefingPending` in flow form — and the next injection-capable hook
   * pays it through `deliverDeferredBriefing`. Absent means false (the
   * schema default): sessionStart callers deliver in-hook and owe nothing.
   */
  readonly briefingPending?: boolean;
  /**
   * The calling connector's declared causal guarantees — its own row of
   * guarantees/declarations.ts, `guaranteeDeclarationFor(<connector>)`.
   * REQUIRED so no host can register without deciding what it declares; the
   * build check pins which connector each call site names.
   */
  readonly guarantees: readonly CausalGuaranteeTriple[];
}

export interface RegisterSessionFlowResult {
  readonly crosscheckSessionId: string;
  readonly workContextId: string;
  readonly developerId: string | null;
  /** False when the hub never accepted a register — state + spool still exist. */
  readonly registered: boolean;
}

/** What one walk of the life ladder needs (state/session-lineage.ts). */
export interface RegisterLadderInput {
  readonly home: string;
  readonly repoKey: string;
  readonly hub: HubContext;
  readonly agentKind: string;
  readonly hostSessionKey: string;
  readonly repoId: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly status: string;
  readonly guarantees: readonly CausalGuaranteeTriple[];
  /** `session.started`'s own position, or the refusal that travels instead. */
  readonly seq: SeqField;
  /** Stop on `repo_mismatch` (RegisterSessionFlowInput.recovery). */
  readonly recovery?: boolean;
  /** The crosscheck session the state file is on, when there is one. */
  readonly liveSessionId: string | null;
  /**
   * A life the caller KNOWS is ended — the hub just refused it as ended
   * (flows/heal-session.ts). It counts like an end the lineage wrote down, so
   * the walk starts above it instead of spending a round trip on a sure 409.
   */
  readonly endedSessionId?: string;
  /**
   * Wall-clock end of the walk (`Date.now()` ms), for a walk that runs inside
   * a hook's flush (flows/heal-session.ts): no rung starts past it, and each
   * request is clamped to what is left. Absent: each rung gets the hub's own
   * timeout, as SessionStart's register always has.
   */
  readonly deadlineMs?: number;
}

/** The newer of two ended rungs, either of which may be unknown. */
const newestRung = (left: number | null, right: number | null): number | null =>
  left === null || right === null ? (left ?? right) : Math.max(left, right);

/** The hub context for one rung: clamped to the walk's deadline, if it has one. */
const rungContext = (input: RegisterLadderInput): HubContext | null => {
  if (input.deadlineMs === undefined) {
    return input.hub;
  }
  const roomMs = input.deadlineMs - Date.now();
  return roomMs <= 0 ? null : { ...input.hub, timeoutMs: Math.min(input.hub.timeoutMs, roomMs) };
};

export type RegisterLadderOutcome =
  | {
      readonly outcome: "registered";
      readonly sessionId: string;
      readonly developerId: string | null;
    }
  /** Recovery only: a LIVE session with this id is bound to another repo. */
  | { readonly outcome: "repo_mismatch" }
  /**
   * The hub did not answer, answered something else, or refused every rung.
   * `sessionId` is the life this host session is on meanwhile: the rung the
   * walk could not settle — never one the hub answered 409, which is ended or
   * somebody else's. Records spooled under it are refused `session_unknown`
   * until a heal registers it as itself (flows/heal-session.ts); under a
   * refused id they were refused for good.
   */
  | { readonly outcome: "unregistered"; readonly sessionId: string };

/**
 * ONE WALK OF THE LIFE LADDER, shared by every register that can meet an
 * ended session: SessionStart on all three hosts and Claude's state-less
 * recovery. A 409 is the hub saying this rung is ended or somebody else's, so
 * the walk climbs; anything else ends it.
 */
export const registerSessionLadder = async (
  input: RegisterLadderInput,
): Promise<RegisterLadderOutcome> => {
  const baseId = crosscheckSessionIdFor(input.hostSessionKey);
  // THE LOSS REPORT, READ ONCE FOR THE LADDER (docs/1.0/loss-accounting.md
  // §4.2). Registration runs right after `reapSpool`, which is where expiry
  // drops and the unclosed count are written, so this is the call that
  // carries a DEAD session's post-mortem losses to the hub. A local read of
  // the ledgers; every rung of the ladder sends the same snapshot.
  const losses = await readTelemetryLossReport(input.home, input.repoKey);
  const start = ladderStart(
    baseId,
    input.liveSessionId,
    newestRung(
      await readEndedLifeRung(input.home, input.hostSessionKey, baseId),
      input.endedSessionId === undefined ? null : lifeRungOf(baseId, input.endedSessionId),
    ),
  );
  const rungs = ladderRungs(start);
  for (const rung of rungs) {
    const sessionId = lifeSessionId(baseId, rung);
    const hub = rungContext(input);
    if (hub === null) {
      return { outcome: "unregistered", sessionId };
    }
    const result = await registerSession(hub, {
      id: sessionId,
      agentKind: input.agentKind,
      repo: input.repoId,
      branch: input.branch,
      baseCommit: input.baseCommit,
      status: input.status,
      losses,
      guarantees: input.guarantees,
      seq: input.seq,
    });
    if (result.ok) {
      return {
        outcome: "registered",
        sessionId,
        developerId: result.data.session.developerId,
      };
    }
    if (result.status !== HTTP_CONFLICT) {
      return { outcome: "unregistered", sessionId };
    }
    if (input.recovery === true && result.code === REPO_MISMATCH_CODE) {
      return { outcome: "repo_mismatch" };
    }
    if (sessionId === input.liveSessionId && result.code !== REPO_MISMATCH_CODE) {
      // THE LIFE THE STATE IS ON IS ENDED, and the walk climbs past it: its
      // records still on disk are the refused life's stragglers, withheld from
      // every later flush exactly as a heal withholds them (spool/refused-
      // lives.ts) — delivered by the next life, the hub would file them into
      // the ended one past its end (review-2 round 7, found by the spool
      // simulation).
      await recordRefusedLife(input.home, input.repoKey, sessionId, new Date());
    }
  }
  return { outcome: "unregistered", sessionId: lifeSessionId(baseId, (rungs.at(-1) ?? start) + 1) };
};

const ReservedEpochSchema = z.looseObject({ epoch: z.string().min(1) });

/** The epoch a register reserved and never named in a state file, or null. */
const readReservedEpoch = async (input: RegisterSessionFlowInput): Promise<string | null> => {
  const parsed = ReservedEpochSchema.safeParse(
    await readJsonOrNull(sessionEpochPathForSlug(input.home, sessionSlug(input.hostSessionKey))),
  );
  return parsed.success ? parsed.data.epoch : null;
};

const reserveEpoch = async (input: RegisterSessionFlowInput, epoch: string): Promise<void> => {
  await writePrivateFile(
    sessionEpochPathForSlug(input.home, sessionSlug(input.hostSessionKey)),
    `${JSON.stringify({ epoch, at: input.now.toISOString() })}\n`,
  );
};

/** The session-start recipe: register → state BEFORE append → work context. */
export const registerSessionFlow = async (
  input: RegisterSessionFlowInput,
): Promise<RegisterSessionFlowResult> => {
  const baseSessionId = crosscheckSessionIdFor(input.hostSessionKey);
  // MINTED BEFORE THE CALL, because the call carries it. The epoch was minted
  // on the state input below — after the POST had already gone out — so the
  // register body had nothing to send and `session.started` landed
  // unpositioned on every host. One epoch, used by both halves.
  const mintedEpoch = crypto.randomUUID();
  // ...AND ON A RE-FIRE THE MINT IS NOT WHAT THE SESSION USES. SessionStart
  // fires again inside a live session (compact, resume, clear) and
  // `withCarriedCapture` keeps the PREVIOUS epoch, so a body carrying this
  // fire's fresh one names an epoch nothing else in the session will be
  // positioned under. It costs nothing while the hub already holds the session
  // — the re-register is answered from its conflict branch and records no
  // second `session.started` — and it costs the WHOLE session when the first
  // register never landed: the CREATE branch then files `session.started`
  // under the foreign epoch and the hub answers `broken / epoch_split` for
  // every pair in that session, permanently. Read here, before the POST,
  // because the POST is what carries it (carriedSeqEpoch's header).
  const previous = await readSessionState(input.home, input.hostSessionKey);
  // ...AND A REGISTER KILLED BEFORE ITS STATE WAS WRITTEN LEFT ITS EPOCH ON THE
  // HUB (review-2 round 7, found by the spool simulation): `session.started`
  // under it, nothing on disk naming it, and the next SessionStart's fresh
  // mint split the session for good. The epoch is reserved before the POST,
  // and a state-less register takes the reservation it finds — nothing was
  // ever positioned under it but `session.started` at 0.
  const fresh = (previous === null ? await readReservedEpoch(input) : null) ?? mintedEpoch;
  const seqEpoch = carriedSeqEpoch(previous, input, fresh);
  if (seqEpoch === fresh) {
    await reserveEpoch(input, fresh);
  }
  const ladder = await registerSessionLadder({
    ...input,
    // `session.started` AT POSITION ZERO (spec 01 §3.2), and this is the only
    // call that can send it: the allocator mints `eventSeq` at 0 and hands
    // out from 1, so nothing ever allocates this position — it is minted with
    // the epoch, by construction. An ABSENT field here would not be a missing
    // position but a WRONG SENTENCE: the hub reads an absent `seq` as
    // `pre_seq_connector`, "a connector from before this field", and would
    // say it about a current connector on the one row every session is
    // guaranteed to have.
    seq: { epoch: seqEpoch, n: 0 },
    liveSessionId: previous?.crosscheckSessionId ?? null,
  });
  const registration = ladder.outcome === "registered" ? ladder : null;
  if (ladder.outcome === "repo_mismatch") {
    // First-wins (trial finding #9): a LIVE session with this id is bound to
    // another repo. NOTHING is written — a state file would re-home the
    // binding, and a spooled work context would be ingested against the
    // other repo's session on the next flush. Silence is the contract.
    return {
      crosscheckSessionId: baseSessionId,
      workContextId: workContextIdFor(baseSessionId),
      developerId: input.fallbackDeveloperId,
      registered: false,
    };
  }
  // THE LIFE THE WALK SETTLED ON, registered or not — never the base id as a
  // default. A re-fire whose register did not land keeps the life it is on; a
  // resume takes the rung above the life its last end closed. Falling back to
  // the base id put a resumed conversation back on a life the hub had ENDED,
  // and the very next flush spent the whole repo spool under it (review E2E-2).
  const crosscheckSessionId = ladder.sessionId;
  const developerId = registration?.developerId ?? input.fallbackDeveloperId;
  const workContextId = workContextIdFor(crosscheckSessionId);
  // A RE-FIRE ON THE LIFE IT IS IN KEEPS THAT LIFE'S STATUS (review-2 round 7,
  // found by the spool simulation): set_intent may have moved it since the
  // first SessionStart, and the work context this register spools would put
  // the host's starting status back over it.
  const status =
    previous !== null && previous.crosscheckSessionId === crosscheckSessionId
      ? (previous.workContextStatus ?? input.status)
      : input.status;
  if (registration !== null) {
    // A register that landed answers the last failed walk's verdict: the hub
    // knows the life now, and a stamp that still said `failed` kept every
    // flush from sending for the rest of its cooldown (review-2 round 6,
    // LOW-1, RS5-D).
    await removeFile(sessionHealPathForSlug(input.home, sessionSlug(input.hostSessionKey)));
  }

  // BEFORE the first append, always: `reap` decides that a spool file has no
  // writer left by finding no session state file for it, and that inference
  // is only sound while state is published before any record is written.
  const stateInput = {
    hostSessionKey: input.hostSessionKey,
    crosscheckSessionId,
    workContextId,
    repoId: input.repoId,
    repoRoot: input.repoRoot,
    hubUrl: input.hubUrl,
    developerId,
    startedAt: input.now.toISOString(),
    lastHeartbeatAt: input.now.toISOString(),
    seenTargets: [],
    deliveredHintRefs: [],
    deliveredHintHashes: [],
    tripwireAskedFiles: [],
    landedAskedFiles: [],
    landedCleanKeys: [],
    // The intent writers (derived-intent worker, set_intent) re-send the
    // title and status on their update record — kept here so they never
    // fabricate one (trial finding #16).
    workContextTitle: input.title,
    workContextStatus: status,
    // THE EPOCH IS MINTED ON THE INPUT, not inside publishSessionState (spec
    // 01 §3.4). publishSessionState's busy-lock FALLBACK writes this object
    // verbatim, with no carry at all — "the counters lose rather than the
    // file" — so an epoch minted inside the locked branch would be absent
    // from exactly the write that most needs one: a session whose state file
    // was re-created with seqEpoch null allocates no positions for the rest
    // of its life, silently. Minted here, that fallback writes a FRESH epoch
    // beside eventSeq 0, which leaves the two halves NOT COMPARABLE rather
    // than sharing positions. On the ordinary path withCarriedCapture
    // restores the previous pair, so a re-fire that takes the lock keeps one
    // epoch for the whole session.
    //
    // THE FRESH MINT, NEVER THE CARRIED EPOCH ON THE WIRE ABOVE. The fallback
    // writes eventSeq 0 with whatever stands here, and the carried epoch
    // beside a counter reset to 0 RE-ISSUES positions this session has already
    // handed out — the one thing the order may never do (withCarriedCapture's
    // header: the pair moves together or not at all). The fallback keeps
    // costing comparability, and never correctness.
    seqEpoch: fresh,
    eventSeq: 0,
    ...(input.briefingPending === true ? { briefingPending: true } : {}),
  };
  if (input.recovery === true) {
    // CLAIM, never overwrite: a sibling recovery that published first keeps
    // its binding (the caller re-reads and judges the repo), and the loser
    // appends no second work-context record. A busy lock is fail-open —
    // nothing written, nothing appended, silence this invocation.
    const claim = await claimSessionState(input.home, stateInput);
    if (claim === null || !claim.claimed) {
      return {
        crosscheckSessionId,
        workContextId,
        developerId,
        registered: registration !== null,
      };
    }
  } else {
    // A SessionStart RE-FIRE (compact/resume/clear) arrives here with the same
    // session id while the session is still running. Publishing carries the
    // capture counters and the worktree-root cache across the fire; the
    // per-fire lists (briefing pointers, the hint seen-set) start empty again,
    // which is what withBriefingSolvedRefs' header specifies.
    await publishSessionState(input.home, stateInput);
  }
  // The state names the epoch now; the reservation has done its job.
  await removeFile(sessionEpochPathForSlug(input.home, sessionSlug(input.hostSessionKey)));
  await appendRecords(
    input.home,
    input.repoKey,
    input.hostSessionKey,
    [
      workContextRecord(
        {
          workContextId,
          sessionId: crosscheckSessionId,
          title: input.title,
          status,
        },
        {
          developerId: developerId ?? UNKNOWN_DEVELOPER_ID,
          agentKind: input.agentKind,
          sessionId: crosscheckSessionId,
        },
        input.now,
      ),
    ],
    input.now,
  );
  return {
    crosscheckSessionId,
    workContextId,
    developerId,
    registered: registration !== null,
  };
};
