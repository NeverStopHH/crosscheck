/**
 * THE AUTHOR'S NOTICE, the reader's side (docs/1.0/landed-changes.md, step
 * 4, decision 11): a stop at Mike's landed change says "Mike is told about
 * this stop" exactly when it has recorded it for him — through a real hook,
 * a real clone and a real hub, down to the notice waiting for Mike.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { createDb, createServer } from "@crosscheck/server";

import { runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { repoKey, sessionSlug, spoolDataPath } from "@crosscheck/connector-core/config/paths.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import { flushSpool } from "@crosscheck/connector-core/spool/flush.ts";
import { readSessionSpool } from "@crosscheck/connector-core/spool/files.ts";
import { SessionStateSchema, writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome } from "../../connector-core/test/helpers.ts";
import {
  KEN,
  MIKE,
  NICK,
  gitIn,
  landWithMergeCommit,
  makeLandingRepos,
  readerFetches,
} from "../../connector-core/test/fixtures/landing-repos.ts";
import type { LandingRepos, Person } from "../../connector-core/test/fixtures/landing-repos.ts";

const ADMIN_TOKEN = "landed-notice-admin";
const SESSION_ID = "landed-notice-uuid";
const FILE = "src/lines.ts";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const HEAVY_SETUP_MS = 60_000;
const TOLD = "Mike is told about this stop.";

const paths: string[] = [];
const servers: { stop: (force?: boolean) => void }[] = [];

afterEach(async () => {
  for (const server of servers) {
    server.stop(true);
  }
  servers.length = 0;
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

const post = (url: string, path: string, key: string, body: unknown): Promise<Response> =>
  fetch(`${url}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

interface Account {
  readonly developerId: string;
  readonly apiKey: string;
}

const account = async (url: string, person: Person): Promise<Account> => {
  const created = await post(url, "/api/developers", ADMIN_TOKEN, { name: person.name, email: person.email });
  const parsed = (await created.json()) as { data: { developer: { id: string }; apiKey: string } };
  return { developerId: parsed.data.developer.id, apiKey: parsed.data.apiKey };
};

interface World {
  readonly hubUrl: string;
  readonly repos: LandingRepos;
  readonly home: string;
  readonly repoId: string;
  readonly nick: Account;
  readonly mike: Account;
  readonly env: Env;
}

/** A real hub, Nick's registered session in his clone, and Mike on the hub. */
const world = async (label: string): Promise<World> => {
  const server = Bun.serve({ port: 0, fetch: createServer({ db: await createDb(), adminToken: ADMIN_TOKEN }).fetch });
  servers.push(server);
  const hubUrl = `http://127.0.0.1:${String(server.port)}`;
  const repos = await makeLandingRepos(label);
  const home = await makeHome(label);
  paths.push(repos.base, home);
  const identity = await resolveRepoIdentity(repos.reader);
  if (identity === null) {
    throw new Error("the reader clone has no repo identity");
  }
  const nick = await account(hubUrl, NICK);
  const mike = await account(hubUrl, MIKE);
  const registered = await post(hubUrl, "/api/sessions", nick.apiKey, {
    id: `cc_${SESSION_ID}`,
    agentKind: "claude-code",
    repo: identity.repoId,
    branch: "nick/lines",
    baseCommit: "a1b2c3d4",
    status: "implementing",
  });
  expect(registered.status).toBe(200);
  await writeSessionState(
    home,
    SessionStateSchema.parse({
      hostSessionKey: SESSION_ID,
      crosscheckSessionId: `cc_${SESSION_ID}`,
      workContextId: `wc_cc_${SESSION_ID}`,
      repoId: identity.repoId,
      repoRoot: repos.reader,
      hubUrl,
      developerId: nick.developerId,
      startedAt: new Date().toISOString(),
    }),
  );
  return {
    hubUrl,
    repos,
    home,
    repoId: identity.repoId,
    nick,
    mike,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: nick.apiKey,
      TZ: "Europe/Berlin",
      CROSSCHECK_LANDING_FETCH: "off",
      // What the stop SAYS, not when: room enough that a slow machine's git
      // cannot spend the why (the budget tests live in landed-why-hook).
      CROSSCHECK_TIMEOUT_MS: "1500",
    },
  };
};

/** A change to FILE by `author`, committed an hour ago and merged into staging since. */
const lands = async (w: World, author: Person, subject: string = "Fix line offset"): Promise<void> => {
  await landWithMergeCommit(w.repos, {
    file: FILE,
    content: "export const offset = 2;\n",
    subject,
    landing: "staging",
    writtenAt: iso(-HOUR_MS),
    landedAt: iso(-30 * MINUTE_MS),
    author,
  });
  await readerFetches(w.repos);
};

const nickEditsRaw = (w: World, env: Env = w.env): Promise<string> =>
  runHook(
    "pre-tool-use",
    JSON.stringify({
      session_id: SESSION_ID,
      cwd: w.repos.reader,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_use_id: "toolu_notice_1",
      tool_input: { file_path: `${w.repos.reader}/${FILE}` },
    }),
    env,
  );

const nickEdits = async (w: World): Promise<string> => {
  const stdout = await nickEditsRaw(w);
  return stdout.length === 0
    ? ""
    : ((JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput
        ?.permissionDecisionReason ?? "");
};

const keyOf = (w: World): string => repoKey(w.hubUrl, w.repoId);

const spooledStops = async (w: World): Promise<readonly Record<string, unknown>[]> => {
  const spool = await readSessionSpool(w.home, keyOf(w), sessionSlug(SESSION_ID));
  return spool.lines
    .map((line) => JSON.parse(line) as { kind: string; body: Record<string, unknown> })
    .filter((record) => record.kind === "landed_stop")
    .map((record) => record.body);
};

describe("a stop at a teammate's landed change, for its author", () => {
  test(
    "says Mike is told, and Mike's notice is waiting on the hub after Nick's next flush",
    async () => {
      const w = await world("notice-told");
      await lands(w, MIKE);

      const reason = await nickEdits(w);
      const stops = await spooledStops(w);
      const flushed = await flushSpool(
        { hubUrl: w.hubUrl, apiKey: w.nick.apiKey, timeoutMs: 5000, home: w.home, repoKey: keyOf(w), now: () => new Date() },
        { sessionId: `cc_${SESSION_ID}`, developerId: w.nick.developerId },
        10_000,
      );
      const waiting = await fetch(`${w.hubUrl}/api/landed/notices?repo=${encodeURIComponent(w.repoId)}`, {
        headers: { Authorization: `Bearer ${w.mike.apiKey}` },
      });
      const notices = ((await waiting.json()) as { data: { notices: { readerName: string; path: string; commits: { missing: boolean }[] }[] } })
        .data.notices;

      expect(reason).toContain("«Fix line offset» by Mike, on staging");
      expect(reason).toContain(TOLD);
      expect(stops).toHaveLength(1);
      expect(stops[0]).toMatchObject({ path: FILE, commits: [{ authorDeveloperId: w.mike.developerId, missing: true }] });
      expect(flushed.outcome).toBe("flushed");
      expect(notices).toEqual([expect.objectContaining({ readerName: "Nick", path: FILE })]);
      expect(notices[0]?.commits.map((commit) => commit.missing)).toEqual([true]);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "a change Nick already has is recorded as one he has (decision 8)",
    async () => {
      const w = await world("notice-has-it");
      await lands(w, MIKE);
      await gitIn(w.repos.reader, ["merge", "-q", "--no-edit", "origin/staging"], { as: NICK });

      const reason = await nickEdits(w);

      expect(reason).toContain("your checkout has it");
      expect(reason).toContain(TOLD);
      expect(await spooledStops(w)).toEqual([
        expect.objectContaining({ commits: [expect.objectContaining({ missing: false })] }),
      ]);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "in notice mode no person sees the stop, so it tells nobody and says nobody is told",
    async () => {
      const w = await world("notice-headless");
      await lands(w, MIKE);

      const stdout = await nickEditsRaw(w, { ...w.env, CROSSCHECK_TRIPWIRE: "notice" });
      const context =
        (JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
          ?.additionalContext ?? "";

      expect(context).toContain("«Fix line offset» by Mike, on staging");
      expect(context).not.toContain("told about this stop");
      expect(await spooledStops(w)).toEqual([]);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "a subject the secret scan flags is sent blank",
    async () => {
      const w = await world("notice-secret");
      await lands(w, MIKE, "rotate deploy key AKIAIOSFODNN7EXAMPLE");

      const reason = await nickEdits(w);

      expect(reason).toContain(TOLD);
      expect(await spooledStops(w)).toEqual([
        expect.objectContaining({ commits: [expect.objectContaining({ subject: "" })] }),
      ]);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "an author the hub does not know is told nothing, and the stop says nothing about telling",
    async () => {
      const w = await world("notice-unknown");
      await lands(w, KEN);

      const reason = await nickEdits(w);

      expect(reason).toContain("«Fix line offset» by Ken, on staging");
      expect(reason).not.toContain("told about this stop");
      expect(await spooledStops(w)).toEqual([]);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "a stop whose record cannot be written names nobody as told",
    async () => {
      const w = await world("notice-unwritable");
      await lands(w, MIKE);
      // The session's spool file is a directory: every append is refused.
      const spoolPath = spoolDataPath(w.home, keyOf(w), sessionSlug(SESSION_ID));
      await mkdir(dirname(spoolPath), { recursive: true });
      await mkdir(spoolPath);

      const reason = await nickEdits(w);

      expect(reason).toContain("«Fix line offset» by Mike, on staging");
      expect(reason).not.toContain("told about this stop");
    },
    HEAVY_SETUP_MS,
  );
});
