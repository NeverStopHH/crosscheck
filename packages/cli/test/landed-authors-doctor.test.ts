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
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createDb, createServer } from "@crosscheck/server";
import type { HubContext } from "@crosscheck/connector-core/http/client.ts";

import {
  checkCloudAgentMailmap,
  checkLandedAuthors,
} from "../src/cli/doctor-landed-authors.ts";
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
    "never offers a .mailmap line that would hand Claude's commits to a person",
    async () => {
      // Arrange: a squash landed as Claude Code on the web commits. The hub
      // says the address is nobody's — true — but mapping it to a teammate
      // would make every cloud session's commits theirs.
      const s = await setup("lad-cloud-agent");
      await lands(s, { name: "Claude", email: "noreply@anthropic.com" }, "export const offset = 6;\n");

      // Act
      const line = await checkLandedAuthors(s.repos.reader, hubFor(s));

      // Assert
      expect(line.level).toBe("PASS");
      expect(line.detail).not.toContain("noreply@anthropic.com");
      expect(line.detail).not.toContain("Claude <");
    },
    HEAVY_SETUP_MS,
  );

  test(
    "a .mailmap line cannot launder a Claude commit into the address it names",
    async () => {
      // Arrange: the line the old doctor suggested, pointing at an address
      // no commit of the fixture carries
      const s = await setup("lad-cloud-agent-mailmap");
      await lands(s, { name: "Claude", email: "noreply@anthropic.com" }, "export const offset = 7;\n");
      await writeFile(join(s.repos.reader, ".mailmap"), "Ghost <ghost@example.com> Claude <noreply@anthropic.com>\n");

      // Act
      const line = await checkLandedAuthors(s.repos.reader, hubFor(s));

      // Assert: the raw identity decides, never the mapped one
      expect(line.detail).not.toContain("ghost@example.com");
      expect(line.detail).not.toContain("noreply@anthropic.com");
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

describe("doctor's cloud agent mailmap line", () => {
  test(
    "warns when the repo's .mailmap hands Claude's commit identity to a person",
    async () => {
      // Arrange: the old doctor's own suggested shape
      const s = await setup("cam-mapped");
      await writeFile(join(s.repos.reader, ".mailmap"), "Mike <mike@example.com> Claude <noreply@anthropic.com>\n");

      // Act
      const line = await checkCloudAgentMailmap(s.repos.reader);

      // Assert: what the line does, that crosscheck ignores it, and the fix
      expect(line).toEqual({
        level: "WARN",
        name: "cloud agent mailmap",
        detail:
          "the repo's .mailmap maps Claude Code on the web's commit identity noreply@anthropic.com " +
          "to another address, so git log, blame and shortlog credit one person with every cloud " +
          "session's commits; crosscheck ignores that mapping and those commits stay an unconnected " +
          "gap — remove the line for noreply@anthropic.com from .mailmap",
      });
    },
    HEAVY_SETUP_MS,
  );

  test(
    "passes when no .mailmap line maps a cloud agent's commit identity",
    async () => {
      // Arrange: a mapping for a teammate only
      const s = await setup("cam-clean");
      await writeFile(join(s.repos.reader, ".mailmap"), "Mike <mike@example.com> <12345+mike@users.noreply.github.com>\n");

      // Act
      const line = await checkCloudAgentMailmap(s.repos.reader);

      // Assert
      expect(line).toEqual({
        level: "PASS",
        name: "cloud agent mailmap",
        detail: "no .mailmap line maps a cloud agent's commit identity to another address",
      });
    },
    HEAVY_SETUP_MS,
  );
});
