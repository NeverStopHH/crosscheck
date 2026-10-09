/**
 * WHAT THE HUB WOULD SHOW, AND WHAT A CONNECTOR BOOKED, at one moment of a
 * case — read by the gate itself, never by a hook, so a look changes nothing
 * it looks at: the tripwire reads go through `peekAs`, kept out of the wire
 * log the assertions over Mike's own requests read; the ledgers are read from
 * the temp homes.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { TestHub } from "./hub.ts";
import { conferenceOverlaps, contextsOf, ghostRows, targetsOf } from "./team.ts";
import type { ConferenceOverlap, ContextRow, GateDeveloper, GhostRow, TargetRow } from "./team.ts";

interface TripwireRow {
  readonly developerName: string;
  readonly [field: string]: unknown;
}

/** Of `files`, the ones `reader`'s tripwire would warn about `teammate` on now, as the hub would answer. */
export const filesWarnedAbout = async (
  hub: TestHub,
  reader: GateDeveloper,
  repo: string,
  files: readonly string[],
  teammate: string,
): Promise<readonly string[]> => {
  const answers = await Promise.all(
    files.map(async (file) => {
      const query = new URLSearchParams({ repo, value: file }).toString();
      const { sessions } = await hub.peekAs<{ sessions: readonly TripwireRow[] }>(reader.account, `/api/hints/tripwire?${query}`);
      return sessions.some((row) => row.developerName === teammate) ? [file] : [];
    }),
  );
  return answers.flat();
};

export interface Observed {
  readonly mikeGhost: readonly GhostRow[];
  readonly nickGhost: readonly GhostRow[];
  readonly mikeConference: readonly ConferenceOverlap[];
  readonly contexts: readonly ContextRow[];
  readonly targets: readonly TargetRow[];
  /** Of Mike's shared files, the ones his tripwire would warn him about Nick on. */
  readonly mikeWarnedAboutNick: readonly string[];
}

export interface ObservedPair {
  readonly mike: GateDeveloper;
  readonly nick: GateDeveloper;
  readonly repoId: string;
  /** The files Mike works on that the case asks his tripwire about. */
  readonly mikeFiles: readonly string[];
}

export const observe = async (hub: TestHub, pair: ObservedPair): Promise<Observed> => ({
  mikeGhost: await ghostRows(hub, pair.mike, pair.repoId),
  nickGhost: await ghostRows(hub, pair.nick, pair.repoId),
  mikeConference: await conferenceOverlaps(hub, pair.mike, pair.repoId),
  contexts: await contextsOf(hub.db, pair.repoId),
  targets: await targetsOf(hub.db, pair.repoId),
  mikeWarnedAboutNick: await filesWarnedAbout(hub, pair.mike, pair.repoId, pair.mikeFiles, "Nick"),
});

/** A stretch of a case on the real clock (the connector's): when one moment the assertions judge began and ended. */
export interface Moment {
  readonly from: number;
  readonly to: number;
}

/** Runs `body` and returns its result with the moment it took. */
export const timed = async <T>(body: () => Promise<T>): Promise<{ readonly value: T; readonly moment: Moment }> => {
  const from = Date.now();
  const value = await body();
  return { value, moment: { from, to: Date.now() } };
};

/** One line a connector booked: the ledger file (home-relative), its kind or reason, its detail, and when. */
export interface Booking {
  readonly file: string;
  readonly kind: string;
  /** The writer's own enum word (a hook name for a loss), or null. */
  readonly detail: string | null;
  /** Epoch ms of the booking's `at`, or null when the line carries none. */
  readonly at: number | null;
}

const bookingOf = (file: string, line: string): Booking => {
  try {
    const parsed = JSON.parse(line) as Readonly<Record<string, unknown>>;
    const at = typeof parsed["at"] === "string" ? Date.parse(parsed["at"]) : Number.NaN;
    return {
      file,
      kind: String(parsed["kind"] ?? parsed["reason"] ?? parsed["type"] ?? "?"),
      detail: typeof parsed["detail"] === "string" ? parsed["detail"] : null,
      at: Number.isNaN(at) ? null : at,
    };
  } catch {
    return { file, kind: line.slice(0, 80), detail: null, at: null };
  }
};

/**
 * EVERY LINE A CONNECTOR BOOKED in its home's ledgers — the loss ledger, every
 * omission ledger, the spool's drop records. Read generically, by file, so a
 * ledger a fixing branch adds is read too.
 */
export const bookingsOf = async (developer: GateDeveloper): Promise<readonly Booking[]> => {
  const entries = await readdir(developer.home, { recursive: true, withFileTypes: true }).catch(() => []);
  const spool = `${join(developer.home, "spool")}/`;
  const ledgers = entries
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".drops")))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !path.startsWith(spool) || path.endsWith(".drops"));
  const bookings = await Promise.all(
    ledgers.map(async (path) =>
      (await readFile(path, "utf8").catch(() => ""))
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => bookingOf(path.slice(developer.home.length + 1), line)),
    ),
  );
  return bookings.flat();
};

/** The bookings as `<file>: <kind>[/<detail>]`, for a log line. */
export const bookedLines = async (developer: GateDeveloper): Promise<readonly string[]> =>
  (await bookingsOf(developer)).map((booking) => `${booking.file}: ${booking.kind}${booking.detail === null ? "" : `/${booking.detail}`}`);

/** How many hooks `developer`'s connector booked as cut or skipped (`hook_timed_out`). */
export const hooksCut = async (developer: GateDeveloper): Promise<number> =>
  (await bookingsOf(developer)).filter((booking) => booking.kind === "hook_timed_out").length;
