/**
 * The READER for the capture counters (trial findings #17/#18/#20).
 *
 * PostToolUse books every edit-tool fire, every target it spooled, the last
 * tool name and the last edited path with the root it resolved against (or
 * null) into the session state — and a count nobody reads keeps nothing
 * honest: 371 worktree edits produced 0 targets across the trial and no
 * surface said so. This scan is what `crosscheck status` (two lines) and
 * `crosscheck doctor` (the `capture` and `hints` checks) print.
 *
 * Repo-scoped and bounded: at most STATUS_MAX_SESSION_STATES state files are
 * read, and any surprise answers zeros, never a throw — diagnostic surfaces,
 * not gates. Two things the bound must not do, because a truncated read is
 * indistinguishable from a broken capture on exactly these surfaces:
 *
 *   - it must not be spent at RANDOM. `readdir` returns UUID file names in OS
 *     hash order, so a plain slice reads an arbitrary subset and the live
 *     session of this repo can miss the window entirely — zero targets, zero
 *     fires, a PASSing `capture` check, on the machine the counters were
 *     built for. The entries are stat'd and sorted NEWEST FIRST instead, and
 *     `statesRead`/`statesTotal` let the surfaces say the cut happened.
 *   - it must not claim more than it measured. A state file exists until
 *     SessionEnd deletes it, so it means "this session never ended" — the
 *     trial found 104 of 127 sessions never closed and no reaper. Sessions
 *     silent for longer than STATUS_SESSION_IDLE_HOURS are counted as IDLE
 *     and reported as such; their counters stay in the totals (they really
 *     were captured) but nothing here calls them live.
 *
 * `statesUnparsed` counts files that were read and did not parse — before, a
 * corrupt state file was indistinguishable from an absent one.
 *
 * No render-layer import here on purpose: this module returns counts, ISO
 * strings and the developer's own local paths; the registered surfaces
 * (cli/doctor.ts, cli/status.ts) do the formatting.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  DOCTOR_CAPTURE_SILENT_FIRES_WARN,
  HOURS_PER_DAY,
  MS_PER_DAY,
  STATUS_MAX_SESSION_STATES,
  STATUS_SESSION_IDLE_HOURS,
} from "../constants.ts";
import { readTextOrNull } from "../config/paths.ts";
import { SessionStateSchema } from "./session-state.ts";
import type { SessionState } from "./session-state.ts";

const idleWindowMs = (): number =>
  (STATUS_SESSION_IDLE_HOURS / HOURS_PER_DAY) * MS_PER_DAY;

/**
 * Silent since `idleBefore`: the last heartbeat, or — for a session that never
 * wrote one — its start. An unparseable stamp reads as idle, since the only
 * thing that could make it fresh is a clock we cannot read.
 */
const isIdleSince = (state: SessionState, idleBefore: number): boolean => {
  const stamp = Date.parse(state.lastHeartbeatAt ?? state.startedAt);
  return Number.isNaN(stamp) || stamp < idleBefore;
};

export interface SessionCaptureHealth {
  /** The host's session key (the state file name); surfaces show a prefix. */
  readonly hostSessionKey: string;
  readonly startedAt: string;
  /** The root the session was bound to at SessionStart (#18 diagnosis). */
  readonly repoRoot: string;
  /** The last heartbeat this session wrote, or null when it never has. */
  readonly lastHeartbeatAt: string | null;
  /** No fire, no heartbeat for STATUS_SESSION_IDLE_HOURS — never ended, not live. */
  readonly isIdle: boolean;
  /** Edit-tool PostToolUse fires, counted BEFORE any drop. */
  readonly editToolFires: number;
  /** Targets actually spooled (monotonic; seenTargets is FIFO-capped). */
  readonly targetsCapturedCount: number;
  readonly lastTargetAt: string | null;
  readonly lastPostToolUseTool: string | null;
  readonly lastEditedPath: string | null;
  /** The root the last edited path resolved against; null = it did not. */
  readonly lastEditedPathResolvedAgainst: string | null;
  readonly foreignRepoDrops: number;
  readonly outsideRootDrops: number;
  /** Hint candidates the prompt path saw from the hub (flows/hint.ts). */
  readonly hintCandidatesSeen: number;
  /** Hints delivered to this session (the seen-set's length). */
  readonly hintsDelivered: number;
}

export interface CaptureHealth {
  /** Sessions of this repo+hub that never ended, newest first. */
  readonly sessions: readonly SessionCaptureHealth[];
  /** How many of `sessions` have gone quiet past STATUS_SESSION_IDLE_HOURS. */
  readonly idleSessions: number;
  /** State files this home holds (all repos, all hubs) — the cut's denominator. */
  readonly statesTotal: number;
  /** State files actually opened: the newest STATUS_MAX_SESSION_STATES of them. */
  readonly statesRead: number;
  /** Opened files whose contents were not session state (corrupt, half-written). */
  readonly statesUnparsed: number;
  readonly fires: number;
  readonly targets: number;
  /**
   * Touches this repo's open sessions resolved against no root of their own
   * repo (trial finding #17). Summed here because a session can drop a
   * hundred of them and still capture one target, which keeps
   * `isCaptureSilentlyDead` false — so without this line the counter reaches
   * no surface at all in that shape.
   */
  readonly outsideDrops: number;
  /** The newest lastTargetAt across the sessions, or null. */
  readonly lastTargetAt: string | null;
  readonly hintsDelivered: number;
  readonly hintCandidatesSeen: number;
}

const NO_HEALTH: CaptureHealth = {
  sessions: [],
  idleSessions: 0,
  statesTotal: 0,
  statesRead: 0,
  statesUnparsed: 0,
  fires: 0,
  targets: 0,
  outsideDrops: 0,
  lastTargetAt: null,
  hintsDelivered: 0,
  hintCandidatesSeen: 0,
};

const SESSIONS_DIR = "sessions";
const STATE_FILE_SUFFIX = ".json";

const newerIso = (a: string | null, b: string | null): string | null => {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  return Date.parse(b) > Date.parse(a) ? b : a;
};

/** mtime, or 0 for a file that vanished between the readdir and the stat. */
const modifiedAt = async (path: string): Promise<number> => {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * GONE — SessionEnd deleted it between the readdir and here — or the parse
 * result. Deliberately NOT `readJsonOrNull`, which folds bad JSON into the
 * same null as an absent file: the two are the difference between "nothing to
 * report" and "a state file on this machine is corrupt", and this reader is
 * the surface that has to tell them apart.
 */
const GONE = "gone";

const readStateFile = async (
  path: string,
): Promise<typeof GONE | ReturnType<typeof SessionStateSchema.safeParse>> => {
  const text = await readTextOrNull(path);
  if (text === null) {
    return GONE;
  }
  try {
    return SessionStateSchema.safeParse(JSON.parse(text));
  } catch {
    return SessionStateSchema.safeParse(undefined);
  }
};

export const readCaptureHealth = async (
  home: string,
  hubUrl: string,
  repoId: string,
  now: Date = new Date(),
): Promise<CaptureHealth> => {
  let names: readonly string[];
  try {
    names = await readdir(join(home, SESSIONS_DIR));
  } catch {
    return NO_HEALTH;
  }
  const stateNames = names.filter((name) => name.endsWith(STATE_FILE_SUFFIX));
  const stamped = await Promise.all(
    stateNames.map(async (name) => {
      const path = join(home, SESSIONS_DIR, name);
      return { path, modifiedAt: await modifiedAt(path) };
    }),
  );
  // Newest first, THEN the cap: the sessions a surface is asked about are the
  // ones that wrote most recently, and a session that just fired a hook wrote
  // its state file microseconds ago.
  const window = [...stamped]
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .slice(0, STATUS_MAX_SESSION_STATES);
  const parsed = await Promise.all(
    window.map((entry) => readStateFile(entry.path)),
  );
  const idleBefore = now.getTime() - idleWindowMs();
  const sessions = parsed
    .flatMap((entry) => (entry !== GONE && entry.success ? [entry.data] : []))
    .filter((state) => state.hubUrl === hubUrl && state.repoId === repoId)
    .map(
      (state): SessionCaptureHealth => ({
        hostSessionKey: state.hostSessionKey,
        startedAt: state.startedAt,
        lastHeartbeatAt: state.lastHeartbeatAt,
        isIdle: isIdleSince(state, idleBefore),
        repoRoot: state.repoRoot,
        editToolFires: state.editToolFires,
        targetsCapturedCount: state.targetsCapturedCount,
        lastTargetAt: state.lastTargetAt,
        lastPostToolUseTool: state.lastPostToolUseTool,
        lastEditedPath: state.lastEditedPath,
        lastEditedPathResolvedAgainst: state.lastEditedPathResolvedAgainst,
        foreignRepoDrops: state.foreignRepoDrops,
        outsideRootDrops: state.outsideRootDrops,
        hintCandidatesSeen: state.hintCandidatesSeen,
        hintsDelivered: state.deliveredHintRefs.length,
      }),
    )
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return sessions.reduce<CaptureHealth>(
    (total, session) => ({
      ...total,
      sessions: [...total.sessions, session],
      idleSessions: total.idleSessions + (session.isIdle ? 1 : 0),
      fires: total.fires + session.editToolFires,
      targets: total.targets + session.targetsCapturedCount,
      outsideDrops: total.outsideDrops + session.outsideRootDrops,
      lastTargetAt: newerIso(total.lastTargetAt, session.lastTargetAt),
      hintsDelivered: total.hintsDelivered + session.hintsDelivered,
      hintCandidatesSeen: total.hintCandidatesSeen + session.hintCandidatesSeen,
    }),
    {
      ...NO_HEALTH,
      statesTotal: stateNames.length,
      statesRead: window.length,
      statesUnparsed: parsed.filter(
        (entry) => entry !== GONE && !entry.success,
      ).length,
    },
  );
};

/**
 * The #17/#18 signature, made a predicate: edits keep firing and NOTHING is
 * captured. Below the threshold one or two fires that landed nowhere are a
 * denylisted lockfile or a loose scratch file — noise; at it, the remainder
 * is exactly Ken's "0 targets" shape and the 371-edit worktree silence.
 */
export const isCaptureSilentlyDead = (session: SessionCaptureHealth): boolean =>
  session.editToolFires >= DOCTOR_CAPTURE_SILENT_FIRES_WARN &&
  session.targetsCapturedCount === 0;
