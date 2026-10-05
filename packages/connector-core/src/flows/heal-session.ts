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
 * session (spec 01 §3.4). A session the hub never registered is registered as
 * ITSELF: the walk starts at its own rung, which the hub then creates.
 *
 * BOUNDED TWICE. Once per flush, by the caller; and once per HEAL_COOLDOWN_MS
 * per session, here — the attempt is stamped beside the state file
 * (`sessions/<slug>.heal`) before the walk, so a hub that refuses every
 * register costs one walk per cooldown, not one per hook. The walk itself runs
 * to the caller's deadline.
 */
import type { CausalGuaranteeTriple } from "@crosscheck/schema";

import { HEAL_COOLDOWN_MS } from "../constants.ts";
import {
  readJsonOrNull,
  sessionHealPathForSlug,
  sessionSlug,
  writePrivateFile,
} from "../config/paths.ts";
import { UNKNOWN_DEVELOPER_ID, workContextRecord } from "../capture/records.ts";
import { ALLOCATION_FAILED } from "../capture/seq.ts";
import type { HubContext } from "../http/client.ts";
import { appendRecords } from "../spool/append.ts";
import type { SessionHealer } from "../spool/flush-heal.ts";
import { recordRefusedLife } from "../spool/refused-lives.ts";
import {
  readSessionState,
  updateSessionState,
  workContextIdFor,
} from "../state/session-state.ts";
import type { SessionState } from "../state/session-state.ts";
import { fallbackWorkContextTitle, registerSessionLadder } from "./register-session.ts";

export type { SessionHeal, SessionHealer } from "../spool/flush-heal.ts";

/** The status a healed life's work context is registered with when state has none. */
const HEAL_STATUS = "implementing";

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

const healPath = (input: SessionHealerInput): string =>
  sessionHealPathForSlug(input.home, sessionSlug(input.hostSessionKey));

/** When the last walk started, or NaN when none is on record. */
const lastAttemptMs = async (input: SessionHealerInput): Promise<number> => {
  const stamp = (await readJsonOrNull(healPath(input))) as { at?: unknown } | null;
  return typeof stamp?.at === "string" ? Date.parse(stamp.at) : Number.NaN;
};

/**
 * Stamps the attempt BEFORE the walk, so a hook killed mid-walk still counts
 * it; false while one is cooling down. Two hooks racing past the read both
 * walk, and the second one's walk lands on the first one's life and changes
 * nothing (`switchState` compares and swaps) — one extra register call, once.
 */
const claimAttempt = async (input: SessionHealerInput, now: Date): Promise<boolean> => {
  const attemptedMs = await lastAttemptMs(input);
  if (!Number.isNaN(attemptedMs) && now.getTime() - attemptedMs < HEAL_COOLDOWN_MS) {
    return false;
  }
  try {
    await writePrivateFile(healPath(input), `${JSON.stringify({ at: now.toISOString() })}\n`);
    return true;
  } catch {
    // A stamp that cannot be written is a cooldown that cannot be kept: no walk.
    return false;
  }
};

/**
 * The state's switch to the life the walk registered, compare-and-swap on the
 * refused id. The capture counters, the epoch and its counter stay — one host
 * session, one counter — and a NEW life's seen-set starts empty, because it
 * deduplicates targets per WORK CONTEXT and the next life has a new one.
 */
const switchState = (
  input: SessionHealerInput,
  refusedSessionId: string,
  sessionId: string,
  developerId: string | null,
): Promise<boolean> =>
  updateSessionState(input.home, input.hostSessionKey, (fresh) =>
    fresh.crosscheckSessionId !== refusedSessionId
      ? null
      : {
          ...fresh,
          crosscheckSessionId: sessionId,
          workContextId: workContextIdFor(sessionId),
          developerId: developerId ?? fresh.developerId,
          seenTargets: sessionId === refusedSessionId ? fresh.seenTargets : [],
        },
  );

/** The next life's work context, spooled before any record that names it. */
const spoolNextWorkContext = async (
  input: SessionHealerInput,
  state: SessionState,
  sessionId: string,
  developerId: string | null,
  now: Date,
): Promise<void> => {
  await appendRecords(
    input.home,
    input.repoKey,
    input.hostSessionKey,
    [
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
      ),
    ],
    now,
  );
};

export const sessionHealer =
  (input: SessionHealerInput): SessionHealer =>
  async (refusedSessionId, deadlineMs) => {
    const state = await readSessionState(input.home, input.hostSessionKey);
    if (state === null) {
      return null;
    }
    // Healed already — by a sibling hook, or a SessionStart that re-registered.
    // Its life is the answer, and costs no walk.
    if (state.crosscheckSessionId !== refusedSessionId) {
      return { refusedSessionId, sessionId: state.crosscheckSessionId };
    }
    const now = input.now();
    if (!(await claimAttempt(input, now))) {
      return null;
    }
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
      liveSessionId: refusedSessionId,
      deadlineMs,
    });
    if (ladder.outcome !== "registered") {
      return null;
    }
    if (!(await switchState(input, refusedSessionId, ladder.sessionId, ladder.developerId))) {
      return null;
    }
    if (ladder.sessionId !== refusedSessionId) {
      // The refused life's stragglers are withheld from every later flush on
      // this repo (spool/refused-lives.ts), then the next life's work context.
      await recordRefusedLife(input.home, input.repoKey, refusedSessionId, now);
      await spoolNextWorkContext(input, state, ladder.sessionId, ladder.developerId, now);
    }
    return { refusedSessionId, sessionId: ladder.sessionId };
  };
