/**
 * THE CAPTURE-LOSS LEDGER (docs/1.0/loss-accounting.md §4.3) — losses that
 * are not records. The `.drops` ledger counts records the connector wrote and
 * did not deliver; this one counts the events upstream of any record: a hook
 * that ran out of budget before its capture could finish, a host payload
 * that lacked a field capture needs, a wire line the ACP observer could not
 * read. Each is a capture that may not have happened, which is exactly the
 * loss the hub's coverage has to hear about.
 *
 * ONE MACHINE-WIDE FILE, KEYED PER LINE. A hook that dies before repo
 * identity resolved does not know which repo it was capturing for, and a
 * Cursor payload with no workspace root cannot be keyed either — so `key` is
 * nullable, and a null key is CHARGED TO EVERY REPO this machine reports for
 * (§4.3, Nick's decision 10.2): the loss happened somewhere, and the
 * conservative reading is that it may have been here. Exact on a one-repo
 * machine; over-reporting in the safe direction on a many-repo one.
 *
 * Append-only for the sync-state lesson (spool/drops.ts header): racing hook
 * processes lose read-modify-write increments, appends they do not. Bounded
 * by MAX_LOSS_LEDGER_BYTES the way the Cursor drift ledger is: past the cap
 * the detail stops and the count is a FLOOR, which the reader says out loud.
 *
 * NO PAYLOAD CONTENT ever lands here: `detail` is the writer's own enum word
 * (a hook name, a host event name) and anything outside that alphabet is
 * stored as `other` — a line is a file, and a renderer reads it back.
 */
import { appendFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { MAX_LOSS_LEDGER_BYTES } from "../constants.ts";
import { ensureDir, readTextOrNull } from "../config/paths.ts";
import { toLines } from "../spool/lines.ts";

/** The LOSS_KINDS (schema/telemetry-loss.ts) this ledger is the source of. */
export const CAPTURE_LOSS_KINDS = [
  "hook_timed_out",
  "host_contract_drift",
  "wire_unobserved",
] as const;

export type CaptureLossKind = (typeof CAPTURE_LOSS_KINDS)[number];

const LOSS_LEDGER_FILE = "losses.jsonl";

export const lossLedgerPath = (home: string): string =>
  join(home, "state", LOSS_LEDGER_FILE);

/** Hook names (`post-tool-use`) and host events (`afterFileEdit`): letters, digits, `_`, `-`. */
const DETAIL_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;
const OTHER_DETAIL = "other";

const screenDetail = (detail: string | null): string | null =>
  detail === null ? null : DETAIL_PATTERN.test(detail) ? detail : OTHER_DETAIL;

export interface CaptureLossEntry {
  readonly kind: CaptureLossKind;
  readonly count: number;
  /** The repo key, or null when the writer did not know it (charged to every repo). */
  readonly key: string | null;
  /** The writer's own enum word — a hook name, a host event — or null. */
  readonly detail: string | null;
  readonly now: Date;
}

/**
 * Best-effort and bounded, like everything on a hook path: a full ledger or
 * an unwritable one costs the detail line, never the hook.
 */
export const recordCaptureLoss = async (
  home: string,
  entry: CaptureLossEntry,
): Promise<void> => {
  if (entry.count <= 0) {
    return;
  }
  try {
    const path = lossLedgerPath(home);
    const size = await stat(path).then(
      (info) => info.size,
      () => 0,
    );
    if (size >= MAX_LOSS_LEDGER_BYTES) {
      return;
    }
    await ensureDir(dirname(path));
    const line = {
      at: entry.now.toISOString(),
      kind: entry.kind,
      count: entry.count,
      key: entry.key,
      detail: screenDetail(entry.detail),
    };
    await appendFile(path, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    // Fail open — the ledger is telemetry, never a failure source.
  }
};

const EntrySchema = z.looseObject({
  at: z.string().min(1),
  kind: z.enum(CAPTURE_LOSS_KINDS),
  count: z.number().int().min(0),
  key: z.string().nullable().default(null),
  detail: z.string().nullable().default(null),
});

export interface CaptureLossSummary {
  /** Events charged to this repo: its own key and the unkeyed ones. */
  readonly total: number;
  readonly byKind: Readonly<Record<string, number>>;
  /** Per `kind:detail`, e.g. `hook_timed_out:post-tool-use`. */
  readonly byDetail: Readonly<Record<string, number>>;
  /** The part of `total` that carried no key — charged here by the machine-wide rule. */
  readonly unkeyed: number;
  readonly oldestAt: string | null;
  readonly newestAt: string | null;
  /** Lines that would not parse — counted, never silently skipped. */
  readonly malformed: number;
  /** True when the ledger refused further detail: every count above is a floor. */
  readonly atCap: boolean;
}

export const EMPTY_CAPTURE_LOSSES: CaptureLossSummary = {
  total: 0,
  byKind: {},
  byDetail: {},
  unkeyed: 0,
  oldestAt: null,
  newestAt: null,
  malformed: 0,
  atCap: false,
};

const safeJson = (line: string): unknown => {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
};

const bump = (
  counts: Readonly<Record<string, number>>,
  name: string,
  by: number,
): Readonly<Record<string, number>> => ({
  ...counts,
  [name]: (counts[name] ?? 0) + by,
});

const earlierIso = (left: string | null, right: string): string =>
  left === null || right < left ? right : left;

const laterIso = (left: string | null, right: string): string =>
  left === null || right > left ? right : left;

/**
 * This repo's share of the ledger: every line keyed to `key`, plus every
 * line keyed to nothing. Compared as strings, which orders correctly because
 * every stamp on this path is `Date#toISOString` — fixed width, UTC.
 */
export const readCaptureLosses = async (
  home: string,
  key: string,
): Promise<CaptureLossSummary> => {
  const raw = await readTextOrNull(lossLedgerPath(home));
  if (raw === null) {
    return EMPTY_CAPTURE_LOSSES;
  }
  const atCap = raw.length >= MAX_LOSS_LEDGER_BYTES;
  return toLines(raw).reduce<CaptureLossSummary>(
    (summary, line) => {
      const parsed = EntrySchema.safeParse(safeJson(line));
      if (!parsed.success) {
        return { ...summary, malformed: summary.malformed + 1 };
      }
      const entry = parsed.data;
      if (entry.key !== null && entry.key !== key) {
        return summary;
      }
      const detail = screenDetail(entry.detail) ?? OTHER_DETAIL;
      return {
        ...summary,
        total: summary.total + entry.count,
        byKind: bump(summary.byKind, entry.kind, entry.count),
        byDetail: bump(summary.byDetail, `${entry.kind}:${detail}`, entry.count),
        unkeyed: summary.unkeyed + (entry.key === null ? entry.count : 0),
        oldestAt: earlierIso(summary.oldestAt, entry.at),
        newestAt: laterIso(summary.newestAt, entry.at),
      };
    },
    { ...EMPTY_CAPTURE_LOSSES, atCap },
  );
};
