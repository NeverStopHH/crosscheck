/**
 * The injection ledger (Block 7 item 5): every injection decision — a
 * delivered briefing or hint, a suppressed attempt — lands one append-only
 * line here, so `doctor` can answer "was the briefing delivered? which event
 * carried the hints?" from facts instead of impressions. The per-event
 * delivered counts are the §6-q4 instrument the manual dogfood reads.
 *
 * Same discipline as src/drift.ts, same reasons: append-only JSONL (racing
 * hook processes lose read-modify-write increments, appends they do not),
 * bounded by MAX_INJECTION_LEDGER_BYTES — past the cap the detail stops and
 * the counts become a floor doctor says out loud. NO INJECTED TEXT ever
 * lands here: kinds, outcomes, event names and reason slugs only — never
 * the briefing, never a hint body, never the ephemeral query (privacy pin).
 */
import { appendFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ensureDir, readTextOrNull } from "@crosscheck/connector-core/config/paths.ts";

import { INJECTION_LEDGER_FILE, MAX_INJECTION_LEDGER_BYTES } from "../constants.ts";

export type InjectionKind = "briefing" | "hint";
export type InjectionOutcome = "delivered" | "suppressed";

export interface InjectionOutcomeEntry {
  readonly kind: InjectionKind;
  readonly outcome: InjectionOutcome;
  /** The hook event that carried (or suppressed) the injection. */
  readonly event: string;
  /** Short reason slug for suppressions (`empty`, `background`, `silence`). */
  readonly reason?: string;
}

export const injectionLedgerPath = (home: string): string =>
  join(home, "state", INJECTION_LEDGER_FILE);

/**
 * Best-effort and bounded, like everything on a hook path: a full ledger or
 * an unwritable one costs the telemetry line, never the hook.
 */
export const recordInjectionOutcome = async (
  home: string,
  entry: InjectionOutcomeEntry,
): Promise<void> => {
  try {
    const path = injectionLedgerPath(home);
    const size = await stat(path).then(
      (info) => info.size,
      () => 0,
    );
    if (size >= MAX_INJECTION_LEDGER_BYTES) {
      return;
    }
    await ensureDir(dirname(path));
    const line = `${JSON.stringify({
      at: new Date().toISOString(),
      kind: entry.kind,
      outcome: entry.outcome,
      event: entry.event,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    })}\n`;
    await appendFile(path, line, "utf8");
  } catch {
    // Fail open — telemetry is never a failure source.
  }
};

export interface InjectionCounters {
  /** Both are floors once `atCap` is true. */
  readonly delivered: number;
  readonly suppressed: number;
}

export interface InjectionSummary {
  readonly briefings: InjectionCounters;
  readonly hints: InjectionCounters;
  /** Delivered hints per carrying event — the §6-q4 instrument. */
  readonly hintEvents: Readonly<Record<string, number>>;
  /** ISO timestamp of the newest DELIVERED row, null when none. */
  readonly lastDeliveredAt: string | null;
  /** Lines that would not parse — counted, never silently skipped. */
  readonly malformed: number;
  /** True when the ledger refused further detail (counts are a floor). */
  readonly atCap: boolean;
}

export const EMPTY_INJECTION_SUMMARY: InjectionSummary = {
  briefings: { delivered: 0, suppressed: 0 },
  hints: { delivered: 0, suppressed: 0 },
  hintEvents: {},
  lastDeliveredAt: null,
  malformed: 0,
  atCap: false,
};

interface LedgerLine {
  readonly at?: string;
  readonly kind?: string;
  readonly outcome?: string;
  readonly event?: string;
}

const parseLine = (line: string): LedgerLine | null => {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as LedgerLine)
      : null;
  } catch {
    return null;
  }
};

export const readInjectionLedger = async (
  home: string,
): Promise<InjectionSummary> => {
  const raw = await readTextOrNull(injectionLedgerPath(home));
  if (raw === null) {
    return EMPTY_INJECTION_SUMMARY;
  }
  const lines = raw.split("\n").filter((line) => line.length > 0);
  let malformed = 0;
  let lastDeliveredAt: string | null = null;
  const briefings = { delivered: 0, suppressed: 0 };
  const hints = { delivered: 0, suppressed: 0 };
  const hintEvents: Record<string, number> = {};
  for (const line of lines) {
    const entry = parseLine(line);
    if (
      entry === null ||
      (entry.kind !== "briefing" && entry.kind !== "hint") ||
      (entry.outcome !== "delivered" && entry.outcome !== "suppressed")
    ) {
      malformed += 1;
      continue;
    }
    const bucket = entry.kind === "briefing" ? briefings : hints;
    bucket[entry.outcome] += 1;
    if (entry.outcome === "delivered") {
      if (typeof entry.at === "string") {
        lastDeliveredAt = entry.at;
      }
      if (entry.kind === "hint") {
        const event = typeof entry.event === "string" ? entry.event : "unknown";
        hintEvents[event] = (hintEvents[event] ?? 0) + 1;
      }
    }
  }
  return {
    briefings,
    hints,
    hintEvents,
    lastDeliveredAt,
    malformed,
    atCap: raw.length >= MAX_INJECTION_LEDGER_BYTES,
  };
};
