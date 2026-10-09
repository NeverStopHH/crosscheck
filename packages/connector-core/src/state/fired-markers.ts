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
 * Two markers, one module:
 *   - `state/<repoKey>-hook-<HookName>.json` `{ "at": "<iso>" }`, one file
 *     per event (review batch 2, M9); `state/<repoKey>-hooks.json`
 *     `{ "<HookName>": "<iso>" }`, what earlier connectors wrote, still read
 *   - `state/<repoKey>-statusline.json` `{ "lastRenderedAt": "<iso>" }`
 *
 * WHAT THIS IS NOT. It is not a counter and it is not a ledger — every value
 * is a last-writer-wins timestamp, exactly like `sync-state.ts`, for the same
 * reason: hooks run in parallel, nothing here takes a lock, and a lost update
 * must cost a slightly stale age rather than a wrong number. Two hooks of one
 * event racing on one repo write the same file; both wrote "just now", so the
 * survivor is right either way. Hooks of DIFFERENT events never share a file
 * any more: sharing one is how eleven of twelve read as never fired.
 *
 * FAIL-OPEN IS THE CONTRACT. Every function below swallows its own errors and
 * returns rather than throwing. A read-only home, a full disk or a corrupt
 * file must cost the marker, never the hook that was writing it — the whole
 * point of the row is a hook path that keeps working while a surface finally
 * tells the truth about it.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import {
  hookFiredPath,
  hookFiredPrefix,
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

/** A hook event's name as a file name may carry it: the runners' own words. */
const HOOK_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;

const HookStampSchema = z.looseObject({ at: z.string().min(1) });

const JSON_SUFFIX = ".json";

/** The later of two stamps, either possibly absent. */
const laterStamp = (left: string | undefined, right: string): string =>
  left === undefined || right > left ? right : left;

/** Every per-hook stamp of `key` (config/paths.ts hookFiredPath), by event. */
const readPerHookStamps = async (home: string, key: string): Promise<HooksFired> => {
  const prefix = hookFiredPrefix(key);
  const names = await readdir(join(home, "state")).catch((): readonly string[] => []);
  const stamps = await Promise.all(
    names
      .filter((name) => name.startsWith(prefix) && name.endsWith(JSON_SUFFIX))
      .map(async (name): Promise<readonly [string, string] | null> => {
        const hook = name.slice(prefix.length, -JSON_SUFFIX.length);
        const parsed = HookStampSchema.safeParse(await readJsonOrNull(hookFiredPath(home, key, hook)));
        return HOOK_NAME_PATTERN.test(hook) && parsed.success ? [hook, parsed.data.at] : null;
      }),
  );
  return Object.fromEntries(stamps.filter((stamp): stamp is readonly [string, string] => stamp !== null));
};

/**
 * Every event's last stamp: the per-hook files, and the combined file every
 * connector before them wrote — the later stamp where both have one.
 */
export const readHooksFired = async (
  home: string,
  key: string,
): Promise<HooksFired> => {
  const parsed = HooksFiredSchema.safeParse(
    await readJsonOrNull(hooksFiredPath(home, key)),
  );
  const legacy: HooksFired = parsed.success ? parsed.data : {};
  const perHook = await readPerHookStamps(home, key);
  return Object.entries(perHook).reduce<HooksFired>(
    (merged, [hook, at]) => ({ ...merged, [hook]: laterStamp(merged[hook], at) }),
    legacy,
  );
};

/**
 * One event's stamp, in its own file.
 *
 * NOT A READ-MODIFY-WRITE ANY MORE (review batch 2, M9): every hook used to
 * read the combined file, add its key and write the whole back, and hooks run
 * in parallel — twelve at once left ONE key, so eleven events read as "never
 * fired", the very lie this marker exists to stop. Each event now writes only
 * its own file, whole, so no write can erase another's. `writePrivateFile` is
 * atomic (write to a temp sibling, rename), so a crashed hook can never leave
 * a half-written file for the next one to parse as truth. Two racing hooks
 * of ONE event both wrote "just now", so the survivor is right either way.
 *
 * WHERE IT IS CALLED FROM MATTERS MORE THAN WHAT IT COSTS: hooks/runner.ts
 * calls it AFTER `await withBudget(...)` has resolved, so this write is
 * outside the budget race — it cannot eat the handler's deadline, cannot cost
 * the SessionStart briefing, and cannot be abandoned half-done by the race
 * resolving underneath it. And it takes no lock, so a burst of hooks ending
 * together never waits on one another to exit.
 */
export const recordHookFired = async (
  home: string,
  key: string,
  hookName: string,
  now: Date,
): Promise<void> => {
  if (!HOOK_NAME_PATTERN.test(hookName)) {
    return;
  }
  try {
    await writePrivateFile(hookFiredPath(home, key, hookName), `${JSON.stringify({ at: now.toISOString() })}\n`);
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
