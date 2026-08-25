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
 *     built for. `listSessionStateFiles` (state/session-scan.ts) stats every
 *     candidate and sorts NEWEST FIRST before the cap, and
 *     `statesRead`/`statesTotal` let the surfaces say the cut happened.
 *   - it must not claim more than it measured. A state file exists until
 *     SessionEnd deletes it, so it means "this session never ended" — the
 *     trial found 104 of 127 sessions never closed and no reaper. How long
 *     each one has been SILENT is measured once, off the newest of its
 *     heartbeat, its start and its own file's mtime (`sessionSilentForMs`),
 *     and read at two thresholds: `isStale` for the doctor gates,
 *     `isIdle` for the 24 h line `status` prints. Their counters stay in the
 *     totals (they really were captured) but nothing here calls them live.
 *
 * `statesUnparsed` counts files that were read and did not parse — before, a
 * corrupt state file was indistinguishable from an absent one.
 *
 * No render-layer import here on purpose: this module returns counts, ISO
 * strings and the developer's own local paths; the registered surfaces
 * (cli/doctor.ts, cli/status.ts) do the formatting.
 */
import {
  DOCTOR_CAPTURE_SILENT_FIRES_WARN,
  DOCTOR_ZOMBIE_STATE_WARN_HOURS,
  HOURS_PER_DAY,
  MS_PER_DAY,
  STATUS_MAX_SESSION_STATES,
  STATUS_SESSION_IDLE_HOURS,
} from "../constants.ts";
import { readTextOrNull } from "../config/paths.ts";
import { listSessionStateFiles, sessionSilentForMs } from "./session-scan.ts";
import { SessionStateSchema } from "./session-state.ts";

const hoursToMs = (hours: number): number => (hours / HOURS_PER_DAY) * MS_PER_DAY;

export interface SessionCaptureHealth {
  /** The host's session key (the state file name); surfaces show a prefix. */
  readonly hostSessionKey: string;
  readonly startedAt: string;
  /** The root the session was bound to at SessionStart (#18 diagnosis). */
  readonly repoRoot: string;
  /** The last heartbeat this session wrote, or null when it never has. */
  readonly lastHeartbeatAt: string | null;
  /**
   * How long since this session did ANYTHING — heartbeat, start, or a write to
   * its own state file (state/session-scan.ts). Null = nothing datable, which
   * both booleans below read as dead.
   */
  readonly silentForMs: number | null;
  /** Silent for STATUS_SESSION_IDLE_HOURS — never ended, and not live. */
  readonly isIdle: boolean;
  /**
   * Silent for DOCTOR_ZOMBIE_STATE_WARN_HOURS — the predicate every OTHER
   * liveness gate in `doctor` uses (`unclosed sessions`, `last capture sync`,
   * `hooks firing`, `statusline last rendered`). Both windows are measured off
   * the same silence, so a session can never be stale on one line and running
   * on the next; what differs is only how much silence each line is willing to
   * call normal.
   */
  readonly isStale: boolean;
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
  /** State files actually opened: the newest `statesCap` of them. */
  readonly statesRead: number;
  /** The cap this read was given — the caller's, so a surface can name it. */
  readonly statesCap: number;
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
  statesCap: STATUS_MAX_SESSION_STATES,
  statesUnparsed: 0,
  fires: 0,
  targets: 0,
  outsideDrops: 0,
  lastTargetAt: null,
  hintsDelivered: 0,
  hintCandidatesSeen: 0,
};

const newerIso = (a: string | null, b: string | null): string | null => {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  return Date.parse(b) > Date.parse(a) ? b : a;
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

/**
 * `limit` is the caller's, because the two surfaces are asked different
 * questions. `status` prints one repo's totals and takes
 * STATUS_MAX_SESSION_STATES; `doctor` derives EVERY "is anybody running
 * anything here" gate from this one read and takes the wider
 * SESSION_STATE_SCAN_MAX_FILES, so its lines cannot disagree by having been
 * computed over different sets. It comes back as `statesCap` so the surface
 * naming the cut names the real number.
 */
export const readCaptureHealth = async (
  home: string,
  hubUrl: string,
  repoId: string,
  now: Date = new Date(),
  limit: number = STATUS_MAX_SESSION_STATES,
): Promise<CaptureHealth> => {
  // Newest first, THEN the cap — the shared listing (state/session-scan.ts),
  // which also hands back the mtime each session's liveness is measured with.
  const listing = await listSessionStateFiles(home, limit);
  const read = await Promise.all(
    listing.files.map(async (file) => ({
      file,
      parsed: await readStateFile(file.path),
    })),
  );
  const nowMs = now.getTime();
  const idleWindowMs = hoursToMs(STATUS_SESSION_IDLE_HOURS);
  const staleWindowMs = hoursToMs(DOCTOR_ZOMBIE_STATE_WARN_HOURS);
  // ONE pass, keeping each state beside the file it came out of: the repo
  // filter and the liveness measure must judge the SAME session, and building
  // them as two arrays indexed by each other's positions is how they stopped
  // doing that once (review finding B2-02).
  const sessions = read
    .flatMap((entry) =>
      entry.parsed !== GONE && entry.parsed.success
        ? [{ file: entry.file, state: entry.parsed.data }]
        : [],
    )
    .filter(({ state }) => state.hubUrl === hubUrl && state.repoId === repoId)
    .map(({ file, state }): SessionCaptureHealth => {
      const silentForMs = sessionSilentForMs(state, file.mtimeMs, nowMs);
      return {
        hostSessionKey: state.hostSessionKey,
        startedAt: state.startedAt,
        lastHeartbeatAt: state.lastHeartbeatAt,
        silentForMs,
        isIdle: silentForMs === null || silentForMs > idleWindowMs,
        isStale: silentForMs === null || silentForMs > staleWindowMs,
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
      };
    })
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
      statesTotal: listing.filesSeen,
      statesRead: listing.files.length,
      statesCap: limit,
      statesUnparsed: read.filter(
        (entry) => entry.parsed !== GONE && !entry.parsed.success,
      ).length,
    },
  );
};

/**
 * The #17/#18 signature, made a predicate: edits keep firing and NOTHING is
 * captured. Below the threshold one or two fires that landed nowhere are a
 * denylisted lockfile or a loose scratch file — noise; at it, the remainder
 * is exactly Ken's "0 targets" shape and the 371-edit worktree silence.
 *
 * SILENT SESSIONS ARE EXCLUDED (review finding B2-04). A state file is deleted
 * only at SessionEnd and the trial found 104 of 127 sessions never closed, so
 * a home is mostly corpses — and a corpse's counters describe a session
 * nobody is running: yesterday's dead session that captured nothing must not
 * be reported as a capture that is failing NOW, whose remedy ("the next edit
 * updates this line") no one is ever going to trigger. It also makes the
 * predicate mean what DOCTOR_CAPTURE_SILENT_FIRES_WARN already says it means
 * — "a LIVE session's capture" — instead of only the fire/target half of it.
 *
 * THE WINDOW IS `isStale`, NOT `isIdle`. Every other liveness gate in `doctor`
 * asks about DOCTOR_ZOMBIE_STATE_WARN_HOURS, and gating this one on the 24 h
 * idle window put two answers to "is anybody running anything here" in one
 * report: a session three hours quiet drew `1 of 1 session state file stale
 * >1h` from `unclosed sessions` and, four lines down, a capture WARN whose
 * remedy is "the next edit updates this line" — an edit in the session the
 * report had just called stale. `isIdle` stays at 24 h because `status`'s
 * `N idle >24h` clause and the totals still mean that; it is the same measured
 * silence, read at two thresholds, rather than two measures.
 */
export const isCaptureSilentlyDead = (session: SessionCaptureHealth): boolean =>
  !session.isStale &&
  session.editToolFires >= DOCTOR_CAPTURE_SILENT_FIRES_WARN &&
  session.targetsCapturedCount === 0;
