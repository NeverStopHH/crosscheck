/**
 * EVERY KEY GESTURE IS A DRAFT, AND SAYS SO (human provenance §5–§8), against
 * a REAL hub that leaves drafts pending — production behaviour:
 *
 *   - `crosscheck followed` at a terminal and without one, `crosscheck
 *     helpful`, `crosscheck pin`, `crosscheck mute`, `crosscheck presence on`
 *     each answer "drafted", never "recorded", and say how the draft becomes
 *     the person's: their passkey, on the page `crosscheck confirm` opens;
 *   - nothing took effect: `pilot --mine` counts none of it as the person's,
 *     the pin list is empty, nobody is muted, presence stays hidden;
 *   - `crosscheck confirm` counts what waits.
 *
 * The suites that pin how the CLI renders a word that took effect run against
 * a hub that applies it at once — every hub before 0.11 — and are unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import { hintDeliveryId } from "@crosscheck/connector-core/capture/records.ts";
import { EXIT_OK } from "@crosscheck/connector-core/constants.ts";
import { writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";

import { runCli } from "../src/index.ts";
import { AGENT_DRAFT_LINE, AGENT_WORD_LINE } from "../src/cli/outcome-render.ts";
import { git, makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";

const ADMIN_TOKEN = "drafted-gestures-admin";
const REPO_ID = "github.com/acme/api";
const LIVE = "cc_12121212-2222-4333-8444-555555555555";
const KEN_SESSION = "cc_34343434-2222-4333-8444-555555555555";
const KEN_CONTEXTS = ["wc_ken_filters", "wc_ken_playback", "wc_ken_export"] as const;
const PINNED = "src/workbench/usePlayback.ts";

let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let repo: string;
let home: string;
let nick: { apiKey: string; id: string };
let ken: { apiKey: string; id: string };

const send = async (method: string, path: string, apiKey: string, body: unknown): Promise<Response> =>
  fetch(`${hubUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const createDeveloper = async (name: string, email: string): Promise<{ apiKey: string; id: string }> => {
  const response = await send("POST", "/api/developers", ADMIN_TOKEN, { name, email });
  const body = (await response.json()) as { data: { apiKey: string; developer: { id: string } } };
  return { apiKey: body.data.apiKey, id: body.data.developer.id };
};

const envelope = (developerId: string, sessionId: string, kind: string, body: unknown): unknown => ({
  cx: "0.1",
  id: `env_${crypto.randomUUID()}`,
  ts: new Date().toISOString(),
  producer: { developerId, agentKind: "claude-code", sessionId },
  kind,
  body,
});

const cli = (argv: readonly string[], interactive = true): Promise<{ stdout: string; exitCode: number }> =>
  runCli(
    argv,
    {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: nick.apiKey,
      CROSSCHECK_TIMEOUT_MS: "4000",
    },
    repo,
    undefined,
    { isInteractive: () => interactive, openUrl: () => Promise.resolve(false) },
  );

beforeAll(async () => {
  const db = await createDb();
  // Production behaviour: every key gesture is left a draft.
  server = Bun.serve({ port: 0, fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  repo = await makeRepo("drafted-gestures", { remote: "git@github.com:acme/api.git" });
  await writeRepoFile(repo, PINNED, "export const play = 1;\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "workbench"]);
  home = await makeHome("drafted-gestures");
  nick = await createDeveloper("Nick", "nick-drafted@example.com");
  ken = await createDeveloper("Ken", "ken-drafted@example.com");
  for (const [key, id] of [
    [nick.apiKey, LIVE],
    [ken.apiKey, KEN_SESSION],
  ] as const) {
    await send("POST", "/api/sessions", key, {
      id,
      agentKind: "claude-code",
      repo: REPO_ID,
      branch: "main",
      baseCommit: "a1b2c3d4",
      status: "implementing",
    });
  }
  await send("POST", "/api/records", ken.apiKey, {
    records: KEN_CONTEXTS.map((id) =>
      envelope(ken.id, KEN_SESSION, "work_context", {
        id,
        sessionId: KEN_SESSION,
        title: "Ken's context",
        status: "implementing",
        createdAt: new Date().toISOString(),
      }),
    ),
  });
  await send("PUT", "/api/team-settings", ADMIN_TOKEN, { repo: REPO_ID, pilotEnrolled: true });
  await send("POST", "/api/records", nick.apiKey, {
    records: KEN_CONTEXTS.map((refId) =>
      envelope(nick.id, LIVE, "hint_delivery", {
        id: hintDeliveryId(LIVE, refId),
        sessionId: LIVE,
        refKind: "work_context",
        refId,
        channel: "prompt_hint",
        deliveredAt: new Date().toISOString(),
      }),
    ),
  });
  await writeSessionState(home, {
    hostSessionKey: LIVE.replace("cc_", ""),
    crosscheckSessionId: LIVE,
    workContextId: `wc_${LIVE}`,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl,
    startedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
  });
});

afterAll(async () => {
  server.stop(true);
  await Promise.all([repo, home].map((path) => rm(path, { recursive: true, force: true })));
});

describe("a key gesture against a hub since human provenance", () => {
  test("crosscheck followed at a terminal is drafted, says how it becomes yours, and counts for nothing yet", async () => {
    // Act
    const said = await cli(["followed", "wc_ken_filters"]);
    const mine = await cli(["pilot", "--mine"]);

    // Assert
    expect(said.exitCode).toBe(EXIT_OK);
    expect(said.stdout).toStartWith("drafted: wc_ken_filters — followed. it is not yours yet: it counts only once you confirm it with your passkey — crosscheck confirm opens the page");
    expect(said.stdout).not.toContain("recorded:");
    expect(mine.stdout).toContain("as you confirmed them with your passkey: followed 0 · overrode 0");
    expect(mine.stdout).toContain("0 rated by your agent · 1 typed at a terminal");
  });

  test("with no terminal the draft is the agent's, and the line no longer promises that a shell makes it yours", async () => {
    // Act
    const said = await cli(["followed", "wc_ken_playback"], false);
    const mine = await cli(["pilot", "--mine"]);

    // Assert
    expect(said.stdout).toContain("drafted: wc_ken_playback — followed");
    expect(said.stdout).toContain(AGENT_DRAFT_LINE);
    expect(said.stdout).not.toContain(AGENT_WORD_LINE);
    expect(said.stdout).not.toContain("for it to stand as yours");
    expect(mine.stdout).toContain("1 rated by your agent · 1 typed at a terminal");
  });

  test("crosscheck helpful is drafted: a label counts once confirmed, not before", async () => {
    // Act
    const said = await cli(["helpful", "wc_ken_export"]);

    // Assert
    expect(said.exitCode).toBe(EXIT_OK);
    expect(said.stdout).toContain(`drafted: ${hintDeliveryId(LIVE, "wc_ken_export")} is helpful — it is not yours yet`);
    expect(said.stdout).not.toContain("recorded:");
  });

  test("crosscheck pin is drafted and protects nothing: the register stays empty", async () => {
    // Act
    const said = await cli(["pin", "Play button plays/pauses", "--files", PINNED, "--check", "open /workbench, press Play"]);
    const listed = await cli(["pin", "list"]);

    // Assert
    expect(said.exitCode).toBe(EXIT_OK);
    expect(said.stdout).toMatch(/^drafted pin pin_[\w-]+: 1 file\(s\) at /);
    expect(said.stdout).toContain("it protects nothing yet — no fence, no suspect — until you confirm it with your passkey");
    expect(said.stdout).not.toContain("everyone on this repo can see it");
    expect(listed.stdout).toContain("pins: 0");
  });

  test("crosscheck mute is drafted: nobody is muted until the person confirms it", async () => {
    // Act
    const said = await cli(["mute", "Ken"]);
    const listed = await cli(["mute", "list"]);

    // Assert
    expect(said.stdout).toBe("drafted: mute Ken — nothing changed yet: it takes effect only once you confirm it with your passkey — crosscheck confirm opens the page\n");
    expect(listed.stdout).toBe("muted developers: (none)\n");
  });

  test("presence off takes effect at once; presence on is drafted and she stays hidden", async () => {
    // Act
    const off = await cli(["presence", "off"]);
    const on = await cli(["presence", "on"]);
    const shown = await cli(["presence"]);

    // Assert
    expect(off.stdout).toStartWith("presence: hidden from teammates");
    expect(on.stdout).toStartWith("presence: hidden from teammates");
    expect(on.stdout).toContain("presence on is drafted — nothing changed yet");
    expect(shown.stdout).toStartWith("presence: hidden from teammates");
  });

  test("crosscheck confirm counts every draft that waits", async () => {
    // Act
    const result = await cli(["confirm"]);

    // Assert — two outcomes, a label, a pin, a mute and presence on
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("6 drafts wait for your passkey");
  });
});
