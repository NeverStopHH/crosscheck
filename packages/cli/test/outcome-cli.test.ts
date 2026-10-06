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
 *     machine; at a terminal the word is the PERSON's, and without one (an
 *     agent's Bash tool) it is recorded as the agent's and says so (07 §13.13
 *     HIGH-1) — the TTY gate `crosscheck noise` keeps, with its stated limit;
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
import { deliveryIdFor } from "@crosscheck/schema";
import { QUOTED_DATA_NOTICE } from "@crosscheck/connector-core/briefing/render.ts";
import { EXIT_OK, EXIT_USAGE } from "@crosscheck/connector-core/constants.ts";
import { writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import type { RecordedOutcome } from "@crosscheck/connector-core/http/hint-outcomes.ts";
import { appendRecords } from "@crosscheck/connector-core/spool/append.ts";
import { holdsUnsentDelivery } from "@crosscheck/connector-core/spool/held-deliveries.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";

import { runCli } from "../src/index.ts";
import {
  AGENT_WORD_LINE,
  DELIVERY_HELD_AMBIGUOUS_LINE,
  DELIVERY_HELD_NO_LIVE_SESSION_LINE,
  DELIVERY_STILL_ON_THIS_MACHINE_LINE,
  OUTCOMES_NOT_SERVED_LINE,
  PERSON_DOOR_NOT_SERVED_LINE,
  REASON_REQUIRED_LINE,
  REASON_SECRET_LINE,
  agentHostLine,
  outcomeRecordedLine,
} from "../src/cli/outcome-render.ts";
import { FOLLOWED_USAGE, OVERRODE_USAGE } from "../src/cli/outcome.ts";
import { defaultInteractiveProbe } from "../src/cli/pin.ts";
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
/** A round-4 hub: it records outcomes, but has no person's door yet (07 §13.13 LOW-7). */
let personlessHub: ReturnType<typeof Bun.serve>;
/** The real hub, but it cannot take records right now — a held delivery cannot be sent (LOW-3). */
let recordlessHub: ReturnType<typeof Bun.serve>;
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
  options: {
    readonly as?: { apiKey: string };
    readonly hub?: string;
    readonly interactive?: boolean;
    readonly env?: Readonly<Record<string, string>>;
  } = {},
): Promise<{ stdout: string; exitCode: number }> =>
  runCli(
    argv,
    {
      ...options.env,
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: options.hub ?? hubUrl,
      CROSSCHECK_API_KEY: (options.as ?? nick).apiKey,
      CROSSCHECK_TIMEOUT_MS: "4000",
    },
    repo,
    undefined,
    // A PERSON AT A TERMINAL unless a test says otherwise (07 §13.13 HIGH-1): without one,
    // the word is recorded as the agent's.
    { isInteractive: () => options.interactive ?? true },
  );

beforeAll(async () => {
  const db = await createDb();
  server = Bun.serve({ port: 0, fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  oldHub = Bun.serve({
    port: 0,
    fetch: () => Response.json({ ok: false, error: { code: "not_found", message: "route not found" } }, { status: 404 }),
  });
  personlessHub = Bun.serve({
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/api/hint-outcomes/mine"
        ? Response.json({ ok: false, error: { code: "not_enrolled", message: "not in the pilot" } }, { status: 422 })
        : Response.json({ ok: false, error: { code: "not_found", message: "route not found" } }, { status: 404 }),
  });
  recordlessHub = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/records") {
        return Response.json({ ok: false, error: { code: "unavailable", message: "try later" } }, { status: 503 });
      }
      const body = request.method === "GET" ? undefined : await request.text();
      return await fetch(`${hubUrl}${url.pathname}${url.search}`, { method: request.method, headers: request.headers, body });
    },
  });
  stuckHub = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/records") {
        return Response.json({ ok: false, error: { code: "unavailable", message: "try later" } }, { status: 503 });
      }
      // both doors (07 §13.12): the person's `/person` and the agent's own
      if (path === "/api/hint-outcomes" || path === "/api/hint-outcomes/person") {
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
  personlessHub.stop(true);
  recordlessHub.stop(true);
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

  test("round 3 (M18): held records go out in the name of the live session on this checkout, not another", async () => {
    // Arrange — LIVE is on this checkout and holds the delivery; SOLO, live too, runs elsewhere
    const ref = "wc_ken_m18";
    await send("POST", "/api/records", ken.apiKey, {
      records: [
        envelope(ken.id, KEN_SESSION, "work_context", {
          id: ref,
          sessionId: KEN_SESSION,
          title: "Ken's other context",
          status: "implementing",
          createdAt: new Date().toISOString(),
        }),
      ],
    });
    const home = await homeWithLive(LIVE);
    await writeSessionState(home, {
      hostSessionKey: SOLO.replace("cc_", ""),
      crosscheckSessionId: SOLO,
      workContextId: `wc_${SOLO}`,
      repoId: REPO_ID,
      repoRoot: `${repo}-elsewhere`,
      hubUrl,
      startedAt: new Date(Date.now() + 1000).toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    });
    await spoolDelivery(home, hubUrl, LIVE, ref);

    // Act
    const result = await cli(home, ["followed", ref]);

    // Assert — LIVE's own spool was sent, so the hub knew the hint
    expect(result.stdout).toStartWith(`recorded: ${ref} — followed`);
  });

  test("round 3: with several live sessions in this checkout, a held hint is not sent in a guessed one's name", async () => {
    // Arrange
    const stuck = `http://127.0.0.1:${String(stuckHub.port)}`;
    const home = await homeWithLive(LIVE, stuck);
    await writeSessionState(home, {
      hostSessionKey: SOLO.replace("cc_", ""),
      crosscheckSessionId: SOLO,
      workContextId: `wc_${SOLO}`,
      repoId: REPO_ID,
      repoRoot: repo,
      hubUrl: stuck,
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    });
    await spoolDelivery(home, stuck, LIVE, "wc_ken_twin");

    // Act
    const result = await cli(home, ["followed", "wc_ken_twin"], { hub: stuck });

    // Assert
    expect(result.stdout).toBe(DELIVERY_HELD_AMBIGUOUS_LINE);
  });

  test("round 3: POST first — a ref the hub knows is recorded without sending what is held", async () => {
    // Arrange — an unrelated delivery is in LIVE's spool
    const home = await homeWithLive(LIVE);
    await spoolDelivery(home, hubUrl, LIVE, "wc_ken_unrelated");

    // Act — Ken's context is a delivery the hub already has; the same word again changes nothing
    const result = await cli(home, ["overrode", KEN_CONTEXT, "--reason", OVERRIDE_REASON]);

    // Assert
    expect(result.exitCode).toBe(EXIT_OK);
    const hub = { hubUrl, apiKey: nick.apiKey, timeoutMs: 4000, home, repoKey: repoKey(hubUrl, REPO_ID), now: () => new Date() };
    expect(await holdsUnsentDelivery(hub, "wc_ken_unrelated")).toBe(true);
  });

  test("review LOW: with no live session here, a held hint is never promised to 'the session's next tool call'", async () => {
    // Arrange — the delivery is in the spool, but no session on this machine is live to send it
    const stuck = `http://127.0.0.1:${String(stuckHub.port)}`;
    const home = await makeHome("outcome-cli");
    homes.push(home);
    await spoolDelivery(home, stuck, LIVE, "wc_ken_orphan");

    // Act
    const result = await cli(home, ["followed", "wc_ken_orphan"], { hub: stuck });

    // Assert — what is true: nothing live here sends it; the next session to start does
    expect(result.stdout).toBe(DELIVERY_HELD_NO_LIVE_SESSION_LINE);
    expect(result.stdout).not.toContain("next tool call");
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

  test("07 §13.13 LOW-7: a hub that records outcomes but predates the person's door says so, and records nothing", async () => {
    // Arrange — fail closed: never fall back to the agent's door with the person's word
    const personless = `http://127.0.0.1:${String(personlessHub.port)}`;
    const home = await homeWithLive(LIVE, personless);

    // Act
    const result = await cli(home, ["followed", KEN_CONTEXT], { hub: personless });

    // Assert
    expect(result.stdout).toBe(PERSON_DOOR_NOT_SERVED_LINE);
    expect(result.exitCode).not.toBe(EXIT_OK);
  });
});

describe("crosscheck pilot --mine", () => {
  test("shows the caller's own outcomes by source teammate, the reason quoted as data", async () => {
    // Arrange — after the cases above: Ken's context overrode; the third, the spooled one and M18's followed
    const home = await homeWithLive(LIVE);

    // Act
    const result = await cli(home, ["pilot", "--mine"]);

    // Assert
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain(QUOTED_DATA_NOTICE);
    expect(result.stdout).toContain("hints that reached you unasked: 5 — followed 3 · overrode 1 · not relevant now 0 · noise 0 · unmarked 1");
    expect(result.stdout).toContain("from Ken: 5 — followed 3 · overrode 1");
    expect(result.stdout).toContain(`overrode, from Ken: «${OVERRIDE_REASON}»`);
  });

  test("the teammate whose work it was sees no count from one recipient, and nobody's name or reason", async () => {
    // Arrange — only Nick received Ken's work, and no whole month has passed
    const home = await homeWithLive(KEN_SESSION);

    // Act
    const result = await cli(home, ["pilot", "--mine"], { as: ken });

    // Assert — review #10: a count from one recipient would be that recipient's words
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toMatch(/your own work, in teammates' hints, \w+ \d{4}: nothing to count — the pilot was not enrolled here during it/);
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

describe("07 §13.12: a word said at a terminal is the person's", () => {
  test("the person's crosscheck followed stands over their agent's later word, which is still recorded", async () => {
    // Arrange — a fresh pointer to the live session, and the person's word on it at a terminal
    const ref = "wc_ken_persons_word";
    await send("POST", "/api/records", ken.apiKey, {
      records: [
        envelope(ken.id, KEN_SESSION, "work_context", {
          id: ref,
          sessionId: KEN_SESSION,
          title: "Ken's context",
          status: "implementing",
          createdAt: new Date().toISOString(),
        }),
      ],
    });
    await deliver(LIVE, ref);
    const home = await homeWithLive(LIVE);
    await cli(home, ["followed", ref]);

    // Act — the agent's word on the same hint, through the agent's own route
    const agent = await send("POST", "/api/hint-outcomes", nick.apiKey, {
      repo: REPO_ID,
      ref,
      outcome: "overrode",
      reason: "the agent went its own way",
    });

    // Assert
    expect(agent.status).toBe(201);
    expect(((await agent.json()) as { data: RecordedOutcome }).data).toMatchObject({
      outcome: "overrode",
      replaced: "followed",
      stands: "followed",
    });
  });
});

describe("round-5 MEDIUM-2 (Q4): the person's own repeat", () => {
  test("crosscheck followed X said twice at a terminal is 'already recorded', and writes nothing the second time", async () => {
    // Arrange — a fresh pointer, followed once
    const ref = "wc_ken_said_twice";
    await send("POST", "/api/records", ken.apiKey, {
      records: [
        envelope(ken.id, KEN_SESSION, "work_context", {
          id: ref,
          sessionId: KEN_SESSION,
          title: "Ken's context",
          status: "implementing",
          createdAt: new Date().toISOString(),
        }),
      ],
    });
    await deliver(LIVE, ref);
    const home = await homeWithLive(LIVE);
    await cli(home, ["followed", ref]);

    // Act
    const again = await cli(home, ["followed", ref]);

    // Assert
    expect(again.stdout).toBe(`already recorded: ${ref} stands at followed — nothing was written a second time\n`);
  });
});

describe("07 §13.13 HIGH-1: with no terminal, the word is the agent's", () => {
  test("crosscheck followed from an agent's Bash tool lands on the agent's route, and says how to make it the person's", async () => {
    // Arrange — a fresh pointer
    const ref = "wc_ken_no_tty";
    await send("POST", "/api/records", ken.apiKey, {
      records: [
        envelope(ken.id, KEN_SESSION, "work_context", {
          id: ref,
          sessionId: KEN_SESSION,
          title: "Ken's context",
          status: "implementing",
          createdAt: new Date().toISOString(),
        }),
      ],
    });
    await deliver(LIVE, ref);
    const home = await homeWithLive(LIVE);

    // Act — no terminal; then the agent's own route says something else
    const result = await cli(home, ["followed", ref], { interactive: false });
    const agent = await send("POST", "/api/hint-outcomes", nick.apiKey, {
      repo: REPO_ID,
      ref,
      outcome: "overrode",
      reason: "the agent went its own way",
    });

    // Assert — the agent's second word overturned the first: both were the agent's
    expect(result.stdout).toStartWith(`recorded: ${ref} — followed`);
    expect(result.stdout).toContain(AGENT_WORD_LINE);
    expect(((await agent.json()) as { data: RecordedOutcome }).data).toMatchObject({
      replaced: "followed",
      stands: "overrode",
    });
  });
});

describe("07 §13.14 LOW-3: the gate holds for overrode, and reads stdin", () => {
  test("T2/T4: crosscheck overrode with no terminal lands on the agent's route, and says so", async () => {
    // Arrange
    const ref = "wc_ken_no_tty_overrode";
    await send("POST", "/api/records", ken.apiKey, {
      records: [
        envelope(ken.id, KEN_SESSION, "work_context", {
          id: ref,
          sessionId: KEN_SESSION,
          title: "Ken's context",
          status: "implementing",
          createdAt: new Date().toISOString(),
        }),
      ],
    });
    await deliver(LIVE, ref);
    const home = await homeWithLive(LIVE);

    // Act — no terminal and no host marker; then the agent's own route says something else
    const result = await cli(home, ["overrode", ref, "--reason", "kept my parser"], { interactive: false });
    const agent = await send("POST", "/api/hint-outcomes", nick.apiKey, { repo: REPO_ID, ref, outcome: "followed" });

    // Assert — the agent's later word overturned it: both were the agent's
    expect(result.stdout).toStartWith(`recorded: ${ref} — overrode`);
    expect(result.stdout).toContain(AGENT_WORD_LINE);
    expect(((await agent.json()) as { data: RecordedOutcome }).data).toMatchObject({
      replaced: "overrode",
      stands: "followed",
    });
  });

  test("T1: the probe asks whether stdin is a terminal — never stdout, which `| tee` takes away from a person", () => {
    // Arrange
    const withTtys = (stdin: boolean, stdout: boolean): boolean => {
      const saved = {
        stdin: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
        stdout: Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
      };
      Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: stdout, configurable: true });
      try {
        return defaultInteractiveProbe();
      } finally {
        for (const [stream, descriptor] of [
          [process.stdin, saved.stdin],
          [process.stdout, saved.stdout],
        ] as const) {
          if (descriptor === undefined) {
            delete (stream as { isTTY?: boolean }).isTTY;
          } else {
            Object.defineProperty(stream, "isTTY", descriptor);
          }
        }
      }
    };

    // Act
    const piped = withTtys(true, false);
    const agentsPty = withTtys(false, true);

    // Assert — `crosscheck followed | tee log` is still the person; a tool whose stdout alone is a pty is not
    expect(piped).toBe(true);
    expect(agentsPty).toBe(false);
  });
});

describe("07 §13.14 LOW-1: the agent's-word line says what 'not a terminal' was", () => {
  test("the line names the three ways input is not a terminal, and where to type it instead", () => {
    // Assert — Claude Code's ! prefix looks like a terminal to the person and is not one to this command
    expect(AGENT_WORD_LINE).toBe(
      "recorded as your agent's word — this command's input was not a terminal (an agent's tool, a pipe, or Claude Code's ! prefix); type it in your own shell for it to stand as yours\n",
    );
  });

  test("the line holds the untrusted-text invariants: no renderer here ever emits a backtick", () => {
    // Assert — the same line every outcome surface prints after an agent's word
    expect(AGENT_WORD_LINE.includes("`")).toBe(false);
    expect(agentHostLine("CLAUDECODE").includes("`")).toBe(false);
  });

  test("the usage says the same of both commands", () => {
    // Arrange
    const said = [
      "  Typed in your own shell it is your word, which your agent's never",
      "  overturns. Where its input is not a terminal (an agent's tool, a pipe,",
      "  or Claude Code's ! prefix), or inside an agent's tool that marks its",
      "  own commands, it is your agent's.",
    ].join("\n");

    // Assert
    expect(FOLLOWED_USAGE).toContain(said);
    expect(OVERRODE_USAGE).toContain(said);
  });
});

describe("07 §13.14 MEDIUM-2: inside an agent host's terminal, the word is the agent's even with a pty", () => {
  const freshPointer = async (ref: string): Promise<string> => {
    await send("POST", "/api/records", ken.apiKey, {
      records: [
        envelope(ken.id, KEN_SESSION, "work_context", {
          id: ref,
          sessionId: KEN_SESSION,
          title: "Ken's context",
          status: "implementing",
          createdAt: new Date().toISOString(),
        }),
      ],
    });
    await deliver(LIVE, ref);
    return homeWithLive(LIVE);
  };

  test.each([
    ["CLAUDECODE", "1"],
    ["CURSOR_AGENT", "1"],
  ] as const)("at a terminal under %s=%s, crosscheck followed lands on the agent's route and names the marker", async (name, value) => {
    // Arrange
    const ref = `wc_ken_host_${name.toLowerCase()}`;
    const home = await freshPointer(ref);

    // Act — a pty (the TTY probe says yes) inside the host; then the agent's own route speaks
    const result = await cli(home, ["followed", ref], { interactive: true, env: { [name]: value } });
    const agent = await send("POST", "/api/hint-outcomes", nick.apiKey, {
      repo: REPO_ID,
      ref,
      outcome: "overrode",
      reason: "the agent went its own way",
    });

    // Assert — the agent's later word overturned it: both were the agent's
    expect(result.stdout).toStartWith(`recorded: ${ref} — followed`);
    expect(result.stdout).toContain(agentHostLine(name));
    expect(result.stdout).toContain(`recorded as your agent's word — this command ran inside an agent's tool (${name} is set)`);
    expect(result.stdout).not.toContain(AGENT_WORD_LINE);
    expect(((await agent.json()) as { data: RecordedOutcome }).data).toMatchObject({
      replaced: "followed",
      stands: "overrode",
    });
  });

  test("a marker never promotes: with no terminal under a host, the word is still the agent's", async () => {
    // Arrange
    const ref = "wc_ken_host_no_tty";
    const home = await freshPointer(ref);

    // Act
    const result = await cli(home, ["overrode", ref, "--reason", "kept my parser"], {
      interactive: false,
      env: { CLAUDECODE: "1" },
    });
    const agent = await send("POST", "/api/hint-outcomes", nick.apiKey, { repo: REPO_ID, ref, outcome: "followed" });

    // Assert
    expect(result.stdout).toContain(agentHostLine("CLAUDECODE"));
    expect(((await agent.json()) as { data: RecordedOutcome }).data).toMatchObject({
      replaced: "overrode",
      stands: "followed",
    });
  });

  test("at a terminal with no marker, the word is still the person's", async () => {
    // Arrange
    const ref = "wc_ken_host_none";
    const home = await freshPointer(ref);

    // Act — a host's variable that is set in the person's own terminal too is no marker
    const result = await cli(home, ["followed", ref], { interactive: true, env: { TERM_PROGRAM: "vscode" } });
    const agent = await send("POST", "/api/hint-outcomes", nick.apiKey, {
      repo: REPO_ID,
      ref,
      outcome: "overrode",
      reason: "the agent went its own way",
    });

    // Assert — the person's word stands over the agent's
    expect(result.stdout).not.toContain("recorded as your agent's word");
    expect(((await agent.json()) as { data: RecordedOutcome }).data).toMatchObject({ stands: "followed" });
  });
});

describe("review H-A: a pointer still on this machine is never passed over for an older one", () => {
  /** A Nick session the hub knows, live in a fresh home of its own. */
  const freshLiveSession = async (session: string): Promise<string> => {
    await send("POST", "/api/sessions", nick.apiKey, {
      id: session,
      agentKind: "claude-code",
      repo: REPO_ID,
      branch: "main",
      baseCommit: "a1b2c3d4",
      status: "implementing",
    });
    return homeWithLive(session);
  };

  const tripwireRecord = (sessionId: string, refId: string): unknown =>
    envelope(nick.id, sessionId, "hint_delivery", {
      id: deliveryIdFor(sessionId, refId, "tripwire"),
      sessionId,
      refKind: "work_context",
      refId,
      channel: "tripwire",
      deliveredAt: new Date().toISOString(),
    });

  test("crosscheck followed <ref> records on today's held delivery, and last week's override stands", async () => {
    // Arrange — SOLO's delivery of the ref is on the hub with an override; LIVE's is still in its spool
    const ref = "wc_ken_ha_followed";
    const reason = "H-A: kept the old filter row";
    await send("POST", "/api/records", ken.apiKey, {
      records: [
        envelope(ken.id, KEN_SESSION, "work_context", {
          id: ref,
          sessionId: KEN_SESSION,
          title: "Ken's context",
          status: "implementing",
          createdAt: new Date().toISOString(),
        }),
      ],
    });
    await deliver(SOLO, ref);
    const overrode = await send("POST", "/api/hint-outcomes", nick.apiKey, {
      repo: REPO_ID,
      ref,
      outcome: "overrode",
      reason,
      session: SOLO,
    });
    expect(overrode.status).toBe(201);
    const home = await homeWithLive(LIVE);
    await spoolDelivery(home, hubUrl, LIVE, ref);

    // Act
    const result = await cli(home, ["followed", ref]);
    const mine = (await (
      await fetch(`${hubUrl}/api/hint-outcomes/mine?repo=${encodeURIComponent(REPO_ID)}`, {
        headers: { Authorization: `Bearer ${nick.apiKey}` },
      })
    ).json()) as { data: { reasons: readonly { reason: string }[] } };

    // Assert — not "superseding the earlier overrode": that was another session's pointer
    expect(result.stdout).toStartWith(`recorded: ${ref} — followed. `);
    expect(mine.data.reasons.map((each) => each.reason)).toContain(reason);
  });

  test("round-5 LOW-3: a held twin that cannot be sent is not 'held' when the same pointer's twin is on the hub", async () => {
    // Arrange — the prompt hint reached the hub; its tripwire twin, newer, is still in the spool,
    // and the hub cannot take records right now
    const recordless = `http://127.0.0.1:${String(recordlessHub.port)}`;
    const session = "cc_aaaaaaaa-2222-4333-8444-555555555555";
    const ref = "wc_ken_ha_unsendable";
    await send("POST", "/api/sessions", nick.apiKey, {
      id: session,
      agentKind: "claude-code",
      repo: REPO_ID,
      branch: "main",
      baseCommit: "a1b2c3d4",
      status: "implementing",
    });
    const onTheHub = await deliver(session, ref);
    const home = await homeWithLive(session, recordless);
    await appendRecords(home, repoKey(recordless, REPO_ID), session.replace("cc_", ""), [tripwireRecord(session, ref)], new Date());

    // Act
    const result = await cli(home, ["followed", ref], { hub: recordless });

    // Assert — one intervention: the word lands on the twin the hub has
    expect(result.stdout).toStartWith(`recorded: ${ref} — followed`);
    const mine = (await (
      await fetch(`${hubUrl}/api/hint-outcomes/mine?repo=${encodeURIComponent(REPO_ID)}`, {
        headers: { Authorization: `Bearer ${nick.apiKey}` },
      })
    ).json()) as { data: { followed: number } };
    expect(mine.data.followed).toBeGreaterThan(0);
    expect(onTheHub).toStartWith("hd_");
  });

  test("crosscheck followed with no id offers a pointer still held here beside an older one, newest first", async () => {
    // Arrange — an older pointer the hub has, and a newer one still in this session's spool
    const session = "cc_88888888-2222-4333-8444-555555555555";
    const home = await freshLiveSession(session);
    const older = await deliver(session, "wc_ken_ha_older");
    const held = hintDeliveryId(session, "wc_ken_ha_newer");
    await spoolDelivery(home, hubUrl, session, "wc_ken_ha_newer");

    // Act
    const result = await cli(home, ["followed"]);

    // Assert — listed, never recorded on the older one
    expect(result.stdout).toContain("name the one you mean");
    expect(result.stdout.indexOf(held)).toBeGreaterThan(-1);
    expect(result.stdout.indexOf(held)).toBeLessThan(result.stdout.indexOf(older));
  });

  test("crosscheck followed with no id takes a pointer's prompt hint and its tripwire ask as one, and records it", async () => {
    // Arrange — one pointer, two deliveries on the hub
    const session = "cc_99999999-2222-4333-8444-555555555555";
    const home = await freshLiveSession(session);
    await deliver(session, "wc_ken_ha_twins");
    await send("POST", "/api/records", nick.apiKey, { records: [tripwireRecord(session, "wc_ken_ha_twins")] });

    // Act
    const result = await cli(home, ["followed"]);

    // Assert — not "2 interventions … name the one you mean"
    expect(result.stdout).toStartWith(`recorded: ${deliveryIdFor(session, "wc_ken_ha_twins", "tripwire")} — followed`);
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

  test("review H2: a repeat under the person's newer noise label says the label stands over it", () => {
    // Act
    const line = outcomeRecordedLine(KEN_CONTEXT, recorded({ repeated: true, stands: "noise" }));

    // Assert
    expect(line).toBe(
      `already recorded: ${KEN_CONTEXT} — followed was said before, and your noise label, made since, stands over it; nothing was written a second time\n`,
    );
  });

  test("survivor R19: the same word with a new reason says the reason was revised", () => {
    // Act
    const line = outcomeRecordedLine(
      KEN_CONTEXT,
      recorded({ outcome: "overrode", replaced: "overrode", stands: "overrode", reasonRevised: true }),
    );

    // Assert
    expect(line).toStartWith(`recorded: ${KEN_CONTEXT} — overrode, the reason revised (the earlier one kept in the history). `);
  });

  test("a word after the noise label names the label it superseded", () => {
    // Act
    const line = outcomeRecordedLine(KEN_CONTEXT, recorded({ replaced: "noise" }));

    // Assert
    expect(line).toStartWith(`recorded: ${KEN_CONTEXT} — followed, superseding your earlier noise label (kept in the history). `);
  });

  test("a word recorded under the person's noise label says the label still stands", () => {
    // Act
    const line = outcomeRecordedLine(KEN_CONTEXT, recorded({ replaced: "noise", stands: "noise" }));

    // Assert — 07 §13.12: an agent's word (crosscheck followed with no terminal) never overturns yours
    expect(line).toStartWith(
      `recorded: ${KEN_CONTEXT} — followed, but your noise label still stands: an agent's word never overturns yours. `,
    );
  });

  test("round-5 LOW-4: a word recorded under the person's helpful label says that label still stands", () => {
    // Act
    const line = outcomeRecordedLine(KEN_CONTEXT, recorded({ replaced: "helpful", stands: "helpful" }));

    // Assert
    expect(line).toStartWith(
      `recorded: ${KEN_CONTEXT} — followed, but your helpful label still stands: an agent's word never overturns yours. `,
    );
  });
});
