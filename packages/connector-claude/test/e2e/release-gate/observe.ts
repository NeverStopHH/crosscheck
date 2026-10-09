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

const kindOf = (line: string): string => {
  try {
    const parsed = JSON.parse(line) as Readonly<Record<string, unknown>>;
    return String(parsed["kind"] ?? parsed["reason"] ?? parsed["type"] ?? "?");
  } catch {
    return line.slice(0, 80);
  }
};

/**
 * EVERY LINE A CONNECTOR BOOKED in its home's ledgers — the loss ledger, every
 * omission ledger, the spool's drop records — as `<file>: <kind or reason>`.
 * Read generically, by file, so a ledger a fixing branch adds is read too.
 */
export const bookedLines = async (developer: GateDeveloper): Promise<readonly string[]> => {
  const entries = await readdir(developer.home, { recursive: true, withFileTypes: true }).catch(() => []);
  const spool = `${join(developer.home, "spool")}/`;
  const ledgers = entries
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".drops")))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !path.startsWith(spool) || path.endsWith(".drops"));
  const lines = await Promise.all(
    ledgers.map(async (path) =>
      (await readFile(path, "utf8").catch(() => ""))
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => `${path.slice(developer.home.length + 1)}: ${kindOf(line)}`),
    ),
  );
  return lines.flat();
};

/** How many hooks `developer`'s connector booked as cut or skipped (`hook_timed_out`). */
export const hooksCut = async (developer: GateDeveloper): Promise<number> =>
  (await bookedLines(developer)).filter((line) => line.endsWith(": hook_timed_out")).length;
