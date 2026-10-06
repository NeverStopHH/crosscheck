/**
 * THE DRAFT REVIEW NUDGE'S SPENT SLOTS, REMEMBERED PAST SESSIONEND.
 *
 * The slot lives in session state (`draftNudge`), and SessionEnd deletes that
 * file. A conversation resumed after it ended (`claude --resume`, a Cursor
 * conversation reopened) keeps its host session key but starts with a fresh
 * state — so without this record the same conversation was nudged again.
 * One small per-home file, keyed by the host session key, newest
 * DRAFT_NUDGE_SPENT_MAX_SESSIONS kept.
 *
 * WRITTEN AT SESSIONEND, READ AT SESSIONSTART — never on the prompt path. The
 * prompt that spends the slot writes only the session's own state; SessionEnd
 * copies the slot here before deleting that state (recordSlotAtEnd), and
 * SessionStart seeds `draftNudge` from here (flows/register-session.ts), so a
 * resumed conversation starts with its slot already spent. A second locked
 * file write on the prompt hook cost the person's keystroke for a record
 * nothing reads until the session is over.
 *
 * Fail-open both ways, like every counter file here: a corrupt file reads as
 * "nothing spent" (the cost is one repeated nudge, never a silent one), and a
 * write that fails costs the record, never the prompt.
 */
import { z } from "zod";

import { DRAFT_NUDGE_SPENT_MAX_SESSIONS } from "../constants.ts";
import {
  draftNudgeSpentLockPath,
  draftNudgeSpentPath,
  readJsonOrNull,
  writePrivateFile,
} from "../config/paths.ts";
import { withLock } from "../spool/lock.ts";
import { readSessionState } from "./session-state.ts";

export type NudgeOutcome = "delivered" | "nothing_due";

const EntrySchema = z.object({
  outcome: z.enum(["delivered", "nothing_due"]),
  // AN INSTANT A CLOCK CAN ORDER: the newest DRAFT_NUDGE_SPENT_MAX_SESSIONS
  // are kept by sorting on it, and an empty or garbled one compares as NaN —
  // which sorted it anywhere and evicted a fresh record (review round 3).
  at: z
    .string()
    .min(1)
    .refine((value) => !Number.isNaN(Date.parse(value))),
});

type Entry = z.infer<typeof EntrySchema>;

/** The file's shape only; each entry is judged on its own (readLedger). */
const LedgerFileSchema = z.object({
  sessions: z.record(z.string(), z.unknown()).catch({}),
});

interface Ledger {
  readonly sessions: Readonly<Record<string, Entry>>;
}

/**
 * ENTRY BY ENTRY: one record a crash or an older writer mangled used to fail
 * the whole map and take every other conversation's spent slot with it —
 * each of them nudged again, and the next write made the loss permanent.
 */
const readLedger = async (home: string): Promise<Ledger> => {
  const parsed = LedgerFileSchema.safeParse(await readJsonOrNull(draftNudgeSpentPath(home)));
  if (!parsed.success) {
    return { sessions: {} };
  }
  const kept = Object.entries(parsed.data.sessions).flatMap(([key, value]) => {
    const entry = EntrySchema.safeParse(value);
    return entry.success ? [[key, entry.data] as const] : [];
  });
  return { sessions: Object.fromEntries(kept) };
};

/** The outcome this conversation's slot was spent on, or null. */
export const readNudgeSpent = async (
  home: string,
  hostSessionKey: string,
): Promise<NudgeOutcome | null> => (await readLedger(home)).sessions[hostSessionKey]?.outcome ?? null;

const withSpent = (ledger: Ledger, hostSessionKey: string, outcome: NudgeOutcome, at: Date): Ledger => {
  const entries = [
    ...Object.entries(ledger.sessions).filter(([key]) => key !== hostSessionKey),
    [hostSessionKey, { outcome, at: at.toISOString() }] as const,
  ];
  const newest = [...entries]
    .sort(([, a], [, b]) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, DRAFT_NUDGE_SPENT_MAX_SESSIONS);
  return { sessions: Object.fromEntries(newest) };
};

export const recordNudgeSpent = async (
  home: string,
  hostSessionKey: string,
  outcome: NudgeOutcome,
  at: Date,
): Promise<void> => {
  try {
    await withLock(draftNudgeSpentLockPath(home), undefined, async () => {
      const next = withSpent(await readLedger(home), hostSessionKey, outcome, at);
      await writePrivateFile(draftNudgeSpentPath(home), JSON.stringify(next));
    });
  } catch {
    // Fail open: the record is lost, the session's end is not.
  }
};

/**
 * SessionEnd's half: the slot this session spent, read off its state before
 * the delete. An unspent slot records nothing, so the next session of the
 * conversation is still owed its nudge.
 */
export const recordSlotAtEnd = async (
  home: string,
  hostSessionKey: string,
  at: Date,
): Promise<void> => {
  const spent = (await readSessionState(home, hostSessionKey))?.draftNudge ?? null;
  if (spent !== null) {
    await recordNudgeSpent(home, hostSessionKey, spent, at);
  }
};
