/**
 * THE KEYS THIS MACHINE DID NOT SEND, counted (config/key-binding.ts).
 *
 * A repo whose `.crosscheck.json` names a hub the developer's key does not
 * belong to — or a CROSSCHECK_HUB_URL that does the same — is "connected to
 * another hub", and every reporting surface stays out of it: nothing is
 * captured there and nothing reaches either hub. That is the SAFER of the two
 * choices. Spooling the captures locally would keep the developer's work on
 * disk addressed to a hub nobody vouched for, flushed by the one action the
 * repo would want to coax out of them — a login to that hub. But a refusal
 * nobody counts is a capture that silently stopped, which is the pilot's
 * failure shape when a login and a repo spell one hub two ways. So each
 * refused hook, tool call or proxy session appends one line here, and
 * `doctor` and `status` print the count beside the WARN naming both origins.
 *
 * LOCAL, NEVER ON THE WIRE: there is no hub this could honestly be reported
 * to. One machine-wide file, appended (racing hooks lose read-modify-write
 * increments, appends they do not), bounded by MAX_FOREIGN_HUB_LEDGER_BYTES —
 * past it the count is a floor the reader says out loud — and fail open: a
 * full or unwritable ledger costs the count, never the hook.
 *
 * NO KEY EVER LANDS HERE. A line holds the two origins, the repo id and the
 * surface's own word, each screened again on the way out, because a line is
 * a file and a renderer reads it back.
 */
import { appendFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import {
  FOREIGN_HUB_WINDOW_DAYS,
  MAX_FOREIGN_HUB_LEDGER_BYTES,
} from "../constants.ts";
import type { ForeignHub } from "../config/key-binding.ts";
import { hubOrigin } from "../config/origin.ts";
import { ensureDir, readTextOrNull } from "../config/paths.ts";

const LEDGER_FILE = "foreign-hub.jsonl";

const MS_PER_DAY = 86_400_000;

/** Hook names, host events, `mcp`, `acp`: letters, digits, `_`, `-`. */
const SURFACE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;
const OTHER_SURFACE = "other";

/** A repo id is printable ASCII without spaces, as repo-identity derives it. */
const REPO_PATTERN = /^[\x21-\x7e]{1,200}$/;

export const foreignHubLedgerPath = (home: string): string => join(home, "state", LEDGER_FILE);

export interface ForeignHubRefusal {
  readonly repoId: string;
  readonly foreignHub: ForeignHub;
  /** The hook, host event or surface that was refused. */
  readonly surface: string;
  readonly now: Date;
}

export const recordForeignHubRefusal = async (
  home: string,
  refusal: ForeignHubRefusal,
): Promise<void> => {
  try {
    const path = foreignHubLedgerPath(home);
    const size = await stat(path).then(
      (info) => info.size,
      () => 0,
    );
    if (size >= MAX_FOREIGN_HUB_LEDGER_BYTES) {
      return;
    }
    await ensureDir(dirname(path));
    const line = {
      at: refusal.now.toISOString(),
      repo: refusal.repoId,
      hub: refusal.foreignHub.hubOrigin,
      key: refusal.foreignHub.keyOrigin,
      surface: SURFACE_PATTERN.test(refusal.surface) ? refusal.surface : OTHER_SURFACE,
    };
    await appendFile(path, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    // Fail open: the count is for doctor and status, never a failure source.
  }
};

const LineSchema = z.looseObject({
  at: z.string().min(1),
  repo: z.string().regex(REPO_PATTERN),
  hub: z.string().min(1),
  key: z.string().nullable().catch(null),
});

/** One repo's refusals inside the window, per pair of origins. */
export interface ForeignHubRefusals {
  readonly repoId: string;
  readonly hubOrigin: string;
  readonly keyOrigin: string | null;
  readonly count: number;
  readonly lastAt: string;
}

export interface ForeignHubLedger {
  /** Newest first. */
  readonly groups: readonly ForeignHubRefusals[];
  /** The ledger reached its cap, so every count is a floor. */
  readonly isFull: boolean;
}

const EMPTY: ForeignHubLedger = { groups: [], isFull: false };

/** An origin read back from disk counts only in its own canonical spelling. */
const isCanonicalOrigin = (value: string): boolean => hubOrigin(value) === value;

const parseLine = (
  line: string,
): { readonly repoId: string; readonly hub: string; readonly key: string | null; readonly at: number } | null => {
  try {
    const parsed = LineSchema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      return null;
    }
    const { at, repo, hub, key } = parsed.data;
    const isScreened = isCanonicalOrigin(hub) && (key === null || isCanonicalOrigin(key));
    const instant = Date.parse(at);
    return isScreened && !Number.isNaN(instant) ? { repoId: repo, hub, key, at: instant } : null;
  } catch {
    return null;
  }
};

const groupKey = (repoId: string, hub: string, key: string | null): string =>
  `${repoId}\n${hub}\n${key ?? ""}`;

/**
 * Every refusal inside FOREIGN_HUB_WINDOW_DAYS, grouped by repo and the two
 * origins. A line that will not parse, or whose origins are not canonical, is
 * skipped: the ledger is a count, not evidence.
 */
export const readForeignHubRefusals = async (home: string, now: Date): Promise<ForeignHubLedger> => {
  const path = foreignHubLedgerPath(home);
  const text = await readTextOrNull(path);
  if (text === null) {
    return EMPTY;
  }
  const since = now.getTime() - FOREIGN_HUB_WINDOW_DAYS * MS_PER_DAY;
  const groups = text
    .split("\n")
    .flatMap((line) => {
      const entry = line.length === 0 ? null : parseLine(line);
      return entry !== null && entry.at >= since && entry.at <= now.getTime() ? [entry] : [];
    })
    .reduce<ReadonlyMap<string, ForeignHubRefusals>>((acc, entry) => {
      const id = groupKey(entry.repoId, entry.hub, entry.key);
      const previous = acc.get(id);
      const lastAt =
        previous === undefined || entry.at > Date.parse(previous.lastAt)
          ? new Date(entry.at).toISOString()
          : previous.lastAt;
      return new Map([
        ...acc,
        [
          id,
          {
            repoId: entry.repoId,
            hubOrigin: entry.hub,
            keyOrigin: entry.key,
            count: (previous?.count ?? 0) + 1,
            lastAt,
          },
        ],
      ]);
    }, new Map());
  const isFull = text.length >= MAX_FOREIGN_HUB_LEDGER_BYTES;
  return {
    groups: [...groups.values()].sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt)),
    isFull,
  };
};

/** "12 refused in the last 7 days, last <instant>" — "at least" when the ledger is full. */
export const formatForeignHubCount = (group: ForeignHubRefusals, isFull: boolean): string =>
  `${isFull ? "at least " : ""}${String(group.count)} refused in the last ${String(FOREIGN_HUB_WINDOW_DAYS)} days, last ${group.lastAt}`;
