/**
 * `cx 0` learns to tell offline from never-onboarded (Anhang A, A4-09).
 *
 * `cx 0 · no teammates on this repo` covered two worlds that need opposite
 * responses: a teammate who logged off this morning, and a repo nobody else
 * has ever connected to. Nothing on the statusline path knew the second person
 * existed — presence is live-only. SessionStart already holds the work-context
 * list, which carries an author and a timestamp per row, so the difference
 * costs one pure derivation and rides in the cache the statusline already
 * reads: no extra hub call, no extra hook budget.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runStatusline } from "../src/index.ts";
import { STATUSLINE_MAX_CHARS } from "@crosscheck/connector-core/constants.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import { deriveLastSeen } from "@crosscheck/connector-core/state/presence-cache.ts";
import type { WorkContextEntry } from "@crosscheck/connector-core/http/hub.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const SESSION_ID = "last-seen-uuid";
const HOUR_MS = 60 * 60 * 1000;

const paths: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const server of servers) {
    server.stop(true);
  }
  servers.length = 0;
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

/** Answers presence with an EMPTY list — the `cx 0` state. */
const emptyPresenceHub = (): string => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ ok: true, data: { sessions: [] } }),
  });
  servers.push(server);
  return `http://127.0.0.1:${String(server.port)}`;
};

const contextRow = (
  developerId: string,
  developerName: string,
  ageMs: number,
  overrides: Partial<WorkContextEntry> = {},
): WorkContextEntry => ({
  id: `wc_${developerId}_${String(ageMs)}`,
  developerId,
  developerName,
  title: "some work",
  status: "analyzing",
  createdAt: new Date(Date.now() - ageMs).toISOString(),
  updatedAt: null,
  ...overrides,
});

describe("deriveLastSeen", () => {
  test("one row per developer, newest first, self excluded", () => {
    // Arrange
    const contexts = [
      contextRow("dev_ken", "Ken", 10 * HOUR_MS),
      contextRow("dev_ken", "Ken", 2 * HOUR_MS),
      contextRow("dev_robin", "Robin", 30 * HOUR_MS),
      contextRow("dev_self", "Nick", HOUR_MS),
    ];

    // Act
    const lastSeen = deriveLastSeen(contexts, "dev_self");

    // Assert
    expect(lastSeen.map((entry) => entry.name)).toEqual(["Ken", "Robin"]);
    // Ken's NEWEST row wins, not whichever came first in the list
    expect(Date.now() - Date.parse(lastSeen[0]?.at ?? "")).toBeLessThan(
      3 * HOUR_MS,
    );
  });

  test("updatedAt beats createdAt when the hub sends both", () => {
    // Arrange
    const contexts = [
      contextRow("dev_ken", "Ken", 40 * HOUR_MS, {
        updatedAt: new Date(Date.now() - HOUR_MS).toISOString(),
      }),
    ];

    // Act
    const lastSeen = deriveLastSeen(contexts, "dev_self");

    // Assert
    expect(Date.now() - Date.parse(lastSeen[0]?.at ?? "")).toBeLessThan(
      2 * HOUR_MS,
    );
  });

  test("rows with no name or no usable date are dropped, not guessed at", () => {
    // Arrange
    const contexts = [
      { ...contextRow("dev_a", "A", HOUR_MS), developerName: undefined },
      { ...contextRow("dev_b", "B", HOUR_MS), createdAt: "not-a-date" },
    ] as readonly WorkContextEntry[];

    // Act
    const lastSeen = deriveLastSeen(contexts, "dev_self");

    // Assert: a half-fact on a status line is noise
    expect(lastSeen).toEqual([]);
  });

  test("capped, because the line is ninety characters wide", () => {
    // Arrange
    const contexts = ["a", "b", "c", "d", "e"].map((id, index) =>
      contextRow(`dev_${id}`, `Dev${id.toUpperCase()}`, (index + 1) * HOUR_MS),
    );

    // Act
    const lastSeen = deriveLastSeen(contexts, "dev_self");

    // Assert
    expect(lastSeen).toHaveLength(3);
  });
});

describe("the statusline's zero-teammate branch", () => {
  test("names who was last seen, and stays inside the width cap", async () => {
    // Arrange: nobody live, one teammate remembered
    const repo = await makeRepo("last-seen", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("last-seen");
    paths.push(repo, home);
    const hubUrl = emptyPresenceHub();
    await mkdir(join(home, "cache"), { recursive: true });
    await writeFile(
      join(home, "cache", `${repoKey(hubUrl, REPO_ID)}-presence.json`),
      `${JSON.stringify({
        fetchedAt: new Date().toISOString(),
        entries: [],
        lastSeen: [
          { name: "Ken", at: new Date(Date.now() - 10 * HOUR_MS).toISOString() },
        ],
      })}\n`,
      "utf8",
    );

    // Act
    const line = await runStatusline(
      JSON.stringify({ session_id: SESSION_ID, cwd: repo }),
      {
        CROSSCHECK_HOME: home,
        HOME: home,
        CROSSCHECK_HUB_URL: hubUrl,
        CROSSCHECK_API_KEY: "test-key",
      },
    );

    // Assert
    expect(line).toContain("no teammates on this repo");
    expect(line).toContain("Ken last seen 10h ago");
    expect(line.length).toBeLessThanOrEqual(STATUSLINE_MAX_CHARS);
  });

  test("a repo nobody else has touched keeps the bare sentence", async () => {
    // Arrange: an empty lastSeen list — the never-onboarded case
    const repo = await makeRepo("last-seen-none", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("last-seen-none");
    paths.push(repo, home);
    const hubUrl = emptyPresenceHub();

    // Act
    const line = await runStatusline(
      JSON.stringify({ session_id: SESSION_ID, cwd: repo }),
      {
        CROSSCHECK_HOME: home,
        HOME: home,
        CROSSCHECK_HUB_URL: hubUrl,
        CROSSCHECK_API_KEY: "test-key",
      },
    );

    // Assert
    expect(line).toContain("no teammates on this repo");
    expect(line).not.toContain("last seen");
  });
});
