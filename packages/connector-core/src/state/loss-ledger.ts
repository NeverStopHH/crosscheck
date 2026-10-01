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
 * conservative reading is that it may have been here. Never exact: the
 * writers book a null key only when the session's state names no repo and a
 * connected repo sits above one of the hook's paths (review M4,
 * config/connected-repo.ts mayBeConnectedRepo) — so a loss in an unconnected
 * checkout charges nobody, and the residue over-reports, the safe direction.
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
import { addCount } from "../spool/counts.ts";
import type { Counts } from "../spool/counts.ts";
import {
  NO_UNDATED,
  ledgerInstant,
  mergeUndated,
  readLedgerText,
  undatedOf,
} from "../spool/ledger-read.ts";
import type { UndatedContent } from "../spool/ledger-read.ts";
import { toLines } from "../spool/lines.ts";
import { UNATTRIBUTED_LOSS_KIND } from "@crosscheck/schema";
import {
  markLossLedgerFull,
  readLossRefusals,
  recordRefusedLoss,
} from "./loss-refusals.ts";
import type { LossRefusals } from "./loss-refusals.ts";

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
      // Refused, never dropped (review H1): counted and dated in the marker.
      await recordRefusedLoss(home, entry.kind, entry.count, entry.now);
      return;
    }
    await ensureDir(dirname(path));
    const line = `${JSON.stringify({
      at: entry.now.toISOString(),
      kind: entry.kind,
      count: entry.count,
      key: entry.key,
      detail: screenDetail(entry.detail),
    })}\n`;
    await appendFile(path, line, "utf8");
    if (size + Buffer.byteLength(line) >= MAX_LOSS_LEDGER_BYTES) {
      await markLossLedgerFull(home, entry.now);
    }
  } catch {
    // Fail open — the ledger is telemetry, never a failure source.
  }
};

/**
 * ONE HOOK THE BUDGET ABANDONED (docs/1.0/loss-accounting.md §3 row 14). The
 * runners call this AFTER the race has resolved, so the append never
 * competes with the handler for the deadline, and only on the timeout path,
 * so a hook that finished pays nothing. `key` is null when the budget won
 * before repo identity resolved — charged to every repo by the reader (§4.3).
 * `hook` is the runner's own event name, screened like every detail.
 */
export const recordHookTimeout = (
  home: string,
  hook: string,
  key: string | null,
  now: Date,
): Promise<void> =>
  recordCaptureLoss(home, { kind: "hook_timed_out", count: 1, key, detail: hook, now });

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
  /**
   * Lines the span cannot date — charged lines whose `at` will not parse and
   * lines that will not parse at all — bounded by the ledger file's mtime
   * (spool/ledger-read.ts, review H2): the report keeps the oldest unknown
   * and takes the bound as a newest, so the loss ages out.
   */
  readonly undated: UndatedContent;
  /** True when the ledger refused further detail: every count above is a floor. */
  readonly atCap: boolean;
  /** Losses the full ledger refused (state/loss-refusals.ts), charged to every repo; in `total`. */
  readonly refused: number;
  /** When the ledger filled, from its marker; null when no readable marker exists. */
  readonly fullSince: string | null;
  /** The newest refusal, from the marker; null when none. */
  readonly refusedNewestAt: string | null;
  /** The ledger file exists and could not be read (review M1); counted in `malformed`. */
  readonly unreadable: boolean;
  /**
   * The ledger's last write by ANY repo — its mtime or the newest refusal,
   * whichever is later. Fourteen days after it, nothing the file holds is
   * inside any repo's window, so removing the file changes no coverage.
   */
  readonly lastWriteAt: string | null;
}

export const EMPTY_CAPTURE_LOSSES: CaptureLossSummary = {
  total: 0,
  byKind: {},
  byDetail: {},
  unkeyed: 0,
  oldestAt: null,
  newestAt: null,
  malformed: 0,
  undated: NO_UNDATED,
  atCap: false,
  refused: 0,
  fullSince: null,
  refusedNewestAt: null,
  unreadable: false,
  lastWriteAt: null,
};

const safeJson = (line: string): unknown => {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
};

const bump = (counts: Counts, name: string, by: number): Counts =>
  addCount(counts, name, by);

const earlierIso = (left: string | null, right: string): string =>
  left === null || right < left ? right : left;

const laterIso = (left: string | null, right: string): string =>
  left === null || right > left ? right : left;

/**
 * The line's instant as the wire carries it, or null when it has none
 * (spool/ledger-read.ts: four-digit years only, review M2).
 */
const instantOf = (at: string): string | null => ledgerInstant(at);

/**
 * This repo's share of the ledger: every line keyed to `key`, plus every
 * line keyed to nothing. Instants are RE-FORMATTED through `Date.parse`
 * before they are compared or returned — a line is a file and files get
 * edited, and the span travels to the hub, whose schema refuses anything
 * but an ISO instant (`TelemetryLossReportSchema`) — so the comparison as
 * strings orders correctly: fixed width, UTC. A line with no readable
 * instant is still charged, and counted as `undated` instead of spanned.
 */
export const readCaptureLosses = async (
  home: string,
  key: string,
): Promise<CaptureLossSummary> => {
  const [ledger, refusals] = await Promise.all([
    readLedgerText(lossLedgerPath(home)),
    readLossRefusals(home),
  ]);
  const raw = ledger.text;
  const lines = ledger.unreadable
    ? unreadableLedger(ledger.writtenBy)
    : raw === null
      ? EMPTY_CAPTURE_LOSSES
      : linesSummary(raw, key, ledger.writtenBy);
  const summary = withRefusals(lines, refusals);
  return {
    ...summary,
    lastWriteAt: laterOrNull(ledger.writtenBy, refusals?.newestAt ?? null),
  };
};

/**
 * A capture ledger that exists and cannot be read (review M1): one line of
 * unknown content — the unreadable-line rule's floor, charged to every repo
 * like any machine-wide unreadable line — bounded by the file's mtime.
 */
const unreadableLedger = (writtenBy: string | null): CaptureLossSummary => ({
  ...EMPTY_CAPTURE_LOSSES,
  malformed: 1,
  undated: undatedOf(1, writtenBy),
  unreadable: true,
});

const laterOrNull = (left: string | null, right: string | null): string | null =>
  left === null || right === null ? (left ?? right) : right > left ? right : left;

const CAPTURE_KIND_SET: ReadonlySet<string> = new Set(CAPTURE_LOSS_KINDS);

/**
 * THE REFUSED LOSSES, CHARGED TO EVERY REPO (review H1): which repo lost them
 * is exactly the detail the cap refused, and an over-charge only weakens.
 * Dated by the marker, so the newest loss is the newest refusal — a full
 * ledger leaves the hub's window fourteen days after it, never freezes in
 * it and never vanishes from it. The oldest moves back to `fullSince`, a
 * lower bound on every refusal.
 */
const withRefusals = (
  summary: CaptureLossSummary,
  refusals: LossRefusals | null,
): CaptureLossSummary => {
  if (refusals === null) {
    return summary;
  }
  const refused = Object.values(refusals.refused).reduce((sum, count) => sum + count, 0);
  const byKind = Object.entries(refusals.refused).reduce<Counts>(
    (kinds, [kind, count]) =>
      bump(kinds, CAPTURE_KIND_SET.has(kind) ? kind : UNATTRIBUTED_LOSS_KIND, count),
    summary.byKind,
  );
  return {
    ...summary,
    total: summary.total + refused,
    byKind,
    unkeyed: summary.unkeyed + refused,
    refused,
    fullSince: refusals.fullSince,
    refusedNewestAt: refused > 0 ? refusals.newestAt : null,
    oldestAt: refused > 0 ? earlierIso(summary.oldestAt, refusals.fullSince) : summary.oldestAt,
    newestAt: laterIso(summary.newestAt, refusals.newestAt),
  };
};

/**
 * `writtenBy` is the ledger's mtime: every line in it was written no later,
 * so it bounds the lines that name no instant (review H2). A line that will
 * not parse is machine-wide — charged to every repo — and so is its bound.
 */
const linesSummary = (raw: string, key: string, writtenBy: string | null): CaptureLossSummary => {
  const atCap = raw.length >= MAX_LOSS_LEDGER_BYTES;
  const undatedLine = undatedOf(1, writtenBy);
  return toLines(raw).reduce<CaptureLossSummary>(
    (summary, line) => {
      const parsed = EntrySchema.safeParse(safeJson(line));
      if (!parsed.success) {
        return {
          ...summary,
          malformed: summary.malformed + 1,
          undated: mergeUndated(summary.undated, undatedLine),
        };
      }
      const entry = parsed.data;
      if (entry.key !== null && entry.key !== key) {
        return summary;
      }
      const detail = screenDetail(entry.detail) ?? OTHER_DETAIL;
      const at = instantOf(entry.at);
      const charged = {
        ...summary,
        total: summary.total + entry.count,
        byKind: bump(summary.byKind, entry.kind, entry.count),
        byDetail: bump(summary.byDetail, `${entry.kind}:${detail}`, entry.count),
        unkeyed: summary.unkeyed + (entry.key === null ? entry.count : 0),
      };
      return at === null
        ? { ...charged, undated: mergeUndated(summary.undated, undatedLine) }
        : {
            ...charged,
            oldestAt: earlierIso(summary.oldestAt, at),
            newestAt: laterIso(summary.newestAt, at),
          };
    },
    { ...EMPTY_CAPTURE_LOSSES, atCap },
  );
};
