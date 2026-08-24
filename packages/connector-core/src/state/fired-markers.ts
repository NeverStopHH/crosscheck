/**
 * Did it actually RUN? — the two facts nothing on the machine recorded.
 *
 * Trial findings M2 and H7. Eleven of `doctor`'s twenty-six lines were
 * textual: they read `.claude/settings.json`, saw a crosscheck command
 * spelled correctly, and printed PASS. None of them could see a PATH entry
 * that had disappeared after `nvm use`, a `CROSSCHECK_DISABLED` in the
 * agent's environment, an agent process older than the wiring, or a
 * statusline that Claude Code never calls because the session is headless.
 * `grep -rn 'lastFired|firedAt|lastRender' packages/*\/src` found nothing on
 * the pre-fix tree: configuration was recorded everywhere and execution
 * nowhere.
 *
 * Two markers, one shape, one module:
 *   - `state/<repoKey>-hooks.json`      `{ "<HookName>": "<iso>" }`
 *   - `state/<repoKey>-statusline.json` `{ "lastRenderedAt": "<iso>" }`
 *
 * WHAT THIS IS NOT. It is not a counter and it is not a ledger — every value
 * is a last-writer-wins timestamp, exactly like `sync-state.ts`, for the same
 * reason: hooks run in parallel, nothing here takes a lock, and a lost update
 * must cost a slightly stale age rather than a wrong number. Two PostToolUse
 * hooks racing on one repo can lose one another's stamp; both wrote "just
 * now", so the survivor is right either way.
 *
 * FAIL-OPEN IS THE CONTRACT. Every function below swallows its own errors and
 * returns rather than throwing. A read-only home, a full disk or a corrupt
 * file must cost the marker, never the hook that was writing it — the whole
 * point of the row is a hook path that keeps working while a surface finally
 * tells the truth about it.
 */
import { z } from "zod";

import {
  hooksFiredPath,
  readJsonOrNull,
  statuslineFiredPath,
  writePrivateFile,
} from "../config/paths.ts";

/**
 * `catchall(z.string())` rather than a closed enum of hook names: a NEWER
 * connector (or a host we have not shipped yet) writing an event this build
 * does not know must not make the whole file unparseable and blind the
 * doctor to the five events it does know.
 */
const HooksFiredSchema = z.looseObject({}).catchall(z.string());

export type HooksFired = Readonly<Record<string, string>>;

const StatuslineFiredSchema = z.looseObject({
  lastRenderedAt: z.string().min(1),
});

export const readHooksFired = async (
  home: string,
  key: string,
): Promise<HooksFired> => {
  const parsed = HooksFiredSchema.safeParse(
    await readJsonOrNull(hooksFiredPath(home, key)),
  );
  return parsed.success ? parsed.data : {};
};

/**
 * One event's stamp, read-modify-written whole.
 *
 * Read-modify-write and not an append, deliberately: the file holds at most
 * six keys (one per registered event), so the whole of it is a single small
 * `JSON.stringify` with no `readdir` and no scan, and `writePrivateFile` is
 * atomic (write to a temp sibling, rename), so a crashed hook can never leave
 * a half-written file for the next one to parse as truth.
 *
 * WHERE IT IS CALLED FROM MATTERS MORE THAN WHAT IT COSTS: hooks/runner.ts
 * calls it AFTER `await withBudget(...)` has resolved, so this write is
 * outside the budget race — it cannot eat the handler's deadline, cannot cost
 * the SessionStart briefing, and cannot be abandoned half-done by the race
 * resolving underneath it.
 */
export const recordHookFired = async (
  home: string,
  key: string,
  hookName: string,
  now: Date,
): Promise<void> => {
  try {
    const current = await readHooksFired(home, key);
    await writePrivateFile(
      hooksFiredPath(home, key),
      `${JSON.stringify({ ...current, [hookName]: now.toISOString() })}\n`,
    );
  } catch {
    // A read-only home must not break the hook this rides on.
  }
};

export const readStatuslineRendered = async (
  home: string,
  key: string,
): Promise<string | null> => {
  const parsed = StatuslineFiredSchema.safeParse(
    await readJsonOrNull(statuslineFiredPath(home, key)),
  );
  return parsed.success ? parsed.data.lastRenderedAt : null;
};

/**
 * One write, no read: the statusline marker has exactly one field, so there
 * is nothing to merge and the round trip would buy nothing.
 */
export const recordStatuslineRendered = async (
  home: string,
  key: string,
  now: Date,
): Promise<void> => {
  try {
    await writePrivateFile(
      statuslineFiredPath(home, key),
      `${JSON.stringify({ lastRenderedAt: now.toISOString() })}\n`,
    );
  } catch {
    // A statusline that prints nothing is worse than one that does not
    // record itself: the caller keeps its rendered line either way.
  }
};
