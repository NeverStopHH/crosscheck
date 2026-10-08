/**
 * THE BRIEFINGS THIS MACHINE DID NOT DELIVER WHOLE (2026-10-08), counted.
 *
 * A SessionStart can lose its briefing three ways, and before this file all
 * three ended in the same "": the hook's budget race won (the runner booked
 * a capture loss, and the person was told nothing), the handler threw (the
 * runner's catch, booked nowhere), or the hub reads did not answer inside
 * their per-request timeouts (fail open, to nothing). An empty session looked
 * exactly like a quiet repo — the pilot failure's shape: the person is told
 * nothing, and nothing says why. Each of the three now prints one line in the
 * session (briefing/omission.ts) and appends one line here, which `doctor`
 * counts, so a slow week is a number rather than a feeling.
 *
 * LOCAL, NEVER ON THE WIRE. This is not telemetry the hub's coverage reads —
 * a missed briefing loses no record — so it is its own small file rather than
 * a new kind in the capture-loss ledger, whose kinds travel to every hub and
 * whose schema an older hub validates.
 *
 * One machine-wide file, keyed per line exactly like the capture-loss ledger
 * (state/loss-ledger.ts): a budget that won before repo identity resolved
 * cannot name the repo, so `key` is null and the reader charges it to every
 * repo — the conservative reading. Append-only, bounded, fail open: a full or
 * unwritable ledger costs the count, never the hook.
 */
import { appendFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { BRIEFING_OMISSION_WINDOW_DAYS, MAX_BRIEFING_OMISSION_LEDGER_BYTES } from "../constants.ts";
import { ensureDir, readTextOrNull } from "../config/paths.ts";

/** Why a briefing did not arrive whole: the budget, a fault, or the hub's reads. */
export const BRIEFING_OMISSION_REASONS = ["budget", "error", "hub"] as const;

export type BriefingOmissionReason = (typeof BRIEFING_OMISSION_REASONS)[number];

const LEDGER_FILE = "briefing-omissions.jsonl";

const MS_PER_DAY = 86_400_000;

export const briefingOmissionsPath = (home: string): string => join(home, "state", LEDGER_FILE);

export interface BriefingOmission {
  /** The repo key, or null when the hook never learned it (charged to every repo). */
  readonly key: string | null;
  readonly reason: BriefingOmissionReason;
  readonly now: Date;
}

export const recordBriefingOmission = async (home: string, omission: BriefingOmission): Promise<void> => {
  try {
    const path = briefingOmissionsPath(home);
    const size = await stat(path).then(
      (info) => info.size,
      () => 0,
    );
    if (size >= MAX_BRIEFING_OMISSION_LEDGER_BYTES) {
      return;
    }
    await ensureDir(dirname(path));
    await appendFile(
      path,
      `${JSON.stringify({ at: omission.now.toISOString(), reason: omission.reason, key: omission.key })}\n`,
      "utf8",
    );
  } catch {
    // Fail open: the count is a convenience for doctor, never a failure source.
  }
};

const LineSchema = z.looseObject({
  at: z.string().min(1),
  reason: z.enum(BRIEFING_OMISSION_REASONS),
  key: z.string().nullable().catch(null),
});

export interface BriefingOmissionCounts {
  readonly total: number;
  readonly byReason: Readonly<Record<BriefingOmissionReason, number>>;
  /** The newest omission's instant, or null when there is none in the window. */
  readonly lastAt: string | null;
}

const NO_OMISSIONS: BriefingOmissionCounts = {
  total: 0,
  byReason: { budget: 0, error: 0, hub: 0 },
  lastAt: null,
};

const parseLine = (line: string): z.infer<typeof LineSchema> | null => {
  try {
    const parsed = LineSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/**
 * This repo's omissions inside BRIEFING_OMISSION_WINDOW_DAYS: its own key's
 * lines and the unkeyed ones. A line that will not parse or carries no
 * readable instant is skipped — the ledger is a count, not evidence.
 */
export const readBriefingOmissions = async (
  home: string,
  key: string,
  now: Date,
): Promise<BriefingOmissionCounts> => {
  const text = await readTextOrNull(briefingOmissionsPath(home));
  if (text === null) {
    return NO_OMISSIONS;
  }
  const since = now.getTime() - BRIEFING_OMISSION_WINDOW_DAYS * MS_PER_DAY;
  return text
    .split("\n")
    .flatMap((line) => {
      const entry = line.length === 0 ? null : parseLine(line);
      const at = entry === null ? Number.NaN : Date.parse(entry.at);
      return entry !== null && (entry.key === null || entry.key === key) && at >= since && at <= now.getTime()
        ? [{ reason: entry.reason, at }]
        : [];
    })
    .reduce<BriefingOmissionCounts>(
      (counts, entry) => ({
        total: counts.total + 1,
        byReason: { ...counts.byReason, [entry.reason]: counts.byReason[entry.reason] + 1 },
        lastAt:
          counts.lastAt === null || entry.at > Date.parse(counts.lastAt) ? new Date(entry.at).toISOString() : counts.lastAt,
      }),
      NO_OMISSIONS,
    );
};
