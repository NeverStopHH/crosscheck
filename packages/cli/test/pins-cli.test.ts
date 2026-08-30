/**
 * `crosscheck pin` and `crosscheck suspect` end to end (regression-guard
 * Stage 1): a REAL hub over PGlite, a REAL git repository, and the commands
 * driven through `runCli`, so the sentences asserted here are the ones a
 * person actually reads.
 *
 * The five properties that make this feature safe to ship, each pinned:
 *
 *   1. an agent cannot pin — no terminal, no vouching, and the refusal says
 *      what to do instead;
 *   2. `pin list` prints the DENOMINATOR, so "2 pins" can never be read as
 *      protection of the rest of the repo;
 *   3. `suspect` names nobody until the pin's check was run and failed;
 *   4. when it does name, it names SESSIONS and their declared intents — the
 *      developer's name appears nowhere in the output;
 *   5. an unreachable hub says UNKNOWN, never "nobody".
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import { runCli } from "../src/index.ts";
import {
  git,
  makeHome,
  makeRepo,
  writeRepoFile,
} from "../../connector-core/test/helpers.ts";

const ADMIN_TOKEN = "pins-cli-admin";
const REPO_ID = "github.com/acme/api";
const PINNED = "src/workbench/usePlayback.ts";
const SECOND = "src/workbench/PlaybackControls.tsx";

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let home: string;
let repo: string;
let nickKey: string;
let mikeKey: string;
let mikeId: string;

const createDeveloper = async (
  name: string,
  email: string,
): Promise<{ readonly apiKey: string; readonly id: string }> => {
  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, email }),
  });
  const body = (await response.json()) as {
    data: { apiKey: string; developer: { id: string } };
  };
  return { apiKey: body.data.apiKey, id: body.data.developer.id };
};

const post = async (
  path: string,
  apiKey: string,
  body: unknown,
): Promise<Response> =>
  fetch(`${hubUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

interface RunOptions {
  readonly interactive?: boolean;
  readonly hub?: string;
}

const runFor = (
  apiKey: string,
  argv: readonly string[],
  options: RunOptions = {},
): Promise<{ stdout: string; exitCode: number }> =>
  runCli(
    [...argv],
    {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: options.hub ?? hubUrl,
      CROSSCHECK_API_KEY: apiKey,
      CROSSCHECK_TIMEOUT_MS: "4000",
    },
    repo,
    undefined,
    { isInteractive: () => options.interactive ?? true },
  );

/**
 * One work context with file touches, posted as the given developer. The
 * producer id is the poster's REAL id: `/api/records` rejects any envelope
 * whose `producer.developerId` is not the authenticated developer, so a
 * placeholder here would seed nothing and leave `suspect` looking correct
 * while it answered from an empty table.
 */
const seedTouches = async (
  apiKey: string,
  developerId: string,
  sessionId: string,
  contextId: string,
  title: string,
  files: readonly string[],
): Promise<void> => {
  const envelope = (kind: string, body: unknown): Record<string, unknown> => ({
    cx: "0.1",
    id: `env_${crypto.randomUUID()}`,
    ts: new Date().toISOString(),
    producer: { developerId, agentKind: "claude-code", sessionId },
    kind,
    body,
  });
  const response = await post("/api/records", apiKey, {
    records: [
      envelope("work_context", {
        id: contextId,
        sessionId,
        title,
        status: "implementing",
        createdAt: new Date().toISOString(),
        intent: {
          summary: "Widen the workbench filter row",
          provenance: "declared",
          confidence: 1,
          capturedAt: new Date().toISOString(),
        },
      }),
      ...files.map((value) =>
        envelope("target", { workContextId: contextId, kind: "file", value }),
      ),
    ],
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { rejected: number } };
  expect(body.data.rejected).toBe(0);
};

const pinIdFrom = (stdout: string): string => {
  const match = /pinned (pin_[\w-]+):/.exec(stdout);
  if (match?.[1] === undefined) {
    throw new Error(`no pin id in: ${stdout}`);
  }
  return match[1];
};

beforeAll(async () => {
  db = await createDb();
  server = Bun.serve({
    port: 0,
    fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch,
  });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  home = await makeHome("pins-cli");
  repo = await makeRepo("pins-cli", { remote: "git@github.com:acme/api.git" });
  await writeRepoFile(repo, PINNED, "export const play = 1;\n");
  await writeRepoFile(repo, SECOND, "export const Controls = 1;\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "workbench"]);
  nickKey = (await createDeveloper("Nick", "nick-pins-cli@example.com")).apiKey;
  const mike = await createDeveloper("Mike", "mike-pins-cli@example.com");
  mikeKey = mike.apiKey;
  mikeId = mike.id;
  for (const [key, id] of [
    [nickKey, "cc_nick"],
    [mikeKey, "cc_mike"],
  ] as const) {
    await post("/api/sessions", key, {
      id,
      agentKind: "claude-code",
      repo: REPO_ID,
      branch: "feat/workbench",
      baseCommit: "a1b2c3d4",
      status: "implementing",
    });
  }
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(
    [home, repo].map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("crosscheck pin", () => {
  test("refuses to pin when no person is at the terminal", async () => {
    // Arrange / Act: an agent's Bash tool call has no controlling tty.
    const result = await runFor(
      nickKey,
      ["pin", "Play button plays/pauses", "--files", PINNED, "--check", "open /workbench, press Play"],
      { interactive: false },
    );

    // Assert: refused, and the sentence says what a person should do.
    expect(result.stdout).toContain("needs a person at a terminal");
    expect(result.stdout).toContain("Run the same command yourself");
    const listed = await runFor(nickKey, ["pin", "list"]);
    expect(listed.stdout).toContain("nothing in this repo is watched");
  });

  test("refuses a speaking-sized pin with no check recipe", async () => {
    // Arrange / Act
    const result = await runFor(nickKey, [
      "pin",
      "Play button plays/pauses",
      "--files",
      PINNED,
    ]);

    // Assert
    expect(result.stdout).toContain("check recipe");
    expect(result.exitCode).not.toBe(0);
  });

  test("records a pin at the current commit, with the coverage denominator", async () => {
    // Act
    const created = await runFor(nickKey, [
      "pin",
      "Play button plays/pauses",
      "--files",
      PINNED,
      SECOND,
      "--check",
      "open /workbench, press Play",
    ]);

    // Assert
    expect(created.stdout).toContain("pinned pin_");
    expect(created.stdout).toContain("2 file(s) at");
    const listed = await runFor(nickKey, ["pin", "list"]);
    expect(listed.stdout).toContain("pins: 1 (2 files");
    // The DENOMINATOR sentence: what is NOT watched, on the same line.
    expect(listed.stdout).toContain("nothing else is watched");
    // The trust label prints the capture mode, not only the provenance.
    expect(listed.stdout).toContain("verified by Nick (a human, at a terminal)");
    expect(listed.stdout).toContain("«Play button plays/pauses»");
  });
});

describe("crosscheck suspect", () => {
  test("names nobody until the pin's check was run and failed", async () => {
    // Arrange: Mike's session touched both pinned files.
    await seedTouches(mikeKey, mikeId, "cc_mike", "wc_mike", "TM roster wiring", [
      PINNED,
      SECOND,
    ]);
    const listed = await runFor(nickKey, ["pin", "list"]);
    const pinId = /- (pin_[\w-]+) «/.exec(listed.stdout)?.[1] ?? "";
    expect(pinId).not.toBe("");

    // Act
    const before = await runFor(nickKey, ["suspect", pinId]);

    // Assert: the premise is missing, so the answer is the next action.
    expect(before.stdout).toContain("nothing is named yet");
    expect(before.stdout).toContain("crosscheck pin --broke");
    expect(before.stdout).not.toContain("cc_mike");
  });

  test("names the session and its intent, never the person", async () => {
    // Arrange
    const listed = await runFor(nickKey, ["pin", "list"]);
    const pinId = /- (pin_[\w-]+) «/.exec(listed.stdout)?.[1] ?? "";
    const broke = await runFor(nickKey, ["pin", "--broke", pinId]);
    expect(broke.stdout).toContain("retracted");

    // Act
    const after = await runFor(nickKey, ["suspect", pinId]);

    // Assert
    expect(after.stdout).toContain("falsified: the pin's check was run and failed");
    expect(after.stdout).toContain("session cc_mike");
    expect(after.stdout).toContain("«TM roster wiring»");
    expect(after.stdout).toContain("intent");
    expect(after.stdout).toContain("get_diagnosis wc_mike");
    // THE PRIVACY LINE: a person is one deliberate hop away, never in the
    // answer itself.
    expect(after.stdout).not.toContain("Mike");
    expect(after.stdout).toContain("sessions, not people");
  });

  test("ranks a named file with no pin at all, and says who the falsifier is", async () => {
    // Arrange / Act: day one, before anybody has pinned anything.
    const result = await runFor(nickKey, ["suspect", PINNED]);

    // Assert
    expect(result.stdout).toContain("no pin here: you named these files yourself");
    expect(result.stdout).toContain("session cc_mike");
  });

  test("an unreachable hub says UNKNOWN, never nobody", async () => {
    // Arrange: port 1 refuses instantly.
    const result = await runFor(nickKey, ["suspect", PINNED], {
      hub: "http://127.0.0.1:1",
    });

    // Assert
    expect(result.stdout).toContain("hub unreachable");
    expect(result.stdout).toContain("UNKNOWN");
  });
});

describe("crosscheck pin --sweep", () => {
  test("migrates a renamed path so the pin keeps watching", async () => {
    // Arrange: the weekly rename.
    await git(repo, ["mv", PINNED, "src/workbench/usePlaybackState.ts"]);
    await git(repo, ["commit", "-m", "rename the playback hook"]);
    // A second, live pin — the first was retracted above.
    const created = await runFor(nickKey, [
      "pin",
      "Playback still plays",
      "--files",
      PINNED,
      "--check",
      "open /workbench, press Play",
    ]);
    const pinId = pinIdFrom(created.stdout);

    // Act
    const swept = await runFor(nickKey, ["pin", "--sweep"]);

    // Assert
    expect(swept.stdout).toContain("1 renamed");
    const listed = await runFor(nickKey, ["pin", "list"]);
    expect(listed.stdout).toContain("src/workbench/usePlaybackState.ts");
    expect(listed.stdout).toContain(pinId);
  });
});
