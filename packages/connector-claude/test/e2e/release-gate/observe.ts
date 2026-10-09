/**
 * WHAT THE HUB WOULD SHOW at one moment of a case — read by the gate itself,
 * never by a hook, so a snapshot changes nothing it looks at: the tripwire
 * reads go through `peekAs`, kept out of the wire log the assertions over
 * Mike's own requests read. (What a connector booked is read by
 * release-gate/gate-checks.ts `bookedLines`.)
 */
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
