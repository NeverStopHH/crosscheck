import {
  STATUSLINE_MAX_CHARS,
  STATUSLINE_MAX_NAMES,
  STATUSLINE_NAME_CHARS,
} from "@crosscheck/connector-core/constants.ts";
import { formatAge, groupTeammates } from "@crosscheck/connector-core/briefing/render.ts";
import type { TeammateGroup } from "@crosscheck/connector-core/briefing/render.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { getPresence } from "@crosscheck/connector-core/http/hub.ts";
import type { PresenceEntry } from "@crosscheck/connector-core/http/hub.ts";
import {
  isCacheFresh,
  readPresenceCache,
  writePresenceCache,
} from "@crosscheck/connector-core/state/presence-cache.ts";
import { readSyncState } from "@crosscheck/connector-core/state/sync-state.ts";
import { prepareHook } from "../hooks/runner.ts";
import type { HookContext } from "../hooks/runner.ts";

const ELLIPSIS = "…";

const capName = (name: string): string =>
  name.length <= STATUSLINE_NAME_CHARS
    ? name
    : `${name.slice(0, STATUSLINE_NAME_CHARS - ELLIPSIS.length)}${ELLIPSIS}`;

const renderNames = (groups: readonly TeammateGroup[]): string => {
  const shown = groups
    .slice(0, STATUSLINE_MAX_NAMES)
    .map((group) => `${capName(group.name)}(${group.status})`)
    .join(", ");
  const hidden = groups.length - Math.min(groups.length, STATUSLINE_MAX_NAMES);
  return hidden > 0 ? `${shown} +${hidden}` : shown;
};

const capLine = (line: string): string =>
  line.length <= STATUSLINE_MAX_CHARS
    ? line
    : `${line.slice(0, STATUSLINE_MAX_CHARS - ELLIPSIS.length)}${ELLIPSIS}`;

const ageSince = (iso: string | null, now: Date): string | null => {
  if (iso === null) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : formatAge(now.getTime() - ms);
};

/** Counts developers, not sessions — several windows are still one teammate. */
const presenceLine = (
  entries: readonly PresenceEntry[],
  syncAge: string,
  now: Date,
): string => {
  const teammates = groupTeammates(entries, now);
  if (teammates.length === 0) {
    return capLine(`cx 0 · no teammates on this repo · sync ${syncAge}`);
  }
  return capLine(
    `cx ${teammates.length} · ${renderNames(teammates)} · sync ${syncAge}`,
  );
};

const renderForContext = async (ctx: HookContext): Promise<string> => {
  const now = ctx.now();
  const cache = await readPresenceCache(ctx.config.home, ctx.repoKey);
  const sync = await readSyncState(ctx.config.home, ctx.repoKey);

  if (cache !== null && isCacheFresh(cache, now)) {
    return presenceLine(
      cache.entries,
      ageSince(sync.lastOkAt, now) ?? "0s",
      now,
    );
  }

  const result = await getPresence(ctx.hub, ctx.identity.repoId);
  if (result.ok) {
    await writePresenceCache(ctx.config.home, ctx.repoKey, result.data, now);
    return presenceLine(result.data, "0s", now);
  }

  const lastOkAge = ageSince(sync.lastOkAt, now);
  if (lastOkAge === null) {
    return "cx ! never synced";
  }
  return capLine(`cx ! hub unreachable · last sync ${lastOkAge}`);
};

/**
 * Human-facing chrome, zero token cost. Prints one line or nothing, and always
 * succeeds — a dead hub must be visible, not silent (DESIGN.md §10 risk 5).
 */
export const runStatusline = async (
  stdin: string,
  env: Env,
): Promise<string> => {
  try {
    const ctx = await prepareHook(stdin, env);
    if (ctx === null) {
      return "";
    }
    return await renderForContext(ctx);
  } catch {
    return "";
  }
};
