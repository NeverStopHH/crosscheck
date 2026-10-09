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
 * failure shape when a login and a repo spell one hub two ways. So refused
 * sessions are counted here, and `doctor` and `status` print the count beside
 * the WARN naming both origins.
 *
 * ONCE PER (SESSION, FOREIGN ORIGIN), not per hook (review M1): every hook of
 * a refused session would otherwise append a line, and one long session
 * filled the cap. The session key is stored only as a short digest.
 *
 * BOUNDED BY AGE AND SIZE, never full for ever. Each write keeps only the
 * lines inside FOREIGN_HUB_WINDOW_DAYS — the reader's own window — so a bait
 * repo opened last month is pruned, and a new one is always recorded. Past
 * MAX_FOREIGN_HUB_LEDGER_BYTES the oldest in-window lines go first and a
 * `floor` marker says the counts are lower bounds; the marker ages out with
 * the window, so "at least N" cannot become permanent.
 *
 * Rewritten atomically (temp file and rename), and only when a new session
 * is counted or a line has aged out — once per refused session, not per
 * hook. Two writers racing can lose one line, which costs one count, never
 * the file. Fail open: an unwritable ledger costs the count, never the hook.
 *
 * NO KEY EVER LANDS HERE. A line holds the two origins, the repo id, the
 * surface's own word and the session digest, each screened again on the way
 * out, because a line is a file and a renderer reads it back.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

import {
  FOREIGN_HUB_WINDOW_DAYS,
  MAX_FOREIGN_HUB_LEDGER_BYTES,
} from "../constants.ts";
import type { ForeignHub } from "../config/key-binding.ts";
import { hubOrigin } from "../config/origin.ts";
import { readTextOrNull, writePrivateFile } from "../config/paths.ts";

const LEDGER_FILE = "foreign-hub.jsonl";

const MS_PER_DAY = 86_400_000;

/** Hex characters kept of a session key's digest: enough to tell sessions apart, nothing to read back. */
const SESSION_DIGEST_CHARS = 16;

/** Hook names, host events, `mcp`, `acp`: letters, digits, `_`, `-`. */
const SURFACE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;
const OTHER_SURFACE = "other";

/** A repo id is printable ASCII without spaces, as repo-identity derives it. */
const REPO_PATTERN = /^[\x21-\x7e]{1,200}$/;
const SESSION_PATTERN = new RegExp(`^[0-9a-f]{${String(SESSION_DIGEST_CHARS)}}$`);

export const foreignHubLedgerPath = (home: string): string => join(home, "state", LEDGER_FILE);

export interface ForeignHubRefusal {
  readonly repoId: string;
  readonly foreignHub: ForeignHub;
  /** The hook, host event or surface that was refused. */
  readonly surface: string;
  /**
   * The host session the refusal belongs to — Claude's session id, Cursor's
   * conversation, the ACP session, the MCP server process. One line per
   * (session, foreign origin); only a digest of it is stored.
   */
  readonly sessionKey: string;
  readonly now: Date;
}

interface RefusalLine {
  readonly kind: "refusal";
  readonly at: number;
  readonly repoId: string;
  readonly hub: string;
  readonly key: string | null;
  readonly surface: string;
  readonly session: string;
}

interface FloorLine {
  readonly kind: "floor";
  readonly at: number;
}

type LedgerLine = RefusalLine | FloorLine;

const RefusalSchema = z.looseObject({
  at: z.string().min(1),
  repo: z.string().regex(REPO_PATTERN),
  hub: z.string().min(1),
  key: z.string().nullable().catch(null),
  surface: z.string().regex(SURFACE_PATTERN).catch(OTHER_SURFACE),
  session: z.string().regex(SESSION_PATTERN),
});

const FloorSchema = z.looseObject({ at: z.string().min(1), floor: z.literal(true) });

/** An origin read back from disk counts only in its own canonical spelling. */
const isCanonicalOrigin = (value: string): boolean => hubOrigin(value) === value;

const parseLine = (line: string): LedgerLine | null => {
  try {
    const raw: unknown = JSON.parse(line);
    const floor = FloorSchema.safeParse(raw);
    if (floor.success) {
      const at = Date.parse(floor.data.at);
      return Number.isNaN(at) ? null : { kind: "floor", at };
    }
    const parsed = RefusalSchema.safeParse(raw);
    if (!parsed.success) {
      return null;
    }
    const { repo, hub, key, surface, session } = parsed.data;
    const at = Date.parse(parsed.data.at);
    const isScreened = isCanonicalOrigin(hub) && (key === null || isCanonicalOrigin(key));
    return isScreened && !Number.isNaN(at)
      ? { kind: "refusal", at, repoId: repo, hub, key, surface, session }
      : null;
  } catch {
    return null;
  }
};

const parseLedger = (text: string): readonly LedgerLine[] =>
  text.split("\n").flatMap((line) => {
    const parsed = line.length === 0 ? null : parseLine(line);
    return parsed === null ? [] : [parsed];
  });

const serialize = (line: LedgerLine): string =>
  line.kind === "floor"
    ? `${JSON.stringify({ at: new Date(line.at).toISOString(), floor: true })}\n`
    : `${JSON.stringify({
        at: new Date(line.at).toISOString(),
        repo: line.repoId,
        hub: line.hub,
        key: line.key,
        surface: line.surface,
        session: line.session,
      })}\n`;

/** Where the newest lines that fit in `budget` bytes start: everything before it is dropped. */
const firstKeptIndex = (sizes: readonly number[], budget: number): number => {
  let used = 0;
  for (let index = sizes.length - 1; index >= 0; index -= 1) {
    used += sizes[index] ?? 0;
    if (used > budget) {
      return index + 1;
    }
  }
  return 0;
};

const sessionDigest = (sessionKey: string): string =>
  createHash("sha256").update(sessionKey).digest("hex").slice(0, SESSION_DIGEST_CHARS);

const isSameRefusal = (line: LedgerLine, wanted: RefusalLine): boolean =>
  line.kind === "refusal" &&
  line.session === wanted.session &&
  line.repoId === wanted.repoId &&
  line.hub === wanted.hub &&
  line.key === wanted.key;

/**
 * The refusals that fit under the cap, oldest dropped first, with ONE floor
 * marker in front when anything inside the window had to go — or when an
 * earlier compaction's marker is still inside it.
 */
const fitToCap = (refusals: readonly RefusalLine[], floorAt: number | null, now: number): readonly LedgerLine[] => {
  const floorBytes = Buffer.byteLength(serialize({ kind: "floor", at: now }));
  const sizes = refusals.map((line) => Buffer.byteLength(serialize(line)));
  const kept = refusals.slice(firstKeptIndex(sizes, MAX_FOREIGN_HUB_LEDGER_BYTES - floorBytes));
  const droppedNow = kept.length < refusals.length;
  const floor: readonly FloorLine[] = droppedNow
    ? [{ kind: "floor", at: now }]
    : floorAt === null
      ? []
      : [{ kind: "floor", at: floorAt }];
  return [...floor, ...kept];
};

export const recordForeignHubRefusal = async (
  home: string,
  refusal: ForeignHubRefusal,
): Promise<void> => {
  try {
    const path = foreignHubLedgerPath(home);
    const now = refusal.now.getTime();
    const since = now - FOREIGN_HUB_WINDOW_DAYS * MS_PER_DAY;
    const lines = parseLedger((await readTextOrNull(path)) ?? "");
    const inWindow = lines.filter((line) => line.at >= since);
    const wanted: RefusalLine = {
      kind: "refusal",
      at: now,
      repoId: refusal.repoId,
      hub: refusal.foreignHub.hubOrigin,
      key: refusal.foreignHub.keyOrigin,
      surface: SURFACE_PATTERN.test(refusal.surface) ? refusal.surface : OTHER_SURFACE,
      session: sessionDigest(refusal.sessionKey),
    };
    const isCounted = inWindow.some((line) => isSameRefusal(line, wanted));
    if (isCounted && inWindow.length === lines.length) {
      return;
    }
    const refusals = [...inWindow, ...(isCounted ? [] : [wanted])].filter(
      (line): line is RefusalLine => line.kind === "refusal",
    );
    const floors = inWindow.filter((line): line is FloorLine => line.kind === "floor");
    const floorAt = floors.length === 0 ? null : Math.max(...floors.map((line) => line.at));
    await writePrivateFile(path, fitToCap(refusals, floorAt, now).map(serialize).join(""));
  } catch {
    // Fail open: the count is for doctor and status, never a failure source.
  }
};

/** One repo's refused sessions inside the window, per pair of origins. */
export interface ForeignHubRefusals {
  readonly repoId: string;
  readonly hubOrigin: string;
  readonly keyOrigin: string | null;
  /** Refused sessions — one line each. */
  readonly count: number;
  readonly lastAt: string;
}

export interface ForeignHubLedger {
  /** Newest first. */
  readonly groups: readonly ForeignHubRefusals[];
  /** Lines inside the window were dropped at the cap, so every count is a floor. */
  readonly isFull: boolean;
}

const groupKey = (line: RefusalLine): string => `${line.repoId}\n${line.hub}\n${line.key ?? ""}`;

/**
 * Every refused session inside FOREIGN_HUB_WINDOW_DAYS — bounded on both
 * sides, so a line stamped by a clock that ran ahead does not count either —
 * grouped by repo and the two origins. A line that will not parse, or whose
 * origins are not canonical, is skipped: the ledger is a count, not evidence.
 */
export const readForeignHubRefusals = async (home: string, now: Date): Promise<ForeignHubLedger> => {
  const text = await readTextOrNull(foreignHubLedgerPath(home));
  const since = now.getTime() - FOREIGN_HUB_WINDOW_DAYS * MS_PER_DAY;
  const inWindow = parseLedger(text ?? "").filter((line) => line.at >= since && line.at <= now.getTime());
  const groups = inWindow
    .filter((line): line is RefusalLine => line.kind === "refusal")
    .reduce<ReadonlyMap<string, ForeignHubRefusals>>((acc, line) => {
      const previous = acc.get(groupKey(line));
      const lastAt =
        previous === undefined || line.at > Date.parse(previous.lastAt)
          ? new Date(line.at).toISOString()
          : previous.lastAt;
      return new Map([
        ...acc,
        [
          groupKey(line),
          { repoId: line.repoId, hubOrigin: line.hub, keyOrigin: line.key, count: (previous?.count ?? 0) + 1, lastAt },
        ],
      ]);
    }, new Map());
  return {
    groups: [...groups.values()].sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt)),
    isFull: inWindow.some((line) => line.kind === "floor"),
  };
};

/** "3 sessions refused in the last 7 days, last <instant>" — "at least" when lines were dropped. */
export const formatForeignHubCount = (group: ForeignHubRefusals, isFull: boolean): string =>
  `${isFull ? "at least " : ""}${String(group.count)} session${group.count === 1 ? "" : "s"} refused in the last ` +
  `${String(FOREIGN_HUB_WINDOW_DAYS)} days, last ${group.lastAt}`;
