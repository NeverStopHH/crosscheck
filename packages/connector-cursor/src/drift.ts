/**
 * The contract-drift ledger (Block 6 item 3): when a Cursor payload parses
 * but lacks a field the §3.2 mapping needs, the handler degrades silently —
 * fail-open, never a crash — AND the degradation is COUNTED here, so
 * `doctor` can say "Cursor renamed something" instead of capture dying the
 * silent death §10 risk 5 forbids.
 *
 * Shape: append-only JSONL at `~/.crosscheck/state/cursor-drift.jsonl`, one
 * line per drifted payload — `{"at": ISO-8601, "event": "<hook event>",
 * "missing": ["<field>", …]}`. Append-only for the sync-state lesson: racing
 * hook processes lose read-modify-write increments, appends they do not
 * (O_APPEND, one small line). Bounded by MAX_DRIFT_LEDGER_BYTES: past the
 * cap the detail stops and the count becomes a floor — which `doctor` says
 * out loud — rather than a disk that grows with every hook fire forever.
 *
 * NO PAYLOAD CONTENT ever lands here: field NAMES only, from our own mapped
 * list — never values (privacy pin).
 */
import { appendFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ensureDir, readTextOrNull } from "@crosscheck/connector-core/config/paths.ts";

import { DRIFT_LEDGER_FILE, MAX_DRIFT_LEDGER_BYTES } from "./constants.ts";

export const driftLedgerPath = (home: string): string =>
  join(home, "state", DRIFT_LEDGER_FILE);

/**
 * Best-effort and bounded, like everything on a hook path: a full ledger or
 * an unwritable one costs the DETAIL line, never the hook.
 */
export const recordContractDrift = async (
  home: string,
  event: string,
  missing: readonly string[],
): Promise<void> => {
  try {
    const path = driftLedgerPath(home);
    const size = await stat(path).then(
      (info) => info.size,
      () => 0,
    );
    if (size >= MAX_DRIFT_LEDGER_BYTES) {
      return;
    }
    await ensureDir(dirname(path));
    const line = `${JSON.stringify({
      at: new Date().toISOString(),
      event,
      missing,
    })}\n`;
    await appendFile(path, line, "utf8");
  } catch {
    // Fail open — the tripwire is telemetry, never a failure source.
  }
};

export interface DriftSummary {
  /** Countable ledger entries. A floor once `atCap` is true. */
  readonly total: number;
  /** Per-`event.field` counts, e.g. `afterFileEdit.file_path`. */
  readonly byField: Readonly<Record<string, number>>;
  /** ISO timestamp of the newest entry, null when the ledger is empty. */
  readonly lastAt: string | null;
  /** Lines that would not parse — counted, never silently skipped. */
  readonly malformed: number;
  /** True when the ledger refused further detail (counts are a floor). */
  readonly atCap: boolean;
}

export const EMPTY_DRIFT_SUMMARY: DriftSummary = {
  total: 0,
  byField: {},
  lastAt: null,
  malformed: 0,
  atCap: false,
};

interface DriftEntry {
  readonly at?: string;
  readonly event?: string;
  readonly missing?: readonly string[];
}

const parseEntry = (line: string): DriftEntry | null => {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as DriftEntry)
      : null;
  } catch {
    return null;
  }
};

export const readContractDrift = async (
  home: string,
): Promise<DriftSummary> => {
  const raw = await readTextOrNull(driftLedgerPath(home));
  if (raw === null) {
    return EMPTY_DRIFT_SUMMARY;
  }
  const lines = raw.split("\n").filter((line) => line.length > 0);
  let malformed = 0;
  let lastAt: string | null = null;
  const byField: Record<string, number> = {};
  let total = 0;
  for (const line of lines) {
    const entry = parseEntry(line);
    if (entry === null) {
      malformed += 1;
      continue;
    }
    total += 1;
    if (typeof entry.at === "string") {
      lastAt = entry.at;
    }
    const event = typeof entry.event === "string" ? entry.event : "unknown";
    for (const field of entry.missing ?? []) {
      const key = `${event}.${String(field)}`;
      byField[key] = (byField[key] ?? 0) + 1;
    }
  }
  return {
    total,
    byField,
    lastAt,
    malformed,
    atCap: raw.length >= MAX_DRIFT_LEDGER_BYTES,
  };
};
