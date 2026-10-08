/**
 * ONE presence call, and the cache it refreshes — the statusline's own
 * (statusline/statusline.ts), shared with the collision relay
 * (hooks/collision-relay.ts) so both surfaces read and write the same answer.
 * The caller decides the request timeout: the statusline gives the full
 * request timeout, the relay its bounded refresh (RELAY_PRESENCE_REFRESH_MS).
 *
 * The last-seen list is SessionStart's to derive (it holds the work
 * contexts); a refresh here carries whatever the cache already had, so it
 * never erases it.
 */
import { getPresence } from "@crosscheck/connector-core/http/hub.ts";
import type { PresenceEntry } from "@crosscheck/connector-core/http/hub.ts";
import type { HubResult } from "@crosscheck/connector-core/http/client.ts";
import { writePresenceCache } from "@crosscheck/connector-core/state/presence-cache.ts";
import type { PresenceCache } from "@crosscheck/connector-core/state/presence-cache.ts";
import type { HookContext } from "./runner.ts";

export const refreshPresence = async (
  ctx: HookContext,
  timeoutMs: number,
  previous: PresenceCache | null,
): Promise<HubResult<readonly PresenceEntry[]>> => {
  const result = await getPresence({ ...ctx.hub, timeoutMs }, ctx.identity.repoId);
  if (result.ok) {
    await writePresenceCache(ctx.config.home, ctx.repoKey, result.data, ctx.now(), previous?.lastSeen ?? []);
  }
  return result;
};
