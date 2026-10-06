/**
 * HELD FIRST (1.0 spec 07 §13.12, review H-A, probe G).
 *
 * Last week's session got a pointer at Ken's context and the agent overrode
 * it; today's session got the same pointer, and its delivery is still in this
 * session's spool. "Post first" asked the hub about the ref, the hub knew
 * last week's delivery, and today's word landed on it — superseding last
 * week's override and its reason, while today's stayed unmarked.
 *
 * What these pin: the sender's own held delivery of the ref is looked for
 * BEFORE posting, and the word is posted against that delivery's own id, so
 * the hub's "unknown" sends it first; and with no id, a pointer's twins are
 * one candidate.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import { deliveryIdFor, hintDeliveryId } from "@crosscheck/schema";

import { getMyHintOutcomes } from "../src/http/hint-outcomes.ts";
import type { MarkCandidate } from "../src/http/pilot.ts";
import { prepareMcp } from "../src/mcp/context.ts";
import { findTool } from "../src/mcp/tools/index.ts";
import { readLiveSessionStates, writeSessionState } from "../src/state/session-state.ts";
import { appendRecords } from "../src/spool/append.ts";
import {
  heldDeliveryIdOf,
  holdsUnsentDelivery,
  onePerPointer,
  withHeldCandidates,
} from "../src/spool/held-deliveries.ts";
import { repoKey } from "../src/config/paths.ts";
import type { Env } from "../src/index.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ADMIN = "held-first-admin";
const REPO_ID = "github.com/acme/api";
const OLD_SESSION = "cc_held-first-nick-old";
const NEW_SESSION = "cc_held-first-nick-new";
const NEW_KEY = "held-first-nick-new";
const KEN_SESSION = "cc_held-first-ken";
const KEN_CONTEXT = `wc_${KEN_SESSION}`;
const OVERRIDE_REASON = "kept the retry on the hub";

let server: ReturnType<typeof Bun.serve>;
let hubUrl = "";
let env: Env;
let home = "";
let repo = "";
let nick = { id: "", apiKey: "" };

const send = (path: string, apiKey: string, body: unknown, method = "POST"): Promise<Response> =>
  fetch(`${hubUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const developer = async (name: string, email: string): Promise<{ id: string; apiKey: string }> => {
  const body = (await (await send("/api/developers", ADMIN, { name, email })).json()) as {
    data: { developer: { id: string }; apiKey: string };
  };
  return { id: body.data.developer.id, apiKey: body.data.apiKey };
};

const envelope = (developerId: string, sessionId: string, kind: string, body: unknown): unknown => ({
  cx: "0.1",
  id: `env_${crypto.randomUUID()}`,
  ts: new Date().toISOString(),
  producer: { developerId, agentKind: "claude-code", sessionId },
  kind,
  body,
});

const seat = async (who: { id: string; apiKey: string }, sessionId: string): Promise<void> => {
  await send("/api/sessions", who.apiKey, {
    id: sessionId,
    agentKind: "claude-code",
    repo: REPO_ID,
    branch: "main",
    baseCommit: "a1b2c3d4",
    status: "analyzing",
  });
  await send("/api/records", who.apiKey, {
    records: [
      envelope(who.id, sessionId, "work_context", {
        id: `wc_${sessionId}`,
        sessionId,
        title: `work of ${sessionId}`,
        status: "analyzing",
        createdAt: new Date().toISOString(),
      }),
    ],
  });
};

const delivery = (sessionId: string): unknown =>
  envelope(nick.id, sessionId, "hint_delivery", {
    id: hintDeliveryId(sessionId, KEN_CONTEXT),
    sessionId,
    refKind: "work_context",
    refId: KEN_CONTEXT,
    channel: "prompt_hint",
    deliveredAt: new Date().toISOString(),
  });

beforeAll(async () => {
  const db = await createDb();
  server = Bun.serve({ port: 0, fetch: createServer({ db, adminToken: ADMIN }).fetch });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  nick = await developer("Nick", "nick-held-first@example.com");
  const ken = await developer("Ken", "ken-held-first@example.com");
  await seat(ken, KEN_SESSION);
  await send("/api/team-settings", ADMIN, { repo: REPO_ID, pilotEnrolled: true }, "PUT");
  await seat(nick, OLD_SESSION);
  await seat(nick, NEW_SESSION);
  // Last week's session: the pointer was delivered and the agent deliberately went its own way.
  await send("/api/records", nick.apiKey, { records: [delivery(OLD_SESSION)] });
  const overrode = await send("/api/hint-outcomes", nick.apiKey, {
    repo: REPO_ID,
    ref: KEN_CONTEXT,
    outcome: "overrode",
    reason: OVERRIDE_REASON,
    session: OLD_SESSION,
  });
  expect(overrode.status).toBe(201);
  home = await makeHome("held-first");
  repo = await makeRepo("held-first", { remote: "git@github.com:acme/api.git" });
  const now = new Date().toISOString();
  await writeSessionState(home, {
    hostSessionKey: NEW_KEY,
    crosscheckSessionId: NEW_SESSION,
    workContextId: `wc_${NEW_SESSION}`,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl,
    developerId: nick.id,
    startedAt: now,
    lastHeartbeatAt: now,
    seenTargets: [],
    workContextTitle: "Rework the importer",
    workContextStatus: "analyzing",
  });
  env = { CROSSCHECK_HOME: home, CROSSCHECK_HUB_URL: hubUrl, CROSSCHECK_API_KEY: nick.apiKey };
});

afterAll(async () => {
  server.stop(true);
  await Promise.all([home, repo].map((path) => rm(path, { recursive: true, force: true })));
});

describe("probe G: today's pointer still held, last week's known to the hub", () => {
  test("mark_hint_outcome records on today's held delivery, and last week's override stands", async () => {
    // Arrange — today the prompt hook booked the same pointer into this session's spool
    await appendRecords(home, repoKey(hubUrl, REPO_ID), NEW_KEY, [delivery(NEW_SESSION)], new Date());
    const setup = await prepareMcp(env, repo);
    if (!setup.ok) {
      throw new Error(setup.message);
    }
    const tool = findTool("mark_hint_outcome");
    if (tool === undefined) {
      throw new Error("mark_hint_outcome is not registered");
    }

    // Act
    const result = await tool.run(setup.ctx, { ref: KEN_CONTEXT, outcome: "followed" });
    const text = result.content.map((part) => part.text).join("\n");
    const view = await getMyHintOutcomes(setup.ctx.hub, { repo: REPO_ID });

    // Assert — today's delivery took the word; last week's keeps its override and its reason
    expect(text).toContain(hintDeliveryId(NEW_SESSION, KEN_CONTEXT));
    expect(text).not.toContain("supersedes");
    expect(await holdsUnsentDelivery(setup.ctx.hub, KEN_CONTEXT)).toBe(false);
    expect(view.ok && view.data).toMatchObject({ received: 2, followed: 1, overrode: 1, unmarked: 0 });
    expect(view.ok ? JSON.stringify(view.data.reasons) : "").toContain(OVERRIDE_REASON);
  });
});

describe("withHeldCandidates (review H-A): what a live session here still holds, as the hub would list it", () => {
  const heldLine = (refId: string, channel: string, minutesAgo: number): unknown =>
    envelope(nick.id, NEW_SESSION, "hint_delivery", {
      id: hintDeliveryId(NEW_SESSION, refId),
      sessionId: NEW_SESSION,
      refKind: "work_context",
      refId,
      channel,
      deliveredAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    });

  test("only unasked deliveries inside the window are offered — never a pull, never one older than the hub would list", async () => {
    // Arrange — a recent prompt hint, a recent pull, and a prompt hint from two hours ago
    await appendRecords(
      home,
      repoKey(hubUrl, REPO_ID),
      NEW_KEY,
      [heldLine("wc_recent", "prompt_hint", 1), heldLine("wc_asked", "suspect", 1), heldLine("wc_stale", "prompt_hint", 120)],
      new Date(),
    );
    const setup = await prepareMcp(env, repo);
    if (!setup.ok) {
      throw new Error(setup.message);
    }
    const live = await readLiveSessionStates(home, hubUrl, REPO_ID, new Date());

    // Act
    const merged = await withHeldCandidates(setup.ctx.hub, live.states, { candidates: [], more: false }, 60, nick.id);

    // Assert
    expect(merged.candidates.map((each) => each.refId)).toEqual(["wc_recent"]);
  });
});

describe("heldDeliveryIdOf (round-5 LOW-3): held first, inside the window the candidates use", () => {
  test("a held delivery of the ref older than the window is not taken for today's", async () => {
    // Arrange — an hour-and-more-old delivery of one ref, a fresh one of another
    const stale = envelope(nick.id, NEW_SESSION, "hint_delivery", {
      id: hintDeliveryId(NEW_SESSION, "wc_held_stale"),
      sessionId: NEW_SESSION,
      refKind: "work_context",
      refId: "wc_held_stale",
      channel: "prompt_hint",
      deliveredAt: new Date(Date.now() - 120 * 60_000).toISOString(),
    });
    const fresh = envelope(nick.id, NEW_SESSION, "hint_delivery", {
      id: hintDeliveryId(NEW_SESSION, "wc_held_fresh"),
      sessionId: NEW_SESSION,
      refKind: "work_context",
      refId: "wc_held_fresh",
      channel: "prompt_hint",
      deliveredAt: new Date().toISOString(),
    });
    await appendRecords(home, repoKey(hubUrl, REPO_ID), NEW_KEY, [stale, fresh], new Date());
    const setup = await prepareMcp(env, repo);
    if (!setup.ok) {
      throw new Error(setup.message);
    }

    // Act
    const staleId = await heldDeliveryIdOf(setup.ctx.hub, setup.ctx.identity, "wc_held_stale", nick.id);
    const freshId = await heldDeliveryIdOf(setup.ctx.hub, setup.ctx.identity, "wc_held_fresh", nick.id);

    // Assert
    expect(staleId).toBeNull();
    expect(freshId).toBe(hintDeliveryId(NEW_SESSION, "wc_held_fresh"));
  });
});

describe("held candidates are the caller's own (round-5 LOW-9)", () => {
  test("a held delivery another developer's key produced is never offered or taken", async () => {
    // Arrange — a line in this home's spool, produced under someone else's developer key
    const theirs = envelope("dev_someone_else", NEW_SESSION, "hint_delivery", {
      id: hintDeliveryId(NEW_SESSION, "wc_theirs"),
      sessionId: NEW_SESSION,
      refKind: "work_context",
      refId: "wc_theirs",
      channel: "prompt_hint",
      deliveredAt: new Date().toISOString(),
    });
    await appendRecords(home, repoKey(hubUrl, REPO_ID), NEW_KEY, [theirs], new Date());
    const setup = await prepareMcp(env, repo);
    if (!setup.ok) {
      throw new Error(setup.message);
    }
    const live = await readLiveSessionStates(home, hubUrl, REPO_ID, new Date());

    // Act
    const offered = await withHeldCandidates(setup.ctx.hub, live.states, { candidates: [], more: false }, 60, nick.id);
    const taken = await heldDeliveryIdOf(setup.ctx.hub, setup.ctx.identity, "wc_theirs", nick.id);

    // Assert
    expect(offered.candidates.map((each) => each.refId)).not.toContain("wc_theirs");
    expect(taken).toBeNull();
  });
});

describe("onePerPointer (07 §13.10, M4): a pointer's twins are one candidate", () => {
  const candidate = (fields: Partial<MarkCandidate>): MarkCandidate => ({
    id: hintDeliveryId(NEW_SESSION, KEN_CONTEXT),
    sessionId: NEW_SESSION,
    channel: "prompt_hint",
    refKind: "work_context",
    refId: KEN_CONTEXT,
    deliveredAt: "2026-10-06T10:00:00.000Z",
    ...fields,
  });

  test("a prompt hint and a tripwire ask about one ref in one session collapse to the newest, newest pointer first", () => {
    // Arrange
    const prompt = candidate({});
    const tripwire = candidate({
      id: deliveryIdFor(NEW_SESSION, KEN_CONTEXT, "tripwire"),
      channel: "tripwire",
      deliveredAt: "2026-10-06T10:05:00.000Z",
    });
    const other = candidate({ id: "hd_other", refId: "wc_other", deliveredAt: "2026-10-06T10:01:00.000Z" });
    const otherSession = candidate({ id: "hd_elsewhere", sessionId: OLD_SESSION, deliveredAt: "2026-10-06T09:00:00.000Z" });

    // Act
    const collapsed = onePerPointer([prompt, other, otherSession, tripwire]);

    // Assert
    expect(collapsed.map((each) => each.id)).toEqual([tripwire.id, "hd_other", "hd_elsewhere"]);
  });
});
