/**
 * HUMAN PROVENANCE, END TO END (0.11 §5, §6) against a REAL hub on a loopback
 * socket and a REAL repository:
 *
 *   1. an agent drafts three ratings through its own door — the call
 *      `mark_hint_outcome` makes;
 *   2. `crosscheck pilot --mine` counts none of them as the person's, and says
 *      three wait, rated by the agent;
 *   3. `crosscheck confirm` says what waits and opens the page;
 *   4. the person opens /ui/confirm in a browser session, confirms two, discards
 *      one, and signs that frozen batch with ONE passkey assertion (a software
 *      authenticator: the capability 04a §8.1 names, used to drive the real
 *      verification);
 *   5. `crosscheck pilot --mine` shows the two as the person's and nothing of
 *      the agent's counted as human — the discarded one is unmarked.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import { PASSKEY_COOLOFF_HOURS } from "../../server/src/constants.ts";
import { hintDeliveryId } from "@crosscheck/connector-core/capture/records.ts";
import { postHintOutcome } from "@crosscheck/connector-core/http/hint-outcomes.ts";
import { writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { EXIT_OK } from "@crosscheck/connector-core/constants.ts";

import { runCli } from "../src/index.ts";
import {
  createSoftCredential,
  softAuthenticationResponse,
  softRegistrationResponse,
} from "../../server/test/fixtures/soft-authenticator.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const ADMIN_TOKEN = "provenance-e2e-admin";
const MS_PER_HOUR = 3_600_000;
/** How far ahead of the wall clock the hub's own clock runs: moved past the cool-off once the person signed. */
let hubAheadMs = 0;
/** The origin the person's browser shows; the socket is 127.0.0.1, a loopback peer. */
const ORIGIN = "http://localhost:7100";
const RP_ID = "localhost";
const REPO_ID = "github.com/acme/api";
const NICK_SESSION = "cc_88888888-2222-4333-8444-555555555555";
const KEN_SESSION = "cc_99999999-2222-4333-8444-555555555555";
const KEN_WORK = [
  ["wc_ken_cache", "Key the cache by repo"],
  ["wc_ken_retry", "Retry uploads on the hub"],
  ["wc_ken_export", "Export keeps the header"],
] as const;

let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let repo: string;
let home: string;
let nick: { apiKey: string; id: string };
let ken: { apiKey: string; id: string };

const send = async (method: string, path: string, key: string, body?: unknown): Promise<Response> =>
  fetch(`${hubUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const dataOf = async <T>(response: Response): Promise<T> => ((await response.json()) as { data: T }).data;

const envelope = (developerId: string, sessionId: string, kind: string, body: unknown): unknown => ({
  cx: "0.1",
  id: `env_${crypto.randomUUID()}`,
  ts: new Date().toISOString(),
  producer: { developerId, agentKind: "claude-code", sessionId },
  kind,
  body,
});

const mine = async (): Promise<string> => {
  const result = await runCli(
    ["pilot", "--mine"],
    {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: nick.apiKey,
      CROSSCHECK_TIMEOUT_MS: "4000",
    },
    repo,
  );
  expect(result.exitCode).toBe(EXIT_OK);
  return result.stdout;
};

/** The person's browser: a session cookie, the page's CSRF token, and the Origin it shows. */
interface Browser {
  readonly cookie: string;
  readonly csrf: string;
}

const browserPost = async (browser: Browser, path: string, body: unknown): Promise<Response> =>
  fetch(`${hubUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: browser.cookie,
      Origin: ORIGIN,
      "x-crosscheck-csrf": browser.csrf,
    },
    body: JSON.stringify(body),
  });

const pageOf = async (cookie: string, path: string): Promise<string> =>
  (await fetch(`${hubUrl}${path}`, { headers: { Cookie: cookie } })).text();

const signIn = async (): Promise<Browser> => {
  const login = await fetch(`${hubUrl}/ui/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ apiKey: nick.apiKey }).toString(),
  });
  const cookie = (login.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
  const page = await pageOf(cookie, "/ui/confirm");
  const csrf = /id="crosscheck-csrf" data-token="([^"]+)"/.exec(page)?.[1] ?? "";
  return { cookie, csrf };
};

const enrolPasskey = async (browser: Browser, credential: ReturnType<typeof createSoftCredential>): Promise<void> => {
  const minted = await dataOf<{ code: string }>(
    await send("POST", `/api/developers/${nick.id}/passkey-enrollments`, ADMIN_TOKEN, {}),
  );
  const fields = { action: "enrol", code: minted.code, label: "MacBook" };
  const options = await dataOf<{ ceremonyId: string; publicKey: { challenge: string } }>(
    await browserPost(browser, "/ui/webauthn/options", fields),
  );
  const verified = await browserPost(browser, "/ui/webauthn/verify", {
    ...fields,
    ceremonyId: options.ceremonyId,
    response: softRegistrationResponse({ credential, challenge: options.publicKey.challenge, origin: ORIGIN, rpId: RP_ID }),
  });
  expect(verified.status).toBe(200);
};

beforeAll(async () => {
  const db = await createDb();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // The hub's own clock, which the test moves past the passkey's cool-off (review H1).
    fetch: createServer({ db, adminToken: ADMIN_TOKEN, webauthnOrigins: [ORIGIN], now: () => new Date(Date.now() + hubAheadMs) }).fetch,
  });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  repo = await makeRepo("provenance-e2e", { remote: "git@github.com:acme/api.git" });
  home = await makeHome("provenance-e2e");
  const created = async (name: string) => {
    const body = await dataOf<{ apiKey: string; developer: { id: string } }>(
      await send("POST", "/api/developers", ADMIN_TOKEN, { name, email: `${name.toLowerCase()}-provenance@example.com` }),
    );
    return { apiKey: body.apiKey, id: body.developer.id };
  };
  nick = await created("Nick");
  ken = await created("Ken");
  for (const [key, id] of [[nick.apiKey, NICK_SESSION], [ken.apiKey, KEN_SESSION]] as const) {
    await send("POST", "/api/sessions", key, {
      id, agentKind: "claude-code", repo: REPO_ID, branch: "main", baseCommit: "a1b2c3d4", status: "implementing",
    });
  }
  await send("POST", "/api/records", ken.apiKey, {
    records: KEN_WORK.map(([id, title]) =>
      envelope(ken.id, KEN_SESSION, "work_context", { id, sessionId: KEN_SESSION, title, status: "implementing", createdAt: new Date().toISOString() }),
    ),
  });
  await send("PUT", "/api/team-settings", ADMIN_TOKEN, { repo: REPO_ID, pilotEnrolled: true });
  await send("POST", "/api/records", nick.apiKey, {
    records: KEN_WORK.map(([refId]) =>
      envelope(nick.id, NICK_SESSION, "hint_delivery", {
        id: hintDeliveryId(NICK_SESSION, refId), sessionId: NICK_SESSION, refKind: "work_context", refId,
        channel: "prompt_hint", deliveredAt: new Date().toISOString(),
      }),
    ),
  });
  await writeSessionState(home, {
    hostSessionKey: NICK_SESSION.replace("cc_", ""),
    crosscheckSessionId: NICK_SESSION,
    workContextId: `wc_${NICK_SESSION}`,
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

describe("an agent drafts three ratings; the person confirms two and discards one", () => {
  test("only the two the person signed count as human, and nothing of the agent's ever does", async () => {
    // Arrange: the agent's three ratings, through the agent's own door
    const ctx = { hubUrl, apiKey: nick.apiKey, timeoutMs: 4000, home, repoKey: "", now: () => new Date() };
    const words = [
      ["wc_ken_cache", "followed"],
      ["wc_ken_retry", "followed"],
      ["wc_ken_export", "overrode"],
    ] as const;
    for (const [ref, outcome] of words) {
      const said = await postHintOutcome(
        ctx,
        { repo: REPO_ID, ref, outcome, session: NICK_SESSION, ...(outcome === "overrode" ? { reason: "kept the header logic on the client" } : {}) },
        "agent",
      );
      expect(said.ok && said.data.draft).toBe(true);
    }
    const beforeConfirming = await mine();
    const opened: string[] = [];
    const confirmCommand = await runCli(
      ["confirm"],
      { CROSSCHECK_HOME: home, HOME: home, CROSSCHECK_HUB_URL: hubUrl, CROSSCHECK_API_KEY: nick.apiKey, CROSSCHECK_TIMEOUT_MS: "4000" },
      repo,
      undefined,
      { openUrl: async (url) => { opened.push(url); return true; } },
    );

    // Act: the person, in their browser
    const browser = await signIn();
    const credential = createSoftCredential();
    await enrolPasskey(browser, credential);
    const page = await pageOf(browser.cookie, "/ui/confirm");
    const fingerprint = /name="fingerprint" value="([0-9a-f]{64})"/.exec(page)?.[1] ?? "";
    const items = [...page.matchAll(/data-draft-id="([^"]+)" data-version="(\d+)">([\s\S]*?)<\/li>/g)].map((match) => ({
      draftId: match[1] ?? "",
      version: Number(match[2]),
      decision: (match[3] ?? "").includes("«Export keeps the header»") ? ("discard" as const) : ("confirm" as const),
    }));
    const batch = await dataOf<{ batchId: string; confirm: number; discard: number }>(
      await browserPost(browser, "/ui/confirm/batch", { fingerprint, items }),
    );
    const fields = { action: "confirm_batch", subjectId: batch.batchId };
    const options = await dataOf<{ ceremonyId: string; publicKey: { challenge: string } }>(
      await browserPost(browser, "/ui/webauthn/options", fields),
    );
    const signed = await browserPost(browser, "/ui/webauthn/verify", {
      ...fields,
      ceremonyId: options.ceremonyId,
      response: softAuthenticationResponse({ credential, challenge: options.publicKey.challenge, origin: ORIGIN, rpId: RP_ID, signCount: 1 }),
    });
    const afterConfirming = await mine();
    // a day on the hub's clock: the passkey enrolled for this is past its announced cool-off
    hubAheadMs = (PASSKEY_COOLOFF_HOURS + 1) * MS_PER_HOUR;
    const afterCoolOff = await mine();

    // Assert — before: nothing human, three of the agent's waiting
    expect(beforeConfirming).toContain("hints that reached you unasked: 3 — as you confirmed them with your passkey: followed 0 · overrode 0 · not relevant now 0 · noise 0 · unmarked 3");
    expect(beforeConfirming).toContain("not confirmed by you, so not counted above: 3 rated by your agent · 0 typed at a terminal · 0 recorded before provenance existed");
    expect(confirmCommand.stdout).toContain("3 drafts wait for your passkey: 3 ratings");
    expect(opened).toEqual([`${hubUrl}/ui/confirm`]);
    // the ceremony: one batch, two confirmed, one discarded, one assertion
    expect(items).toHaveLength(3);
    expect([batch.confirm, batch.discard]).toEqual([2, 1]);
    expect(signed.status).toBe(200);
    // after: the two the person signed wait out their passkey's cool-off (H1), said so with when
    expect(afterConfirming).toContain("as you confirmed them with your passkey: followed 0 · overrode 0 · not relevant now 0 · noise 0 · unmarked 3");
    expect(afterConfirming).toMatch(/ {2}2 confirmed, counting from \d{4}-\d{2}-\d{2}T[\d:.]+Z — the passkey that confirmed them is still in its cool-off/);
    // a day later: the two the person signed count, and nothing of the agent's ever does
    expect(afterCoolOff).toContain("hints that reached you unasked: 3 — as you confirmed them with your passkey: followed 2 · overrode 0 · not relevant now 0 · noise 0 · unmarked 1");
    expect(afterCoolOff).toContain("not confirmed by you, so not counted above: 0 rated by your agent · 0 typed at a terminal · 0 recorded before provenance existed");
    expect(afterCoolOff).not.toContain("counting from");
    expect(afterCoolOff).not.toContain("kept the header logic on the client");
  });
});
