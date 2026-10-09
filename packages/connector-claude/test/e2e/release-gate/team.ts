/**
 * Developers and what the hub knows about them, for the release gate.
 *
 * EVERY DEVELOPER RUNS AS THE PILOT MACHINE DID: `CROSSCHECK_TRIPWIRE=notice`
 * (the owner's shell sets it — orchestration subagents are headless, and an
 * ask there is a one-shot deny), so a tripwire hit is `additionalContext` for
 * the agent and nothing else unless a build adds a person-facing channel.
 * Also, per developer: a temp CROSSCHECK_HOME (never ~/.crosscheck), the
 * in-process hub's URL (asserted loopback and not 7100), the landing fetch
 * off (its remote is a github.com URL that must never be contacted), and a
 * summarizer command that does not exist, so a derive worker the prompt hook
 * spawns fails open instead of starting a real model.
 *
 * THE BUDGET is the profile's (release-gate/profile.ts): PRODUCTION leaves
 * `CROSSCHECK_TIMEOUT_MS` unset, exactly as an installed connector runs —
 * HTTP_TIMEOUT_MS per request and each hook's ratio of it; GENEROUS sets the
 * old 4000 ms.
 */
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import type { Db } from "@crosscheck/server";

import type { Person } from "./git.ts";
import type { HostDeveloper } from "./host.ts";
import type { HubDeveloper, TestHub } from "./hub.ts";
import { GENEROUS_TIMEOUT_MS } from "./profile.ts";
import type { GateBudget } from "./profile.ts";

const FORBIDDEN_HUB_PORT = "7100";

export interface GateDeveloper extends HostDeveloper {
  readonly person: Person;
  readonly account: HubDeveloper;
  readonly home: string;
}

const assertLocalHub = (url: string): void => {
  const parsed = new URL(url);
  if (parsed.hostname !== "127.0.0.1" || parsed.port === FORBIDDEN_HUB_PORT || parsed.port === "") {
    throw new Error(`release gate refuses hub ${parsed.host}: only an in-process loopback hub`);
  }
};

export const makeDeveloper = async (
  hub: TestHub,
  person: Person,
  label: string,
  budget: GateBudget = "generous",
): Promise<GateDeveloper> => {
  assertLocalHub(hub.url);
  const account = await hub.createDeveloper(person.name, person.email);
  const home = await mkdtemp(join(tmpdir(), `cx-gate-home-${label}-`));
  return {
    name: person.name,
    person,
    account,
    home,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: account.apiKey,
      ...(budget === "generous" ? { CROSSCHECK_TIMEOUT_MS: GENEROUS_TIMEOUT_MS } : {}),
      CROSSCHECK_TRIPWIRE: "notice",
      CROSSCHECK_LANDING_FETCH: "off",
      CROSSCHECK_SUMMARIZER_CMD: join(home, "no-summarizer-installed"),
    },
  };
};

export interface GhostRow {
  readonly workContextId: string;
  readonly title: string;
  readonly developerName: string;
  readonly sharedTargets: readonly { readonly kind: string; readonly value: string }[];
  readonly sharedTargetCount: number;
  readonly [field: string]: unknown;
}

const repoQuery = (repo: string): string => `?repo=${encodeURIComponent(repo)}`;

/** `GET /api/ghost-checks` as `reader` — the overlap rows their briefing is built from. */
export const ghostRows = async (hub: TestHub, reader: GateDeveloper, repo: string): Promise<readonly GhostRow[]> =>
  (await hub.getAs<{ ghostChecks: readonly GhostRow[] }>(reader.account, `/api/ghost-checks${repoQuery(repo)}`))
    .ghostChecks;

export interface ConferenceOverlap {
  readonly workContextIdA: string;
  readonly workContextIdB: string;
  readonly sharedTargetCount: number;
  readonly sharedTargets: readonly { readonly kind: string; readonly value: string }[];
  readonly [field: string]: unknown;
}

/** `GET /api/conference` as `reader` — its duplicated-work pairs. */
export const conferenceOverlaps = async (
  hub: TestHub,
  reader: GateDeveloper,
  repo: string,
): Promise<readonly ConferenceOverlap[]> =>
  (
    await hub.getAs<{ conference: { overlaps: readonly ConferenceOverlap[] } }>(
      reader.account,
      `/api/conference${repoQuery(repo)}`,
    )
  ).conference.overlaps;

export interface ContextRow {
  readonly id: string;
  readonly title: string;
  readonly developer: string;
  readonly sessionBranch: string;
  readonly landedAt: string | null;
  /** Every column the build's work_contexts row has (topic branch included where it exists). */
  readonly row: Readonly<Record<string, unknown>>;
}

export const contextsOf = async (db: Db, repo: string): Promise<readonly ContextRow[]> => {
  const result = await db.execute(sql`
    select to_jsonb(wc) as row, d.name as developer, s.branch as session_branch
      from work_contexts wc
      join agent_sessions s on s.id = wc.session_id
      join developers d on d.id = s.developer_id
     where s.repo = ${repo}
     order by wc.id`);
  return result.rows.map((raw) => {
    const row = raw["row"] as Readonly<Record<string, unknown>>;
    return {
      id: String(row["id"]),
      title: String(row["title"]),
      developer: String(raw["developer"]),
      sessionBranch: String(raw["session_branch"]),
      landedAt: typeof row["landed_at"] === "string" ? row["landed_at"] : null,
      row,
    };
  });
};

export interface TargetRow {
  readonly developer: string;
  readonly workContextId: string;
  readonly kind: string;
  readonly value: string;
  readonly source: string;
}

export const targetsOf = async (db: Db, repo: string): Promise<readonly TargetRow[]> => {
  const result = await db.execute(sql`
    select d.name as developer, t.work_context_id, t.kind, t.value, t.source
      from work_context_targets t
      join work_contexts wc on wc.id = t.work_context_id
      join agent_sessions s on s.id = wc.session_id
      join developers d on d.id = s.developer_id
     where s.repo = ${repo}
     order by t.value, d.name`);
  return result.rows.map((row) => ({
    developer: String(row["developer"]),
    workContextId: String(row["work_context_id"]),
    kind: String(row["kind"]),
    value: String(row["value"]),
    source: String(row["source"]),
  }));
};

/** Every regular file under `root`, as text — a home is small, and a scan must see all of it. */
const readAllText = async (root: string): Promise<readonly { readonly path: string; readonly text: string }[]> => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  return Promise.all(files.map(async (path) => ({ path, text: await readFile(path, "utf8").catch(() => "") })));
};

/** Where `marker` occurs among the given texts and under the given directories: names only. */
export const findMarker = async (
  marker: string,
  texts: Readonly<Record<string, string>>,
  directories: readonly string[],
): Promise<readonly string[]> => {
  const inTexts = Object.entries(texts).flatMap(([name, text]) => (text.includes(marker) ? [name] : []));
  const inFiles = (await Promise.all(directories.map(readAllText)))
    .flat()
    .flatMap((file) => (file.text.includes(marker) ? [file.path] : []));
  return [...inTexts, ...inFiles];
};
