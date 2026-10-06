/**
 * `sessionHealer` — the life ladder (state/session-lineage.ts), walked MID-LIFE
 * when the hub refuses this session's own id.
 *
 * SessionStart is the only place a life used to be registered, so a session the
 * hub ended or never heard of stayed refused until the host fired SessionStart
 * again: a sibling process's SessionEnd landing after a reload, a register that
 * timed out, a 0.10 conversation already deaf at upgrade. Every record it
 * captured in between was rejected while the spool cursor moved past it. The
 * flush (spool/flush.ts) and the heartbeat (flows/heartbeat.ts) now call this
 * when the hub refuses the session they speak for, and it does what a
 * SessionStart would: walk the ladder from the refused life, register the next
 * one, and spool its work context.
 *
 * WHAT IT NEVER DOES is reopen the refused life. An end the connector reported
 * stays final (server services/records.ts checkProducerSession); the next life
 * is a new session with its own `session.started`, positioned under the state
 * file's epoch at 0 — the counter runs on, so nothing this session already
 * handed out is issued twice, and order is only ever compared inside one
 * session (spec 01 §3.4). An ENDED life's walk starts above it — its rung is a
 * sure 409; a session the hub never registered is registered as ITSELF.
 *
 * BOUNDED TWICE. Once per flush, by the caller; and once per HEAL_COOLDOWN_MS
 * per session, here — the attempt is stamped beside the state file
 * (`sessions/<slug>.heal`) before the walk, so a hub that refuses every
 * register costs one walk per cooldown, not one per hook. The walk itself runs
 * to the caller's deadline, and a heal with no room for one round trip stamps
 * nothing at all.
 *
 * AND NEVER A DEAD END WHERE A LIFE EXISTS (review P4–P6). A heal whose sibling
 * already moved the state answers that life; one that meets a sibling's walk
 * in flight, or has no room, answers `pending`, so its caller keeps its records
 * on disk for the life that walk lands rather than dropping them.
 */
import type { CausalGuaranteeTriple } from "@crosscheck/schema";

import { HEAL_COOLDOWN_MS, HEAL_MIN_ROOM_MS } from "../constants.ts";
import {
  readJsonOrNull,
  removeFile,
  repoKey,
  sessionHealPathForSlug,
  sessionSlug,
  writePrivateFile,
} from "../config/paths.ts";
import { UNKNOWN_DEVELOPER_ID, workContextRecord } from "../capture/records.ts";
import { ALLOCATION_FAILED } from "../capture/seq.ts";
import type { HubContext } from "../http/client.ts";
import { endSession } from "../http/hub.ts";
import { oweWorkContext } from "../spool/owed-work-context.ts";
import type { HealResult, SessionHealer, SessionRefusal } from "../spool/flush-heal.ts";
import { recordRefusedLife } from "../spool/refused-lives.ts";
import { lifeRungOf, readEndedLifeRung, recordEndedLife } from "../state/session-lineage.ts";
import {
  crosscheckSessionIdFor,
  readSessionState,
  underSessionStateLock,
  workContextIdFor,
  writeSessionState,
} from "../state/session-state.ts";
import type { SessionState } from "../state/session-state.ts";
import { fallbackWorkContextTitle, registerSessionLadder } from "./register-session.ts";

export type {
  HealResult,
  RefusalCause,
  SessionHeal,
  SessionHealer,
  SessionRefusal,
} from "../spool/flush-heal.ts";

/** The status a healed life's work context is registered with when state has none. */
const HEAL_STATUS = "implementing";

const PENDING: HealResult = { outcome: "pending" };
const FAILED: HealResult = { outcome: "failed" };

export interface SessionHealerInput {
  readonly home: string;
  readonly repoKey: string;
  readonly hub: HubContext;
  readonly agentKind: string;
  /** The host's own id for this session (state/host-session-key.ts). */
  readonly hostSessionKey: string;
  readonly repoId: string;
  readonly branch: string;
  readonly baseCommit: string;
  /** The connector's declared causal guarantees, as SessionStart sends them. */
  readonly guarantees: readonly CausalGuaranteeTriple[];
  readonly now: () => Date;
}

/**
 * The last attempt, as stamped: when it started (the cooldown's clock, read on
 * the caller's `now`), and — while it walks — the wall-clock deadline it walks
 * to, past which a `walking` stamp is a walker that died mid-way.
 */
interface HealStamp {
  readonly atMs: number;
  readonly walking: boolean;
  readonly untilMs: number;
  /** The life a finished walk registered nothing for, or null. */
  readonly failedFor: string | null;
}

const healPath = (input: SessionHealerInput): string =>
  sessionHealPathForSlug(input.home, sessionSlug(input.hostSessionKey));

const readStamp = async (input: SessionHealerInput): Promise<HealStamp | null> => {
  const stamp = (await readJsonOrNull(healPath(input))) as {
    at?: unknown;
    phase?: unknown;
    until?: unknown;
    failed?: unknown;
  } | null;
  const atMs = typeof stamp?.at === "string" ? Date.parse(stamp.at) : Number.NaN;
  return Number.isNaN(atMs)
    ? null
    : {
        atMs,
        walking: stamp?.phase === "walking",
        untilMs: typeof stamp?.until === "number" ? stamp.until : 0,
        failedFor: typeof stamp?.failed === "string" ? stamp.failed : null,
      };
};

const writeStamp = async (
  input: SessionHealerInput,
  now: Date,
  phase: "walking" | "done",
  untilMs: number,
  failedFor: string | null = null,
): Promise<boolean> => {
  try {
    const failed = failedFor === null ? {} : { failed: failedFor };
    await writePrivateFile(
      healPath(input),
      `${JSON.stringify({ at: now.toISOString(), phase, until: untilMs, ...failed })}\n`,
    );
    return true;
  } catch {
    // A stamp that cannot be written is a cooldown that cannot be kept: no walk.
    return false;
  }
};

/**
 * Whether this heal may walk now: `walk`, or the answer to give instead. A
 * sibling's walk still inside its deadline is `pending` — it may land a life
 * this caller's records can go under — and any other attempt inside the
 * cooldown is `failed`. Too little room for one round trip is `pending` too,
 * and stamps nothing: a heal that cannot reach the hub must not cost the next
 * one its turn (review P6).
 */
const mayWalk = async (
  input: SessionHealerInput,
  now: Date,
  deadlineMs: number,
): Promise<"walk" | HealResult> => {
  const stamp = await readStamp(input);
  if (stamp !== null && now.getTime() - stamp.atMs < HEAL_COOLDOWN_MS) {
    return stamp.walking && Date.now() < stamp.untilMs ? PENDING : FAILED;
  }
  return deadlineMs - Date.now() < HEAL_MIN_ROOM_MS ? PENDING : "walk";
};

/** What the state's switch did: the life is the state's now, a sibling moved it first, or the lock stayed busy. */
type Swap = "swapped" | "cas_lost" | "lock_busy";

/**
 * The state's switch to the life the walk registered, compare-and-swap on the
 * refused id. The capture counters, the epoch and its counter stay — one host
 * session, one counter — and the life is registered now.
 *
 * THE LIFE'S WORK CONTEXT IS OWED IN THE SAME LOCKED STEP (review-2 round 6,
 * HIGH-1): the state never names a life without the debt that its records'
 * flushes pay first (spool/owed-work-context.ts). A parallel capture for the
 * life finds the debt; a SessionEnd that finds the life counts it as
 * undelivered and defers.
 *
 * THE SEEN-SET STARTS EMPTY ON EVERY HEAL, the same id's too (review-2
 * MEDIUM-1). It deduplicates targets per work context the HUB holds, and a
 * refused life's records may never have reached it: a file in the set would
 * never be captured again, with no further loss counted.
 */
const swapLife = (
  input: SessionHealerInput,
  refusedSessionId: string,
  sessionId: string,
  developerId: string | null,
  workContext: Record<string, unknown>,
): Promise<Swap> =>
  underSessionStateLock<Swap>(input.home, input.hostSessionKey, "lock_busy", async () => {
    const fresh = await readSessionState(input.home, input.hostSessionKey);
    if (fresh === null || fresh.crosscheckSessionId !== refusedSessionId) {
      return "cas_lost";
    }
    await oweWorkContext(input.home, input.repoKey, sessionSlug(input.hostSessionKey), {
      sessionId,
      record: workContext,
    });
    await writeSessionState(input.home, {
      ...fresh,
      crosscheckSessionId: sessionId,
      workContextId: workContextIdFor(sessionId),
      developerId: developerId ?? fresh.developerId,
      seenTargets: [],
    });
    return "swapped";
  });

/** The work context of the life the walk registered — the record every later one of it names. */
const nextWorkContext = (
  input: SessionHealerInput,
  state: SessionState,
  sessionId: string,
  developerId: string | null,
  now: Date,
): Record<string, unknown> =>
  workContextRecord(
    {
      workContextId: workContextIdFor(sessionId),
      sessionId,
      title: state.workContextTitle ?? fallbackWorkContextTitle(input.branch, input.repoId),
      status: state.workContextStatus ?? HEAL_STATUS,
    },
    {
      developerId: developerId ?? state.developerId ?? UNKNOWN_DEVELOPER_ID,
      agentKind: input.agentKind,
      sessionId,
    },
    now,
  );

const healedTo = (refusedSessionId: string, sessionId: string): HealResult => ({
  outcome: "healed",
  refusedSessionId,
  sessionId,
});

/**
 * The life the state file moved to while this heal was not looking — a
 * sibling's heal, a SessionStart — or null when it still names the refused one
 * or is gone.
 */
const movedLife = async (input: SessionHealerInput, refusedSessionId: string): Promise<string | null> => {
  const state = await readSessionState(input.home, input.hostSessionKey);
  return state === null || state.crosscheckSessionId === refusedSessionId ? null : state.crosscheckSessionId;
};

/**
 * A life the walk registered that no state file names: ended on the hub at
 * once — it never allocated a position, so its end travels the refusal that
 * says so — and written down as the newest ended life, so a resume starts
 * above it. Best-effort: an end that does not land leaves the life to the
 * hub's reaper, and the lineage still keeps the resume off it.
 *
 * NEVER A LIFE THE STATE NAMES (review-2 round 6, MEDIUM-1), checked under
 * the state lock, the end sent inside it so no switch can name the life in
 * between. A lock that stays busy retires nothing: the state may name it.
 */
const retireOrphan = async (input: SessionHealerInput, sessionId: string, now: Date): Promise<void> => {
  const retired = await underSessionStateLock(input.home, input.hostSessionKey, false, async () => {
    if ((await readSessionState(input.home, input.hostSessionKey))?.crosscheckSessionId === sessionId) {
      return false;
    }
    await endSession(input.hub, sessionId, ALLOCATION_FAILED);
    return true;
  });
  if (!retired) {
    return;
  }
  const baseId = crosscheckSessionIdFor(input.hostSessionKey);
  const ended = await readEndedLifeRung(input.home, input.hostSessionKey, baseId);
  if ((lifeRungOf(baseId, sessionId) ?? 0) > (ended ?? -1)) {
    await recordEndedLife(input.home, input.hostSessionKey, sessionId, now);
  }
};

/**
 * The heal binds to the SESSION's repo, never the hook's (review finding 7): a
 * hook that resolved another repo — a Stop in a multi-repo workspace — must
 * not re-home the session. The next life's registration, the loss report it
 * carries, the refused-life note and the next work context all follow the
 * binding the state file holds; the hub connection stays the hook's.
 */
const boundToSession = (input: SessionHealerInput, state: SessionState): SessionHealerInput => {
  const key = repoKey(state.hubUrl, state.repoId);
  return { ...input, repoId: state.repoId, repoKey: key, hub: { ...input.hub, repoKey: key } };
};

/** The walk itself, once `mayWalk` allowed it and the attempt is stamped. */
const walk = async (
  input: SessionHealerInput,
  state: SessionState,
  refusal: SessionRefusal,
  deadlineMs: number,
  now: Date,
): Promise<HealResult> => {
  const ladder = await registerSessionLadder({
    home: input.home,
    repoKey: input.repoKey,
    hub: input.hub,
    agentKind: input.agentKind,
    hostSessionKey: input.hostSessionKey,
    repoId: input.repoId,
    branch: input.branch,
    baseCommit: input.baseCommit,
    status: state.workContextStatus ?? HEAL_STATUS,
    guarantees: input.guarantees,
    seq: state.seqEpoch === null ? ALLOCATION_FAILED : { epoch: state.seqEpoch, n: 0 },
    // First-wins: a live session with this id bound to ANOTHER repo stops
    // the walk rather than spawning a sibling for the foreign repo.
    recovery: true,
    liveSessionId: refusal.sessionId,
    ...(refusal.cause === "session_ended" ? { endedSessionId: refusal.sessionId } : {}),
    deadlineMs,
  });
  if (ladder.outcome !== "registered") {
    return FAILED;
  }
  // A life the walk climbed past is written down as refused already — by the
  // heal, for a refusal as ended, and by the ladder, for a 409 on it — so its
  // stragglers are withheld from every later flush (spool/refused-lives.ts).
  // Then the life's work context, OWED — a heal onto the SAME id too (review-2
  // finding 1): the one registration spooled may have been spent by then,
  // and every later record of the life names it. The debt is written with
  // the switch, under the state lock (swapLife), and paid at the head of the
  // next batch that carries the life's records, however many flushes that
  // takes (review-2 round 6, HIGH-1) — the caller's re-send first, built
  // from the state as it is when it goes (review-2 round 7, M1).
  const workContext = nextWorkContext(input, state, ladder.sessionId, ladder.developerId, now);
  const swap = await swapLife(input, refusal.sessionId, ladder.sessionId, ladder.developerId, workContext);
  if (swap === "lock_busy") {
    // NOT A LOST RACE (review-2 round 6, MEDIUM-1): nothing is known about the
    // state, only that the switch could not take the lock. The heal is
    // pending — the caller keeps its batch, and the next one walks again. A
    // life this walk registered that the state does not name is retired; one
    // it does name — the same id, registered as itself — never is.
    await retireOrphan(input, ladder.sessionId, now);
    return PENDING;
  }
  if (swap === "cas_lost") {
    // Lost the compare-and-swap: a sibling moved the state first. Its life is
    // the answer — usually the very one this walk just registered (review P4).
    const moved = await movedLife(input, refusal.sessionId);
    if (moved !== ladder.sessionId) {
      // ...and when it is not — SessionEnd deleted the state mid-walk, or a
      // sibling landed elsewhere — the life this walk registered belongs to
      // nobody. Left open, the next resume would land on it under a fresh
      // epoch and split its order (review finding 6).
      await retireOrphan(input, ladder.sessionId, now);
    }
    return moved === null ? FAILED : healedTo(refusal.sessionId, moved);
  }
  return healedTo(refusal.sessionId, ladder.sessionId);
};

/**
 * Whether a send under `sessionId` would only be refused again: the last
 * walk for that very life finished with nothing registered, and its cooldown
 * runs (review-2 LOW-5). A flush pinned on its own head batch used to re-send
 * it on every hook for the whole five minutes.
 */
const refusedFor =
  (input: SessionHealerInput) =>
  async (sessionId: string): Promise<boolean> => {
    const stamp = await readStamp(input);
    return (
      stamp !== null &&
      !stamp.walking &&
      stamp.failedFor === sessionId &&
      input.now().getTime() - stamp.atMs < HEAL_COOLDOWN_MS
    );
  };

const heal =
  (input: SessionHealerInput) =>
  async (refusal: SessionRefusal, deadlineMs: number, beforeWalk?: () => Promise<void>): Promise<HealResult> => {
    const state = await readSessionState(input.home, input.hostSessionKey);
    if (state === null) {
      return FAILED;
    }
    if (refusal.cause === "session_ended") {
      // THE HUB SAID THE LIFE IS OVER — a heartbeat's 409 as much as a
      // flush's refusal — and that holds whether or not a walk lands past it
      // (review-2 round 7, found by the spool simulation): its stragglers are
      // withheld from every later flush (spool/refused-lives.ts).
      await recordRefusedLife(input.home, boundToSession(input, state).repoKey, refusal.sessionId, input.now());
    }
    // Healed already — by a sibling hook, or a SessionStart that re-registered.
    // Its life is the answer, and costs no walk.
    if (state.crosscheckSessionId !== refusal.sessionId) {
      return healedTo(refusal.sessionId, state.crosscheckSessionId);
    }
    const now = input.now();
    const allowed = await mayWalk(input, now, deadlineMs);
    if (allowed !== "walk") {
      // The cooldown's verdict, unless a sibling moved the state since the read above.
      const moved = await movedLife(input, refusal.sessionId);
      return moved === null ? allowed : healedTo(refusal.sessionId, moved);
    }
    if (!(await writeStamp(input, now, "walking", deadlineMs))) {
      return FAILED;
    }
    await beforeWalk?.();
    const result = await walk(boundToSession(input, state), state, refusal, deadlineMs, now);
    if (result.outcome === "pending") {
      // The switch met a busy lock: no verdict, so no cooldown and no
      // `failed` — the next hook walks again (review-2 round 6, MEDIUM-1).
      await removeFile(healPath(input));
      return result;
    }
    await writeStamp(input, now, "done", deadlineMs, result.outcome === "healed" ? null : refusal.sessionId);
    return result;
  };

export const sessionHealer = (input: SessionHealerInput): SessionHealer =>
  Object.assign(heal(input), { refusedFor: refusedFor(input) });
