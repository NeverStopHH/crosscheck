/**
 * THE LIVES A MID-LIFE HEAL LEFT BEHIND (flows/heal-session.ts), per repo.
 *
 * When the hub refuses a session's own id and the heal moves it to the next
 * life, records the refused life produced can still be on disk: a parallel
 * hook appended one after the flush read its batch, or the drain ran out of
 * budget. Any LIVE session's flush would deliver them — that is the successor
 * rule, and it is right for a backlog written BEFORE its session ended. These
 * were written after: the hub had already ended that life. A record whose body
 * names its session would then be filed into that ended session past its end,
 * or under an epoch the hub never saw from it (spec 01 §3.4), so spool/flush.ts
 * withholds those and counts them; it needs this list to know which lives.
 *
 * BOUNDED ON WRITE (review finding 8). It was append-only and read on every
 * drain, with lines past MAX_SPOOL_AGE_DAYS ignored on read and never removed.
 * A write now keeps only the young lives, at most REFUSED_LIVES_MAX of the
 * newest, and rewrites the file whole — atomically, through a sibling rename —
 * when anything is to be dropped; otherwise it appends. Nothing a reap would
 * keep can still be waiting on a life older than that age. Two healers writing
 * in the same instant can cost one line: the flush-triggered heal runs under
 * the repo's flush lock, so only a heartbeat's heal can race it, and a lost
 * line costs the withholding of that life's stragglers, never the heal.
 *
 * "YOUNG" OUTLIVES THE SPOOL IT GUARDS (review-2 round 8, H1). It was the age
 * bound itself, and a dead host's spool is released as abandoned only after
 * that very bound of silence: every entry the dead conversation wrote had aged
 * out by the time a successor could first send its stragglers, and they were
 * filed into the ended session. An entry is kept while its host session still
 * has records or a debt on this repo's disk, and never less than
 * REFUSED_LIFE_KEEP_DAYS — twice the bound, the most a released spool waits
 * before reap expires it (spool/reap.ts).
 *
 * AN ENTRY THAT OWNS LEFTOVERS IS NEVER EVICTED (review-2 round 9, H2). Every
 * SessionEnd writes its life down too (round 8, M1), and 64 of them, young
 * and owning nothing, pushed out the oldest entry — the one still withholding
 * a straggler, which a successor then filed into its ended session. Over the
 * cap the oldest entries that own nothing go first; and a SessionEnd's own
 * entry goes once its spool is empty and REFUSED_END_GRACE_MS has passed, the
 * most a hook still in flight beside the end can take to append.
 */
import { z } from "zod";

import { MS_PER_DAY, REFUSED_END_GRACE_MS, REFUSED_LIFE_KEEP_DAYS, REFUSED_LIVES_MAX } from "../constants.ts";
import {
  readTextOrNull,
  sessionSlug,
  spoolOwedWorkContextPath,
  spoolRefusedLivesPath,
  writePrivateFile,
} from "../config/paths.ts";
import { conversationOf } from "../state/session-lineage.ts";
import { crosscheckSessionIdFor } from "../state/session-state.ts";
import { readSessionSpool } from "./files.ts";
import { ledgerMs } from "./ledger-read.ts";
import { toLines } from "./lines.ts";
import { appendOnce } from "./write.ts";

const RefusedLifeSchema = z.looseObject({
  sessionId: z.string().min(1),
  at: z.string().min(1),
  /** Written by the life's own SessionEnd (or its deferred end), not by a heal. */
  by: z.literal("end").optional(),
});

type RefusedLife = z.infer<typeof RefusedLifeSchema>;

/** Who wrote a life down: a heal, or a refusal the hub answered — or the life's own end. */
export type RefusedBy = "heal" | "end";

const parse = (line: string): RefusedLife | null => {
  try {
    const parsed = RefusedLifeSchema.safeParse(JSON.parse(line) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** Undatable reads as young: an unknown age must not release a straggler. */
const isYoung = (life: RefusedLife, cutoffMs: number): boolean =>
  (ledgerMs(life.at) ?? Number.POSITIVE_INFINITY) > cutoffMs;

const cutoffOf = (now: Date): number => now.getTime() - REFUSED_LIFE_KEEP_DAYS * MS_PER_DAY;

/** The spool slug of the host session a life is one of — `cc_<key>~r2` is `<key>`'s — or null for an id none minted. */
const slugOfLife = (sessionId: string): string | null => {
  const prefix = crosscheckSessionIdFor("");
  const base = conversationOf(sessionId);
  return base.startsWith(prefix) ? sessionSlug(base.slice(prefix.length)) : null;
};

/** Whether the life's host session still has records or a debt on this repo's disk: stragglers that could still go. */
const ownsLeftovers = async (home: string, key: string, sessionId: string): Promise<boolean> => {
  const slug = slugOfLife(sessionId);
  if (slug === null) {
    return false;
  }
  return (
    (await readSessionSpool(home, key, slug)).lines.length > 0 ||
    (await Bun.file(spoolOwedWorkContextPath(home, key, slug)).exists())
  );
};

/** A SessionEnd's own entry, still inside the time a hook in flight beside the end has to append. */
const isInGrace = (life: RefusedLife, now: Date): boolean =>
  (ledgerMs(life.at) ?? Number.POSITIVE_INFINITY) > now.getTime() - REFUSED_END_GRACE_MS;

/** A kept line; `isWithinBound` false means it is kept only because its life still owns leftovers. */
interface KeptLine {
  readonly line: string;
  readonly sessionId: string;
  readonly isWithinBound: boolean;
}

/**
 * Not yet past its own bound — a heal's entry young, a SessionEnd's in its
 * grace — or still guarding something on disk: a life a successor's flush
 * must keep withholding. The disk is read only past the bound: the drain
 * reads this note on every flush.
 */
const judge = async (home: string, key: string, line: string, now: Date): Promise<KeptLine | null> => {
  const life = parse(line);
  if (life === null) {
    return null;
  }
  const isWithinBound = life.by === "end" ? isInGrace(life, now) : isYoung(life, cutoffOf(now));
  return isWithinBound || (await ownsLeftovers(home, key, life.sessionId))
    ? { line, sessionId: life.sessionId, isWithinBound }
    : null;
};

const readLines = async (home: string, key: string): Promise<readonly string[]> =>
  toLines(await readTextOrNull(spoolRefusedLivesPath(home, key)));

/** The lines whose lives are still kept, in order; an unreadable line is dropped. */
const keptLines = async (home: string, key: string, lines: readonly string[], now: Date): Promise<readonly KeptLine[]> =>
  (await Promise.all(lines.map((line) => judge(home, key, line, now)))).filter((kept) => kept !== null);

/** Over the cap, the oldest lines that own nothing go — never one that does, never the newest. */
const withinCap = async (home: string, key: string, kept: readonly KeptLine[]): Promise<readonly KeptLine[]> => {
  const excess = kept.length - REFUSED_LIVES_MAX;
  const evicted = new Set<KeptLine>();
  for (const entry of kept.slice(0, -1)) {
    if (evicted.size >= excess) {
      break;
    }
    if (entry.isWithinBound && !(await ownsLeftovers(home, key, entry.sessionId))) {
      evicted.add(entry);
    }
  }
  return kept.filter((entry) => !evicted.has(entry));
};

/** The refused lives still young enough, or still owning records, to have stragglers waiting. */
export const readRefusedLives = async (
  home: string,
  key: string,
  now: Date,
): Promise<ReadonlySet<string>> => {
  const kept = await keptLines(home, key, await readLines(home, key), now);
  return new Set(kept.map((entry) => entry.sessionId));
};

const lineOf = (sessionId: string, now: Date, by: RefusedBy): string =>
  JSON.stringify({ sessionId, at: now.toISOString(), ...(by === "end" ? { by } : {}) });

/**
 * Best-effort, like every ledger write on a hook path: a line that does not
 * land costs the withholding of that life's stragglers, never the heal.
 */
export const recordRefusedLife = async (
  home: string,
  key: string,
  sessionId: string,
  now: Date,
  by: RefusedBy = "heal",
): Promise<void> => {
  const path = spoolRefusedLivesPath(home, key);
  const lines = await readLines(home, key);
  const kept = await keptLines(home, key, lines, now);
  // Recorded already: every refusal of a life that stays ended says so again,
  // and a second line would only push an older life out of the window.
  if (kept.some((entry) => entry.sessionId === sessionId)) {
    return;
  }
  const line = lineOf(sessionId, now, by);
  if (kept.length === lines.length && kept.length < REFUSED_LIVES_MAX) {
    await appendOnce(path, `${line}\n`);
    return;
  }
  const newest = await withinCap(home, key, [...kept, { line, sessionId, isWithinBound: true }]);
  try {
    await writePrivateFile(path, `${newest.map((entry) => entry.line).join("\n")}\n`);
  } catch {
    // Best-effort, as above.
  }
};
