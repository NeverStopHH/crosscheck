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
  MAX_SPOOL_AGE_DAYS,
  MS_PER_DAY,
  REGISTER_LADDER_MAX_ATTEMPTS,
  SESSION_STATE_REAP_MAX_PER_RUN,
} from "../constants.ts";
import {
  readJsonOrNull,
  sessionLineagePathForSlug,
  sessionSlug,
  writePrivateFile,
} from "../config/paths.ts";
import { sessionStateDir } from "./session-scan.ts";

const LIFE_SUFFIX = "~r";
const LINEAGE_SUFFIX = ".lineage";
/** The mid-life heal's cooldown stamp (flows/heal-session.ts), swept the same way. */
const HEAL_SUFFIX = ".heal";
/** A register's reserved epoch (flows/register-session.ts), swept the same way. */
const EPOCH_SUFFIX = ".epoch";
const SIDE_FILE_SUFFIXES = [LINEAGE_SUFFIX, HEAL_SUFFIX, EPOCH_SUFFIX] as const;
/** A rung as the ladder spells it: no sign, no leading zero, nine digits at most. */
const RUNG_PATTERN = /^[1-9][0-9]{0,8}$/;

const LineageSchema = z.looseObject({
  crosscheckSessionId: z.string().min(1),
  epoch: z.string().min(1).optional(),
  /** The position the end took under `epoch`, past everything the life's counter handed out. */
  n: z.number().int().min(0).optional(),
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
 * Written at the END of a life, never at its start: a life that is still
 * running is named by its state file, and a lineage file exists only for host
 * sessions that ended and may come back. Fail-open — a lost write costs the
 * next resume a longer walk from the base id, never a refused record.
 */
export const recordEndedLife = async (
  home: string,
  hostSessionKey: string,
  crosscheckSessionId: string,
  now: Date,
  epoch: string | null = null,
  n: number | null = null,
): Promise<void> => {
  try {
    await writePrivateFile(
      lineagePath(home, hostSessionKey),
      `${JSON.stringify({ crosscheckSessionId, ...(epoch === null ? {} : { epoch, ...(n === null ? {} : { n }) }), at: now.toISOString() })}\n`,
    );
  } catch {
    // The ladder still finds the next life without it.
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
    try {
      await rm(path, { force: true });
      reaped += 1;
    } catch {
      // A file that will not go stays; the next SessionStart tries again.
    }
  }
  return reaped;
};
