/**
 * doctor's `last capture sync` line (trial finding H5 — the tautology).
 *
 * The old line read `lastOkAt`, which `recordSync` stamps after every ok hub
 * request with a non-empty repo key — doctor's OWN reachability probe six
 * lines earlier included. So a machine whose hooks had not reached the hub in
 * three hours printed `PASS last sync 0s ago`, and the same line read
 * `PASS last sync 2h ago` directly beneath `FAIL hub reachable invalid api
 * key`. The record is split now: `lastOkAt` = the hub answered this machine,
 * `lastCaptureOkAt` = a hook got through (register/heartbeat/records/end are
 * the only capture-marked calls, http/hub.ts).
 *
 * The hub here ANSWERS. That is the whole point — on the pre-fix tree an
 * answering hub is exactly what made the line green.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runDoctor } from "../src/cli/doctor.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

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

/** Answers presence like a healthy hub — the reachability probe must PASS. */
const acceptingHub = (): string => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ ok: true, data: { sessions: [] } }),
  });
  servers.push(server);
  return `http://127.0.0.1:${String(server.port)}`;
};

const fixture = async (): Promise<{
  readonly repo: string;
  readonly home: string;
  readonly hubUrl: string;
}> => {
  const repo = await makeRepo("doctor-last-sync", {
    remote: "git@github.com:acme/api.git",
  });
  const home = await makeHome("doctor-last-sync");
  paths.push(repo, home);
  return { repo, home, hubUrl: acceptingHub() };
};

const writeSyncState = async (
  home: string,
  hubUrl: string,
  record: Record<string, unknown>,
): Promise<void> => {
  const dir = join(home, "state");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${repoKey(hubUrl, REPO_ID)}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
};

/** A session state file is the "a session is running" signal doctor gates on. */
const writeLiveSession = async (home: string): Promise<void> => {
  const dir = join(home, "sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "live.json"), "{}\n", "utf8");
};

const doctorEnv = (home: string, hubUrl: string) => ({
  CROSSCHECK_HOME: home,
  HOME: home,
  CROSSCHECK_HUB_URL: hubUrl,
  CROSSCHECK_API_KEY: "test-key",
});

describe("doctor last capture sync", () => {
  test("WARNs on a 3h-old capture stamp beside a live session, while the hub is reachable", async () => {
    // Arrange: the hub answers; a hook last got through three hours ago.
    const { repo, home, hubUrl } = await fixture();
    const threeHoursAgo = new Date(Date.now() - THREE_HOURS_MS).toISOString();
    await writeSyncState(home, hubUrl, {
      lastSyncAt: threeHoursAgo,
      lastOkAt: threeHoursAgo,
      lastCaptureOkAt: threeHoursAgo,
      lastError: null,
      lastErrorStatus: null,
      cursorVersion: null,
    });
    await writeLiveSession(home);

    // Act
    const result = await runDoctor(
      doctorEnv(home, hubUrl),
      repo,
      async () => null,
    );

    // Assert: the capture path is stale, the hub is not — two facts, two lines
    expect(result.stdout).toContain("WARN  last capture sync");
    expect(result.stdout).toContain("with a live session");
    expect(result.stdout).toContain("PASS  hub reachable");
    // The pre-fix wording is the bug; it must be gone.
    expect(result.stdout).not.toContain("PASS  last sync 0s ago");
  });

  test("doctor's own probe never moves the capture stamp", async () => {
    // Arrange: a stamp doctor could only refresh by writing it itself
    const { repo, home, hubUrl } = await fixture();
    const threeHoursAgo = new Date(Date.now() - THREE_HOURS_MS).toISOString();
    await writeSyncState(home, hubUrl, {
      lastSyncAt: threeHoursAgo,
      lastOkAt: threeHoursAgo,
      lastCaptureOkAt: threeHoursAgo,
      lastError: null,
      lastErrorStatus: null,
      cursorVersion: null,
    });

    // Act
    await runDoctor(doctorEnv(home, hubUrl), repo, async () => null);

    // Assert: read back from disk — the probe wrote nothing here
    const after = (await Bun.file(
      join(home, "state", `${repoKey(hubUrl, REPO_ID)}.json`),
    ).json()) as { lastCaptureOkAt: string };
    expect(after.lastCaptureOkAt).toBe(threeHoursAgo);
  });

  test("a fresh capture stamp passes, live session or not", async () => {
    // Arrange
    const { repo, home, hubUrl } = await fixture();
    const nowIso = new Date().toISOString();
    await writeSyncState(home, hubUrl, {
      lastSyncAt: nowIso,
      lastOkAt: nowIso,
      lastCaptureOkAt: nowIso,
      lastError: null,
      lastErrorStatus: null,
      cursorVersion: null,
    });
    await writeLiveSession(home);

    // Act
    const result = await runDoctor(
      doctorEnv(home, hubUrl),
      repo,
      async () => null,
    );

    // Assert
    expect(result.stdout).toContain("PASS  last capture sync");
  });

  test("a machine with no session yet is not a defect", async () => {
    // Arrange: no sync state at all, no session state
    const { repo, home, hubUrl } = await fixture();

    // Act
    const result = await runDoctor(
      doctorEnv(home, hubUrl),
      repo,
      async () => null,
    );

    // Assert: silence, not a warning nobody can act on
    expect(result.stdout).toContain(
      "PASS  last capture sync  never — no session has reported from this repo",
    );
  });

  test("a live session that has never captured WARNs", async () => {
    // Arrange
    const { repo, home, hubUrl } = await fixture();
    await writeLiveSession(home);

    // Act
    const result = await runDoctor(
      doctorEnv(home, hubUrl),
      repo,
      async () => null,
    );

    // Assert
    expect(result.stdout).toContain("WARN  last capture sync");
    expect(result.stdout).toContain("no hook has reached the hub yet");
  });
});
