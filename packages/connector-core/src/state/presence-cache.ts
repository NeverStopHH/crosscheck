import { z } from "zod";

import { PRESENCE_CACHE_TTL_MS } from "../constants.ts";
import { presenceCachePath, readJsonOrNull, writePrivateFile } from "../config/paths.ts";
import { PresenceEntrySchema } from "../http/hub.ts";
import type { PresenceEntry } from "../http/hub.ts";

export const PresenceCacheSchema = z.looseObject({
  fetchedAt: z.string().min(1),
  entries: z.array(PresenceEntrySchema),
});

export type PresenceCache = z.infer<typeof PresenceCacheSchema>;

export const readPresenceCache = async (
  home: string,
  key: string,
): Promise<PresenceCache | null> => {
  const parsed = PresenceCacheSchema.safeParse(
    await readJsonOrNull(presenceCachePath(home, key)),
  );
  return parsed.success ? parsed.data : null;
};

export const writePresenceCache = async (
  home: string,
  key: string,
  entries: readonly PresenceEntry[],
  now: Date,
): Promise<void> => {
  await writePrivateFile(
    presenceCachePath(home, key),
    `${JSON.stringify({ fetchedAt: now.toISOString(), entries }, null, 2)}\n`,
  );
};

/** A fresh cache means the statusline costs zero HTTP requests. */
export const isCacheFresh = (cache: PresenceCache, now: Date): boolean => {
  const fetchedMs = Date.parse(cache.fetchedAt);
  if (Number.isNaN(fetchedMs)) {
    return false;
  }
  const ageMs = now.getTime() - fetchedMs;
  return ageMs >= 0 && ageMs < PRESENCE_CACHE_TTL_MS;
};
