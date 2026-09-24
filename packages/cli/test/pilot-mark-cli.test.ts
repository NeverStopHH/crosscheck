/**
 * The pilot's two human gestures end to end (1.0 spec 07 §3.2) — `crosscheck
 * noise [id]` and `crosscheck pin --ok <id>` — with a REAL hub, a REAL
 * repository, and session-state files in a throwaway home — because "which
 * delivery did the person mean" is decided by what is live on THIS machine,
 * and only real state files say that.
 *
 * What these pin:
 *   · one candidate is marked without asking; several are LISTED and nothing
 *     is marked, because a guessed mark is noise about noise;
 *   · no live session, or nothing recent, is SAID — a gesture that appears
 *     to do nothing is one a team stops making;
 *   · the id a person actually saw — the work context a hint printed — is
 *     enough, and so is a delivery id;
 *   · an agent cannot make the gesture: no terminal, no mark.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import { hintDeliveryId } from "@crosscheck/connector-core/capture/records.ts";
import {
  EXIT_OK,
  EXIT_USAGE,
} from "@crosscheck/connector-core/constants.ts";
import { writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";

import { runCli } from "../src/index.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const ADMIN_TOKEN = "noise-cli-admin";
const REPO_ID = "github.com/acme/api";
const OTHER_REPO_ID = "github.com/acme/web";
const LIVE = "cc_11111111-2222-4333-8444-555555555555";
const GONE = "cc_22222222-2222-4333-8444-555555555555";
const QUIET = "cc_44444444-2222-4333-8444-555555555555";
const KEN_SESSION = "cc_33333333-2222-4333-8444-555555555555";
const KEN_CONTEXT = "wc_ken_playback";
const KEN_OTHER_CONTEXT = "wc_ken_filters";
const MS_PER_MINUTE = 60_000;

let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let repo: string;
let otherRepo: string;
let nick: { apiKey: string; id: string };
let ken: { apiKey: string; id: string };
const homes: string[] = [];

const createDeveloper = async (
  name: string,
  email: string,
): Promise<{ apiKey: string; id: string }> => {
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

const send = async (
  method: string,
  path: string,
  apiKey: string,
  body: unknown,
): Promise<Response> =>
  fetch(`${hubUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

const envelope = (
  developerId: string,
  sessionId: string,
  kind: string,
  body: unknown,
): unknown => ({
  cx: "0.1",
  id: `env_${crypto.randomUUID()}`,
  ts: new Date().toISOString(),
  producer: { developerId, agentKind: "claude-code", sessionId },
  kind,
  body,
});

/** A pointer at one of Ken's contexts, delivered to one of Nick's sessions. */
const deliver = async (
  sessionId: string,
  refId: string,
  minutesAgo: number,
): Promise<string> => {
  const id = hintDeliveryId(sessionId, refId);
  const response = await send("POST", "/api/records", nick.apiKey, {
    records: [
      envelope(nick.id, sessionId, "hint_delivery", {
        id,
        sessionId,
        refKind: "work_context",
        refId,
        channel: "prompt_hint",
        deliveredAt: new Date(Date.now() - minutesAgo * MS_PER_MINUTE).toISOString(),
      }),
    ],
  });
  expect(response.status).toBe(200);
  return id;
};

/** A home whose only live session is `sessionId` on this repo. */
const homeWithLive = async (
  sessionId: string | null,
  repoRoot: string = repo,
  repoId: string = REPO_ID,
): Promise<string> => {
  const home = await makeHome("noise-cli");
  homes.push(home);
  if (sessionId !== null) {
    await writeSessionState(home, {
      hostSessionKey: sessionId.replace("cc_", ""),
      crosscheckSessionId: sessionId,
      workContextId: `wc_${sessionId}`,
      repoId,
      repoRoot,
      hubUrl,
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    });
  }
  return home;
};

const noise = (
  home: string,
  argv: readonly string[] = [],
  options: { readonly interactive?: boolean; readonly cwd?: string } = {},
): Promise<{ stdout: string; exitCode: number }> =>
  runCli(
    ["noise", ...argv],
    {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: nick.apiKey,
      CROSSCHECK_TIMEOUT_MS: "4000",
    },
    options.cwd ?? repo,
    undefined,
    { isInteractive: () => options.interactive ?? true },
  );

beforeAll(async () => {
  const db = await createDb();
  server = Bun.serve({
    port: 0,
    fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch,
  });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  repo = await makeRepo("noise-cli", { remote: "git@github.com:acme/api.git" });
  otherRepo = await makeRepo("noise-cli-web", { remote: "git@github.com:acme/web.git" });
  nick = await createDeveloper("Nick", "nick-noise@example.com");
  ken = await createDeveloper("Ken", "ken-noise@example.com");
  for (const [key, id, repoId] of [
    [nick.apiKey, LIVE, REPO_ID],
    [nick.apiKey, GONE, REPO_ID],
    [nick.apiKey, QUIET, REPO_ID],
    [ken.apiKey, KEN_SESSION, REPO_ID],
  ] as const) {
    await send("POST", "/api/sessions", key, {
      id,
      agentKind: "claude-code",
      repo: repoId,
      branch: "main",
      baseCommit: "a1b2c3d4",
      status: "implementing",
    });
  }
  const contexts = await send("POST", "/api/records", ken.apiKey, {
    records: [KEN_CONTEXT, KEN_OTHER_CONTEXT].map((id) =>
      envelope(ken.id, KEN_SESSION, "work_context", {
        id,
        sessionId: KEN_SESSION,
        title: "Ken's context",
        status: "implementing",
        createdAt: new Date().toISOString(),
      }),
    ),
  });
  expect(contexts.status).toBe(200);
  await send("PUT", "/api/team-settings", ADMIN_TOKEN, {
    repo: REPO_ID,
    pilotEnrolled: true,
  });
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(
    [repo, otherRepo, ...homes].map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("crosscheck noise", () => {
  test("with no id, the one recent delivery to a live session here is marked", async () => {
    // Arrange
    const id = await deliver(LIVE, KEN_CONTEXT, 5);
    const home = await homeWithLive(LIVE);

    // Act
    const result = await noise(home);

    // Assert
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain(`recorded: ${id} is off-target`);
    // Saying it again is one mark, and the person is told so.
    const again = await noise(home, [id]);
    expect(again.stdout).toContain("already");
  });

  test("several candidates are listed, and none is guessed", async () => {
    // Arrange
    const first = await deliver(LIVE, KEN_OTHER_CONTEXT, 3);
    const home = await homeWithLive(LIVE);

    // Act — LIVE now holds two recent deliveries (this one and the one above)
    const result = await noise(home);

    // Assert
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("name the one you mean");
    expect(result.stdout).toContain(`crosscheck noise ${first}`);
    expect(result.stdout).not.toContain("recorded:");
  });

  test("no live session on this machine is said, with what to do", async () => {
    // Arrange
    const home = await homeWithLive(null);

    // Act
    const result = await noise(home);

    // Assert
    expect(result.stdout).toContain("no live crosscheck session");
    expect(result.stdout).toContain("crosscheck noise wc_");
  });

  test("a delivery to a session NOT on this machine is not the one meant", async () => {
    // Arrange — GONE is Nick's too, but its state file is on another laptop.
    await deliver(GONE, KEN_CONTEXT, 2);
    const home = await homeWithLive(LIVE);

    // Act
    const result = await noise(home);

    // Assert — only LIVE's two are offered.
    expect(result.stdout).not.toContain(hintDeliveryId(GONE, KEN_CONTEXT));
  });

  test("the work context a hint printed is enough to find the delivery", async () => {
    // Arrange — the person saw `wc_ken_playback` in the hint, never an hd_ id.
    const home = await homeWithLive(null);

    // Act
    const result = await noise(home, [KEN_CONTEXT]);

    // Assert — the newest delivery of that ref (to GONE, two minutes ago).
    expect(result.stdout).toContain(
      `recorded: ${hintDeliveryId(GONE, KEN_CONTEXT)} is off-target`,
    );
  });

  test("a ref that never reached you says so", async () => {
    // Arrange
    const home = await homeWithLive(null);

    // Act
    const result = await noise(home, ["wc_nobody_sent_this"]);

    // Assert
    expect(result.stdout).toContain("no pointer at wc_nobody_sent_this reached you");
  });

  test("an id that is not an id is a usage error, and nothing is sent", async () => {
    // Arrange — flag-shaped input never reaches the command (the help gate
    // refuses it), so this is the other shape: a word with a space in it.
    const home = await homeWithLive(null);

    // Act
    const result = await noise(home, ["wc_with space"]);

    // Assert
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stdout).toContain("usage: crosscheck noise");
  });

  test("with no id, an intervention older than the hour is not the one meant", async () => {
    // Arrange — QUIET's only delivery arrived ninety minutes ago.
    await deliver(QUIET, KEN_CONTEXT, 90);
    const home = await homeWithLive(QUIET);

    // Act
    const result = await noise(home);

    // Assert
    expect(result.stdout).toContain("nothing reached a live session here in the last 60 minutes");
    expect(result.stdout).not.toContain("recorded:");
  });

  test("an agent cannot make the gesture", async () => {
    // Arrange — no controlling terminal: the call came through a tool.
    const id = await deliver(LIVE, "wc_agent_attempt", 1);
    const home = await homeWithLive(LIVE);

    // Act
    const result = await noise(home, [id], { interactive: false });

    // Assert
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stdout).toContain("needs a person at a terminal");
    // And nothing was recorded: a person making the same mark is not a repeat.
    const human = await noise(home, [id]);
    expect(human.stdout).toContain("recorded:");
  });

  test("a repo that never enrolled is told, not ignored", async () => {
    // Arrange
    const home = await homeWithLive(LIVE, otherRepo, OTHER_REPO_ID);

    // Act
    const result = await noise(home, [], { cwd: otherRepo });

    // Assert
    expect(result.stdout).toContain("not in the pilot");
  });
});

describe("crosscheck pin --ok", () => {
  /** A pin Ken created; anybody who runs its recipe may say it passed. */
  const kenPins = async (id: string): Promise<void> => {
    const response = await send("POST", "/api/pins", ken.apiKey, {
      id,
      repo: REPO_ID,
      surface: "Play button plays/pauses",
      files: ["src/workbench/usePlayback.ts"],
      check: "open /workbench, press Play",
      presence: "controlling_terminal",
      verifiedAtCommit: "a1b2c3d4",
    });
    expect(response.status).toBe(200);
  };

  const pinOk = (
    home: string,
    id: string,
    interactive = true,
  ): Promise<{ stdout: string; exitCode: number }> =>
    runCli(
      ["pin", "--ok", id],
      {
        CROSSCHECK_HOME: home,
        HOME: home,
        CROSSCHECK_HUB_URL: hubUrl,
        CROSSCHECK_API_KEY: nick.apiKey,
        CROSSCHECK_TIMEOUT_MS: "4000",
      },
      repo,
      undefined,
      { isInteractive: () => interactive },
    );

  test("whoever ran the recipe and watched it pass says so in one word", async () => {
    // Arrange
    await kenPins("pin_ok_live");
    const home = await homeWithLive(null);

    // Act
    const result = await pinOk(home, "pin_ok_live");

    // Assert
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("recorded: you ran pin_ok_live's check and watched it pass");
  });

  test("an agent cannot say a check passed", async () => {
    // Arrange
    await kenPins("pin_ok_agent");
    const home = await homeWithLive(null);

    // Act
    const result = await pinOk(home, "pin_ok_agent", false);

    // Assert
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stdout).toContain("needs a person at a terminal");
  });

  test("a pin recorded broken is not marked ok — the fix is a re-pin", async () => {
    // Arrange
    await kenPins("pin_ok_broken");
    await send("POST", "/api/pins/pin_ok_broken/broke", ken.apiKey, {
      repo: REPO_ID,
      presence: "controlling_terminal",
    });
    const home = await homeWithLive(null);

    // Act
    const result = await pinOk(home, "pin_ok_broken");

    // Assert
    expect(result.stdout).toContain("pin that surface again");
  });
});
