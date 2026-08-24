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
import { recordStatuslineRendered } from "@crosscheck/connector-core/state/fired-markers.ts";
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
    return capLine(`cx 0 · no teammates on this repo · capture ${syncAge}`);
  }
  return capLine(
    `cx ${teammates.length} · ${renderNames(teammates)} · capture ${syncAge}`,
  );
};

const HTTP_UNAUTHORIZED = 401;

/**
 * What a hub failure MEANS, in the reader's words — trial finding M4.
 *
 * This used to branch on `result.ok` alone, so a rotated or revoked api key
 * (HTTP 401, an answer) rendered `cx ! hub unreachable · last sync 2h` and
 * sent the developer to check their network for a credential problem. The
 * status and the kind are both on `HubResult` already (http/client.ts); all
 * three states below name their own remedy, and every one keeps the age.
 */
const failureHead = (
  status: number,
  kind: "network" | "http" | "malformed",
): string => {
  if (status === HTTP_UNAUTHORIZED) {
    return "key rejected · crosscheck login";
  }
  if (kind === "network") {
    return "hub unreachable";
  }
  return "hub answered garbage";
};

const failureLine = (head: string, age: string | null): string =>
  capLine(age === null ? `cx ! ${head}` : `cx ! ${head} · last capture ${age}`);

const renderForContext = async (ctx: HookContext): Promise<string> => {
  const now = ctx.now();
  const cache = await readPresenceCache(ctx.config.home, ctx.repoKey);
  const sync = await readSyncState(ctx.config.home, ctx.repoKey);
  // The CAPTURE stamp (state/sync-state.ts), not `lastOkAt`: this very
  // function's presence poll used to write `lastOkAt` and the next render read
  // it back as `sync 0s`, which is the statusline's half of H5. A read is not
  // capture-marked, so what shows here is when a HOOK last got through.
  const captureAge = ageSince(sync.lastCaptureOkAt, now);

  if (cache !== null && isCacheFresh(cache, now)) {
    // A fresh cache means no call was made — so a 401 booked by the last real
    // call is the newest thing known about the hub, and saying "sync 12s"
    // over it would launder a rejected key into health (M4's cached path).
    if (sync.lastErrorStatus === HTTP_UNAUTHORIZED) {
      return failureLine(failureHead(HTTP_UNAUTHORIZED, "http"), captureAge);
    }
    return presenceLine(cache.entries, captureAge ?? "never", now);
  }

  const result = await getPresence(ctx.hub, ctx.identity.repoId);
  if (result.ok) {
    await writePresenceCache(ctx.config.home, ctx.repoKey, result.data, now);
    return presenceLine(result.data, captureAge ?? "never", now);
  }

  return failureLine(failureHead(result.status, result.kind), captureAge);
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
    const line = await renderForContext(ctx);
    // The RENDERED fact, which nothing recorded before (trial finding H7).
    // `doctor`'s `statusline registered` line reads the settings file and
    // reports what it says — and the statusline is a terminal-TUI feature, so
    // on a machine whose sessions are all `--output-format stream-json` the
    // registration is perfect and the function is never called. Written after
    // the line is in hand and swallowing its own errors: a statusline that
    // prints nothing is worse than one that fails to record itself.
    await recordStatuslineRendered(ctx.config.home, ctx.repoKey, ctx.now());
    return line;
  } catch {
    return "";
  }
};
