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

import { sweepPins } from "@crosscheck/connector-core/http/hub.ts";
import { MAX_PIN_SWEEP_UPDATES } from "@crosscheck/schema";
import type { HubContext } from "@crosscheck/connector-core/http/client.ts";

import { runCli } from "../src/index.ts";
import { renderPinList } from "../src/cli/pin-render.ts";
import { renderSuspect } from "../src/cli/suspect-render.ts";
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

describe("crosscheck pin list at scale", () => {
  test("says the listing was truncated, so 200 rows never read as all of them", () => {
    // Arrange: a registry bigger than one page. The hub caps the LIST at
    // MAX_PINS_LISTED while the coverage counts every pin, which is right —
    // but a reader who sees 200 rows under a denominator of 250 and is told
    // nothing has been shown a subset labelled as the whole.
    const registry = {
      pins: [
        {
          id: "pin_11111111-2222-4333-8444-555555555555",
          repo: REPO_ID,
          surface: "Play button plays/pauses",
          files: [{ path: PINNED, status: "present" }],
          check: "open /workbench, press Play",
          captureMode: "human",
          verifiedById: "dev_nick",
          verifiedByName: "Nick",
          verifiedAtCommit: "a1b2c3d4",
          verifiedAt: new Date().toISOString(),
          brokeAt: null,
          brokeByName: null,
          speaking: true,
          missingPaths: 0,
          renamedPaths: 0,
          renamedAt: null,
          renamedByName: null,
        },
      ],
      coverage: {
        pins: 250,
        files: 700,
        speaking: 250,
        broken: 0,
        missingPaths: 0,
        oldestVerifiedAt: new Date().toISOString(),
      },
    };

    // Act
    const rendered = renderPinList(REPO_ID, registry, new Date());

    // Assert
    expect(rendered).toContain("pins: 250");
    expect(rendered).toContain("showing 1 of 250");
  });

  test("names who rewrote a pin's file set, and when", () => {
    // Arrange: the file set is what suspect intersects, so a rewrite moves
    // who gets named. The registry recorded nothing about it at all — a
    // repointed pin read exactly like one nobody had touched.
    const now = new Date();
    const registry = {
      pins: [
        {
          id: "pin_11111111-2222-4333-8444-555555555555",
          repo: REPO_ID,
          surface: "Play button plays/pauses",
          files: [{ path: "src/billing/invoice.ts", status: "present" }],
          check: "open /workbench, press Play",
          captureMode: "human",
          verifiedById: "dev_nick",
          verifiedByName: "Nick",
          verifiedAtCommit: "a1b2c3d4",
          verifiedAt: now.toISOString(),
          brokeAt: null,
          brokeByName: null,
          speaking: true,
          missingPaths: 0,
          renamedPaths: 1,
          renamedAt: new Date(now.getTime() - 120_000).toISOString(),
          renamedByName: "Ken",
        },
      ],
      coverage: {
        pins: 1,
        files: 1,
        speaking: 1,
        broken: 0,
        missingPaths: 0,
        oldestVerifiedAt: now.toISOString(),
      },
    };

    // Act
    const rendered = renderPinList(REPO_ID, registry, now);

    // Assert
    expect(rendered).toContain("1 path(s) rewritten by a sweep 2m ago by Ken");
  });
});

describe("crosscheck suspect at scale", () => {
  test("says the candidate list was cut, so 50 rows never read as all of them", () => {
    // Arrange: the company corpus shape — 305 work contexts touched the
    // pinned files inside the window and the hub scored the 50 that ranked
    // highest. A reader told only "50 session(s) touched this surface"
    // counts fifty and concludes crosscheck saw everything.
    const candidate = {
      sessionId: "cc_one",
      agentKind: "claude-code",
      branch: "main",
      workContextId: "wc_one",
      workContextTitle: "Playback transport rework",
      intent: null,
      lastActiveAt: new Date().toISOString(),
      overlap: 2,
      authorTouches: 8,
      lift: 0.25,
      sources: ["tool_edit"],
      readerMuted: false,
      isSelf: false,
    };
    const view = {
      outcome: "no_separation",
      falsifier: { kind: "recorded_break", at: new Date().toISOString(), check: null },
      scope: {
        kind: "pin",
        pinId: "pin_playback",
        surface: "Play button plays/pauses",
        files: [PINNED],
        missingFiles: [],
        rewrittenPaths: 0,
        rewrittenAt: null,
      },
      totals: { sessionsTouching: 305, sessionsScored: 50, windowDays: 14 },
      attribution: "sessions",
      candidates: [candidate],
    };

    // Act
    const rendered = renderSuspect(view, new Date());

    // Assert
    expect(rendered).toContain("305 session(s) touched this surface");
    expect(rendered).toContain("scored 50 of 305");
  });

  test("says the pin's file set was rewritten by a sweep, and when", () => {
    // Arrange: repointing a pin moves the set suspect intersects, so it moves
    // who gets named — under the same surface label and the same "the check
    // was run and failed" header. It is inside the authority `anyone may pin`
    // grants, so it is recorded rather than refused; before this there was no
    // record anywhere that the file set had ever moved.
    const now = new Date();
    const view = {
      outcome: "no_touch",
      falsifier: { kind: "recorded_break", at: now.toISOString(), check: null },
      scope: {
        kind: "pin",
        pinId: "pin_playback",
        surface: "Play button plays/pauses",
        files: ["src/billing/invoice.ts"],
        missingFiles: [],
        rewrittenPaths: 1,
        rewrittenAt: new Date(now.getTime() - 60_000).toISOString(),
      },
      totals: { sessionsTouching: 0, sessionsScored: 0, windowDays: 14 },
      attribution: "sessions",
      candidates: [],
    };

    // Act
    const rendered = renderSuspect(view, now);

    // Assert
    expect(rendered).toContain("1 pinned path(s) were rewritten by a sweep");
  });

  test("says a zero over a dead path is about the pin, not the world", () => {
    // Arrange: the sweep already recorded that git no longer has this path.
    // A touch row can only exist against a path that EXISTS, so the
    // intersection can only ever be empty — and "whatever broke it is not in
    // crosscheck's record" sends the reader hunting for a session when the
    // remedy is to re-pin the surface at its new path.
    const view = {
      outcome: "no_touch",
      falsifier: { kind: "recorded_break", at: new Date().toISOString(), check: null },
      scope: {
        kind: "pin",
        pinId: "pin_playback",
        surface: "Play button plays/pauses",
        files: [PINNED],
        missingFiles: [PINNED],
        rewrittenPaths: 0,
        rewrittenAt: null,
      },
      totals: { sessionsTouching: 0, sessionsScored: 0, windowDays: 14 },
      attribution: "sessions",
      candidates: [],
    };

    // Act
    const rendered = renderSuspect(view, new Date());

    // Assert
    expect(rendered).toContain(`${PINNED} (MISSING)`);
    expect(rendered).toContain("every path this pin watches is gone from git");
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

  test("chunks a sweep bigger than one request instead of being refused", async () => {
    // Arrange: runSweep builds one update per (pin, file) pair over the whole
    // listed page — 200 pins of 2 files is 400 — and the route caps the array
    // with zod .max(), which REJECTS the whole body rather than truncating.
    // With no chunking anywhere, the sweep was refused outright and recorded
    // NOTHING from 101 two-file pins upward: far below the 5,000-pin target
    // and reachable by a thirty-engineer team.
    const ctx: HubContext = {
      hubUrl,
      apiKey: nickKey,
      timeoutMs: 8000,
      home,
      repoKey: REPO_ID,
      now: () => new Date(),
    };
    const updates = Array.from(
      { length: MAX_PIN_SWEEP_UPDATES + 1 },
      (_unused, index) => ({
        pinId: `pin_absent_${String(index)}`,
        path: "src/core/absent.ts",
        newPath: "src/core/absent-moved.ts",
      }),
    );

    // Act
    const reported = await sweepPins(ctx, REPO_ID, updates);

    // Assert: two requests, one answer, and every update accounted for —
    // these name pins this hub does not hold, so they land as ignored.
    expect(reported.ok).toBe(true);
    if (reported.ok) {
      expect(reported.data.applied + reported.data.ignored).toBe(updates.length);
    }
  });

  test("says how many updates the hub refused to record", async () => {
    // Arrange: this team pins only files you have worked in. The rename
    // target is a file Nick has no recorded touch of, so the hub declines to
    // write it — and a sweep that reports "1 path recorded" while one update
    // was dropped has told the reader the register is current when it is not.
    const setPolicy = async (pinPolicy: string): Promise<void> => {
      const response = await fetch(`${hubUrl}/api/team-settings`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ repo: REPO_ID, pinPolicy }),
      });
      expect(response.status).toBe(200);
    };
    await writeRepoFile(repo, "src/core/policy-target.ts", "export const x = 1;\n");
    await git(repo, ["add", "src/core/policy-target.ts"]);
    await git(repo, ["commit", "-m", "add the policy target"]);
    await runFor(nickKey, [
      "pin",
      "Policy target still builds",
      "--files",
      "src/core/policy-target.ts",
      "--check",
      "run the build",
    ]);
    await git(repo, ["mv", "src/core/policy-target.ts", "src/core/invoice-target.ts"]);
    await git(repo, ["commit", "-m", "move the target into billing"]);
    await setPolicy("touched_files");

    // Act
    const swept = await runFor(nickKey, ["pin", "--sweep"]);
    await setPolicy("anyone");

    // Assert
    // Every live pin's rename target is a file Nick never worked in, so the
    // count follows how many pins this file left behind — the assertion is
    // that it is not zero and that the sentence names the cause.
    expect(swept.stdout).toMatch(/[1-9]\d* not recorded/);
    expect(swept.stdout).toContain("this team's pin policy");
  });
});
