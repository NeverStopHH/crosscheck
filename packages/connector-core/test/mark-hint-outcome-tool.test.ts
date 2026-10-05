/**
 * `mark_hint_outcome` end to end against a REAL hub (1.0 spec 07 §13).
 *
 * The agent is the one that knows what a hint led to: it read the pointer,
 * and it either reused the teammate's decision or went its own way for a
 * reason. These pin the tool's half of that bargain:
 *
 *   · the id the hint PRINTED is enough — the hub finds this session's
 *     delivery of it, and the person's own view counts it;
 *   · an override carries its reason, and a reason that looks like a secret
 *     never leaves the machine;
 *   · noise is refused BY NAME and pointed at the person's own command: the
 *     agent may say what happened next, never whether the product was noisy
 *     (07 D3, PIL-6);
 *   · a hub that predates outcomes says so instead of failing vaguely.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import { PIN_PRESENCE_TERMINAL, hintDeliveryId } from "@crosscheck/schema";

import { MyHintOutcomesSchema, getMyHintOutcomes } from "../src/http/hint-outcomes.ts";
import { prepareMcp } from "../src/mcp/context.ts";
import type { McpContext } from "../src/mcp/context.ts";
import { findTool } from "../src/mcp/tools/index.ts";
import {
  DELIVERY_STILL_ON_THIS_MACHINE,
  NOISE_IS_THE_PERSONS_LABEL,
  OUTCOMES_NOT_SERVED,
  OVERRIDE_NEEDS_REASON,
  REASON_SECRET_REFUSAL,
} from "../src/mcp/tools/mark-hint-outcome.ts";
import { QUOTED_DATA_NOTICE } from "../src/briefing/render.ts";
import { writeSessionState } from "../src/state/session-state.ts";
import { appendRecords } from "../src/spool/append.ts";
import { repoKey } from "../src/config/paths.ts";
import type { Env } from "../src/index.ts";
import { INJECTION_CORPUS } from "./fixtures/injection-corpus.ts";
import { assertUntrustedCharacters } from "./fixtures/untrusted-invariants.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ADMIN_TOKEN = "outcome-tool-admin";
const REPO_ID = "github.com/acme/api";
const NICK_SESSION = "cc_outcome-nick-uuid";
const KEN_SESSION = "cc_outcome-ken-uuid";
const KEN_CONTEXT = `wc_${KEN_SESSION}`;
/** A synthetic AWS example key, the same fixture secret-scan.test.ts uses. */
const CREDENTIAL = "AKIAIOSFODNN7EXAMPLE";

/**
 * The full corpus four times over, under a loaded runner (mcp-hostile-hub.test.ts
 * says why). Kept fast by preparing the tool's context ONCE: preparing it per
 * call spawned git for every answer and ran 6–9 s alone, 20 s under four
 * parallel runs — the timeout is not what was raised.
 */
const CORPUS_TIMEOUT_MS = 20_000;

let server: ReturnType<typeof Bun.serve>;
let oldHub: ReturnType<typeof Bun.serve>;
let hostileHub: ReturnType<typeof Bun.serve>;
/** What the hostile hub answers next; rebound per payload. */
let hostileAnswer: () => Response = () => Response.json({}, { status: 500 });
let hubUrl: string;
let nickEnv: Env;
let nickApiKey: string;
let nickId: string;
let nickHome: string;
let nickRepo: string;
const cleanups: string[] = [];

const send = async (path: string, apiKey: string, body: unknown, method = "POST"): Promise<Response> =>
  fetch(`${hubUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const developer = async (name: string, email: string): Promise<{ id: string; apiKey: string }> => {
  const response = await send("/api/developers", ADMIN_TOKEN, { name, email });
  const body = (await response.json()) as { data: { developer: { id: string }; apiKey: string } };
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

const seat = async (who: { id: string; apiKey: string }, sessionId: string, title: string): Promise<void> => {
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
        title,
        status: "analyzing",
        createdAt: new Date().toISOString(),
      }),
    ],
  });
};

const developerKeys = new Map<string, { id: string; apiKey: string }>();

const developerKey = async (name: string): Promise<{ id: string; apiKey: string }> => {
  const known = developerKeys.get(name);
  if (known === undefined) {
    throw new Error(`no developer ${name}`);
  }
  return known;
};

/** A delivery booked into Nick's spool the way the prompt hook books one — not yet sent. */
const spoolDelivery = async (hub: string, ref: string): Promise<void> => {
  const delivery = envelope(nickId, NICK_SESSION, "hint_delivery", {
    id: hintDeliveryId(NICK_SESSION, ref),
    sessionId: NICK_SESSION,
    refKind: "work_context",
    refId: ref,
    channel: "prompt_hint",
    deliveredAt: new Date().toISOString(),
  });
  await appendRecords(nickHome, repoKey(hub, REPO_ID), "outcome-nick-uuid", [delivery], new Date());
};

const contextFor = async (env: Env): Promise<McpContext> => {
  const setup = await prepareMcp(env, nickRepo);
  if (!setup.ok) {
    throw new Error(`prepareMcp failed: ${setup.message}`);
  }
  return setup.ctx;
};

const callIn = async (ctx: McpContext, args: unknown): Promise<{ text: string; isError: boolean }> => {
  const tool = findTool("mark_hint_outcome");
  if (tool === undefined) {
    throw new Error("no tool mark_hint_outcome");
  }
  const result = await tool.run(ctx, args);
  return { text: result.content.map((part) => part.text).join("\n"), isError: result.isError === true };
};

const call = async (args: unknown, env: Env = nickEnv): Promise<{ text: string; isError: boolean }> =>
  callIn(await contextFor(env), args);

const mine = async () => {
  const ctx = await contextFor(nickEnv);
  const view = await getMyHintOutcomes(ctx.hub, { repo: REPO_ID });
  if (!view.ok) {
    throw new Error(`view failed: ${view.message}`);
  }
  return view.data;
};

beforeAll(async () => {
  const db = await createDb();
  server = Bun.serve({ port: 0, fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  // A hub from before 07 §13: every route it lacks is its own `notFound`
  // envelope (server/src/app.ts), exactly as a real older hub answers.
  oldHub = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({ ok: false, error: { code: "not_found", message: "route not found" } }, { status: 404 }),
  });
  hostileHub = Bun.serve({ port: 0, fetch: () => hostileAnswer() });
  const nick = await developer("Nick", "nick-outcome-tool@example.com");
  const ken = await developer("Ken", "ken-outcome-tool@example.com");
  developerKeys.set("Ken", ken);
  await seat(ken, KEN_SESSION, "Widen the filter row");
  await seat(nick, NICK_SESSION, "Rework the importer");
  // Enrolled BEFORE the hint arrives: a delivery from before the repo could
  // record outcomes is outside every outcome figure (07 §13.9).
  await send("/api/team-settings", ADMIN_TOKEN, { repo: REPO_ID, pilotEnrolled: true }, "PUT");
  await send("/api/records", nick.apiKey, {
    records: [
      envelope(nick.id, NICK_SESSION, "hint_delivery", {
        id: hintDeliveryId(NICK_SESSION, KEN_CONTEXT),
        sessionId: NICK_SESSION,
        refKind: "work_context",
        refId: KEN_CONTEXT,
        channel: "prompt_hint",
        deliveredAt: new Date().toISOString(),
      }),
    ],
  });
  const home = await makeHome("outcome-tool");
  nickRepo = await makeRepo("outcome-tool", { remote: "git@github.com:acme/api.git" });
  cleanups.push(home, nickRepo);
  const startedAt = new Date().toISOString();
  await writeSessionState(home, {
    hostSessionKey: "outcome-nick-uuid",
    crosscheckSessionId: NICK_SESSION,
    workContextId: `wc_${NICK_SESSION}`,
    repoId: REPO_ID,
    repoRoot: nickRepo,
    hubUrl,
    developerId: nick.id,
    startedAt,
    lastHeartbeatAt: startedAt,
    seenTargets: [],
    workContextTitle: "Rework the importer",
    workContextStatus: "analyzing",
  });
  nickEnv = { CROSSCHECK_HOME: home, CROSSCHECK_HUB_URL: hubUrl, CROSSCHECK_API_KEY: nick.apiKey };
  nickApiKey = nick.apiKey;
  nickId = nick.id;
  nickHome = home;
});

afterAll(async () => {
  server.stop(true);
  oldHub.stop(true);
  hostileHub.stop(true);
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

describe("mark_hint_outcome", () => {
  test("the id the hint printed records what it led to, and the person's own view counts it", async () => {
    // Act
    const result = await call({ ref: KEN_CONTEXT, outcome: "followed" });

    // Assert
    expect(result.isError).toBe(false);
    expect(result.text).toContain("followed");
    expect(result.text).toContain(KEN_CONTEXT);
    expect(await mine()).toMatchObject({ received: 1, followed: 1 });
  });

  test("a different word later supersedes, and the answer says what it replaced", async () => {
    // Act
    const result = await call({
      ref: KEN_CONTEXT,
      outcome: "overrode",
      reason: "kept the narrow row: the wide one breaks the mobile layout",
    });

    // Assert
    expect(result.isError).toBe(false);
    expect(result.text).toContain("followed");
    expect(await mine()).toMatchObject({ received: 1, followed: 0, overrode: 1 });
  });

  test("review #11: after the person's noise label the same word is written, and the answer names the label it superseded", async () => {
    // Arrange — the person labels the delivery noise at a terminal, after the agent's word
    const reason = "kept the narrow row: the wide one breaks the mobile layout";
    await send("/api/pilot-marks", nickApiKey, {
      repo: REPO_ID,
      refKind: "hint_delivery",
      refId: hintDeliveryId(NICK_SESSION, KEN_CONTEXT),
      mark: "noise",
      presence: PIN_PRESENCE_TERMINAL,
    });

    // Act — "Already recorded … stands at overrode" would be false: the label stands
    const again = await call({ ref: KEN_CONTEXT, outcome: "overrode", reason });
    const repeat = await call({ ref: KEN_CONTEXT, outcome: "overrode", reason });

    // Assert
    expect(again.text).toContain("It supersedes your earlier noise label, which stays in the history.");
    expect(await mine()).toMatchObject({ received: 1, overrode: 1, noise: 0 });
    expect(repeat.text).toContain(`Already recorded: the hint at ${KEN_CONTEXT} stands at overrode.`);
  });

  test("review #11: a word that ties with the noise label says the label still stands", async () => {
    // Arrange — the hub reports a tie (the label wins, D-O7)
    const env: Env = { ...nickEnv, CROSSCHECK_HUB_URL: `http://127.0.0.1:${String(hostileHub.port)}` };
    hostileAnswer = () =>
      Response.json({
        ok: true,
        data: { id: "ho_1", deliveryId: "hd_1", outcome: "followed", repeated: false, replaced: "noise", stands: "noise" },
      });

    // Act
    const tied = await call({ ref: KEN_CONTEXT, outcome: "followed" }, env);

    // Assert
    expect(tied.text).toContain("A noise label made at the same instant still stands: a label wins a tie.");
    expect(tied.text).not.toContain("It supersedes");
  });

  test("review #14: a hint still on this machine is sent before the outcome, which is then recorded", async () => {
    // Arrange — a prompt hint booked its delivery into the spool; no tool has run since
    const ref = "wc_ken_second";
    await send("/api/records", (await developerKey("Ken")).apiKey, {
      records: [
        envelope((await developerKey("Ken")).id, KEN_SESSION, "work_context", {
          id: ref,
          sessionId: KEN_SESSION,
          title: "Batch the uploads",
          status: "analyzing",
          createdAt: new Date().toISOString(),
        }),
      ],
    });
    await spoolDelivery(hubUrl, ref);

    // Act
    const result = await call({ ref, outcome: "followed" });

    // Assert — "no hint with that id reached you" would be false: it reached Nick
    expect(result.isError).toBe(false);
    expect(result.text).toContain(`Recorded: the hint at ${ref}`);
  });

  test("review #14: a hint the hub has not received yet is never answered 'never reached you'", async () => {
    // Arrange — the hub cannot take the spooled delivery and does not know the ref
    const env: Env = { ...nickEnv, CROSSCHECK_HUB_URL: `http://127.0.0.1:${String(hostileHub.port)}` };
    hostileAnswer = () =>
      Response.json(
        { ok: false, error: { code: "unknown_ref", message: "no hint with that id reached you on this repo" } },
        { status: 422 },
      );
    await spoolDelivery(`http://127.0.0.1:${String(hostileHub.port)}`, "wc_ken_held");

    // Act
    const result = await call({ ref: "wc_ken_held", outcome: "followed" }, env);

    // Assert
    expect(result.isError).toBe(true);
    expect(result.text).toContain(DELIVERY_STILL_ON_THIS_MACHINE);
    expect(result.text).not.toContain("reached you on this repo");
  });

  test("an override without its reason is refused before any round trip", async () => {
    // Act
    const result = await call({ ref: KEN_CONTEXT, outcome: "overrode" });

    // Assert — refused here, in the tool's words, not by the hub's schema
    expect(result.isError).toBe(true);
    expect(result.text).toBe(OVERRIDE_NEEDS_REASON);
  });

  test("noise is refused by name, and pointed at the person's own label", async () => {
    // Act
    const result = await call({ ref: KEN_CONTEXT, outcome: "noise" });

    // Assert
    expect(result.isError).toBe(true);
    expect(result.text).toBe(NOISE_IS_THE_PERSONS_LABEL);
    expect(result.text).toContain("crosscheck noise");
  });

  test("a reason that looks like a secret never leaves the machine", async () => {
    // Arrange
    const before = await mine();

    // Act
    const result = await call({
      ref: KEN_CONTEXT,
      outcome: "not_relevant_now",
      reason: `the deploy key ${CREDENTIAL} was already rotated`,
    });

    // Assert — refused HERE, in the tool's own words, not by the hub's scan
    expect(result.isError).toBe(true);
    expect(result.text).toBe(REASON_SECRET_REFUSAL);
    expect(await mine()).toMatchObject({
      notRelevantNow: before.notRelevantNow,
      reasons: before.reasons,
    });
  });

  test("a hub that predates outcomes says so, and nothing pretends to be recorded", async () => {
    // Arrange
    const env: Env = { ...nickEnv, CROSSCHECK_HUB_URL: `http://127.0.0.1:${String(oldHub.port)}` };

    // Act
    const result = await call({ ref: KEN_CONTEXT, outcome: "followed" }, env);

    // Assert
    expect(result.isError).toBe(true);
    expect(result.text).toBe(OUTCOMES_NOT_SERVED);
  });
});

/** Every rule that holds for injected text, over a whole tool reply, line by line. */
const assertSafeReply = (text: string, where: string): void => {
  expect(text.includes("\r"), where).toBe(false);
  text.split("\n").forEach((line, index) => {
    assertUntrustedCharacters(line, `${where} line ${String(index + 1)}`);
  });
  if (text.includes("«")) {
    expect(text.includes(QUOTED_DATA_NOTICE), `${where}: notice`).toBe(true);
  }
};

describe("a hostile hub cannot speak through mark_hint_outcome's reply", () => {
  test(
    "every string the hub chooses — ids, outcome words, what stands, refusal code and message — holds the invariants",
    async () => {
      // Arrange — one context for the whole corpus: the hub's answer is what varies
      const ctx = await contextFor({ ...nickEnv, CROSSCHECK_HUB_URL: `http://127.0.0.1:${String(hostileHub.port)}` });
      const args = { ref: KEN_CONTEXT, outcome: "followed" };
      const answers = (payload: string): readonly (() => Response)[] => [
        // a success naming everything with the payload; what stands differing
        // from the word (a tie); a repeat standing at the payload; a refusal
        () =>
          Response.json({
            ok: true,
            data: { id: payload, deliveryId: payload, outcome: payload, repeated: false, replaced: payload, stands: payload },
          }),
        () =>
          Response.json({
            ok: true,
            data: { id: payload, deliveryId: payload, outcome: "followed", repeated: false, replaced: payload, stands: payload },
          }),
        () =>
          Response.json({
            ok: true,
            data: { id: payload, deliveryId: payload, outcome: payload, repeated: true, replaced: null, stands: payload },
          }),
        () => Response.json({ ok: false, error: { code: payload, message: payload } }, { status: 422 }),
      ];

      for (const entry of INJECTION_CORPUS) {
        for (const [index, answer] of answers(entry.payload).entries()) {
          // Act
          hostileAnswer = answer;
          const reply = await callIn(ctx, args);

          // Assert
          assertSafeReply(reply.text, `answer ${String(index)}/${entry.id}`);
        }
      }
    },
    CORPUS_TIMEOUT_MS,
  );
});

describe("the source credit on the wire (review #10)", () => {
  const view = (yourWork: Record<string, unknown>): Record<string, unknown> => ({
    repo: REPO_ID,
    days: 56,
    sinceIso: "2026-08-10T00:00:00.000Z",
    untilIso: "2026-10-05T00:00:00.000Z",
    received: 0,
    followed: 0,
    overrode: 0,
    notRelevantNow: 0,
    noise: 0,
    unmarked: 0,
    bySource: [],
    bySourceBeyondList: 0,
    reasons: [],
    reasonsBeyondList: 0,
    yourWork: { periodStartIso: "2026-09-01T00:00:00.000Z", periodEndIso: "2026-10-01T00:00:00.000Z", ...yourWork },
  });

  test("a credit is a count or a withholding — one with both, or neither, is unreadable", () => {
    // Act
    const counted = MyHintOutcomesSchema.safeParse(view({ followed: 4, withheld: null }));
    const withheld = MyHintOutcomesSchema.safeParse(view({ followed: null, withheld: "too_few_recorders" }));
    const both = MyHintOutcomesSchema.safeParse(view({ followed: 4, withheld: "too_few_recorders" }));
    const neither = MyHintOutcomesSchema.safeParse(view({ followed: null, withheld: null }));

    // Assert — a number beside "withheld" would print what the hub held back
    expect(counted.success).toBe(true);
    expect(withheld.success).toBe(true);
    expect(both.success).toBe(false);
    expect(neither.success).toBe(false);
  });
});
