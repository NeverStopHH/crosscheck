import { z } from "zod";

import { PRESENCE_CACHE_TTL_MS, STATUSLINE_MAX_LAST_SEEN } from "../constants.ts";
import { presenceCachePath, readJsonOrNull, writePrivateFile } from "../config/paths.ts";
import { PresenceEntrySchema } from "../http/hub.ts";
import type { PresenceEntry, WorkContextEntry } from "../http/hub.ts";

/**
 * A teammate who is not here NOW but has been (Anhang A, A4-09).
 *
 * The statusline renders `cx 0 · no teammates on this repo` from live presence
 * alone, and that one sentence covers two completely different worlds: a
 * teammate who went offline this morning, and a repo where nobody but you has
 * ever connected. The first needs no action; the second is an onboarding gap.
 * SessionStart already holds the work-context list, which carries the author
 * and a timestamp per row, so the difference costs no extra hub call — only
 * this small derived list riding along in the cache the statusline already
 * reads.
 */
export const LastSeenEntrySchema = z.looseObject({
  name: z.string().min(1),
  at: z.string().min(1),
});

export type LastSeenEntry = z.infer<typeof LastSeenEntrySchema>;

export const PresenceCacheSchema = z.looseObject({
  fetchedAt: z.string().min(1),
  entries: z.array(PresenceEntrySchema),
  /** Default keeps every cache written before A4-09 parsing unchanged. */
  lastSeen: z.array(LastSeenEntrySchema).default([]),
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
  lastSeen: readonly LastSeenEntry[] = [],
): Promise<void> => {
  await writePrivateFile(
    presenceCachePath(home, key),
    `${JSON.stringify({ fetchedAt: now.toISOString(), entries, lastSeen }, null, 2)}\n`,
  );
};

/**
 * The most recent trace of each OTHER developer on this repo, newest first.
 *
 * PURE, and derived from what SessionStart already fetched: one row per
 * developer, dated by `updatedAt ?? createdAt` — the context's own last
 * movement — capped at STATUSLINE_MAX_LAST_SEEN because the statusline has
 * ninety characters and this is a suffix on a line that already has a job.
 * Rows with no usable name or date are dropped rather than rendered as
 * "unknown": a half-fact on a status line is noise.
 */
export const deriveLastSeen = (
  workContexts: readonly WorkContextEntry[],
  selfDeveloperId: string | null,
): readonly LastSeenEntry[] => {
  const newest = new Map<string, LastSeenEntry>();
  for (const entry of workContexts) {
    if (entry.developerId === selfDeveloperId) {
      continue;
    }
    const name = entry.developerName;
    const at = entry.updatedAt ?? entry.createdAt;
    if (name === undefined || at === null || Number.isNaN(Date.parse(at))) {
      continue;
    }
    const existing = newest.get(entry.developerId);
    if (existing === undefined || Date.parse(at) > Date.parse(existing.at)) {
      newest.set(entry.developerId, { name, at });
    }
  }
  return [...newest.values()]
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
    .slice(0, STATUSLINE_MAX_LAST_SEEN);
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
