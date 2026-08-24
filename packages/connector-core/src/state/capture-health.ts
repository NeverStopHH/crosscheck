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
 * Repo-scoped and bounded like the summarizer cost reader
 * (connector-claude/src/summarizer/cost.ts): at most STATUS_MAX_SESSION_STATES
 * state files are read, only the LIVE sessions of this repo+hub are summed,
 * and any surprise answers zeros, never a throw — diagnostic surfaces, not
 * gates. Session state is deleted at SessionEnd, so these are per-LIVE-session
 * facts by design.
 *
 * No render-layer import here on purpose: this module returns counts, ISO
 * strings and the developer's own local paths; the registered surfaces
 * (cli/doctor.ts, cli/status.ts) do the formatting.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  DOCTOR_CAPTURE_SILENT_FIRES_WARN,
  STATUS_MAX_SESSION_STATES,
} from "../constants.ts";
import { readJsonOrNull } from "../config/paths.ts";
import { SessionStateSchema } from "./session-state.ts";

export interface SessionCaptureHealth {
  /** The host's session key (the state file name); surfaces show a prefix. */
  readonly hostSessionKey: string;
  readonly startedAt: string;
  /** The root the session was bound to at SessionStart (#18 diagnosis). */
  readonly repoRoot: string;
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
  /** Live sessions of this repo+hub, newest first. */
  readonly sessions: readonly SessionCaptureHealth[];
  readonly fires: number;
  readonly targets: number;
  /**
   * Touches this repo's live sessions resolved against no root of their own
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

export const readCaptureHealth = async (
  home: string,
  hubUrl: string,
  repoId: string,
): Promise<CaptureHealth> => {
  let names: readonly string[];
  try {
    names = await readdir(join(home, SESSIONS_DIR));
  } catch {
    return NO_HEALTH;
  }
  const parsed = await Promise.all(
    names
      .filter((name) => name.endsWith(STATE_FILE_SUFFIX))
      .slice(0, STATUS_MAX_SESSION_STATES)
      .map(async (name) =>
        SessionStateSchema.safeParse(
          await readJsonOrNull(join(home, SESSIONS_DIR, name)),
        ),
      ),
  );
  const sessions = parsed
    .filter((entry) => entry.success)
    .map((entry) => entry.data)
    .filter((state) => state.hubUrl === hubUrl && state.repoId === repoId)
    .map(
      (state): SessionCaptureHealth => ({
        hostSessionKey: state.hostSessionKey,
        startedAt: state.startedAt,
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
      sessions: [...total.sessions, session],
      fires: total.fires + session.editToolFires,
      targets: total.targets + session.targetsCapturedCount,
      outsideDrops: total.outsideDrops + session.outsideRootDrops,
      lastTargetAt: newerIso(total.lastTargetAt, session.lastTargetAt),
      hintsDelivered: total.hintsDelivered + session.hintsDelivered,
      hintCandidatesSeen: total.hintCandidatesSeen + session.hintCandidatesSeen,
    }),
    NO_HEALTH,
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
