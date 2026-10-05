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

export type NudgeOutcome = "delivered" | "nothing_due";

const EntrySchema = z.object({
  outcome: z.enum(["delivered", "nothing_due"]),
  at: z.string().min(1),
});

const LedgerSchema = z.object({
  sessions: z.record(z.string(), EntrySchema).catch({}),
});

type Ledger = z.infer<typeof LedgerSchema>;

const readLedger = async (home: string): Promise<Ledger> => {
  const parsed = LedgerSchema.safeParse(await readJsonOrNull(draftNudgeSpentPath(home)));
  return parsed.success ? parsed.data : { sessions: {} };
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
    // Fail open: the record is lost, the prompt is not.
  }
};
