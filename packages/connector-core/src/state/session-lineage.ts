/**
 * THE LIVES OF ONE HOST SESSION (pilot, 2026-10-05).
 *
 * A host keeps one session id for the whole life of a conversation: Claude
 * Code resumes `claude --resume`, a VS Code reload and every reopened chat
 * under the SAME `session_id`, a Cursor chat keeps its `conversation_id`, an
 * ACP `session/load` names the session it loads. Each of those lives ENDS its
 * crosscheck session — SessionEnd, sessionEnd, a proxy exit — and an end the
 * connector reported is final on the hub: every later record in that
 * session's name is refused as a late write (server services/records.ts
 * checkProducerSession), while the spool cursor moves past it.
 *
 * So a life after an end is a NEW crosscheck session, one rung up:
 * `cc_<key>`, `cc_<key>~r1`, `cc_<key>~r2`, … Each rung is its own session
 * with its own epoch and its own end, which is what spec 01 §3.4 needs —
 * order exists only inside one (session, epoch), and a reported end stays
 * the last position of the session it ended. Nothing is reopened, nothing is
 * folded into an epoch that already ended, and the hub needs no change: a hub
 * from before this file answers the ladder exactly as it always did.
 *
 * THE LADDER HAD THREE RUNGS, and the pilot's conversations ran off its end:
 * the fourth life found every rung ended and registered nothing, kept the base
 * id the hub had just refused, and lost every record it captured for a month.
 * The walk is now as long as a conversation, and cheap because it starts at
 * the newest life this machine knows — the live one its state file names, or
 * the one its last end wrote down here — and gallops from there.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import {
  MAX_KNOWN_WORKTREE_ROOTS,
  MAX_SPOOL_AGE_DAYS,
  MS_PER_DAY,
  REGISTER_LADDER_MAX_ATTEMPTS,
  SESSION_STATE_REAP_MAX_PER_RUN,
} from "../constants.ts";
import {
  readJsonOrNull,
  repoKey,
  sessionLineagePathForSlug,
  sessionSlug,
  sessionStatePathForSlug,
  writePrivateFile,
} from "../config/paths.ts";
import { recordCaptureLoss } from "./loss-ledger.ts";
import { sessionStateDir } from "./session-scan.ts";
import { KnownWorktreeRootSchema } from "./session-state.ts";
import type { KnownWorktreeRoot, SessionState } from "./session-state.ts";

const LIFE_SUFFIX = "~r";
const LINEAGE_SUFFIX = ".lineage";
/** The mid-life heal's cooldown stamp (flows/heal-session.ts), swept the same way. */
const HEAL_SUFFIX = ".heal";
/** A register's reserved epoch (flows/register-session.ts), swept the same way. */
const EPOCH_SUFFIX = ".epoch";
/** SessionEnd's "rests booked" marker (state/rests-booked.ts), swept the same way. */
const RESTS_BOOKED_SUFFIX = ".rests-booked";
const SIDE_FILE_SUFFIXES = [LINEAGE_SUFFIX, HEAL_SUFFIX, EPOCH_SUFFIX, RESTS_BOOKED_SUFFIX] as const;
/** A rung as the ladder spells it: no sign, no leading zero, nine digits at most. */
const RUNG_PATTERN = /^[1-9][0-9]{0,8}$/;

/**
 * WHAT THE NEXT LIFE'S GIT LANE NEEDS OF THIS ONE (review batch 2, H1): the
 * binding it was captured under, the conversation's first start — the
 * window — and the roots of its repo it touched, each with its own first
 * touch and any shell mark no sweep had spent yet. A life's end takes its
 * contexts off every collision surface (an ended life is no live work), so
 * what it left dirty, committed or Bash-created reaches a teammate again only
 * when the next life files it; with the state file gone, this is the only
 * place that knows where to look.
 */
const CarriedCaptureSchema = z.looseObject({
  repoId: z.string().min(1),
  hubUrl: z.string().min(1),
  since: z.string().min(1),
  roots: z.array(KnownWorktreeRootSchema).max(MAX_KNOWN_WORKTREE_ROOTS),
  shellSweepSince: z.string().min(1).nullable().default(null),
});

export type CarriedCapture = z.infer<typeof CarriedCaptureSchema>;

const LineageSchema = z.looseObject({
  /**
   * The life the last END closed. Absent on a note the state reaper wrote for
   * a life that died without one (recordReapedCapture): that life is not
   * ended here — its marker still restores it for a resume — the note only
   * carries what it owed.
   */
  crosscheckSessionId: z.string().min(1).optional(),
  epoch: z.string().min(1).optional(),
  /** The position the end took under `epoch`, past everything the life's counter handed out. */
  n: z.number().int().min(0).optional(),
  /** When the end was written down. */
  at: z.string().min(1).optional(),
  /** A capture that will not parse is no capture: the ladder's fields above must still read. */
  capture: CarriedCaptureSchema.optional().catch(undefined),
});

/** The crosscheck session id of a host session's `rung`-th life. */
export const lifeSessionId = (baseId: string, rung: number): string =>
  rung === 0 ? baseId : `${baseId}${LIFE_SUFFIX}${String(rung)}`;

/**
 * The conversation a crosscheck session id belongs to: its base id, every
 * life of one host session sharing it. Two ids of one conversation are lives
 * of the same work; two different bases are two conversations.
 */
export const conversationOf = (sessionId: string): string => {
  const at = sessionId.lastIndexOf(LIFE_SUFFIX);
  return at > 0 && RUNG_PATTERN.test(sessionId.slice(at + LIFE_SUFFIX.length))
    ? sessionId.slice(0, at)
    : sessionId;
};

/** Which life an id names, or null when it is not one of `baseId`'s. */
export const lifeRungOf = (
  baseId: string,
  sessionId: string | null | undefined,
): number | null => {
  if (sessionId === baseId) {
    return 0;
  }
  const prefix = `${baseId}${LIFE_SUFFIX}`;
  if (sessionId === null || sessionId === undefined || !sessionId.startsWith(prefix)) {
    return null;
  }
  const rung = sessionId.slice(prefix.length);
  return RUNG_PATTERN.test(rung) ? Number(rung) : null;
};

/**
 * The rungs one walk tries: the start itself — a re-fire's live life, which
 * the hub answers `updated` — then +1, the next life after an end, then
 * galloping. A rung skipped by the gallop is only a name nobody took.
 */
export const ladderRungs = (start: number): readonly number[] =>
  Array.from(
    { length: REGISTER_LADDER_MAX_ATTEMPTS },
    (_, attempt) => start + (attempt === 0 ? 0 : 2 ** (attempt - 1)),
  );

/**
 * Where the walk starts: the life the state file is on, unless an END at or
 * above it was written down — then the life above that end. Both are hints, and
 * neither is required: with no hint the walk starts at the base id.
 *
 * NEVER ON THE ENDED RUNG. A life the host ended is over whether or not the
 * hub heard it: when SessionEnd's `end` failed or was deferred, the hub still
 * holds that life open and answers a register on it `updated`, and the resume
 * — whose state file was deleted with the end, so it mints a fresh epoch —
 * would then file a second epoch into it and break its order for good. The
 * deferred end still closes it from its marker (spool/reap.ts).
 */
export const ladderStart = (
  baseId: string,
  liveSessionId: string | null,
  endedRung: number | null,
): number => {
  const live = lifeRungOf(baseId, liveSessionId);
  return endedRung !== null && (live === null || endedRung >= live) ? endedRung + 1 : (live ?? 0);
};

const lineagePath = (home: string, hostSessionKey: string): string =>
  sessionLineagePathForSlug(home, sessionSlug(hostSessionKey));

/** The rung of the crosscheck session this host session ended last, if known. */
export const readEndedLifeRung = async (
  home: string,
  hostSessionKey: string,
  baseId: string,
): Promise<number | null> => {
  const parsed = LineageSchema.safeParse(await readJsonOrNull(lineagePath(home, hostSessionKey)));
  return parsed.success ? lifeRungOf(baseId, parsed.data.crosscheckSessionId) : null;
};

/**
 * The epoch the life this host session ended last was on, if written down
 * (review-2 round 8, L2, seed 11974). A heal's register of the next life goes
 * out under the state's epoch, and one the hub took after the heal stopped
 * listening left that life open under it with no state naming it once
 * SessionEnd deleted the file. The resume that lands on it takes this epoch,
 * not a fresh mint: nothing was positioned in that life but `session.started`.
 */
export const readEndedLifeEpoch = async (home: string, hostSessionKey: string): Promise<string | null> => {
  const parsed = LineageSchema.safeParse(await readJsonOrNull(lineagePath(home, hostSessionKey)));
  return parsed.success ? (parsed.data.epoch ?? null) : null;
};

/** An end's position: the epoch and the position it took. */
export interface EndedLifePosition {
  readonly epoch: string;
  readonly n: number;
}

/**
 * THE POSITION THE LAST END WRITTEN DOWN TOOK, when it closed `sessionId`
 * (all seed 30495) — what the life's end marker keeps until the hub takes the
 * end, and nothing keeps after. A SessionStart re-fire that read the state
 * before a SessionEnd beside it deleted the file, and settled back on the same
 * life, found neither the state nor the marker, and started the life on a
 * fresh mint: the heal that followed carried that epoch into the next life,
 * which an unheard heal had opened under the old one.
 */
export const readEndedLifePosition = async (
  home: string,
  hostSessionKey: string,
  sessionId: string,
): Promise<EndedLifePosition | null> => {
  const parsed = LineageSchema.safeParse(await readJsonOrNull(lineagePath(home, hostSessionKey)));
  if (!parsed.success || parsed.data.crosscheckSessionId !== sessionId) {
    return null;
  }
  const { epoch, n } = parsed.data;
  return epoch === undefined || n === undefined ? null : { epoch, n };
};

/**
 * What a life hands the next one: its binding, the window's start (the
 * conversation's first, `captureSince`, else the life's own) and its own
 * repo's roots — never a foreign one, which no lane sweeps — with what
 * belonged to the life alone (when it swept a root, which untracked cut it
 * booked) left behind.
 */
export const carriedCaptureOf = (state: SessionState): CarriedCapture => ({
  repoId: state.repoId,
  hubUrl: state.hubUrl,
  since: state.captureSince ?? state.startedAt,
  roots: state.knownWorktreeRoots
    .filter((entry) => entry.repoId === state.repoId)
    .slice(-MAX_KNOWN_WORKTREE_ROOTS)
    .map(({ untrackedCutLife: _lifeOnly, ...entry }): KnownWorktreeRoot => ({ ...entry, gitSweptAt: null })),
  shellSweepSince: state.shellSweepSince ?? null,
});

/**
 * The sweeps a capture still owes: its roots a shell worked in that no lane
 * swept since, or — a shell whose words named no root — one. A root swept
 * clean owes nothing: its work was filed, under the life that ended.
 */
export const pendingSweepsOf = (capture: CarriedCapture): number => {
  const marked = capture.roots.filter((root) => root.bashTouchedAt !== null).length;
  return marked > 0 ? marked : capture.shellSweepSince === null ? 0 : 1;
};

/** The loss ledger's word for a sweep no life will make: the hook whose end left it owed. */
const UNSWEPT_DETAIL = "session-end";

/**
 * A CAPTURE NO LIFE WILL SWEEP IS BOOKED, NEVER DROPPED (review batch 2, H1):
 * the shell work it still owed was never filed under any life. Booked like a
 * lane that did not run (flows/git-lane.ts, `hook_timed_out`), keyed to the
 * capture's own repo and dated by the end that left it.
 */
export const bookUnsweptCapture = async (home: string, capture: CarriedCapture, endedAt: Date): Promise<void> => {
  await recordCaptureLoss(home, {
    kind: "hook_timed_out",
    count: pendingSweepsOf(capture),
    key: repoKey(capture.hubUrl, capture.repoId),
    detail: UNSWEPT_DETAIL,
    now: endedAt,
  });
};

const isSameCaptureBinding = (left: CarriedCapture, right: CarriedCapture): boolean =>
  left.repoId === right.repoId && left.hubUrl === right.hubUrl;

/** The capture the last end wrote down, if any (review batch 2, H1). */
export const readCarriedCapture = async (home: string, hostSessionKey: string): Promise<CarriedCapture | null> => {
  const parsed = LineageSchema.safeParse(await readJsonOrNull(lineagePath(home, hostSessionKey)));
  return parsed.success ? (parsed.data.capture ?? null) : null;
};

const instantOr = (iso: string | undefined, fallback: Date): Date => {
  const ms = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isNaN(ms) ? fallback : new Date(ms);
};

/**
 * Written at the END of a life, never at its start: a life that is still
 * running is named by its state file, and a lineage file exists only for host
 * sessions that ended and may come back. Fail-open — a lost write costs the
 * next resume a longer walk from the base id, never a refused record — and
 * said: false when nothing was written, so the caller can book what the
 * capture would have carried.
 *
 * THE CAPTURE (review batch 2, H1): an end that carries one replaces the one
 * on file; an end that carries none — a heal retiring an orphan life, whose
 * state lives on — keeps it. A capture of ANOTHER binding replaced here is
 * one no resume of this conversation can carry any more, and is booked.
 */
export const recordEndedLife = async (
  home: string,
  hostSessionKey: string,
  crosscheckSessionId: string,
  now: Date,
  epoch: string | null = null,
  n: number | null = null,
  capture: CarriedCapture | null = null,
): Promise<boolean> => {
  try {
    const path = lineagePath(home, hostSessionKey);
    const prior = LineageSchema.safeParse(await readJsonOrNull(path));
    const priorCapture = prior.success ? (prior.data.capture ?? null) : null;
    const kept = capture ?? priorCapture;
    await writePrivateFile(
      path,
      `${JSON.stringify({
        crosscheckSessionId,
        ...(epoch === null ? {} : { epoch, ...(n === null ? {} : { n }) }),
        at: now.toISOString(),
        ...(kept === null ? {} : { capture: kept }),
      })}\n`,
    );
    if (capture !== null && priorCapture !== null && !isSameCaptureBinding(priorCapture, capture)) {
      await bookUnsweptCapture(home, priorCapture, instantOr(prior.success ? prior.data.at : undefined, now));
    }
    return true;
  } catch {
    // The ladder still finds the next life without it.
    return false;
  }
};

/**
 * A LIFE THAT DIED WITHOUT SESSIONEND STILL OWES ITS SWEEP (final review of
 * batch 2, the gap behind N1): the state reaper removes its corpse a week on,
 * and the Bash-marked roots no lane swept were then neither delivered nor
 * counted — for a resumed life, N1's consume had taken that count off the
 * note. The reaper writes the capture back here, the way SessionEnd's
 * recordEndedLife does, so a resume still carries and sweeps it and a note
 * nobody resumes is booked when it goes stale (reapStaleLineages, with no
 * live state beside it). WITHOUT ENDING THE LIFE: the ladder's fields stay
 * exactly as the last end wrote them (none, for a first life), because a
 * reaped life is one its end marker still restores for a state-less resume
 * (flows/register-session.ts readMarkedPosition; review-2 round 9, M1 + M2)
 * — naming it ended here would send that resume one rung up, past the
 * counter the hub still holds. A capture of another binding replaced here is
 * booked, as recordEndedLife books it.
 */
export const recordReapedCapture = async (
  home: string,
  hostSessionKey: string,
  capture: CarriedCapture,
  now: Date,
): Promise<boolean> => {
  try {
    const path = lineagePath(home, hostSessionKey);
    const prior = LineageSchema.safeParse(await readJsonOrNull(path));
    const priorCapture = prior.success ? (prior.data.capture ?? null) : null;
    const { capture: _replaced, ...ladder } = prior.success ? prior.data : {};
    await writePrivateFile(path, `${JSON.stringify({ ...ladder, at: now.toISOString(), capture })}\n`);
    if (priorCapture !== null && !isSameCaptureBinding(priorCapture, capture)) {
      await bookUnsweptCapture(home, priorCapture, instantOr(prior.success ? prior.data.at : undefined, now));
    }
    return true;
  } catch {
    return false;
  }
};

/**
 * THE CAPTURE A RESUME TOOK IS STRUCK OFF THE NOTE (review batch 2, final
 * review N1): once the next life's state holds the roots and their marks,
 * that live state owns the debt — its first lane sweeps them, its SessionEnd
 * writes the next capture — and a note that still carried them was booked by
 * the reaper as sweeps never made, after the resumed life had made them: a
 * `hook_timed_out` on the wire, so the hub read the repo's coverage as lost
 * for a fortnight, for a loss that did not happen. The ladder's fields stay;
 * only the capture goes. Fail-open, like every write here: a note that will
 * not rewrite is still never booked beside a live state (reapStaleLineages).
 */
export const consumeCarriedCapture = async (home: string, hostSessionKey: string): Promise<boolean> => {
  try {
    const path = lineagePath(home, hostSessionKey);
    const prior = LineageSchema.safeParse(await readJsonOrNull(path));
    if (!prior.success || prior.data.capture === undefined) {
      return false;
    }
    const { capture: _taken, ...note } = prior.data;
    await writePrivateFile(path, `${JSON.stringify(note)}\n`);
    return true;
  } catch {
    return false;
  }
};

const isLineageStale = async (path: string, nowMs: number): Promise<boolean> => {
  try {
    return nowMs - (await stat(path)).mtimeMs > MAX_SPOOL_AGE_DAYS * MS_PER_DAY;
  } catch {
    return false;
  }
};

/**
 * Whether the host session a lineage note belongs to is still named by a
 * state file: its live life owns whatever the note carried (final review
 * N1) — the resume took the capture into that state, and its next lane or
 * SessionEnd is what delivers or books it. A note beside a live state is
 * spent, never a loss.
 */
const isHostSessionLive = async (home: string, lineageName: string): Promise<boolean> =>
  Bun.file(sessionStatePathForSlug(home, lineageName.slice(0, -LINEAGE_SUFFIX.length))).exists();

/**
 * Lineage notes and heal stamps of host sessions that never came back,
 * removed after the same MAX_SPOOL_AGE_DAYS every other spool artifact obeys
 * and bounded per run like the state reap that calls it. A conversation
 * resumed later than that walks from the base id instead, which the gallop
 * keeps short.
 */
export const reapStaleLineages = async (home: string, now: Date): Promise<number> => {
  const dir = sessionStateDir(home);
  let names: readonly string[];
  try {
    names = (await readdir(dir)).filter((name) =>
      SIDE_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix)),
    );
  } catch {
    return 0;
  }
  let reaped = 0;
  for (const name of names) {
    if (reaped >= SESSION_STATE_REAP_MAX_PER_RUN) {
      break;
    }
    const path = join(dir, name);
    if (!(await isLineageStale(path, now.getTime()))) {
      continue;
    }
    // A conversation that never came back leaves the sweeps its last life
    // still owed unmade (review batch 2, H1): booked once the note is gone,
    // so a note that will not go is not booked again on every run — and
    // never beside a live state of the same host session (final review N1),
    // whose life owns the debt and delivers or books it itself.
    const isLineage = name.endsWith(LINEAGE_SUFFIX);
    const lineage = isLineage ? LineageSchema.safeParse(await readJsonOrNull(path)) : null;
    const isOwedElsewhere = isLineage && (await isHostSessionLive(home, name));
    try {
      await rm(path, { force: true });
      reaped += 1;
    } catch {
      // A file that will not go stays; the next SessionStart tries again.
      continue;
    }
    const capture = lineage?.success === true ? (lineage.data.capture ?? null) : null;
    if (capture !== null && lineage?.success === true && !isOwedElsewhere) {
      await bookUnsweptCapture(home, capture, instantOr(lineage.data.at, now));
    }
  }
  return reaped;
};
