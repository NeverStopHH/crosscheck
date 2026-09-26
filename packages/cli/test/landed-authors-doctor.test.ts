/**
 * `doctor`'s "landed-change reasons" line: whose commits on the landing
 * branches the hub cannot put a name to (docs/1.0/landed-changes.md, step 3,
 * decision 7).
 *
 * A landed-change stop names the teammate work behind a commit only when the
 * hub knows the commit's author address. GitHub writes squash commits under
 * an address like 12345+mike@users.noreply.github.com, and an address the hub
 * does not know silently costs every stop its why. This line names those
 * addresses — read from the reader's own clone, after .mailmap, own and bot
 * commits left out — with the .mailmap line that fixes each for the whole
 * team. PASS throughout: an outside contributor is no fault.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import type { HubContext } from "@crosscheck/connector-core/http/client.ts";

import { checkLandedAuthors } from "../src/cli/doctor-landed-authors.ts";
import { makeHome } from "../../connector-core/test/helpers.ts";
import {
  NICK,
  commitFile,
  gitIn,
  landWithSquash,
  makeLandingRepos,
  readerFetches,
} from "../../connector-core/test/fixtures/landing-repos.ts";
import type { LandingRepos, Person } from "../../connector-core/test/fixtures/landing-repos.ts";

const ADMIN_TOKEN = "landed-authors-admin";
const HEAVY_SETUP_MS = 60_000;
const DAY_MS = 86_400_000;
const DEPENDABOT: Person = {
  name: "dependabot[bot]",
  email: "49699333+dependabot[bot]@users.noreply.github.com",
};

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

const post = (url: string, path: string, key: string, body: unknown): Promise<Response> =>
  fetch(`${url}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

interface Setup {
  readonly repos: LandingRepos;
  readonly hubUrl: string;
  readonly nickKey: string;
  readonly home: string;
}

const setup = async (label: string): Promise<Setup> => {
  const server = Bun.serve({ port: 0, fetch: createServer({ db: await createDb(), adminToken: ADMIN_TOKEN }).fetch });
  servers.push(server);
  const hubUrl = `http://127.0.0.1:${String(server.port)}`;
  const created = await post(hubUrl, "/api/developers", ADMIN_TOKEN, { name: NICK.name, email: NICK.email });
  const nickKey = ((await created.json()) as { data: { apiKey: string } }).data.apiKey;
  const repos = await makeLandingRepos(label);
  const home = await makeHome(label);
  paths.push(repos.base, home);
  return { repos, hubUrl, nickKey, home };
};

const hubFor = (s: Setup): HubContext => ({
  hubUrl: s.hubUrl,
  apiKey: s.nickKey,
  timeoutMs: 2000,
  home: s.home,
  repoKey: "",
  now: () => new Date(),
});

const lands = async (s: Setup, author: Person, content: string): Promise<void> => {
  await landWithSquash(s.repos, {
    file: "src/lines.ts",
    content,
    subject: "A change",
    landing: "staging",
    landedAt: new Date(Date.now() - DAY_MS).toISOString(),
    author,
  });
  await readerFetches(s.repos);
};

const MIKE_NOREPLY: Person = { name: "Mike", email: "12345+mike@users.noreply.github.com" };

describe("doctor's landed-change reasons line", () => {
  test(
    "names a commit address the hub does not know, and the .mailmap line that fixes it",
    async () => {
      const s = await setup("lad-unknown");
      await lands(s, MIKE_NOREPLY, "export const offset = 2;\n");

      const line = await checkLandedAuthors(s.repos.reader, hubFor(s));

      expect(line.level).toBe("PASS");
      expect(line.name).toBe("landed-change reasons");
      expect(line.detail).toContain("12345+mike@users.noreply.github.com");
      expect(line.detail).toContain(".mailmap");
      expect(line.detail).toContain("Mike <");
    },
    HEAVY_SETUP_MS,
  );

  test(
    "says so when every author is known, so their stops can name their work",
    async () => {
      const s = await setup("lad-known");
      // Mike under both addresses he commits with: his own (the fixture's
      // first commit) and GitHub's squash address, linked by an admin.
      const created = await post(s.hubUrl, "/api/developers", ADMIN_TOKEN, { name: "Mike", email: "mike@example.com" });
      const mikeId = ((await created.json()) as { data: { developer: { id: string } } }).data.developer.id;
      await post(s.hubUrl, `/api/developers/${mikeId}/emails`, ADMIN_TOKEN, { email: MIKE_NOREPLY.email });
      await lands(s, MIKE_NOREPLY, "export const offset = 3;\n");

      const line = await checkLandedAuthors(s.repos.reader, hubFor(s));

      expect(line.level).toBe("PASS");
      expect(line.detail).toContain("known to the hub");
      expect(line.detail).not.toContain("@");
    },
    HEAVY_SETUP_MS,
  );

  test(
    "leaves bots and the reader's own commits out",
    async () => {
      const s = await setup("lad-bots-own");
      await lands(s, DEPENDABOT, "export const offset = 4;\n");
      // Nick commits from a laptop address the hub has never heard of, so
      // only the own-address rule — not the hub — can keep it off the list.
      const laptop: Person = { name: NICK.name, email: "nick-laptop@example.com" };
      await gitIn(s.repos.reader, ["config", "user.email", laptop.email]);
      await gitIn(s.repos.reader, ["checkout", "-q", "-b", "nick/landed", "origin/staging"]);
      await commitFile(s.repos.reader, "src/mine.ts", "export {};\n", "mine", { as: laptop });
      await gitIn(s.repos.reader, ["push", "-q", "origin", "HEAD:staging"]);
      await readerFetches(s.repos);

      const line = await checkLandedAuthors(s.repos.reader, hubFor(s));

      expect(line.level).toBe("PASS");
      expect(line.detail).not.toContain("dependabot");
      expect(line.detail).not.toContain(laptop.email);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "an older hub without the question is said, not warned about",
    async () => {
      const fake = Bun.serve({
        port: 0,
        fetch: () => Response.json({ ok: false, error: { code: "not_found", message: "no route" } }, { status: 404 }),
      });
      servers.push(fake);
      const s = await setup("lad-old-hub");
      await lands(s, MIKE_NOREPLY, "export const offset = 5;\n");

      const line = await checkLandedAuthors(s.repos.reader, {
        ...hubFor(s),
        hubUrl: `http://127.0.0.1:${String(fake.port)}`,
      });

      expect(line.level).toBe("PASS");
      expect(line.detail).toContain("does not answer this yet");
    },
    HEAVY_SETUP_MS,
  );
});
