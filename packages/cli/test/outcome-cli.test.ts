/**
 * The person's half of 07 §13, end to end against a REAL hub and a REAL
 * repository: `crosscheck followed` / `crosscheck overrode` record what a hint
 * led to, and `crosscheck pilot --mine` shows the caller their own outcomes.
 *
 * What these pin:
 *   · the id the hint printed is enough, and with no id the one recent
 *     delivery to a live session is answered — several are LISTED, never
 *     guessed, exactly as `crosscheck noise` does;
 *   · an override carries its reason, a secret-shaped reason never leaves the
 *     machine, and no terminal is needed: an outcome is the record an agent
 *     may write too (only a LABEL is a person's, behind the TTY gate);
 *   · `--mine` is the caller's own view — by source teammate, reasons quoted —
 *     and a teammate's view of the same history is one count about their own
 *     work, never the recipient's name or reason;
 *   · an older hub says it does not record outcomes, and `--by-developer` is
 *     still refused by name.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import { hintDeliveryId } from "@crosscheck/connector-core/capture/records.ts";
import { QUOTED_DATA_NOTICE } from "@crosscheck/connector-core/briefing/render.ts";
import { EXIT_OK, EXIT_USAGE } from "@crosscheck/connector-core/constants.ts";
import { writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import type { RecordedOutcome } from "@crosscheck/connector-core/http/hint-outcomes.ts";
import { appendRecords } from "@crosscheck/connector-core/spool/append.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";

import { runCli } from "../src/index.ts";
import {
  DELIVERY_STILL_ON_THIS_MACHINE_LINE,
  OUTCOMES_NOT_SERVED_LINE,
  REASON_REQUIRED_LINE,
  REASON_SECRET_LINE,
  outcomeRecordedLine,
} from "../src/cli/outcome-render.ts";
import { MINE_NOT_SERVED_LINE } from "../src/cli/pilot-mine-render.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const ADMIN_TOKEN = "outcome-cli-admin";
const REPO_ID = "github.com/acme/api";
const LIVE = "cc_55555555-2222-4333-8444-555555555555";
const SOLO = "cc_66666666-2222-4333-8444-555555555555";
const KEN_SESSION = "cc_77777777-2222-4333-8444-555555555555";
const KEN_CONTEXT = "wc_ken_filters";
const KEN_OTHER_CONTEXT = "wc_ken_playback";
const KEN_THIRD_CONTEXT = "wc_ken_export";
const OVERRIDE_REASON = "kept the narrow row: the wide one breaks the mobile layout";
/** A synthetic AWS example key, the fixture every secret-scan test uses. */
const CREDENTIAL = "AKIAIOSFODNN7EXAMPLE";

let server: ReturnType<typeof Bun.serve>;
let oldHub: ReturnType<typeof Bun.serve>;
/** A hub that cannot take records yet and knows no delivery — a spooled hint's view of the world. */
let stuckHub: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let repo: string;
let nick: { apiKey: string; id: string };
let ken: { apiKey: string; id: string };
const homes: string[] = [];

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

const deliver = async (sessionId: string, refId: string): Promise<string> => {
  const id = hintDeliveryId(sessionId, refId);
  await send("POST", "/api/records", nick.apiKey, {
    records: [
      envelope(nick.id, sessionId, "hint_delivery", {
        id,
        sessionId,
        refKind: "work_context",
        refId,
        channel: "prompt_hint",
        deliveredAt: new Date().toISOString(),
      }),
    ],
  });
  return id;
};

const homeWithLive = async (sessionId: string, hub: string = hubUrl): Promise<string> => {
  const home = await makeHome("outcome-cli");
  homes.push(home);
  await writeSessionState(home, {
    hostSessionKey: sessionId.replace("cc_", ""),
    crosscheckSessionId: sessionId,
    workContextId: `wc_${sessionId}`,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl: hub,
    startedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
  });
  return home;
};

/** A delivery the prompt hook booked into the spool — not yet sent, no tool has run since. */
const spoolDelivery = async (home: string, hub: string, sessionId: string, refId: string): Promise<void> => {
  const delivery = envelope(nick.id, sessionId, "hint_delivery", {
    id: hintDeliveryId(sessionId, refId),
    sessionId,
    refKind: "work_context",
    refId,
    channel: "prompt_hint",
    deliveredAt: new Date().toISOString(),
  });
  await appendRecords(home, repoKey(hub, REPO_ID), sessionId.replace("cc_", ""), [delivery], new Date());
};

const cli = (
  home: string,
  argv: readonly string[],
  options: { readonly as?: { apiKey: string }; readonly hub?: string } = {},
): Promise<{ stdout: string; exitCode: number }> =>
  runCli(
    argv,
    {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: options.hub ?? hubUrl,
      CROSSCHECK_API_KEY: (options.as ?? nick).apiKey,
      CROSSCHECK_TIMEOUT_MS: "4000",
    },
    repo,
    undefined,
    // NO TERMINAL, on purpose: an outcome is what an agent may record too.
    { isInteractive: () => false },
  );

beforeAll(async () => {
  const db = await createDb();
  server = Bun.serve({ port: 0, fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  oldHub = Bun.serve({
    port: 0,
    fetch: () => Response.json({ ok: false, error: { code: "not_found", message: "route not found" } }, { status: 404 }),
  });
  stuckHub = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/records") {
        return Response.json({ ok: false, error: { code: "unavailable", message: "try later" } }, { status: 503 });
      }
      if (path === "/api/hint-outcomes") {
        return Response.json(
          { ok: false, error: { code: "unknown_ref", message: "no hint with that id reached you on this repo" } },
          { status: 422 },
        );
      }
      return Response.json({ ok: true, data: { candidates: [], more: false } });
    },
  });
  repo = await makeRepo("outcome-cli", { remote: "git@github.com:acme/api.git" });
  nick = await createDeveloper("Nick", "nick-outcome-cli@example.com");
  ken = await createDeveloper("Ken", "ken-outcome-cli@example.com");
  for (const [key, id] of [
    [nick.apiKey, LIVE],
    [nick.apiKey, SOLO],
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
    records: [KEN_CONTEXT, KEN_OTHER_CONTEXT, KEN_THIRD_CONTEXT].map((id) =>
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
  await deliver(LIVE, KEN_CONTEXT);
  await deliver(LIVE, KEN_OTHER_CONTEXT);
  await deliver(SOLO, KEN_THIRD_CONTEXT);
});

afterAll(async () => {
  server.stop(true);
  oldHub.stop(true);
  stuckHub.stop(true);
  await Promise.all([repo, ...homes].map((path) => rm(path, { recursive: true, force: true })));
});

describe("crosscheck followed / overrode", () => {
  test("the id the hint printed records an outcome, with no terminal needed", async () => {
    // Arrange
    const home = await homeWithLive(LIVE);

    // Act
    const result = await cli(home, ["followed", KEN_CONTEXT]);

    // Assert
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toStartWith(`recorded: ${KEN_CONTEXT} — followed`);
  });

  test("an override without its reason is a usage error, and records nothing", async () => {
    // Arrange
    const home = await homeWithLive(LIVE);

    // Act
    const result = await cli(home, ["overrode", KEN_CONTEXT]);

    // Assert
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stdout).toStartWith(REASON_REQUIRED_LINE);
  });

  test("an override with its reason supersedes the earlier word and says so", async () => {
    // Arrange
    const home = await homeWithLive(LIVE);

    // Act
    const result = await cli(home, ["overrode", KEN_CONTEXT, "--reason", OVERRIDE_REASON]);

    // Assert
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("overrode");
    expect(result.stdout).toContain("superseding the earlier followed");
  });

  test("a secret-shaped reason never leaves the machine", async () => {
    // Arrange
    const home = await homeWithLive(LIVE);

    // Act
    const result = await cli(home, ["followed", KEN_OTHER_CONTEXT, "--reason", `used ${CREDENTIAL}`]);

    // Assert
    expect(result.stdout).toBe(REASON_SECRET_LINE);
    expect(result.stdout).not.toContain(CREDENTIAL);
  });

  test("with no id, several recent deliveries are listed and nothing is guessed", async () => {
    // Arrange — the live session got two pointers
    const home = await homeWithLive(LIVE);

    // Act
    const result = await cli(home, ["followed"]);

    // Assert
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("name the one you mean");
    expect(result.stdout).toContain("crosscheck followed hd_");
  });

  test("with no id, the one recent delivery to a live session is answered", async () => {
    // Arrange — this session got exactly one
    const home = await homeWithLive(SOLO);

    // Act
    const result = await cli(home, ["followed"]);

    // Assert
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toStartWith(`recorded: ${hintDeliveryId(SOLO, KEN_THIRD_CONTEXT)} — followed`);
  });

  test("review #14: an id still on this machine is sent before the outcome, which is then recorded", async () => {
    // Arrange — Ken's context is known; Nick's delivery of it is still in the spool
    const ref = "wc_ken_spooled";
    await send("POST", "/api/records", ken.apiKey, {
      records: [
        envelope(ken.id, KEN_SESSION, "work_context", {
          id: ref,
          sessionId: KEN_SESSION,
          title: "Ken's spooled context",
          status: "implementing",
          createdAt: new Date().toISOString(),
        }),
      ],
    });
    const home = await homeWithLive(LIVE);
    await spoolDelivery(home, hubUrl, LIVE, ref);

    // Act
    const result = await cli(home, ["followed", ref]);

    // Assert — "no hint with that id reached you" would be false: it reached Nick
    expect(result.stdout).toStartWith(`recorded: ${ref} — followed`);
  });

  test("review #14: a hint the hub has not received yet is never answered 'never reached you'", async () => {
    // Arrange — the hub cannot take the spooled delivery yet
    const stuck = `http://127.0.0.1:${String(stuckHub.port)}`;
    const home = await homeWithLive(LIVE, stuck);
    await spoolDelivery(home, stuck, LIVE, "wc_ken_held");

    // Act
    const byId = await cli(home, ["followed", "wc_ken_held"], { hub: stuck });
    const recent = await cli(home, ["followed"], { hub: stuck });

    // Assert
    expect(byId.stdout).toBe(DELIVERY_STILL_ON_THIS_MACHINE_LINE);
    expect(recent.stdout).toBe(DELIVERY_STILL_ON_THIS_MACHINE_LINE);
  });

  test("a hub that predates outcomes says so", async () => {
    // Arrange
    const home = await homeWithLive(LIVE);

    // Act
    const result = await cli(home, ["followed", KEN_CONTEXT], {
      hub: `http://127.0.0.1:${String(oldHub.port)}`,
    });

    // Assert
    expect(result.stdout).toBe(OUTCOMES_NOT_SERVED_LINE);
  });
});

describe("crosscheck pilot --mine", () => {
  test("shows the caller's own outcomes by source teammate, the reason quoted as data", async () => {
    // Arrange — after the cases above: Ken's context overrode, the third and the spooled one followed
    const home = await homeWithLive(LIVE);

    // Act
    const result = await cli(home, ["pilot", "--mine"]);

    // Assert
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain(QUOTED_DATA_NOTICE);
    expect(result.stdout).toContain("hints that reached you unasked: 4 — followed 2 · overrode 1 · not relevant now 0 · noise 0 · unmarked 1");
    expect(result.stdout).toContain("from Ken: 4 — followed 2 · overrode 1");
    expect(result.stdout).toContain(`overrode, from Ken: «${OVERRIDE_REASON}»`);
  });

  test("the teammate whose work it was sees no count from one recipient, and nobody's name or reason", async () => {
    // Arrange — only Nick received Ken's work, and no whole month has passed
    const home = await homeWithLive(KEN_SESSION);

    // Act
    const result = await cli(home, ["pilot", "--mine"], { as: ken });

    // Assert — review #10: a count from one recipient would be that recipient's words
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toMatch(/your own work, in teammates' hints, \w+ \d{4}: nothing to count — outcomes became recordable here after it ended/);
    expect(result.stdout).not.toContain("followed 1 time");
    expect(result.stdout).not.toContain("Nick");
    expect(result.stdout).not.toContain(OVERRIDE_REASON);
  });

  test("a per-developer breakdown is still refused by name", async () => {
    // Arrange
    const home = await homeWithLive(LIVE);

    // Act
    const result = await cli(home, ["pilot", "--mine", "--by-developer"]);

    // Assert
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stdout).toContain("never per person");
  });

  test("a hub that predates outcomes says so", async () => {
    // Arrange
    const home = await homeWithLive(LIVE);

    // Act
    const result = await cli(home, ["pilot", "--mine"], { hub: `http://127.0.0.1:${String(oldHub.port)}` });

    // Assert
    expect(result.stdout).toBe(MINE_NOT_SERVED_LINE);
  });
});

describe("outcomeRecordedLine (review #11): the answer says what stands", () => {
  const recorded = (fields: Partial<RecordedOutcome>): RecordedOutcome => ({
    id: "ho_1",
    deliveryId: "hd_1",
    outcome: "followed",
    repeated: false,
    replaced: null,
    stands: "followed",
    ...fields,
  });

  test("a repeat names the word that stands", () => {
    // Act
    const line = outcomeRecordedLine(KEN_CONTEXT, recorded({ repeated: true }));

    // Assert
    expect(line).toBe(`already recorded: ${KEN_CONTEXT} stands at followed — nothing was written a second time\n`);
  });

  test("a word after the noise label names the label it superseded", () => {
    // Act
    const line = outcomeRecordedLine(KEN_CONTEXT, recorded({ replaced: "noise" }));

    // Assert
    expect(line).toStartWith(`recorded: ${KEN_CONTEXT} — followed, superseding your earlier noise label (kept in the history). `);
  });

  test("a word that ties with the noise label says the label still stands", () => {
    // Act
    const line = outcomeRecordedLine(KEN_CONTEXT, recorded({ replaced: "noise", stands: "noise" }));

    // Assert
    expect(line).toStartWith(
      `recorded: ${KEN_CONTEXT} — followed, but your noise label from the same instant still stands (a label wins a tie). `,
    );
  });
});
