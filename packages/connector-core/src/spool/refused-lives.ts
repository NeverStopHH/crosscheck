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
 * APPEND-ONLY, one line per healed life, so two healers never lose each
 * other's line to a read-modify-write — the drop ledger's lesson. A machine
 * heals a handful of times a month; lines older than MAX_SPOOL_AGE_DAYS are
 * read as gone, because nothing a reap would keep can still be waiting.
 */
import { z } from "zod";

import { MAX_SPOOL_AGE_DAYS, MS_PER_DAY } from "../constants.ts";
import { readTextOrNull, spoolRefusedLivesPath } from "../config/paths.ts";
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

/** The refused lives still young enough to have records waiting. */
export const readRefusedLives = async (
  home: string,
  key: string,
  now: Date,
): Promise<ReadonlySet<string>> => {
  const cutoffMs = now.getTime() - MAX_SPOOL_AGE_DAYS * MS_PER_DAY;
  const lives = toLines(await readTextOrNull(spoolRefusedLivesPath(home, key)))
    .map(parse)
    .filter((life): life is RefusedLife => life !== null && isYoung(life, cutoffMs));
  return new Set(lives.map((life) => life.sessionId));
};

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
  await appendOnce(
    spoolRefusedLivesPath(home, key),
    `${JSON.stringify({ sessionId, at: now.toISOString() })}\n`,
  );
};
