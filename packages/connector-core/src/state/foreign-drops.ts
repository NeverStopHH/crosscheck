/**
 * The READER for the foreign-repo drop counter (trial finding #9,
 * adversarial review): first-wins drops a multi-repo workspace's foreign
 * touches and COUNTS them in session state — but a count nobody reads keeps
 * nothing honest. This scan is what `crosscheck doctor` (WARN) and
 * `crosscheck status` (line) print, so "my second repo records nothing"
 * stops being silent.
 *
 * Machine-wide on purpose: the session that dropped a touch of repo B is
 * bound to repo A, so a repo-scoped read from B would never see it. The
 * scan is bounded (FOREIGN_DROPS_SCAN_MAX_FILES state files, the named
 * repos capped) and fail-open: any surprise answers zeros, never a throw —
 * these are diagnostic surfaces, not gates.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  FOREIGN_DROPS_MAX_NAMED_REPOS,
  FOREIGN_DROPS_SCAN_MAX_FILES,
} from "../constants.ts";
import { readJsonOrNull } from "../config/paths.ts";
import { SessionStateSchema } from "./session-state.ts";

export interface ForeignDropSummary {
  /** Total foreign-repo touches dropped across live sessions. */
  readonly drops: number;
  /** How many live sessions dropped at least one. */
  readonly sessions: number;
  /** The repos those sessions ARE bound to (deduplicated, capped). */
  readonly repoIds: readonly string[];
}

const EMPTY: ForeignDropSummary = { drops: 0, sessions: 0, repoIds: [] };

const SESSIONS_DIR = "sessions";
const STATE_FILE_SUFFIX = ".json";

export const readForeignRepoDrops = async (
  home: string,
): Promise<ForeignDropSummary> => {
  try {
    const dir = join(home, SESSIONS_DIR);
    const files = (await readdir(dir))
      .filter((name) => name.endsWith(STATE_FILE_SUFFIX))
      .slice(0, FOREIGN_DROPS_SCAN_MAX_FILES);
    let drops = 0;
    let sessions = 0;
    const repoIds = new Set<string>();
    for (const name of files) {
      const parsed = SessionStateSchema.safeParse(
        await readJsonOrNull(join(dir, name)),
      );
      if (!parsed.success || parsed.data.foreignRepoDrops === 0) {
        continue;
      }
      drops += parsed.data.foreignRepoDrops;
      sessions += 1;
      if (repoIds.size < FOREIGN_DROPS_MAX_NAMED_REPOS) {
        repoIds.add(parsed.data.repoId);
      }
    }
    return { drops, sessions, repoIds: [...repoIds] };
  } catch {
    return EMPTY;
  }
};

/**
 * The one sentence both surfaces print — doctor and status must agree, the
 * spool-drops discipline. Count, binding, rule, remedy.
 */
export const formatForeignDropLine = (summary: ForeignDropSummary): string => {
  const touches = summary.drops === 1 ? "file touch" : "file touches";
  const sessionsPart = `${String(summary.sessions)} live session${summary.sessions === 1 ? "" : "s"}`;
  const boundPart =
    summary.repoIds.length === 0
      ? ""
      : ` bound to ${summary.repoIds.join(", ")}`;
  return (
    `${String(summary.drops)} ${touches} in a different connected repo ` +
    `dropped by ${sessionsPart}${boundPart} — one agent session reports to ` +
    `one repo; open the other repo as its own workspace/session`
  );
};
