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
 */
import { z } from "zod";

import { MAX_SPOOL_AGE_DAYS, MS_PER_DAY, REFUSED_LIVES_MAX } from "../constants.ts";
import { readTextOrNull, spoolRefusedLivesPath, writePrivateFile } from "../config/paths.ts";
import { ledgerMs } from "./ledger-read.ts";
import { toLines } from "./lines.ts";
import { appendOnce } from "./write.ts";

const RefusedLifeSchema = z.looseObject({
  sessionId: z.string().min(1),
  at: z.string().min(1),
});

type RefusedLife = z.infer<typeof RefusedLifeSchema>;

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

const cutoffOf = (now: Date): number => now.getTime() - MAX_SPOOL_AGE_DAYS * MS_PER_DAY;

const readLines = async (home: string, key: string): Promise<readonly string[]> =>
  toLines(await readTextOrNull(spoolRefusedLivesPath(home, key)));

/** The refused lives still young enough to have records waiting. */
export const readRefusedLives = async (
  home: string,
  key: string,
  now: Date,
): Promise<ReadonlySet<string>> => {
  const cutoffMs = cutoffOf(now);
  const lives = (await readLines(home, key))
    .map(parse)
    .filter((life): life is RefusedLife => life !== null && isYoung(life, cutoffMs));
  return new Set(lives.map((life) => life.sessionId));
};

const lineOf = (sessionId: string, now: Date): string =>
  JSON.stringify({ sessionId, at: now.toISOString() });

/**
 * Best-effort, like every ledger write on a hook path: a line that does not
 * land costs the withholding of that life's stragglers, never the heal.
 */
export const recordRefusedLife = async (
  home: string,
  key: string,
  sessionId: string,
  now: Date,
): Promise<void> => {
  const path = spoolRefusedLivesPath(home, key);
  const lines = await readLines(home, key);
  const cutoffMs = cutoffOf(now);
  const kept = lines.filter((line) => {
    const life = parse(line);
    return life !== null && isYoung(life, cutoffMs);
  });
  // Recorded already: every refusal of a life that stays ended says so again,
  // and a second line would only push an older life out of the window.
  if (kept.some((line) => parse(line)?.sessionId === sessionId)) {
    return;
  }
  if (kept.length === lines.length && kept.length < REFUSED_LIVES_MAX) {
    await appendOnce(path, `${lineOf(sessionId, now)}\n`);
    return;
  }
  const newest = [...kept, lineOf(sessionId, now)].slice(-REFUSED_LIVES_MAX);
  try {
    await writePrivateFile(path, `${newest.join("\n")}\n`);
  } catch {
    // Best-effort, as above.
  }
};
